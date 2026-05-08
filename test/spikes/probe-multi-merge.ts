import { openDatabase } from '/Users/dmestas/projects/qkb/dist/db.js';
const db = openDatabase(':memory:');
db.loadExtension('/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib');
const stmt = db.prepare("SELECT cypher(?, ?) AS r");

// Create 10 nodes (use comma-sep CREATE which works)
{
  const params = {};
  const parts = [];
  for (let i = 0; i < 10; i++) {
    params[`id${i}`] = `n${i}`;
    parts.push(`(m${i}:Note {id: $id${i}})`);
  }
  stmt.get(`CREATE ${parts.join(', ')}`, JSON.stringify(params));
}
console.log('10 nodes created');

// Try 1: Chained MATCH+MERGE space-separated (the "fast" pattern from earlier probes)
{
  const params = {};
  let q = '';
  for (let i = 0; i < 5; i++) {
    params[`f${i}`] = `n${i}`;
    params[`t${i}`] = `n${i+1}`;
    q += `MATCH (a${i} {id: $f${i}}), (b${i} {id: $t${i}}) MERGE (a${i})-[:LINKS]->(b${i}) `;
  }
  stmt.get(q, JSON.stringify(params));
  const c = JSON.parse(stmt.get(`MATCH ()-[r:LINKS]->() RETURN r`, '{}').r);
  console.log(`Chained-MATCH-MERGE 5: actual edges =`, c.length);
}

// Try 2: Single MATCH for ALL nodes + chained MERGEs
{
  const params = {};
  let matchPattern = [];
  let mergePattern = [];
  for (let i = 0; i < 5; i++) {
    params[`f${i}`] = `n${i}`;
    params[`t${i}`] = `n${i+1}`;
    matchPattern.push(`(a${i} {id: $f${i}})`, `(b${i} {id: $t${i}})`);
    mergePattern.push(`MERGE (a${i})-[:LINKS2]->(b${i})`);
  }
  const q = `MATCH ${matchPattern.join(', ')} ${mergePattern.join(' ')}`;
  try {
    stmt.get(q, JSON.stringify(params));
    const c = JSON.parse(stmt.get(`MATCH ()-[r:LINKS2]->() RETURN r`, '{}').r);
    console.log(`Single-MATCH all + chained-MERGEs 5: actual edges =`, c.length);
  } catch (e) { console.log('FAIL:', e.message.slice(0, 150)); }
}

// Try 3: Comma-separated MERGE patterns
{
  const params = {};
  let mergeParts = [];
  for (let i = 0; i < 5; i++) {
    params[`f${i}`] = `n${i}`;
    params[`t${i}`] = `n${i+1}`;
    mergeParts.push(`(a${i} {id: $f${i}})-[:LINKS3]->(b${i} {id: $t${i}})`);
  }
  const q = `MERGE ${mergeParts.join(', ')}`;
  try {
    stmt.get(q, JSON.stringify(params));
    const c = JSON.parse(stmt.get(`MATCH ()-[r:LINKS3]->() RETURN r`, '{}').r);
    console.log(`Comma-MERGE 5: actual edges =`, c.length);
  } catch (e) { console.log('Comma-MERGE FAIL:', e.message.slice(0, 150)); }
}

// Try 4: MATCH + comma-separated MERGE patterns
{
  const params = {};
  let matchParts = [], mergeParts = [];
  for (let i = 0; i < 5; i++) {
    params[`f${i}`] = `n${i}`;
    params[`t${i}`] = `n${i+1}`;
    matchParts.push(`(a${i} {id: $f${i}})`, `(b${i} {id: $t${i}})`);
    mergeParts.push(`(a${i})-[:LINKS4]->(b${i})`);
  }
  const q = `MATCH ${matchParts.join(', ')} MERGE ${mergeParts.join(', ')}`;
  try {
    stmt.get(q, JSON.stringify(params));
    const c = JSON.parse(stmt.get(`MATCH ()-[r:LINKS4]->() RETURN r`, '{}').r);
    console.log(`MATCH + comma-MERGE 5: actual edges =`, c.length);
  } catch (e) { console.log('MATCH+comma-MERGE FAIL:', e.message.slice(0, 150)); }
}
