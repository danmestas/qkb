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
