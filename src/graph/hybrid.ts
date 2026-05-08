/**
 * Hybrid query strategies — RFC-0007 §5 (Phase 2B) + RFC-0008 (this PR).
 *
 * Three strategies, all implemented in QKB code (not in GraphQLite):
 *
 *   1. filterThenRank: a Cypher query produces a candidate (hash, seq)
 *      set; the existing FTS/vector path scores those candidates.
 *      Cheap path; recommended.
 *
 *   2. rankThenRerank: existing hybrid search produces a top-K; a
 *      Cypher neighbor expansion adds related candidates; uniform-weight
 *      RRF combines. Chunk-level (designed for the Phase 2D entity-extraction
 *      graph). More expensive; gated by explicit opt-in.
 *
 *   3. edgeWeightedRank (RFC-0008 strategy #2): existing hybrid search
 *      produces a top-K, each seed's parent doc gets 1-hop expansion
 *      via the graph layer, and per-edge-type weights determine each
 *      neighbor's contribution. Doc-level (the shape produced by
 *      `qkb graph link`), batched into a single Cypher round-trip.
 *
 * These functions are intentionally additive — they don't modify the
 * existing `store.search()` defaults. Callers explicitly invoke them
 * (or pass `useGraph: true` to `hybridQuery`) when they want the graph
 * integration.
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

/**
 * Default per-edge-type weights for {@link runEdgeWeightedRank}. Calibrated
 * for vault-style corpora where the graph is populated by `qkb graph link`:
 *
 *   - **EMBEDS** (≈0.9): Obsidian's `![[X]]` is "render this note inline" —
 *     the embedded note is functionally part of the host doc. Highest signal.
 *   - **LINKS_TO** (≈0.4): plain `[[X]]` is "this note mentions this other
 *     note" — moderate signal; common, sometimes a passing reference.
 *   - **REFERENCES** (≈0.2): markdown `[txt](rel.md)` — weakest because
 *     such links are often footnotes or citations, not topical relations.
 *
 * Tunable per call via {@link EdgeWeightedRankArgs.weights}; surfaced to
 * the CLI as `qkb query --graph-weights '{"LINKS_TO": 0.5, ...}'`. Edge
 * types missing from the map default to 0 (i.e. ignored) when filterByWeights
 * is true; with filterByWeights=false they get the implicit weight 0.1.
 */
export const DEFAULT_EDGE_WEIGHTS: Readonly<Record<string, number>> =
  Object.freeze({
    EMBEDS: 0.9,
    LINKS_TO: 0.4,
    REFERENCES: 0.2,
  });

export interface EdgeWeightedRankArgs {
  /**
   * Initial seeds from the existing hybrid pipeline. Each seed is a
   * `qkb://collection/path[?index=...]`-style file URL with its post-RRF
   * rank score. The function looks up each URL's doc id internally.
   */
  seeds: ReadonlyArray<{ file: string; score: number }>;
  /**
   * Per-edge-type weights. Omitted types are filtered out (treated as 0).
   * Defaults to {@link DEFAULT_EDGE_WEIGHTS}.
   */
  weights?: Record<string, number>;
  /**
   * Maximum expanded candidates returned. Defaults to 50 — enough to
   * meaningfully reshape the candidate pool without blowing up the
   * downstream chunk/rerank cost.
   */
  expansionLimit?: number;
  /** RRF k constant (default 60 per the original RRF paper). */
  rrfK?: number;
}

export interface EdgeWeightedRankResult {
  /**
   * Expanded candidate list — each entry is a doc that's reachable from
   * a seed via the graph, scored by `Σ weights[rel] / (k + seedRank)`.
   * `file` matches the qkb:// URL shape `searchFTS` returns. `body` is
   * the full document content (caller can pass directly into the chunking
   * stage). Sorted by score descending.
   */
  expanded: Array<{
    file: string;
    displayPath: string;
    title: string;
    body: string;
    score: number;
  }>;
}

/**
 * Edge-type-weighted 1-hop expansion (RFC-0008 strategy #2).
 *
 * For each seed (post-RRF candidate from `hybridQuery`), find its parent
 * doc, fetch outgoing graph edges in ONE batched Cypher call, and score
 * each reachable neighbor by the edge type's weight × the seed's RRF
 * contribution. Returns the expanded candidate list ready for the
 * downstream chunk + rerank stages.
 *
 * Pipeline:
 *   1. Resolve seed file URLs → doc ids via SQL (single batch query).
 *   2. ONE Cypher: `MATCH (a)-[r]->(b) WHERE a.id IN $srcIds AND
 *      type(r) IN $types RETURN a.id, b.id, type(r)`.
 *   3. Aggregate per dst: `score += weights[rel] / (rrfK + seedRank)`.
 *   4. Sort dst by score, take top {@link expansionLimit}.
 *   5. Resolve dst doc ids → file URLs + body via SQL (single batch).
 *
 * Total latency budget: ~20ms on a 5k-edge graph (1 Cypher + 2 SQL +
 * RRF math). Well under the 1-2s graph-step budget.
 *
 * Failure modes:
 *   - Empty seeds → empty expansion (no-op).
 *   - Empty graph (no edges) → empty expansion (no-op).
 *   - Seeds whose docs aren't in the graph → silently dropped at SQL
 *     resolve. The expansion is best-effort.
 *   - Hub neighbors with very high in-degree may dominate. v1 doesn't
 *     normalize by degree; document this as a known caveat (RFC-0008).
 */
export function runEdgeWeightedRank(
  store: Store,
  args: EdgeWeightedRankArgs
): EdgeWeightedRankResult {
  const weights = args.weights ?? DEFAULT_EDGE_WEIGHTS;
  const allowedTypes = Object.keys(weights).filter((t) => weights[t]! > 0);
  for (const t of allowedTypes) {
    if (!IDENT_RE.test(t)) {
      throw new TypeError(
        `runEdgeWeightedRank: invalid edge type ${JSON.stringify(t)}.`
      );
    }
  }
  const expansionLimit = Math.max(1, Math.min(args.expansionLimit ?? 50, 500));
  const k = args.rrfK ?? 60;

  if (args.seeds.length === 0 || allowedTypes.length === 0) {
    return { expanded: [] };
  }

  // Step 1: resolve seed file URLs → doc ids. One SQL batch.
  // The qkb:// URL shape from searchFTS is `qkb://<collection>/<path>`
  // (no query string at the SQL layer — the `?index=` suffix is added
  // by the CLI display layer, not the search results). Match defensively
  // by stripping any trailing `?...`.
  const cleanedFiles = args.seeds.map((s) => s.file.split("?")[0]!);
  const placeholders = cleanedFiles.map(() => "?").join(",");
  const seedRows = store.db
    .prepare(
      `SELECT 'qkb://' || d.collection || '/' || d.path AS file, d.id AS docId
       FROM documents d
       WHERE d.active = 1
         AND ('qkb://' || d.collection || '/' || d.path) IN (${placeholders})`
    )
    .all(...cleanedFiles) as Array<{ file: string; docId: number }>;

  if (seedRows.length === 0) return { expanded: [] };

  // Map file → seed rank (1-indexed).
  const seedRankByFile = new Map<string, number>();
  args.seeds.forEach((s, idx) => {
    const cleaned = s.file.split("?")[0]!;
    if (!seedRankByFile.has(cleaned)) seedRankByFile.set(cleaned, idx + 1);
  });
  const seedRankByDocId = new Map<number, number>();
  for (const row of seedRows) {
    const rank = seedRankByFile.get(row.file);
    if (rank !== undefined) seedRankByDocId.set(row.docId, rank);
  }

  const srcIds = seedRows.map((r) => `doc:${r.docId}`);

  // Step 2: ONE Cypher to fetch all outgoing edges of any seed doc.
  type EdgeRow = { src: string; dst: string; rel: string };
  let edgeRows: EdgeRow[];
  try {
    edgeRows = runCypher<EdgeRow>(
      store.db,
      `MATCH (a)-[r]->(b)
       WHERE a.id IN $srcIds AND type(r) IN $types
       RETURN a.id AS src, b.id AS dst, type(r) AS rel` as CypherQuery,
      { srcIds, types: allowedTypes }
    );
  } catch {
    // Graph layer unavailable / Cypher quirk — degrade to no expansion.
    return { expanded: [] };
  }

  if (edgeRows.length === 0) return { expanded: [] };

  // Step 3: aggregate per dst id with weighted score.
  // Drop self-edges (a doc linking to itself) and edges back to seeds
  // (already in the candidate pool).
  const seedDocIdSet = new Set(seedRows.map((r) => r.docId));
  const dstScore = new Map<number, number>();
  const dstEdgeTypes = new Map<number, Set<string>>();
  for (const e of edgeRows) {
    const srcDocId = parseDocId(e.src);
    const dstDocId = parseDocId(e.dst);
    if (srcDocId === null || dstDocId === null) continue;
    if (dstDocId === srcDocId) continue;
    if (seedDocIdSet.has(dstDocId)) continue;

    const seedRank = seedRankByDocId.get(srcDocId);
    if (seedRank === undefined) continue;

    const w = weights[e.rel] ?? 0;
    if (w <= 0) continue;

    const contribution = w / (k + seedRank);
    dstScore.set(dstDocId, (dstScore.get(dstDocId) ?? 0) + contribution);

    const types = dstEdgeTypes.get(dstDocId) ?? new Set<string>();
    types.add(e.rel);
    dstEdgeTypes.set(dstDocId, types);
  }

  if (dstScore.size === 0) return { expanded: [] };

  // Step 4: take top-N by score.
  const topDsts = [...dstScore.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, expansionLimit);

  // Step 5: resolve dst doc ids → file + body in one SQL batch.
  const dstIds = topDsts.map(([id]) => id);
  const dstPlaceholders = dstIds.map(() => "?").join(",");
  const dstRows = store.db
    .prepare(
      `SELECT
         d.id AS docId,
         'qkb://' || d.collection || '/' || d.path AS file,
         d.collection || '/' || d.path AS displayPath,
         d.title AS title,
         c.doc AS body
       FROM documents d JOIN content c ON c.hash = d.hash
       WHERE d.active = 1 AND d.id IN (${dstPlaceholders})`
    )
    .all(...dstIds) as Array<{
    docId: number;
    file: string;
    displayPath: string;
    title: string;
    body: string;
  }>;

  const rowByDocId = new Map(dstRows.map((r) => [r.docId, r]));

  const expanded = topDsts
    .map(([docId, score]) => {
      const r = rowByDocId.get(docId);
      if (!r) return null;
      return {
        file: r.file,
        displayPath: r.displayPath,
        title: r.title,
        body: r.body,
        score,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return { expanded };
}

function parseDocId(nodeId: string): number | null {
  if (!nodeId.startsWith("doc:")) return null;
  const n = Number(nodeId.slice(4));
  return Number.isFinite(n) ? n : null;
}
