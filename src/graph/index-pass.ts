/**
 * Graph indexing pass — RFC-0009 §"Indexing path".
 *
 * One logical step from the orchestrator's perspective. Internally it
 * (a) iterates all active docs in scope, (b) extracts wikilinks /
 * embeds / markdown refs and resolves them against the document set,
 * (c) upserts doc nodes + edges into the GraphQLite layer, and
 * (d) prunes orphaned graph rows for files no longer in `documents`.
 *
 * All four substeps are idempotent — re-running is cheap and
 * self-healing. The orchestrator doesn't need to know about the
 * substeps; this module owns its own lifecycle.
 *
 * Schema reality check (deviates from PLAN.md): the graph layer is
 * GraphQLite-backed (Cypher `(:Note)-[:LINKS_TO]->(:Note)` patterns),
 * not a relational `graph_edges` table. qmd's doc table is
 * `documents` (joined with `content` by hash), not `docs.body`. This
 * pass uses Cypher writes via the existing graph SDK helpers
 * (`runUpsertNodesBulk`, `runUpsertEdgesBulk`) and Cypher deletes for
 * orphan GC.
 */
import type { Database } from "../db.js";
import {
  extractLinks,
  parseFrontmatter,
  chooseLabel,
  buildResolver,
  resolveLinks,
} from "./wikilink-extraction.js";
import {
  runUpsertNodesBulk,
  runUpsertEdgesBulk,
  type UpsertNodeArgs,
  type UpsertEdgeArgs,
} from "./sdk.js";

export interface GraphPassResult {
  /** Total edges upserted (resolved wikilinks + embeds + md-refs). */
  edgesUpserted: number;
  /** Doc nodes (`:Note`/`:Entity`/...) pruned by orphan GC. */
  nodesPruned: number;
  /** WikiTarget placeholder nodes pruned (no longer referenced by any active doc). */
  wikiTargetsPruned: number;
}

/**
 * Run the graph indexing pass against `db` (which must have GraphQLite
 * loaded). Reads from qmd's `documents` + `content` tables, writes
 * Cypher nodes/edges, prunes orphans.
 *
 * @param scope - Optional collection-name allowlist. When omitted,
 *   processes all collections.
 */
export function runGraphPass(
  db: Database,
  scope?: ReadonlyArray<string>
): GraphPassResult {
  // 1. Pull active docs (with body) joined to content.
  const params: unknown[] = [];
  let where = "d.active = 1";
  if (scope && scope.length > 0) {
    const placeholders = scope.map(() => "?").join(",");
    where += ` AND d.collection IN (${placeholders})`;
    for (const c of scope) params.push(c);
  }
  const sql =
    `SELECT d.id AS id, d.collection AS collection, d.path AS path, d.title AS title, c.doc AS doc
       FROM documents d JOIN content c ON c.hash = d.hash
       WHERE ${where}
       ORDER BY d.id ASC`;
  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    collection: string;
    path: string;
    title: string;
    doc: string;
  }>;

  // 2. Build resolver across the indexed set so cross-doc wikilinks
  //    resolve correctly. Doing this once rather than per-batch.
  const resolver = buildResolver(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      path: r.path,
      doc: r.doc,
    }))
  );

  // 3. Walk docs, building node + edge batches.
  const nodesByLabel = new Map<string, UpsertNodeArgs[]>();
  const wikiTargets = new Set<string>();
  const edges: UpsertEdgeArgs[] = [];

  for (const row of rows) {
    const fm = parseFrontmatter(row.doc);
    const label = chooseLabel(fm, row.path);
    const docNodeId = `doc:${row.id}`;
    const list = nodesByLabel.get(label) ?? [];
    list.push({
      id: docNodeId,
      label,
      properties: {
        collection: row.collection,
        path: row.path,
        title: row.title,
      },
    });
    nodesByLabel.set(label, list);

    const links = extractLinks(row.doc);

    const resolvedWiki = resolveLinks(links.wikilinks, resolver);
    for (const r of resolvedWiki) {
      if (r.docId !== null) {
        edges.push({
          from: docNodeId,
          to: `doc:${r.docId}`,
          type: "LINKS_TO",
        });
      } else {
        wikiTargets.add(r.target);
        edges.push({
          from: docNodeId,
          to: `wikitarget:${r.target}`,
          type: "LINKS_TO",
        });
      }
    }

    const resolvedEmbeds = resolveLinks(links.embeds, resolver);
    for (const r of resolvedEmbeds) {
      if (r.docId !== null) {
        edges.push({ from: docNodeId, to: `doc:${r.docId}`, type: "EMBEDS" });
      }
      // Unresolved embeds (typically images, attachments) are skipped.
    }

    const resolvedMd = resolveLinks(links.mdLinks, resolver);
    for (const r of resolvedMd) {
      if (r.docId !== null) {
        edges.push({
          from: docNodeId,
          to: `doc:${r.docId}`,
          type: "REFERENCES",
        });
      }
    }
  }

  // 4. Upsert WikiTarget placeholders first (so resolved targets always
  //    have a node to point at by the time edges land).
  if (wikiTargets.size > 0) {
    const wtNodes: UpsertNodeArgs[] = [...wikiTargets].map((name) => ({
      id: `wikitarget:${name}`,
      label: "WikiTarget",
      properties: { name },
    }));
    runUpsertNodesBulk(db, wtNodes);
  }

  // 5. Upsert all real doc nodes, label by label.
  for (const [, nodes] of nodesByLabel) {
    runUpsertNodesBulk(db, nodes);
  }

  // 6. Upsert all edges in batches.
  runUpsertEdgesBulk(db, edges);

  // 7+8. Orphan GC. Hidden inside `runGraphPass()` so callers don't
  //       coordinate it. Also exposed standalone via `pruneGraphOrphans`
  //       for cheap post-`removeCollection` cleanup that doesn't need a
  //       full filesystem walk.
  const { nodesPruned, wikiTargetsPruned } = pruneGraphOrphans(db);

  return {
    edgesUpserted: edges.length,
    nodesPruned,
    wikiTargetsPruned,
  };
}

/**
 * Prune orphaned doc nodes and WikiTarget placeholders from the graph
 * layer. Standalone-callable so commands like `qkb collection remove`
 * can clean up cheaply after qmd hard-deletes rows from `documents`,
 * without paying for a full `runGraphPass()` (which re-walks every
 * active doc, parses frontmatter, and re-extracts links).
 *
 * (a) Doc nodes: any `(:* {id: 'doc:N'})` whose backing `documents.id`
 *     is no longer present + active gets `DETACH DELETE`d (incident
 *     edges drop with it).
 * (b) WikiTarget placeholders: any `(:WikiTarget)` with no inbound
 *     `:LINKS_TO` edge is orphaned and pruned.
 *
 * Idempotent — re-running is a cheap no-op when the graph is already
 * clean.
 */
export function pruneGraphOrphans(
  db: Database
): { nodesPruned: number; wikiTargetsPruned: number } {
  // (a) Doc nodes: ask Cypher for all `doc:*` nodes, then check each
  //     id against the `documents` table. Anything orphaned gets
  //     DETACH DELETEd (also drops incident edges).
  const docNodesRow = db
    .prepare("SELECT cypher(?, ?) AS r")
    .get(
      "MATCH (n) WHERE n.id STARTS WITH 'doc:' RETURN n.id AS id",
      JSON.stringify({})
    ) as { r: string };
  let docNodes: Array<{ id: string }> = [];
  try {
    const parsed = JSON.parse(docNodesRow.r);
    if (Array.isArray(parsed)) docNodes = parsed as Array<{ id: string }>;
  } catch {
    // Status string or non-JSON — nothing to prune.
  }

  let nodesPruned = 0;
  if (docNodes.length > 0) {
    const docIds = docNodes
      .map((n) => Number(n.id.slice("doc:".length)))
      .filter((n) => Number.isFinite(n));
    if (docIds.length > 0) {
      const placeholders = docIds.map(() => "?").join(",");
      const aliveRows = db
        .prepare(
          `SELECT id FROM documents WHERE active = 1 AND id IN (${placeholders})`
        )
        .all(...docIds) as Array<{ id: number }>;
      const aliveIds = new Set(aliveRows.map((r) => r.id));

      for (const node of docNodes) {
        const numericId = Number(node.id.slice("doc:".length));
        if (!Number.isFinite(numericId)) continue;
        if (aliveIds.has(numericId)) continue;
        db.prepare("SELECT cypher(?, ?)").get(
          "MATCH (n {id: $id}) DETACH DELETE n",
          JSON.stringify({ id: node.id })
        );
        nodesPruned++;
      }
    }
  }

  // (b) WikiTarget placeholders: a WikiTarget with no inbound
  //     `:LINKS_TO` edge is orphaned.
  const orphanWikiRow = db
    .prepare("SELECT cypher(?, ?) AS r")
    .get(
      "MATCH (w:WikiTarget) WHERE NOT (()-[:LINKS_TO]->(w)) RETURN w.id AS id",
      JSON.stringify({})
    ) as { r: string };
  let orphanWikiTargets: Array<{ id: string }> = [];
  try {
    const parsed = JSON.parse(orphanWikiRow.r);
    if (Array.isArray(parsed)) orphanWikiTargets = parsed as Array<{ id: string }>;
  } catch {
    // ignore
  }
  let wikiTargetsPruned = 0;
  for (const node of orphanWikiTargets) {
    db.prepare("SELECT cypher(?, ?)").get(
      "MATCH (n {id: $id}) DETACH DELETE n",
      JSON.stringify({ id: node.id })
    );
    wikiTargetsPruned++;
  }

  return { nodesPruned, wikiTargetsPruned };
}
