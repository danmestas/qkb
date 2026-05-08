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
} from "../store.js";
import { runCypher, runPageRank, type CypherQuery } from "./sdk.js";
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
  llm: import("../llm.js").LLM,
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
  const { loadConfig } = await import("../collections.js");
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
