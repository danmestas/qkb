/**
 * Fast-path bulk graph writer — direct SQL against GraphQLite's
 * underlying tables, bypassing the per-statement Cypher executor.
 *
 * WHY THIS EXISTS
 * ---------------
 * `runUpsertEdgesBulk` builds each edge via a Cypher
 * `MATCH (a {id:$f}), (b {id:$t}) MERGE (a)-[:T]->(b)`. GraphQLite
 * resolves `{id: $x}` by scanning `node_props_text` (the `id` property
 * is text and — unlike `node_props_int` — has no `(key_id, value)`
 * index). So every endpoint match is O(nodes), making the whole edge
 * pass O(nodes × edges). On a densely-linked vault (≈11.5k nodes /
 * ≈97k edges) that is hours; empirically it never completed.
 *
 * GraphQLite stores its graph in plain SQLite tables (verified via the
 * `gqlite` CLI `.schema`):
 *   nodes(id INTEGER PK)
 *   node_labels(node_id, label)
 *   property_keys(id, key UNIQUE)
 *   node_props_text(node_id, key_id, value)
 *   edges(id, source_id, target_id, type)
 * Writing these directly — building the `id → node PK` map once in
 * memory, then batch-inserting nodes/labels/props/edges — turns the
 * whole pass into O(nodes + edges). Measured: 11.5k nodes + 96k edges
 * in ~0.3s vs. hours. Cypher reads the result back identically.
 *
 * Semantics preserved vs. the Cypher path:
 *   - Node identity is the `id` property string ("doc:N" / "wikitarget:X").
 *   - Re-running is idempotent: existing ids are skipped (not duplicated),
 *     and existing (source,target,type) edges are not re-created.
 *   - Each node carries exactly one label + its string properties
 *     (collection/path/title/name) — matching what index-pass.ts emits.
 *
 * Scope note: index-pass.ts only ever writes TEXT properties on nodes
 * and label-only edges (no edge props), so this writer handles that
 * shape. If a caller needs non-text props or edge props it must use the
 * Cypher path.
 */
import type { Database } from "../internals/db.js";
import type { UpsertNodeArgs, UpsertEdgeArgs } from "./sdk.js";

/**
 * Ensure the index that makes Cypher `{id: ...}` / text-property lookups
 * fast at QUERY time too (GraphQLite ships one for int props but not
 * text). Idempotent. Cheap insurance even outside the bulk path.
 */
export function ensureTextPropIndex(db: Database): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_node_props_text_key_value
       ON node_props_text(key_id, value, node_id)`
  );
}

interface FastWriteResult {
  nodesInserted: number;
  edgesInserted: number;
}

/**
 * Bulk-write nodes + edges via direct SQL. Returns counts of rows newly
 * inserted (existing nodes/edges are left untouched — idempotent).
 *
 * @param db     GraphQLite-loaded database (its node/edge tables must
 *               already exist; they are created lazily on first Cypher
 *               write, so callers should have run at least the schema
 *               bootstrap — index-pass always upserts ≥1 node first).
 * @param nodes  Flat node list (id, label, text properties).
 * @param edges  Flat edge list (from-id, to-id, type). Edge props ignored.
 */
export function fastBulkWrite(
  db: Database,
  nodes: ReadonlyArray<UpsertNodeArgs>,
  edges: ReadonlyArray<UpsertEdgeArgs>
): FastWriteResult {
  ensureTextPropIndex(db);

  const result: FastWriteResult = { nodesInserted: 0, edgesInserted: 0 };

  const tx = db.transaction(() => {
    // 1. Load the existing id → node PK map once.
    const idToPk = new Map<string, number>();
    const existing = db
      .prepare(
        `SELECT t.node_id AS pk, t.value AS id
           FROM node_props_text t
           JOIN property_keys k ON k.id = t.key_id
          WHERE k.key = 'id'`
      )
      .all() as Array<{ pk: number; id: string }>;
    for (const row of existing) idToPk.set(row.id, row.pk);

    // 2. Resolve (or create) the 'id' property key.
    db.prepare(`INSERT OR IGNORE INTO property_keys(key) VALUES('id')`).run();
    const idKeyId = (
      db.prepare(`SELECT id FROM property_keys WHERE key='id'`).get() as {
        id: number;
      }
    ).id;

    // Cache for arbitrary property keys (collection/path/title/name/...).
    const keyIdCache = new Map<string, number>([["id", idKeyId]]);
    const getKeyId = (key: string): number => {
      const hit = keyIdCache.get(key);
      if (hit !== undefined) return hit;
      db.prepare(`INSERT OR IGNORE INTO property_keys(key) VALUES(?)`).run(key);
      const id = (
        db.prepare(`SELECT id FROM property_keys WHERE key=?`).get(key) as {
          id: number;
        }
      ).id;
      keyIdCache.set(key, id);
      return id;
    };

    const insNode = db.prepare(`INSERT INTO nodes DEFAULT VALUES`);
    const insLabel = db.prepare(
      `INSERT OR IGNORE INTO node_labels(node_id, label) VALUES(?, ?)`
    );
    const insTextProp = db.prepare(
      `INSERT OR IGNORE INTO node_props_text(node_id, key_id, value) VALUES(?, ?, ?)`
    );

    // 3. Insert new nodes (skip ids that already exist), recording PKs.
    for (const n of nodes) {
      if (idToPk.has(n.id)) continue;
      const pk = Number(insNode.run().lastInsertRowid);
      idToPk.set(n.id, pk);
      insLabel.run(pk, n.label);
      insTextProp.run(pk, idKeyId, n.id);
      if (n.properties) {
        for (const [key, value] of Object.entries(n.properties)) {
          if (value === undefined || value === null) continue;
          // index-pass only emits string props; stringify defensively.
          insTextProp.run(pk, getKeyId(key), String(value));
        }
      }
      result.nodesInserted++;
    }

    // 4. Insert edges by PK. Dedup against existing (source,target,type).
    const edgeExists = db.prepare(
      `SELECT 1 FROM edges WHERE source_id=? AND target_id=? AND type=? LIMIT 1`
    );
    const insEdge = db.prepare(
      `INSERT INTO edges(source_id, target_id, type) VALUES(?, ?, ?)`
    );
    for (const e of edges) {
      const from = idToPk.get(e.from);
      const to = idToPk.get(e.to);
      if (from === undefined || to === undefined) continue; // endpoint missing
      if (edgeExists.get(from, to, e.type)) continue;
      insEdge.run(from, to, e.type);
      result.edgesInserted++;
    }
  });
  tx();

  return result;
}
