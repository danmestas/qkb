import { openDatabase } from "/Users/dmestas/projects/qkb/src/internals/db.js";
const db = openDatabase(":memory:");
db.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");

// Setup
db.prepare("SELECT cypher(?)").get("CREATE (c:Chunk {hash: 'h1', seq: 0})");
db.prepare("SELECT cypher(?)").get("CREATE (t:Topic {name: 'graphs'})");
db.prepare("SELECT cypher(?, ?)").get(
  "MATCH (c:Chunk), (t:Topic) MERGE (c)-[:MENTIONS]->(t) RETURN 1",
  '{}'
);

const tries: Array<readonly [string, string, string]> = [
  ["T1: simple anonymous node + inline prop", "MATCH (c:Chunk)-[:MENTIONS]->(:Topic) RETURN c.hash AS hash", '{}'],
  ["T2: anonymous node with inline literal", "MATCH (c:Chunk)-[:MENTIONS]->(:Topic {name: 'graphs'}) RETURN c.hash AS hash", '{}'],
  ["T3: anonymous node with inline $param", "MATCH (c:Chunk)-[:MENTIONS]->(:Topic {name: $topic}) RETURN c.hash AS hash", '{"topic":"graphs"}'],
  ["T4: MATCH with hash property access", "MATCH (c:Chunk) RETURN c.hash AS hash, c.seq AS seq", '{}'],
];

for (const [name, q, p] of tries) {
  try {
    const r = db.prepare("SELECT cypher(?, ?) AS r").get(q, p) as { r: string };
    console.log(name, "->", r.r);
  } catch (e) {
    console.log(name, "-> ERR:", (e as Error).message.slice(0, 120));
  }
}
