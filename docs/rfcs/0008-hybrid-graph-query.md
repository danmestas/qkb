# RFC-0008 — Hybrid Graph Query Strategies for `qkb query`

**Status**: Strategy #2 in implementation. Strategies #1, #3, #4 documented for future work.

**Context**: After RFC-0007 (graph layer) and PR #50/#52 (bulk perf + auto-link in update), QKB has a populated structural graph (~700 typed nodes, ~5,000 edges on flight-planner-kb) that the main `qkb query` pipeline does not consult. This RFC catalogs four strategies for blending graph signal into hybrid retrieval, with concrete implementation notes per strategy and the trade-offs.

## Pipeline today (recap)

```
question
   ├── query expansion (Qwen3 1.7B) → ~6 paraphrases + 1 HyDE pseudo-doc
   ├── per-paraphrase BM25 (FTS5) + vector (sqlite-vec / embeddinggemma)
   ├── RRF blend (k=60)
   ├── top-40 → cross-encoder reranker (qwen3-reranker)
   └── final ranked list
```

End-to-end on flight-planner-kb (124MB, 638 docs): ~30s. The reranker dominates. The graph layer holds 5,090 LINKS_TO + EMBEDS + REFERENCES edges that this pipeline doesn't touch.

## Constraints (load-bearing — don't violate)

- **Local-first**: no network. All inference on the user's box.
- **Latency budget**: any graph step must be <1-2s or it's a regression.
- **No new LLM calls**: query expansion + reranker already cost ~30s. Graph step must be non-LLM.
- **GraphQLite v0.4.4 quirks**: no UNWIND, no chained WITH, var-length-rel + `type(r)` errors (see `test/spikes/probe-multi-merge.ts`, `probe-mcp-neighbors.ts`).
- **Read-only at query time**: don't write graph state per query.
- **Graceful degradation**: strategies must no-op cleanly when graph is empty/sparse.
- **Heterogeneous corpora**: not every vault has wikilinks. Strategies must not break on path-only or text-only corpora.

## Strategies

### Strategy #1 — Personalized PageRank from BM25/vector seeds (HippoRAG-lite)

**One-liner**: Run BM25+vector first, use top-N as PPR personalization vector, then re-score every node by stationary probability.

**What it does**. The neighborhood-aware retrieval pattern. After the existing pipeline emits its top-N candidates, we treat those as the "personalization vector" of a Personalized PageRank computation over the graph: PPR walks the graph from each seed, accumulating mass at every reachable node, weighted by its closeness to seeds in graph topology. Multi-hop neighbors of strong seeds bubble up even when they have **zero keyword overlap** with the query — exactly the case pure vector/BM25 cannot solve. The "doc never said `Vmc` but it's one wikilink away from `engine-out procedure`" case.

**Algorithm**: push-based PPR (Andersen-Chung-Lang). Maintain two vectors — a "residual" and a "score". Start with residual at seeds proportional to their pipeline rank. Repeatedly pop the highest-residual node, push `(1-α)` fraction of its residual to its neighbors (uniform or weighted), keep `α` as score. Converges in O(1/(α·ε)) operations independent of graph size. With `α=0.5, ε=1e-4` on a 5k-edge graph, converges in <100ms.

**Implementation sketch for QKB**:
1. Read adjacency once per query via a single Cypher call: `MATCH (a)-[r]->(b) RETURN a.id AS src, b.id AS dst, type(r) AS rel` — ~50ms for 5k edges, fits a typed-array CSR (Compressed Sparse Row) in memory.
2. Map seed chunks → seed doc ids via SQL `JOIN documents ON content.hash = documents.hash`.
3. Run push-PPR in pure TS — no GraphQLite involvement after step 1. New module `src/graph/ppr.ts`.
4. Map PPR-scored doc ids back to their chunks (all chunks of a doc share the doc's score).
5. RRF-blend PPR ranks with the existing fused list (k=60).
6. Pass top-40 to the reranker as today.

**Existing primitive reuse**: none — this is a new pipeline step. Doesn't touch `filterThenRank` or `rankThenRerank`.

**Latency estimate**: 50ms (adjacency read) + 100ms (PPR convergence) + ~10ms (chunk mapping) ≈ **~160ms total**. Under the budget.

**Why for flight-planner-kb-style corpus**:
- Dense `LINKS_TO` is exactly what PPR exploits — high-degree concept nodes act as natural hubs that propagate seed mass.
- Typed-frontmatter nodes (Entity/Concept/Source) cluster naturally — PPR concentrates probability at the right cluster for the seed.
- Real query example: "what are landing requirements in Zambia?" — vector might find some Zambia docs, but PPR walks from those seeds through `LINKS_TO` to "Africa-NOTAM-overview", "FAA-NMS-international-coverage", "ICAO-Annex-14-runway-spec" — docs that don't mention Zambia at all but are exactly what the user wants.

**Failure modes**:
- **Hub dominance**: high-in-degree pages (MOC indexes) absorb all the PPR mass and drown out specific results. Mitigation: damping factor `α=0.5` (not the canonical `0.85`) to keep mass closer to the seeds, and post-PPR demote nodes with `degree > P95` by a `log(degree)` factor.
- **Empty graph**: PPR returns the seed set unchanged (all mass stays at seeds when there are no out-edges). Degrades cleanly to a no-op.
- **Disconnected components**: seeds in component A can't reach component B. Acceptable — that's the topology. RRF blend with the original list ensures we don't drop good non-graph results.

**References**:
- HippoRAG (NeurIPS'24) — [arXiv:2405.14831](https://arxiv.org/abs/2405.14831), [github.com/OSU-NLP-Group/HippoRAG](https://github.com/OSU-NLP-Group/HippoRAG)
- Andersen-Chung-Lang push-PPR (canonical local PPR) — [paper PDF](https://www.cs.cmu.edu/~glmiller/Publications/AndersenChungLang2006.pdf)
- SPRIG (linear CPU GraphRAG) — [arXiv:2602.23372](https://arxiv.org/html/2602.23372v1)

---

### Strategy #2 — Edge-type weighted 1-hop expansion (**SHIPPING FIRST**)

**One-liner**: Treat edge types as having different reliability — `EMBEDS` (≈0.9) means "part of", `LINKS_TO` (≈0.4) means "related", `REFERENCES` (≈0.2) is weakest. Score 1-hop neighbors by per-type weight × seed rank.

**What it does**. The simplest possible graph-aware reranking. After the existing pipeline emits its top-K candidates, we look at each seed's parent doc, find its 1-hop graph neighbors via the graph layer, and weight each neighbor's contribution to the candidate pool by **the type of edge that connects them**. This makes the typed graph finally pay for itself: an `EMBEDS` edge (the canonical Obsidian "include this note here") is near-identity, while a `REFERENCES` (a passing markdown link) is weak.

**Algorithm**: for each seed chunk, map to its parent doc. For all parent docs, fetch outgoing edges in ONE batched Cypher call. For each `(src, rel, dst)` triple, contribute `weights[rel] / (rrfK + seedRank)` to dst's score. Sort dst doc ids by accumulated score, map back to all their chunks, RRF-blend with the seed list.

**Implementation sketch for QKB**:
1. Existing pipeline produces top-N seeds (chunks). Take top 20 (configurable).
2. Map seed hashes → doc ids via SQL `SELECT id, hash FROM documents WHERE hash IN ($hashes)`.
3. Single Cypher: `MATCH (a) WHERE a.id IN $docIds MATCH (a)-[r]->(b) WHERE type(r) IN $allowedTypes RETURN a.id AS src, b.id AS dst, type(r) AS rel`.
4. Aggregate: `dstScore[b] += weights[rel] × (1 / (rrfK + srcSeedRank))`.
5. Sort dst by score, take top-50 doc ids.
6. Resolve dst doc ids → all their chunks via SQL.
7. RRF-blend the expansion with the seed list (k=60).

**Existing primitive reuse**: `runRankThenRerank` does the *shape*, but is hardcoded chunk-level and uses uniform edge weights. This work adds a sibling `runEdgeWeightedRank` that operates on doc-level nodes (the shape produced by `qkb graph link`) with per-type weights.

**Latency estimate**: 1 batched Cypher (~10ms) + 2 SQL joins (~5ms) + RRF (1ms) ≈ **~20ms total**. Bottom of the budget.

**Default weights** (tunable via `--graph-weights '{}'`):
```json
{
  "EMBEDS":     0.9,
  "LINKS_TO":   0.4,
  "REFERENCES": 0.2
}
```

Rationale: `EMBEDS` is "this note is rendered inside this one" — the rendered content is functionally part of the host doc. `LINKS_TO` is "this note mentions this other note" — moderate signal. `REFERENCES` is "this note has a passing markdown link to this other file" — weakest because such links are often footnotes or asides.

**Why for flight-planner-kb-style corpus**:
- `EMBEDS` is sparse but high-fidelity. Pulling embedded targets in at high weight is almost free precision.
- `LINKS_TO` density (5,000 edges / 700 docs ≈ 7 edges/doc) gives meaningful expansion without flooding.
- Distinguishing the three types finally makes the typed-edge work in `qkb graph link` pay back through retrieval.
- Real query example: "FAA NMS landing reqs" — top vector hit is `FAA-NMS.md`, which `EMBEDS` `nms-api-faq.md` (high weight) and `LINKS_TO` 19 other procedure docs (moderate weight). The reranker now sees those as candidates instead of having to re-find them via lexical match.

**Failure modes**:
- **Bad weights tank precision**. Mitigation: defaults are conservative (EMBEDS biggest, REFERENCES smallest), expose `--graph-weights` for power users, A/B-test on a held-out query set before changing defaults.
- **Empty graph or non-Obsidian corpus**: no edges → expansion produces empty list → RRF blend reduces to seed list unchanged. No-op fallthrough.
- **Hub neighbors with inflated importance**: a neighbor with 200 incoming `LINKS_TO` looks artificially strong. Mitigation: cap per-doc contributions or normalize by destination in-degree (deferred to v2).

**References**:
- Retrieval-Augmented Generation with Graphs survey — [arXiv:2501.00309](https://arxiv.org/abs/2501.00309)
- Graph-Based Re-ranking: Emerging Techniques — [arXiv:2503.14802](https://arxiv.org/html/2503.14802v1)

---

### Strategy #3 — Subgraph-as-context for the reranker (ego-graph injection)

**One-liner**: For each top-40 candidate going into the cross-encoder reranker, inject a 1-2 line structural blurb describing its graph neighborhood, so the reranker scores against text + structure together.

**What it does**. The reranker today scores `(query, doc-chunk)` pairs as text-only. The graph already knows that `doc-chunk` is an excerpt from `FAA-NMS.md`, which `EMBEDS` `[Vmc-procedure]` and is `LINKED_TO` by `[engine-out-checklist]`. Why not tell the reranker that? A 200-character structural blurb prepended to the chunk text lets the cross-encoder use the graph context as an additional signal — without an extra model call. The structural blurb is a free upgrade because the reranker call is already happening.

**Algorithm**:
1. After existing top-40 candidate selection, build per-candidate ego subgraph: 1-hop neighbors with edge type and neighbor title.
2. Format as: `"This doc EMBEDS [Vmc-procedure]; LINKS_TO [engine-out-checklist], [aerodynamic-stall-recovery]; LINKED_FROM_BY [pilot-handbook]."`
3. Cap at 200 chars (truncate longest names first).
4. Prepend to the chunk text in the reranker input.

**Implementation sketch for QKB**:
1. Single Cypher per batch: `MATCH (n) WHERE n.id IN $candidateDocIds MATCH (n)-[r]-(m) RETURN n.id AS src, type(r) AS rel, m.title AS title LIMIT 8 PER src` (the LIMIT-PER quirk needs subquery in v0.4.4 — fall back to fetch all + truncate in TS).
2. Build per-candidate blurb string (sorted by edge type weight, longest neighbor titles truncated to 30 chars).
3. Modify reranker call site to accept an optional `prefix` per chunk; prepend with a separator like `"[CONTEXT] {blurb}\n[CONTENT] {chunkText}"`.
4. Reranker scores against the combined text. No additional LLM calls.

**Existing primitive reuse**: minimal — needs a new shared `buildEgoSubgraph(docIds)` helper. Reranker call site needs the prefix-injection point.

**Latency estimate**: 1 Cypher (~10ms) + string building (~1ms) + free reranker pass (already happening) ≈ **~10ms net**.

**Why for flight-planner-kb-style corpus**:
- Frontmatter `type:` (Entity, Concept, Source) and clear neighbor titles give the reranker useful context.
- Domain reranker (qwen3) understands aviation terminology — a blurb mentioning `[NOTAM-classification]` will move a candidate up if the query is about NOTAMs.
- Cheapest possible re-use of the cross-encoder pass.

**Failure modes**:
- **Prompt bloat pushes content out**. Mitigation: hard 200-char cap; only inject when ≥1 edge exists; A/B vs. no-injection.
- **Misleading structural context**: a doc with `LINKS_TO` an unrelated topic could push the candidate the wrong way. Mitigation: only include neighbors with `EMBEDS` (high-fidelity) by default; surface `LINKS_TO` as opt-in.
- **Empty graph**: no blurb prepended, reranker behaves as today. No-op.

**References**:
- SubgraphRAG — [arXiv overview](https://www.emergentmind.com/topics/subgraphrag-framework)
- SG-RAG MOT (subgraph retrieval for KGQA) — [MDPI 2025](https://www.mdpi.com/2504-4990/7/3/74)

---

### Strategy #4 — Community-summary global retrieval (GraphRAG-lite)

**One-liner**: Run Leiden community detection at index time, generate per-community summaries via the local LLM, store as virtual docs in FTS5/vec. Query-time is unchanged — the summaries get hit by BM25/vector alongside real docs.

**What it does**. Pointwise retrieval can answer "what is X?" but cannot answer "what is this vault *about*?" or "summarize the cluster of work around X". Microsoft's GraphRAG addresses this by clustering the graph (Leiden), generating an LLM summary per cluster, and using those summaries as a separate retrieval index. QKB-lite version: store the community summaries as synthetic markdown docs at `qkb://_communities/N`, indexed normally. The existing query pipeline now sees them and surfaces them when the question is community-scope.

**Algorithm**:
1. **Index time**: build adjacency, run Leiden clustering (graphology-communities-leiden npm package), generate one LLM summary per community using the local generate model. Persist as synthetic documents.
2. **Query time**: zero changes — existing BM25+vector hits the synthetic docs alongside real ones.
3. **Refresh**: tied to `qkb update`'s post-link step. Leiden is stable under small perturbations, so only re-summarize affected communities (sentinel hash check).

**Implementation sketch for QKB**:
1. Add `qkb graph summarize` CLI command (or wire into `qkb update --refresh-summaries`).
2. New module `src/graph/community.ts` exports `runCommunityDetection(store)` and `generateCommunitySummaries(store, llm)`.
3. Synthetic doc shape: `{collection: "_communities", path: "_communities/N.md", title: "Community N: <theme>", doc: "<LLM summary>"}`. Stored in `documents` + `content` tables like any other doc, but flagged so they don't show up in `qkb ls`.
4. LLM cost budget: ~30 communities × ~2k tokens prompt ≈ 60k tokens at index time (one-shot).

**Existing primitive reuse**: index-time only, no query-time path changes.

**Latency estimate**: query-time **0ms added** (synthetic docs go through normal pipeline). Index-time: ~10-30 min one-time on flight-planner-kb scale.

**Why for flight-planner-kb-style corpus**:
- Solves the *global sensemaking gap*. Question like "what's the state of NOTAM reform?" — pointwise retrieval finds individual docs; community summary gives the picture.
- Communities map naturally to vault domains (the flight-planner-kb has `wiki/domains/Aviation.md`-style domain pages already; Leiden would discover similar groupings).
- Pure additive — doesn't change existing query behavior.

**Failure modes**:
- **Summary drift on stale graphs**. Mitigation: tie regeneration to `qkb update`; only refresh communities whose member set changed.
- **LLM hallucination in summaries** (wrong claims about the cluster). Mitigation: surface as `[community summary]`-prefixed snippets, not authoritative answers; the rerank still penalizes them if they don't match the query well.
- **Cold-start cost**: 10-30 min on first run is expensive. Mitigation: opt-in via `qkb graph summarize`, not part of default `qkb update`.

**References**:
- Microsoft GraphRAG paper — [arXiv:2404.16130](https://arxiv.org/abs/2404.16130)
- GraphRAG repo — [microsoft.github.io/graphrag](https://microsoft.github.io/graphrag/)
- Awesome-GraphRAG curated list — [github.com/DEEP-PolyU/Awesome-GraphRAG](https://github.com/DEEP-PolyU/Awesome-GraphRAG)

---

## Implementation order

| Order | Strategy | Why this order |
|-------|----------|----------------|
| 1 (now) | #2 — edge-weighted 1-hop | Lowest risk; cheapest implementation; gives us per-edge-type weighting infrastructure that #1 reuses. Single PR. |
| 2 | #1 — PPR from seeds | Highest-value once weights infrastructure exists. Multi-hop unlock that BM25/vector cannot do. New module. |
| 3 | #3 — ego-graph injection | Bolt-on once #1's per-edge weights are in scope. Modifies reranker call site. |
| 4 | #4 — community summaries | Defer until users ask vault-summary questions. Index-time cost makes this opt-in. |

All four ship behind `qkb query --graph` (or specific sub-flags). Default `qkb query` behavior unchanged until A/B confirms wins.

## Open questions

- **Default-on threshold**: at what point do we flip `--graph` on by default? Probably never — make it sticky via config (`graph.use_in_query: true`). Architecture decision deferred.
- **Cross-corpus tuning**: weights tuned for flight-planner-kb may not suit a code documentation vault or a research-paper archive. May need per-collection weights.
- **Pre-existing 50-edge gap** (5,140 emitted vs 5,090 stored in DB on flight-planner-kb): orthogonal to this RFC; tracked as separate follow-up.
