import { openDatabase } from "/Users/dmestas/projects/qkb/src/db.js";

const db = openDatabase(":memory:");
db.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");

db.prepare("SELECT cypher(?)").get("CREATE (:P {id: 'a'}), (:P {id: 'b'}), (:P {id: 'c'})");
db.prepare("SELECT cypher(?, ?)").get(
  "MATCH (a {id: $f}), (b {id: $t}) MERGE (a)-[:KNOWS]->(b)",
  JSON.stringify({ f: "a", t: "b" })
);
db.prepare("SELECT cypher(?, ?)").get(
  "MATCH (a {id: $f}), (b {id: $t}) MERGE (a)-[:FOLLOWS]->(b)",
  JSON.stringify({ f: "a", t: "c" })
);

const all = db.prepare("SELECT cypher(?) AS r").get(
  "MATCH (a)-[r]->(b) RETURN a.id AS af, type(r) AS t, b.id AS bt"
) as { r: string };
console.log("ALL EDGES:", all.r);

const tries: Array<readonly [string, string, string]> = [
  ["Q1 unbounded var-length", "MATCH (a {id: $id})-[r*1..1]->(b) RETURN DISTINCT b.id AS id, type(r) AS type", '{"id":"a"}'],
  ["Q2 single hop", "MATCH (a {id: $id})-[r]->(b) RETURN DISTINCT b.id AS id, type(r) AS type", '{"id":"a"}'],
  ["Q3 type filter alt", "MATCH (a {id: $id})-[r:KNOWS|FOLLOWS]->(b) RETURN DISTINCT b.id AS id, type(r) AS type", '{"id":"a"}'],
  ["Q4 path with var-length 1..2", "MATCH (a {id: $id})-[*1..2]->(b) RETURN DISTINCT b.id AS id", '{"id":"a"}'],
  ["Q5 path explicit type 1..2", "MATCH (a {id: $id})-[:KNOWS*1..2]->(b) RETURN DISTINCT b.id AS id", '{"id":"a"}'],
];

for (const [name, q, p] of tries) {
  try {
    const r = db.prepare("SELECT cypher(?, ?) AS r").get(q, p) as { r: string };
    console.log(name, "->", r.r);
  } catch (e) {
    console.log(name, "-> ERROR:", (e as Error).message);
  }
}
