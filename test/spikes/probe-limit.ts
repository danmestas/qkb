import { openDatabase } from '/Users/dmestas/projects/qkb/dist/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'probe-'));
try {
  const db = openDatabase(join(tmp, 'probe.sqlite'));
  db.loadExtension('/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib');
  const stmt = db.prepare("SELECT cypher(?, ?) AS r");

  // CREATE batch limit
  for (const n of [50, 100, 200, 500]) {
    const params = {};
    const parts = [];
    for (let i = 0; i < n; i++) {
      params[`id${i}`] = `nc${n}_${i}`;
      parts.push(`(m${i}:CTest {id: $id${i}})`);
    }
    try {
      stmt.get(`CREATE ${parts.join(', ')}`, JSON.stringify(params));
      console.log(`CREATE ${n}: OK`);
    } catch (e) {
      console.log(`CREATE ${n}: FAIL — ${e.message.slice(0, 80)}`);
    }
  }

  // Setup nodes for MATCH probes
  const setupParams = {};
  const setupParts = [];
  for (let i = 0; i < 200; i++) {
    setupParams[`id${i}`] = `e${i}`;
    setupParts.push(`(m${i}:Edge {id: $id${i}})`);
  }
  // Workaround: split into 2 calls of 100 each since CREATE 200 might fail
  {
    const p = {};
    const parts = [];
    for (let i = 0; i < 100; i++) { p[`id${i}`] = `e${i}`; parts.push(`(m${i}:Edge {id: $id${i}})`); }
    stmt.get(`CREATE ${parts.join(', ')}`, JSON.stringify(p));
  }
  {
    const p = {};
    const parts = [];
    for (let i = 0; i < 100; i++) { p[`id${i}`] = `e${100 + i}`; parts.push(`(m${i}:Edge {id: $id${i}})`); }
    stmt.get(`CREATE ${parts.join(', ')}`, JSON.stringify(p));
  }

  // MATCH+SET limit
  for (const n of [10, 30, 50, 60, 63]) {
    const params = {};
    const matchParts = [], setParts = [];
    for (let i = 0; i < n; i++) {
      params[`id${i}`] = `e${i}`;
      params[`p${i}`] = { phase: `phase-${n}` };
      matchParts.push(`(n${i}:Edge {id: $id${i}})`);
      setParts.push(`n${i} += $p${i}`);
    }
    try {
      stmt.get(`MATCH ${matchParts.join(', ')} SET ${setParts.join(', ')}`, JSON.stringify(params));
      console.log(`MATCH+SET ${n}: OK`);
    } catch (e) {
      console.log(`MATCH+SET ${n}: FAIL — ${e.message.slice(0, 80)}`);
    }
  }

  // Edge batch limit (MATCH 2 endpoints + MERGE)
  for (const n of [10, 20, 30, 31, 32]) {
    const params = {};
    const matchParts = [], mergeParts = [];
    for (let i = 0; i < n; i++) {
      params[`f${i}`] = `e${i}`;
      params[`t${i}`] = `e${i + 1}`;
      matchParts.push(`(a${i} {id: $f${i}})`, `(b${i} {id: $t${i}})`);
      mergeParts.push(`(a${i})-[:T${n}]->(b${i})`);
    }
    try {
      stmt.get(`MATCH ${matchParts.join(', ')} MERGE ${mergeParts.join(', ')}`, JSON.stringify(params));
      console.log(`Edge batch ${n}: OK`);
    } catch (e) {
      console.log(`Edge batch ${n}: FAIL — ${e.message.slice(0, 80)}`);
    }
  }
  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
