/**
 * Diagnostic probe — NOT a test. Runs from the qkb workspace so imports resolve.
 *
 *   npx tsx test/spikes/probe-merge-syntax.ts
 *
 * This file documents the three GraphQLite v0.4.4 quirks that shaped the
 * PR-6 SDK design (`src/graph/sdk.ts`):
 *
 *   1. `MERGE (n:Label {id: $id})` — $id silently null inside the inline
 *      property map. Subsequent calls with different ids match the same
 *      null-id node. Affects MERGE on nodes only; CREATE and MATCH with
 *      $param inside inline maps work fine.
 *
 *   2. Chained MERGE doesn't propagate node variables. e.g.
 *      `MERGE (a {id: $f}) MERGE (b {id: $t}) MERGE (a)-[r]->(b)` — the
 *      third MERGE doesn't see a/b. Use `MATCH (a),(b) MERGE (a)-[r]->(b)`.
 *
 *   3. `CREATE (n {id: $id}) SET n += $props` — combining CREATE + SET in
 *      ONE cypher() call silently drops the SET. Split into two calls, OR
 *      inline all properties in the CREATE pattern (which works).
 *
 *   4. `SET r += $props` — `r` (relationship variable) reports
 *      "Unbound variable in bulk SET" even when bound by MERGE. Use
 *      inline relationship properties at MERGE time instead.
 *
 * Re-run when bumping the pinned GraphQLite version to verify the bugs
 * are fixed; if so, the SDK in PR-6 can be simplified.
 */
import { openDatabase } from "../../src/internals/db.js";

const db = openDatabase(":memory:");
db.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");

const tries: ReadonlyArray<readonly [string, string, string]> = [
  ["M1: SET r += $props", "MERGE (a {id: 'x'}) MERGE (b {id: 'y'}) MERGE (a)-[r:KNOWS]->(b) SET r += $props RETURN 1", '{"props":{"since":2020}}'],
  ["M2: SET r += map literal", "MERGE (a {id: 'x'}) MERGE (b {id: 'y'}) MERGE (a)-[r:KNOWS]->(b) SET r += {since: 2020} RETURN 1", "{}"],
  ["M3: SET r.field = value", "MERGE (a {id: 'x'}) MERGE (b {id: 'y'}) MERGE (a)-[r:KNOWS]->(b) SET r.since = 2020 RETURN 1", "{}"],
  ["M4: inline rel props with $param", "MERGE (a {id: 'x'}) MERGE (b {id: 'y'}) MERGE (a)-[r:KNOWS {since: $since}]->(b) RETURN 1", '{"since":2020}'],
  ["M5: MERGE with WITH bridges", "MERGE (a {id: 'x'}) WITH a MERGE (b {id: 'y'}) WITH a, b MERGE (a)-[r:KNOWS]->(b) SET r += $props RETURN 1", '{"props":{"since":2020}}'],
  ["M6: MATCH + MATCH + MERGE r + WITH r + SET", "MATCH (a {id: 'x2'}) MATCH (b {id: 'y2'}) MERGE (a)-[r:LINKS]->(b) WITH r SET r += $props RETURN 1", '{"props":{"weight":0.5}}'],
  ["M7: MERGE + ON CREATE SET (props on create only)", "MERGE (a {id: 'x3'}) MERGE (b {id: 'y3'}) MERGE (a)-[r:CARES {weight: $w}]->(b) RETURN 1", '{"w":0.7}'],
  ["M8: pre-create nodes + inline props", "CREATE (a:T {id: 'x4'}) CREATE (b:T {id: 'y4'}) CREATE (a)-[:LINK {weight: $w}]->(b) RETURN 1", '{"w":0.9}'],
];

console.log("---SETUP for M6---");
db.prepare("SELECT cypher(?)").get("CREATE (:Marker {id: 'x2'}), (:Marker {id: 'y2'})");

// === LABEL SEMANTICS PROBE ===
console.log("\n---LABEL SEMANTICS---");
const db2 = openDatabase(":memory:");
db2.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");

// Create labeled node
db2.prepare("SELECT cypher(?)").get("CREATE (:Person {id: 'alice'})");

// Try MERGE without label — does it match the labeled node?
const r1 = db2.prepare("SELECT cypher(?) AS r").get("MATCH (n {id: 'alice'}) RETURN labels(n) AS l, count(n) AS c") as { r: string };
console.log("MATCH (n {id: 'alice'}) RETURN labels(n), count:", r1.r);

const r2 = db2.prepare("SELECT cypher(?) AS r").get("MERGE (n {id: 'alice'}) RETURN labels(n) AS l, count(n) AS c") as { r: string };
console.log("MERGE (n {id: 'alice'}) RETURN labels(n), count:", r2.r);

const r3 = db2.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN labels(n) AS l, count(*) AS c") as { r: string };
console.log("All nodes after MERGE:", r3.r);

// === FULL upsertEdge SEQUENCE ===
console.log("\n---FULL upsertEdge SEQUENCE---");
const db3 = openDatabase(":memory:");
db3.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");

// upsertNode alice
db3.prepare("SELECT cypher(?, ?)").get(
  "MERGE (n:Person {id: $id}) SET n += $props RETURN 1",
  '{"id":"person:alice","props":{"id":"person:alice","name":"Alice"}}'
);
// upsertNode bob
db3.prepare("SELECT cypher(?, ?)").get(
  "MERGE (n:Person {id: $id}) SET n += $props RETURN 1",
  '{"id":"person:bob","props":{"id":"person:bob","name":"Bob"}}'
);

const allNodes = db3.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN labels(n) AS l, n.id AS id, n.name AS name") as { r: string };
console.log("After 2 upsertNode calls:", allNodes.r);

// upsertEdge alice→bob
db3.prepare("SELECT cypher(?, ?)").get(
  "MERGE (a {id: $from}) MERGE (b {id: $to}) MERGE (a)-[:KNOWS {since: $p_since}]->(b) RETURN 1",
  '{"from":"person:alice","to":"person:bob","p_since":2020}'
);

const allRels = db3.prepare("SELECT cypher(?) AS r").get("MATCH (a)-[r]->(b) RETURN labels(a) AS la, a.id AS aid, type(r) AS rt, r.since AS rsince, labels(b) AS lb, b.id AS bid") as { r: string };
console.log("After upsertEdge:", allRels.r);

const matchedRel = db3.prepare("SELECT cypher(?, ?) AS r").get(
  "MATCH (a:Person {id: $a})-[r:KNOWS]->(b:Person) RETURN b.name AS name, r.since AS since",
  '{"a":"person:alice"}'
) as { r: string };
console.log("Test query result:", matchedRel.r);

// === upsertNode-only probe ===
console.log("\n---upsertNode in isolation---");
const dbN = openDatabase(":memory:");
dbN.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");

dbN.prepare("SELECT cypher(?, ?)").get(
  "MERGE (n:Person {id: $id}) SET n += $props RETURN 1",
  '{"id":"alice","props":{"id":"alice","name":"Alice","age":30}}'
);
console.log("After upsert alice:", (dbN.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN n.id AS id, n.name AS name, n.age AS age") as { r: string }).r);

dbN.prepare("SELECT cypher(?, ?)").get(
  "MERGE (n:Person {id: $id}) SET n += $props RETURN 1",
  '{"id":"bob","props":{"id":"bob","name":"Bob","age":25}}'
);
console.log("After upsert bob:", (dbN.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN n.id AS id, n.name AS name, n.age AS age") as { r: string }).r);
console.log("Count(*):", (dbN.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN count(n) AS c") as { r: string }).r);
console.log("MATCH (n:Person):", (dbN.prepare("SELECT cypher(?) AS r").get("MATCH (n:Person) RETURN n.id AS id") as { r: string }).r);

// === MERGE without SET (test if SET is the culprit) ===
console.log("\n---MERGE without SET---");
const dbM = openDatabase(":memory:");
dbM.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");
dbM.prepare("SELECT cypher(?, ?)").get("MERGE (n:Person {id: $id, name: $name}) RETURN 1", '{"id":"alice","name":"Alice"}');
console.log("After alice:", (dbM.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN n.id AS id, n.name AS name, count(*) AS c") as { r: string }).r);
dbM.prepare("SELECT cypher(?, ?)").get("MERGE (n:Person {id: $id, name: $name}) RETURN 1", '{"id":"bob","name":"Bob"}');
console.log("After bob:", (dbM.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN n.id AS id, n.name AS name") as { r: string }).r);
console.log("Count after both:", (dbM.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN count(n) AS c") as { r: string }).r);

// === MERGE then separate SET (single statement, but test order) ===
console.log("\n---ON CREATE SET pattern---");
const dbO = openDatabase(":memory:");
dbO.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");
dbO.prepare("SELECT cypher(?, ?)").get("MERGE (n:Person {id: $id}) ON CREATE SET n.name = $name ON MATCH SET n.name = $name RETURN 1", '{"id":"alice","name":"Alice"}');
console.log("After alice:", (dbO.prepare("SELECT cypher(?) AS r").get("MATCH (n:Person) RETURN n.id AS id, n.name AS name") as { r: string }).r);
dbO.prepare("SELECT cypher(?, ?)").get("MERGE (n:Person {id: $id}) ON CREATE SET n.name = $name ON MATCH SET n.name = $name RETURN 1", '{"id":"bob","name":"Bob"}');
console.log("After bob:", (dbO.prepare("SELECT cypher(?) AS r").get("MATCH (n:Person) RETURN n.id AS id, n.name AS name") as { r: string }).r);
console.log("Count after both:", (dbO.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN count(n) AS c") as { r: string }).r);

// === Parameter binding sanity ===
console.log("\n---Parameter binding sanity---");
const dbP = openDatabase(":memory:");
dbP.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");

// Simplest CREATE with $param
const r_a = dbP.prepare("SELECT cypher(?, ?) AS r").get("CREATE (n:T {id: $id}) RETURN n.id AS x", '{"id":"hello"}') as { r: string };
console.log("CREATE with $id:", r_a.r);
console.log("Verify:", (dbP.prepare("SELECT cypher(?) AS r").get("MATCH (n:T) RETURN n.id AS id") as { r: string }).r);

// MATCH with $param
const r_b = dbP.prepare("SELECT cypher(?, ?) AS r").get("MATCH (n:T {id: $id}) RETURN n.id AS x", '{"id":"hello"}') as { r: string };
console.log("MATCH (n:T {id: $id}):", r_b.r);

// What if we use CREATE then MATCH with literal?
const dbQ = openDatabase(":memory:");
dbQ.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");
dbQ.prepare("SELECT cypher(?)").get("CREATE (n:T {id: 'literal'}) RETURN 1");
console.log("After literal CREATE:", (dbQ.prepare("SELECT cypher(?) AS r").get("MATCH (n:T) RETURN n.id AS id") as { r: string }).r);

// === MERGE with $param vs literal ===
console.log("\n---MERGE $param vs literal---");
const dbR = openDatabase(":memory:");
dbR.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");

console.log("--- MERGE with literal id ---");
dbR.prepare("SELECT cypher(?)").get("MERGE (n:T {id: 'a1'}) RETURN n.id AS id");
console.log("After literal a1:", (dbR.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN n.id AS id, count(*) AS c") as { r: string }).r);
dbR.prepare("SELECT cypher(?)").get("MERGE (n:T {id: 'b1'}) RETURN n.id AS id");
console.log("After literal b1:", (dbR.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN n.id AS id, count(*) AS c") as { r: string }).r);
console.log("Count:", (dbR.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN count(n) AS c") as { r: string }).r);

console.log("\n--- MERGE with $param id ---");
const dbS = openDatabase(":memory:");
dbS.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");
dbS.prepare("SELECT cypher(?, ?)").get("MERGE (n:T {id: $id}) RETURN n.id AS id", '{"id":"a2"}');
console.log("After param a2:", (dbS.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN n.id AS id, count(*) AS c") as { r: string }).r);
dbS.prepare("SELECT cypher(?, ?)").get("MERGE (n:T {id: $id}) RETURN n.id AS id", '{"id":"b2"}');
console.log("After param b2:", (dbS.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN n.id AS id, count(*) AS c") as { r: string }).r);
console.log("Count:", (dbS.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN count(n) AS c") as { r: string }).r);

// === ON CREATE / ON MATCH with $param ===
console.log("\n---ON CREATE / ON MATCH with $param---");
const dbU = openDatabase(":memory:");
dbU.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");
// MERGE on label only (no inline), set id via ON CREATE — does this work?
try {
  dbU.prepare("SELECT cypher(?, ?)").get("MERGE (n:T) ON CREATE SET n.id = $id RETURN n.id AS id", '{"id":"x1"}');
  console.log("After x1:", (dbU.prepare("SELECT cypher(?) AS r").get("MATCH (n:T) RETURN n.id AS id") as { r: string }).r);
} catch (e) { console.log("Failed:", (e as Error).message); }

// Different pattern: MATCH/CREATE branch via 2 queries — the safe workaround
console.log("\n---2-query upsert workaround---");
const dbV = openDatabase(":memory:");
dbV.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");

function nodeUpsert2Q(db: typeof dbV, label: string, id: string, props: Record<string, unknown>) {
  const matchR = db.prepare("SELECT cypher(?, ?) AS r").get(
    `MATCH (n:${label} {id: $id}) RETURN n.id AS id`,
    JSON.stringify({ id })
  ) as { r: string };
  const exists = (JSON.parse(matchR.r) as unknown[]).length > 0;
  if (exists) {
    db.prepare("SELECT cypher(?, ?)").get(
      `MATCH (n:${label} {id: $id}) SET n += $props RETURN 1`,
      JSON.stringify({ id, props })
    );
  } else {
    db.prepare("SELECT cypher(?, ?)").get(
      `CREATE (n:${label} {id: $id}) SET n += $props RETURN 1`,
      JSON.stringify({ id, props })
    );
  }
}

nodeUpsert2Q(dbV, "Person", "alice", { name: "Alice", age: 30 });
nodeUpsert2Q(dbV, "Person", "bob", { name: "Bob", age: 25 });
console.log("After 2 upserts:", (dbV.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN n.id AS id, n.name AS name") as { r: string }).r);
console.log("Count:", (dbV.prepare("SELECT cypher(?) AS r").get("MATCH (n) RETURN count(n) AS c") as { r: string }).r);

// Update alice via the 2-query upsert
nodeUpsert2Q(dbV, "Person", "alice", { name: "Alice", age: 31 });
console.log("After update alice:", (dbV.prepare("SELECT cypher(?) AS r").get("MATCH (n {id: 'alice'}) RETURN n.id AS id, n.age AS age") as { r: string }).r);

// === SET n += $props vs SET n.x = $x ===
console.log("\n---SET n += $props vs SET n.x = $x---");
const dbW = openDatabase(":memory:");
dbW.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");
dbW.prepare("SELECT cypher(?, ?)").get("CREATE (n:T {id: $id}) RETURN 1", '{"id":"a"}');
console.log("Step1:", (dbW.prepare("SELECT cypher(?) AS r").get("MATCH (n:T) RETURN n.id AS id, n.name AS name") as { r: string }).r);

// Try SET via individual fields
dbW.prepare("SELECT cypher(?, ?)").get("MATCH (n:T {id: $id}) SET n.name = $name, n.age = $age RETURN 1", '{"id":"a","name":"Alice","age":30}');
console.log("After SET fields:", (dbW.prepare("SELECT cypher(?) AS r").get("MATCH (n:T) RETURN n.id AS id, n.name AS name, n.age AS age") as { r: string }).r);

const dbX = openDatabase(":memory:");
dbX.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");
dbX.prepare("SELECT cypher(?, ?)").get("CREATE (n:T {id: $id}) RETURN 1", '{"id":"b"}');
// Try SET via += object
dbX.prepare("SELECT cypher(?, ?)").get("MATCH (n:T {id: $id}) SET n += $props RETURN 1", '{"id":"b","props":{"name":"Bob","age":25}}');
console.log("After SET += $props:", (dbX.prepare("SELECT cypher(?) AS r").get("MATCH (n:T) RETURN n.id AS id, n.name AS name, n.age AS age") as { r: string }).r);

// === CREATE then SET props in one query ===
console.log("\n---CREATE then SET in one query---");
const dbY = openDatabase(":memory:");
dbY.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");
dbY.prepare("SELECT cypher(?, ?)").get(
  "CREATE (n:T {id: $id}) SET n += $props RETURN 1",
  '{"id":"alice","props":{"name":"Alice","id":"alice","age":30}}'
);
console.log("Result:", (dbY.prepare("SELECT cypher(?) AS r").get("MATCH (n:T) RETURN n.id AS id, n.name AS name, n.age AS age") as { r: string }).r);

// Maybe the issue is with two writes in one cypher() call
console.log("\n---CREATE separate from SET---");
const dbZ = openDatabase(":memory:");
dbZ.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");
dbZ.prepare("SELECT cypher(?, ?)").get("CREATE (n:T {id: $id}) RETURN 1", '{"id":"alice"}');
dbZ.prepare("SELECT cypher(?, ?)").get(
  "MATCH (n:T {id: $id}) SET n += $props RETURN 1",
  '{"id":"alice","props":{"name":"Alice","age":30}}'
);
console.log("Result:", (dbZ.prepare("SELECT cypher(?) AS r").get("MATCH (n:T) RETURN n.id AS id, n.name AS name, n.age AS age") as { r: string }).r);

// === MATCH-then-MERGE pattern ===
console.log("\n---MATCH-then-MERGE---");
const db4 = openDatabase(":memory:");
db4.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");

// Setup
db4.prepare("SELECT cypher(?)").get("CREATE (:Person {id: 'alice', name: 'Alice'}), (:Person {id: 'bob', name: 'Bob'})");

// MATCH then MERGE
const eR = db4.prepare("SELECT cypher(?, ?) AS r").get(
  "MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[:KNOWS {since: $since}]->(b) RETURN 1",
  '{"from":"alice","to":"bob","since":2020}'
) as { r: string };
console.log("MATCH + MERGE rel:", eR.r);

const allRels4 = db4.prepare("SELECT cypher(?) AS r").get("MATCH (a)-[r]->(b) RETURN type(r) AS t, r.since AS s, a.name AS afrom, b.name AS bto") as { r: string };
console.log("All rels:", allRels4.r);

for (const [name, q, p] of tries) {
  try {
    const row = db.prepare("SELECT cypher(?, ?) AS r").get(q, p) as { r: string };
    console.log(name, "->", row.r.slice(0, 120));
  } catch (e) {
    console.log(name, "-> ERROR:", (e as Error).message.slice(0, 120));
  }
}
