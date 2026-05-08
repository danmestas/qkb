/**
 * Hybrid query strategies — RFC-0007 §5 (Phase 2B).
 *
 * Two strategies, both implemented in QKB code (not in GraphQLite):
 *
 *   1. filterThenRank: a Cypher query produces a candidate (hash, seq)
 *      set; the existing FTS/vector path scores those candidates.
 *      Cheap path; recommended.
 *
 *   2. rankThenRerank: existing hybrid search produces a top-K; a
 *      Cypher neighbor expansion adds related candidates; RRF combines.
 *      More expensive; gated by explicit opt-in.
 *
 * These functions are intentionally additive — they don't modify the
 * existing `store.search()` defaults. Callers explicitly invoke
 * `store.graph.filterThenRank(...)` or `store.graph.rankThenRerank(...)`
 * when they want the graph integration.
 */
import { runCypher, type CypherQuery } from "./sdk.js";
import type { Store } from "../store.js";

export interface FilterThenRankArgs {
  /** Cypher query that returns rows with `hash` and `seq` columns. */
  cypher: CypherQuery;
  /** Bound parameters for the Cypher query. */
  params?: Record<string, unknown>;
  /** Maximum candidate count after the graph filter (default 200). */
  candidateLimit?: number;
}

export interface FilterThenRankResult {
  /** Composite (hash, seq) candidates the graph layer surfaced. */
  candidates: Array<{ hash: string; seq: number }>;
  /** Source query for traceability. */
  cypher: string;
}

/**
 * Run the graph filter step. Returns the (hash, seq) candidate set.
 * The caller passes this set to the existing FTS/vector scoring path
 * (caller-side, since QKB's BM25/vector pipeline takes a `WHERE` filter
 * over content_vectors via prepared SQL — no need to bind it here).
 */
export function runFilterThenRank(
  store: Store,
  args: FilterThenRankArgs
): FilterThenRankResult {
  const limit = Math.max(1, Math.min(args.candidateLimit ?? 200, 10_000));

  const rows = runCypher<{ hash: string; seq: number | string }>(
    store.db,
    args.cypher,
    args.params ?? {}
  );

  const candidates = rows
    .filter((r) => typeof r.hash === "string" && r.hash.length > 0)
    .slice(0, limit)
    .map((r) => ({
      hash: r.hash,
      seq: typeof r.seq === "number" ? r.seq : Number(r.seq) || 0,
    }));

  return { candidates, cypher: String(args.cypher) };
}

export interface RankThenRerankArgs {
  /** Initial top-K (hash, seq) candidates from the existing hybrid search. */
  seeds: ReadonlyArray<{ hash: string; seq: number; score: number }>;
  /** Number of graph hops to expand (1-3). */
  hops?: number;
  /** Edge type whitelist for the expansion. */
  edgeTypes?: string[];
  /** RRF k constant (default 60 per the original RRF paper). */
  rrfK?: number;
}

export interface RankThenRerankResult {
  /** Final ranked list of (hash, seq) tuples after RRF. */
  ranked: Array<{ hash: string; seq: number; score: number }>;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reciprocal Rank Fusion. Two ranked lists, output one combined ranked
 * list. Standard formula: sum over lists of 1 / (k + rank_i).
 * `rrfK` defaults to 60.
 */
function rrf(
  listA: ReadonlyArray<{ key: string; rank: number }>,
  listB: ReadonlyArray<{ key: string; rank: number }>,
  k: number
): Array<{ key: string; score: number }> {
  const scores = new Map<string, number>();
  for (const { key, rank } of listA) {
    scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank));
  }
  for (const { key, rank } of listB) {
    scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank));
  }
  return Array.from(scores.entries())
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Run the rank-then-rerank step. Takes an initial seed list (from the
 * existing search), expands each seed N hops via the graph layer to
 * gather neighbors, then RRF-combines:
 *   - List A: original seed ranks
 *   - List B: ranks from the graph-expanded set (by frequency of arrival)
 *
 * Returns the merged ranked list. Caller decides how to surface it.
 */
export function runRankThenRerank(
  store: Store,
  args: RankThenRerankArgs
): RankThenRerankResult {
  const hops = Math.max(1, Math.min(args.hops ?? 1, 3));
  const k = args.rrfK ?? 60;

  if (args.edgeTypes !== undefined) {
    for (const t of args.edgeTypes) {
      if (!IDENT_RE.test(t)) {
        throw new TypeError(
          `runRankThenRerank: invalid edge type ${JSON.stringify(t)}.`
        );
      }
    }
  }

  // List A: original seeds, ranked by their position.
  const listA = args.seeds.map((s, idx) => ({
    key: `${s.hash}:${s.seq}`,
    rank: idx + 1,
  }));

  // List B: graph-expanded neighbors, ranked by accumulated arrivals.
  // For each seed, run a 1..hops traversal from its chunk node and
  // collect the chunk neighbors that come back. Score by how often a
  // given (hash, seq) shows up in the union of expansions.
  const arrivalCounts = new Map<string, number>();
  for (const seed of args.seeds) {
    const seedNodeId = `chunk:${seed.hash}:${seed.seq}`;
    const typeFilter =
      args.edgeTypes && args.edgeTypes.length > 0
        ? args.edgeTypes.join("|")
        : "";

    let neighborQuery: string;
    if (hops === 1) {
      const relPattern = typeFilter ? `[r:${typeFilter}]` : "[r]";
      neighborQuery = `MATCH (a {id: $id})-${relPattern}->(b:Chunk) RETURN b.hash AS hash, b.seq AS seq`;
    } else {
      const varPattern = typeFilter
        ? `[:${typeFilter}*1..${hops}]`
        : `[*1..${hops}]`;
      neighborQuery = `MATCH (a {id: $id})-${varPattern}->(b:Chunk) RETURN b.hash AS hash, b.seq AS seq`;
    }

    let rows: Array<{ hash: string; seq: number | string }> = [];
    try {
      rows = runCypher<{ hash: string; seq: number | string }>(
        store.db,
        neighborQuery as CypherQuery,
        { id: seedNodeId }
      );
    } catch {
      // Seed without a corresponding graph node — skip.
      continue;
    }

    for (const row of rows) {
      if (!row.hash) continue;
      const seq = typeof row.seq === "number" ? row.seq : Number(row.seq) || 0;
      const key = `${row.hash}:${seq}`;
      arrivalCounts.set(key, (arrivalCounts.get(key) ?? 0) + 1);
    }
  }

  const listB = Array.from(arrivalCounts.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([key], idx) => ({ key, rank: idx + 1 }));

  // Combine via RRF.
  const fused = rrf(listA, listB, k);

  // Map back to (hash, seq, score) shape.
  const ranked = fused.map(({ key, score }) => {
    const [hash, seqStr] = key.split(":");
    return { hash: hash ?? "", seq: Number(seqStr) || 0, score };
  });

  return { ranked };
}
