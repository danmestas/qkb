/**
 * Graph-aware query path — RFC-0009 §"Query path".
 *
 * The vendored ~80 LoC that lets qkb stay graph-aware without forking
 * qmd. qmd's `SearchHooks` is observability-only (no candidate-mutation
 * hook) and qmd's `exports` field blocks sub-path imports, so we cannot
 * mutate the candidate pool inside qmd's `hybridQuery()` from outside.
 *
 * Pipeline:
 *   1. `store.search({rerank: false})` — qmd does query expansion, BM25,
 *      vector search, and RRF fusion, returning fused candidates without
 *      cross-encoder reranking.
 *   2. Top-K seeds drive a 1-hop graph expansion via
 *      `runEdgeWeightedRank()`. Same logic the 3.x hybrid path used.
 *   3. `mergeForRerank` deduplicates the union of fused + graph-expanded
 *      candidates into `{file, text}[]` rerank input. Graph candidates
 *      already carry full body content from `runEdgeWeightedRank`'s SQL
 *      resolve step (see `EdgeWeightedRankResult` in `src/graph/hybrid.ts`).
 *   4. `store.internal.rerank()` runs the cross-encoder over the union.
 *      qmd owns the model lifecycle (lazy load, inactivity unload).
 *   5. `blendScores` returns reranked entries in `HybridQueryResult` shape;
 *      original RRF candidates keep their explain trace, graph-expanded
 *      entries get a synthesised one.
 *
 * Internal-surface dependencies (RFC-0009 §"Internal surface dependencies"):
 *   - `QMDStore.search({rerank:false})` returns RRF-fused candidates.
 *   - `QMDStore.internal.rerank(query, docs, model?, intent?)` runs the
 *     cross-encoder; same shape qkb's local Store exposed in 3.x.
 *   - `QMDStore.internal.db` lets `runEdgeWeightedRank` resolve seed/dst
 *     doc ids to `qkb://` file URLs and full bodies.
 *
 * Plan-versus-reality deviations (intentional):
 *   - Plan said `await runEdgeWeightedRank(...)`. The function is sync
 *     (no LLM in the graph hop) — drop the await.
 *   - Plan iterated `expansion` directly. The function returns
 *     `{ expanded: [...] }` — we read `expansion.expanded`.
 *   - Plan called `store.internal.llm.rerank(query, docs, {model})`.
 *     The store-level wrapper `store.internal.rerank(query, docs, model)`
 *     returns the simple `{file, score}[]` shape; the `LlamaCpp`-level
 *     `.rerank()` returns `{results: [...], model}` and is one rung
 *     lower than we need. Use the store wrapper.
 *   - Plan passed `store.internal.db` to `runEdgeWeightedRank`. The
 *     function takes a `Store`-shaped object (uses only `.db`). qmd's
 *     `InternalStore` matches that contract structurally — pass it
 *     directly via the same `as unknown as Store` trick PR-2 used in
 *     `src/orchestrator/index-orchestrator.ts`.
 */
import type { QMDStore, HybridQueryResult } from "@tobilu/qmd";
import {
  runEdgeWeightedRank,
  DEFAULT_EDGE_WEIGHTS,
  type EdgeWeightedRankResult,
} from "../graph/hybrid.js";
import type { Store } from "../internals/store-engine.js";

/**
 * Reranker model. Mirrors qmd's `DEFAULT_RERANK_MODEL_URI` shape
 * (`hf:org/repo/file.gguf`); the qmd-level pull cache will resolve the
 * file path. We pass the model name explicitly so callers can observe
 * which model scored their query.
 */
const RERANK_MODEL =
  "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";

/** Top-K of the fused candidate list used as graph seeds. */
const SEED_COUNT = 8;

/**
 * Initial fused-pool size. 60 leaves headroom for the graph expansion to
 * inject candidates without immediately competing with strong fused-rank
 * candidates the cross-encoder hasn't seen yet.
 */
const FUSED_LIMIT = 60;

export interface QueryWithGraphOpts {
  /** Final result count after rerank + dedup. Defaults to 10. */
  limit?: number;
  /** Restrict search to a single collection (passed through to qmd). */
  collection?: string;
  /** Per-edge-type weights override for the graph expansion. */
  weights?: Record<string, number>;
  /** Domain intent hint forwarded to qmd's expand + rerank stages. */
  intent?: string;
}

/**
 * Run a graph-aware query against `store`.
 *
 * Returns reranked `HybridQueryResult` entries — graph-expanded files
 * are synthesised with score, file, body, and a placeholder
 * `bestChunk`/`docid` so callers don't need to special-case them.
 */
export async function queryWithGraph(
  store: QMDStore,
  query: string,
  opts: QueryWithGraphOpts = {}
): Promise<HybridQueryResult[]> {
  const userLimit = opts.limit ?? 10;
  const weights = opts.weights ?? DEFAULT_EDGE_WEIGHTS;

  // 1. qmd does expand + BM25 + vec + RRF; skip rerank so we can inject
  //    graph candidates before the cross-encoder sees the pool.
  const fused = await store.search({
    query,
    limit: FUSED_LIMIT,
    rerank: false,
    collection: opts.collection,
    intent: opts.intent,
  });

  if (fused.length === 0) return [];

  // 2. Top-K seeds → 1-hop graph expansion. Sync (no LLM in this hop).
  //    Cast InternalStore → local Store: both have the same `.db` shape.
  const seeds = fused.slice(0, SEED_COUNT).map((r) => ({
    file: r.file,
    score: r.score,
  }));
  const expansion: EdgeWeightedRankResult = runEdgeWeightedRank(
    store.internal as unknown as Store,
    { seeds, weights }
  );

  // 3. Build the rerank input as `{file, text}[]`. Bodies come back fully
  //    populated on graph-expanded entries (see EdgeWeightedRankResult.body
  //    JSDoc) so this step is purely deduplication + assembly.
  const candidates = mergeForRerank(fused, expansion);
  if (candidates.length === 0) return [];

  // 4. Rerank via qmd's store-level wrapper. Returns `{file, score}[]`
  //    (the LlamaCpp-level `.rerank()` returns a richer shape; we want
  //    the wrapper because qmd already handles the model lifecycle).
  const reranked = await store.internal.rerank(
    query,
    candidates,
    RERANK_MODEL,
    opts.intent
  );

  // 5. Position-aware blend → return top-N.
  return blendScores(fused, expansion.expanded, reranked).slice(0, userLimit);
}

/**
 * Deduplicate fused + graph-expanded candidates into rerank input.
 * Fused entries win on ties (their `body` is the full doc body from qmd).
 */
function mergeForRerank(
  fused: HybridQueryResult[],
  expansion: EdgeWeightedRankResult
): { file: string; text: string }[] {
  const seen = new Set<string>();
  const out: { file: string; text: string }[] = [];

  for (const r of fused) {
    if (seen.has(r.file)) continue;
    seen.add(r.file);
    out.push({ file: r.file, text: r.body || r.title || r.file });
  }

  for (const e of expansion.expanded) {
    if (seen.has(e.file)) continue;
    seen.add(e.file);
    out.push({ file: e.file, text: e.body || e.title || e.file });
  }

  return out;
}

/**
 * Re-emit reranked entries in `HybridQueryResult` shape, sorted by
 * reranker score descending. Original fused entries keep their explain
 * trace; graph-expanded entries get a synthesised one.
 */
function blendScores(
  fused: HybridQueryResult[],
  expanded: EdgeWeightedRankResult["expanded"],
  reranked: { file: string; score: number }[]
): HybridQueryResult[] {
  const fusedByFile = new Map(fused.map((r) => [r.file, r]));
  const expandedByFile = new Map(expanded.map((e) => [e.file, e]));

  const blended: HybridQueryResult[] = [];
  for (const r of reranked) {
    const original = fusedByFile.get(r.file);
    if (original) {
      blended.push({ ...original, score: r.score });
      continue;
    }
    const exp = expandedByFile.get(r.file);
    if (exp) {
      // Synthesise a HybridQueryResult for graph-expanded entries.
      // `bestChunk` falls back to the doc body; `docid` is unknown at
      // this layer (the graph expansion resolves by file URL, not docid).
      blended.push({
        file: exp.file,
        displayPath: exp.displayPath,
        title: exp.title,
        body: exp.body,
        bestChunk: exp.body,
        bestChunkPos: 0,
        score: r.score,
        context: null,
        docid: "",
      });
    }
  }
  return blended.sort((a, b) => b.score - a.score);
}
