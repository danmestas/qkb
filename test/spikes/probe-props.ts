import { openDatabase } from "/Users/dmestas/projects/qkb/src/internals/db.js";
const db = openDatabase(":memory:");
db.loadExtension("/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib");
db.prepare("SELECT cypher(?)").get("CREATE (:Person {id: 'alice', name: 'Alice', age: 30})");
const tries = [
  "MATCH (n) RETURN n.id AS id, labels(n)[0] AS label, properties(n) AS props",
  "MATCH (n) RETURN n.id AS id, n.name AS name",
  "MATCH (n) RETURN labels(n) AS labels",
  "MATCH (n) RETURN n",
];
for (const q of tries) {
  try {
    const r = db.prepare("SELECT cypher(?) AS r").get(q) as { r: string };
    console.log(q, "->", r.r);
  } catch (e) {
    console.log(q, "-> ERR:", (e as Error).message);
  }
}
