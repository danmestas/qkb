/**
 * Graph CLI subcommand logic — RFC-0007 §4.6.2.
 *
 * Pure functions (Store → result object). The main `qkb graph ...`
 * dispatcher in `src/cli/qkb.ts` parses argv, calls these, prints the
 * result, and exits with the returned code.
 *
 * Subcommands:
 *   - graphStatus  — layer state + version + node/edge counts
 *   - graphQuery   — parameterized Cypher; refuses $-vars without --params
 *   - graphPageRank — top-N PageRank results
 *   - graphGc       — sweep orphan chunk:* nodes (dry-run or apply)
 */
import {
  cleanupOrphanedChunkNodes,
  isGraphLayerAvailable,
  getGraphLayerUnavailableReason,
  type Store,
} from "../internals/store-engine.js";
import {
  runCypher,
  runPageRank,
  findNeighbors,
  validateFindNeighborsArgs,
  type CypherQuery,
} from "./sdk.js";
import { dumpGraph, restoreGraph } from "./dump-restore.js";

export interface GraphCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DOLLAR_VAR_RE = /\$[A-Za-z_][A-Za-z0-9_]*/g;

export function graphStatus(store: Store): GraphCliResult {
  if (!isGraphLayerAvailable()) {
    const reason = getGraphLayerUnavailableReason() ?? "unknown";
    // Distinguish "disabled by config" (default) from "couldn't load".
    const explicitlyDisabled = /graph\.enabled=false/i.test(reason);
    const state = explicitlyDisabled ? "disabled" : "unavailable";
    const stdout = `graph layer: ${state} (${reason})\n`;
    return { stdout, stderr: "", exitCode: 0 };
  }

  const meta = store.db
    .prepare("SELECT graphqlite_version, initialized_at FROM graph_meta")
    .get() as
    | { graphqlite_version: string; initialized_at: string }
    | undefined;

  // Counts via Cypher
  const nodeCountRow = store.db
    .prepare("SELECT cypher(?) AS r")
    .get("MATCH (n) RETURN count(n) AS c") as { r: string };
  const edgeCountRow = store.db
    .prepare("SELECT cypher(?) AS r")
    .get("MATCH ()-[r]->() RETURN count(r) AS c") as { r: string };

  const nodes = (JSON.parse(nodeCountRow.r) as Array<{ c: number | string }>)[0]?.c ?? 0;
  const edges = (JSON.parse(edgeCountRow.r) as Array<{ c: number | string }>)[0]?.c ?? 0;

  const stdout =
    `graph layer: enabled\n` +
    `  version: ${meta?.graphqlite_version ?? "unknown"}\n` +
    `  initialized: ${meta?.initialized_at ?? "unknown"}\n` +
    `  nodes: ${nodes}\n` +
    `  edges: ${edges}\n`;

  return { stdout, stderr: "", exitCode: 0 };
}

export function graphQuery(
  store: Store,
  query: string,
  paramsJson: string | undefined
): GraphCliResult {
  // Guard: any $-prefixed identifier requires --params
  const dollarVars = query.match(DOLLAR_VAR_RE);
  if (dollarVars && dollarVars.length > 0 && paramsJson === undefined) {
    return {
      stdout: "",
      stderr:
        `graph query: --params is required for queries containing parameters ` +
        `(found: ${[...new Set(dollarVars)].join(", ")}).\n` +
        `Pass parameters as JSON: --params '{"id": "..."}'.\n`,
      exitCode: 1,
    };
  }

  let params: Record<string, unknown> = {};
  if (paramsJson !== undefined) {
    try {
      const parsed = JSON.parse(paramsJson) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
          stdout: "",
          stderr: `graph query: --params must be a JSON object.\n`,
          exitCode: 1,
        };
      }
      params = parsed as Record<string, unknown>;
    } catch (err) {
      return {
        stdout: "",
        stderr: `graph query: failed to parse --params as JSON: ${(err as Error).message}\n`,
        exitCode: 1,
      };
    }
  }

  if (!isGraphLayerAvailable()) {
    return {
      stdout: "",
      stderr: `graph query: layer is unavailable (${getGraphLayerUnavailableReason() ?? "unknown"}).\n`,
      exitCode: 1,
    };
  }

  try {
    const rows = runCypher(store.db, query as CypherQuery, params);
    return {
      stdout: JSON.stringify(rows, null, 2) + "\n",
      stderr: "",
      exitCode: 0,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: `graph query: ${(err as Error).message}\n`,
      exitCode: 1,
    };
  }
}

export interface GraphNeighborsCliOptions {
  hops: number;
  edgeTypes?: ReadonlyArray<string>;
  json?: boolean;
}

/**
 * CLI surface over `findNeighbors`. Pretty-prints the neighbor list as
 * a hop-shaped text table by default, or JSON when `--json` is passed.
 *
 * Hides the same v0.4.4 quirks `findNeighbors` does (hop=1 vs hop>1
 * return shape, type filter encoding) — CLI users don't need to know
 * the var-length-relationship gotchas to ask "what does X link to?".
 */
export function graphNeighbors(
  store: Store,
  nodeId: string,
  options: GraphNeighborsCliOptions
): GraphCliResult {
  // Validate before checking layer availability so users on systems
  // without GraphQLite still get a precise hops/types error instead
  // of "layer is unavailable".
  try {
    validateFindNeighborsArgs({
      nodeId,
      hops: options.hops,
      edgeTypes: options.edgeTypes,
    });
  } catch (err) {
    return {
      stdout: "",
      stderr: `graph neighbors: ${(err as Error).message}\n`,
      exitCode: 1,
    };
  }

  if (!isGraphLayerAvailable()) {
    return {
      stdout: "",
      stderr: `graph neighbors: layer is unavailable (${getGraphLayerUnavailableReason() ?? "unknown"}).\n`,
      exitCode: 1,
    };
  }

  let result;
  try {
    result = findNeighbors(store.db, {
      nodeId,
      hops: options.hops,
      edgeTypes: options.edgeTypes,
    });
  } catch (err) {
    return {
      stdout: "",
      stderr: `graph neighbors: ${(err as Error).message}\n`,
      exitCode: 1,
    };
  }

  if (options.json) {
    return {
      stdout: JSON.stringify(result.rows, null, 2) + "\n",
      stderr: "",
      exitCode: 0,
    };
  }

  const lines: string[] = [];
  lines.push(
    `Neighbors of ${nodeId} (hops=${options.hops}` +
      (options.edgeTypes && options.edgeTypes.length > 0
        ? `, types=${options.edgeTypes.join("|")}`
        : "") +
      `): ${result.rows.length}`
  );
  for (const r of result.rows) {
    lines.push(
      result.returnType === "id_and_type"
        ? `  ${r.id}  [${r.type ?? "?"}]`
        : `  ${r.id}`
    );
  }
  return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
}

export function graphPageRank(store: Store, top: number): GraphCliResult {
  if (!isGraphLayerAvailable()) {
    return {
      stdout: "",
      stderr: `graph pagerank: layer is unavailable (${getGraphLayerUnavailableReason() ?? "unknown"}).\n`,
      exitCode: 1,
    };
  }

  const ranks = runPageRank(store.db);
  const sorted = ranks.sort((a, b) => b.score - a.score).slice(0, top);

  const lines: string[] = [];
  lines.push(`PageRank — top ${sorted.length} (of ${ranks.length} ranked nodes)`);
  for (const row of sorted) {
    const id = row.user_id ?? row.node_id;
    lines.push(`  ${row.score.toFixed(6)}  ${id}`);
  }

  return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
}

export function graphGc(store: Store, dryRun: boolean): GraphCliResult {
  if (!isGraphLayerAvailable()) {
    return {
      stdout: "",
      stderr: `graph gc: layer is unavailable (${getGraphLayerUnavailableReason() ?? "unknown"}).\n`,
      exitCode: 1,
    };
  }

  if (dryRun) {
    // Count orphans without deleting. Re-implement the existence check
    // inline to avoid mutating state.
    const allChunksRow = store.db
      .prepare("SELECT cypher(?) AS r")
      .get("MATCH (c:Chunk) RETURN c.id AS id, c.hash AS hash") as { r: string };
    const chunks = JSON.parse(allChunksRow.r) as Array<{
      id: string;
      hash: string;
    }>;

    if (chunks.length === 0) {
      return { stdout: "graph gc (dry-run): 0 orphan chunk nodes.\n", stderr: "", exitCode: 0 };
    }

    const referencedHashes = [...new Set(chunks.map((c) => c.hash))];
    const placeholders = referencedHashes.map(() => "?").join(",");
    const aliveRows = store.db
      .prepare(`SELECT hash FROM content WHERE hash IN (${placeholders})`)
      .all(...referencedHashes) as Array<{ hash: string }>;
    const aliveHashes = new Set(aliveRows.map((r) => r.hash));
    const orphans = chunks.filter((c) => !aliveHashes.has(c.hash));

    const lines: string[] = [];
    lines.push(`graph gc (dry-run): ${orphans.length} orphan chunk node(s):`);
    for (const o of orphans) lines.push(`  ${o.id}`);
    return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
  }

  const removed = cleanupOrphanedChunkNodes(store.db);
  return {
    stdout: `graph gc: removed ${removed} orphan chunk node(s).\n`,
    stderr: "",
    exitCode: 0,
  };
}

export function graphDump(store: Store): GraphCliResult {
  if (!isGraphLayerAvailable()) {
    return {
      stdout: "",
      stderr: `graph dump: layer is unavailable (${getGraphLayerUnavailableReason() ?? "unknown"}).\n`,
      exitCode: 1,
    };
  }
  return { stdout: dumpGraph(store), stderr: "", exitCode: 0 };
}

export function graphRestore(store: Store, ndjson: string): GraphCliResult {
  if (!isGraphLayerAvailable()) {
    return {
      stdout: "",
      stderr: `graph restore: layer is unavailable (${getGraphLayerUnavailableReason() ?? "unknown"}). Set graph.enabled=true and ensure GraphQLite is installed.\n`,
      exitCode: 1,
    };
  }
  try {
    const counts = restoreGraph(store, ndjson);
    return {
      stdout: `graph restore: imported ${counts.nodes} node(s) and ${counts.edges} edge(s).\n`,
      stderr: "",
      exitCode: 0,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: `graph restore: ${(err as Error).message}\n`,
      exitCode: 1,
    };
  }
}

export interface GraphExtractOptions {
  collection?: string;
  limit?: number;
}

/**
 * Run LLM-based entity extraction over indexed documents and upsert
 * the resulting `entity:*` nodes and `doc:*-[:MENTIONS]->entity:*`
 * edges into the graph.
 *
 * Document-level extraction is cleaner than chunk-level here because:
 *   - QKB doesn't store chunk text separately (chunks are derived
 *     from `content.doc` at embed time)
 *   - "documents that mention X" is the more natural top-level query
 *
 * Per-chunk linkage stays as future work if a real use case emerges.
 */
export async function graphExtract(
  store: Store,
  llm: import("../internals/llm.js").LLM,
  options: GraphExtractOptions = {}
): Promise<GraphCliResult> {
  if (!isGraphLayerAvailable()) {
    return {
      stdout: "",
      stderr: `graph extract: layer is unavailable (${getGraphLayerUnavailableReason() ?? "unknown"}).\n`,
      exitCode: 1,
    };
  }

  // Read entity-extraction config (types + optional model override).
  const { resolveGraphConfig } = await import("./config.js");
  const { loadConfig } = await import("../internals/collections-yaml.js");
  const resolved = resolveGraphConfig(loadConfig());
  if (!resolved.entity_extraction.enabled) {
    return {
      stdout: "",
      stderr:
        `graph extract: graph.entity_extraction.enabled=false. ` +
        `Set it to true in ~/.config/qkb/index.yml first.\n`,
      exitCode: 1,
    };
  }

  const { extractEntities, entityNodeId } = await import("./entity-extraction.js");

  // Pull active docs (optionally filtered + limited).
  const params: unknown[] = [];
  let where = "d.active = 1";
  if (options.collection) {
    where += " AND d.collection = ?";
    params.push(options.collection);
  }
  let limitClause = "";
  if (options.limit && options.limit > 0) {
    limitClause = " LIMIT ?";
    params.push(options.limit);
  }
  const sql = `SELECT d.id AS docId, d.collection AS collection, d.path AS path, d.title AS title, d.hash AS hash, c.doc AS doc
               FROM documents d JOIN content c ON c.hash = d.hash
               WHERE ${where}
               ORDER BY d.id ASC${limitClause}`;
  const rows = store.db.prepare(sql).all(...params) as Array<{
    docId: number;
    collection: string;
    path: string;
    title: string;
    hash: string;
    doc: string;
  }>;

  if (rows.length === 0) {
    return {
      stdout: "graph extract: no documents to process.\n",
      stderr: "",
      exitCode: 0,
    };
  }

  let totalEntities = 0;
  let totalEdges = 0;
  let docsProcessed = 0;
  const types = resolved.entity_extraction.types;

  for (const row of rows) {
    const entities = await extractEntities(llm, row.doc, types, {
      model: resolved.entity_extraction.model,
    });
    if (entities.length === 0) continue;

    const docNodeId = `doc:${row.docId}`;
    const nodeBatch = [
      {
        id: docNodeId,
        label: "Doc",
        properties: {
          collection: row.collection,
          path: row.path,
          title: row.title,
        },
      },
      ...entities.map((e) => ({
        id: entityNodeId(e.type, e.name),
        label: e.type,
        properties: { name: e.name },
      })),
    ];
    const edgeBatch = entities.map((e) => ({
      from: docNodeId,
      to: entityNodeId(e.type, e.name),
      type: "MENTIONS",
    }));

    store.graph.upsertNodesBulk(nodeBatch);
    store.graph.upsertEdgesBulk(edgeBatch);

    totalEntities += entities.length;
    totalEdges += edgeBatch.length;
    docsProcessed++;
  }

  return {
    stdout:
      `graph extract: processed ${docsProcessed} docs, upserted ${totalEntities} entity nodes ` +
      `and ${totalEdges} MENTIONS edges (over ${rows.length} candidates).\n`,
    stderr: "",
    exitCode: 0,
  };
}

export interface GraphLinkOptions {
  collection?: string;
  /** Limit to N docs for testing/iteration. */
  limit?: number;
}

/**
 * Vault-aware structural graph extraction. Walks the document table,
 * parses each doc's frontmatter + body, extracts wikilinks / embeds /
 * markdown refs, resolves them against the indexed-doc set, and
 * upserts:
 *
 *   (:<Label> {id: 'doc:N', title, path})    — typed nodes per doc
 *   (:<Label>)-[:LINKS_TO]->(:<Label>)        — resolved wikilink
 *   (:<Label>)-[:LINKS_TO]->(:WikiTarget)     — unresolved wikilink
 *   (:<Label>)-[:EMBEDS]->(:<Label>)          — resolved ![[X]]
 *   (:<Label>)-[:REFERENCES]->(:<Label>)      — resolved ](rel.md)
 *
 * Label is the frontmatter `type:` (capitalized) when present, else
 * derived from the path (entities/Foo.md → Entity), else Note.
 *
 * No LLM. Fully deterministic. Designed for Obsidian-style vaults
 * (see flight-planner-kb's vault-ingest skill).
 */
export async function graphLink(
  store: Store,
  options: GraphLinkOptions = {}
): Promise<GraphCliResult> {
  if (!isGraphLayerAvailable()) {
    return {
      stdout: "",
      stderr: `graph link: layer is unavailable (${getGraphLayerUnavailableReason() ?? "unknown"}).\n`,
      exitCode: 1,
    };
  }

  const {
    extractLinks,
    parseFrontmatter,
    chooseLabel,
    buildResolver,
    resolveLinks,
  } = await import("./wikilink-extraction.js");

  // Pull all active docs (with bodies) from the index.
  const params: unknown[] = [];
  let where = "d.active = 1";
  if (options.collection) {
    where += " AND d.collection = ?";
    params.push(options.collection);
  }
  let limitClause = "";
  if (options.limit && options.limit > 0) {
    limitClause = " LIMIT ?";
    params.push(options.limit);
  }
  const sql = `SELECT d.id AS id, d.collection AS collection, d.path AS path, d.title AS title, c.doc AS doc
               FROM documents d JOIN content c ON c.hash = d.hash
               WHERE ${where}
               ORDER BY d.id ASC${limitClause}`;
  const rows = store.db.prepare(sql).all(...params) as Array<{
    id: number;
    collection: string;
    path: string;
    title: string;
    doc: string;
  }>;

  if (rows.length === 0) {
    return {
      stdout: "graph link: no documents to process.\n",
      stderr: "",
      exitCode: 0,
    };
  }

  // Build resolver across the whole indexed set so cross-doc wikilinks
  // resolve correctly. Doing this once rather than per-batch.
  const resolver = buildResolver(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      path: r.path,
      doc: r.doc,
    }))
  );

  // First pass: upsert all doc nodes with proper labels. Doing this
  // before any edges so resolved targets always have a node to point
  // at. Group by label so each `upsertNodesBulk` call is single-label.
  const nodesByLabel = new Map<string, Array<{ id: string; label: string; properties: Record<string, unknown> }>>();
  const wikiTargets = new Set<string>(); // unresolved targets get aggregated

  type Edge = { from: string; to: string; type: string; properties?: Record<string, unknown> };
  const edges: Edge[] = [];

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
        edges.push({ from: docNodeId, to: `doc:${r.docId}`, type: "LINKS_TO" });
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
      // Unresolved embeds (typically images, attachments) are skipped —
      // not all embeds are markdown-resolvable.
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

  // Upsert WikiTarget placeholders first (for unresolved wikilinks).
  if (wikiTargets.size > 0) {
    const wtNodes = [...wikiTargets].map((name) => ({
      id: `wikitarget:${name}`,
      label: "WikiTarget",
      properties: { name },
    }));
    store.graph.upsertNodesBulk(wtNodes);
  }

  // Upsert all real doc nodes, label by label.
  let totalNodes = wikiTargets.size;
  for (const [, nodes] of nodesByLabel) {
    store.graph.upsertNodesBulk(nodes);
    totalNodes += nodes.length;
  }

  // Upsert all edges. Bulk insertion goes inside a single tx already
  // (per upsertEdgesBulk semantics).
  store.graph.upsertEdgesBulk(edges);

  return {
    stdout:
      `graph link: processed ${rows.length} docs. ` +
      `Upserted ${totalNodes} nodes (${nodesByLabel.size} distinct labels) and ${edges.length} edges. ` +
      `Unresolved wikilinks: ${wikiTargets.size}.\n`,
    stderr: "",
    exitCode: 0,
  };
}
