# RFC-0010 — `qkb graph rank` via Personalized PageRank

**Status**: Proposed. Spike at `test/spikes/probe-ppr.ts` validates the core algorithm and informed several spec revisions (see "Spike findings" below).

**Context**: The graph skill (`vault-query-graph` in `flight-planner-kb`) requires the agent to *name* a seed entity before it can walk anywhere. The v3 skill-comparison bench (`bench/results/skill-bench-v3-2026-05-13.html`) surfaced the consequent failure mode: on Q13 ("what existing patterns should I follow for a new FAA ingestion pipeline?") the graph skill missed `Cycle-Aware Publication Refresh` entirely — not because the page wasn't well-linked, but because the agent didn't pick it as a seed. The hybrid pipeline (`qkb query --graph`) handles seed selection internally via BM25+vector+rerank, but pays ~30–60s for the privilege.

This RFC proposes a pure-graph relevance retrieval command, `qkb graph rank`, that uses Personalized PageRank (PPR) as a fast, deterministic alternative for the question shape *"what nodes are relevant to my question, judged by graph topology?"*. Target latency: under 200ms end-to-end. Target use: when the relevant entity isn't lexically obvious from the question, but the graph topology makes it findable.

## Pipeline today (where this fits)

```
question
   ├── qkb search    → BM25 over chunk FTS5 (~50ms)
   ├── qkb vsearch   → vector recall over chunk embeddings
   ├── qkb query     → full hybrid: expansion + BM25 + vsearch + RRF + graph 1-hop + rerank (~30-60s)
   └── qkb graph *   → direct graph operations (neighbors, query, link)
```

Missing: a *node-level relevance* signal that uses graph topology as its sole evidence. `qkb query --graph` does a 1-hop graph *expansion* on top of the hybrid pipeline's candidates, but that's a single hop and operates on the chunk-rank pool. PPR runs iterative diffusion on the *node* graph and converges to a stable distribution of relevance, drawing on multi-hop topology without rerank or vector cost.

## Constraints (load-bearing — don't violate)

- **Local-first**: no network. All compute on the user's box. PPR has no LLM step.
- **Latency budget**: total command latency under 200ms on flight-planner-kb-sized graphs (~1855 nodes, ~14K edges). The hybrid pipeline is the slow option; PPR is the fast one.
- **No new LLM calls**: PPR uses BM25 (already fast) for seed-vector construction, optionally backed by fuzzy title match. No query expansion, no embedding lookup, no rerank.
- **Determinism**: same input → same output. PPR is deterministic given fixed iteration count and tolerance.
- **GraphQLite v0.4.4 quirks**: implementation reads the graph layer into memory rather than running PPR via Cypher (Cypher can't express linear-algebra fixed-point iteration cleanly).

## Goals

- A new CLI subcommand: `qkb graph rank <question> [-n N] [-c collection]`.
- Returns the top-N nodes ranked by PPR score from a question-derived personalization vector.
- ≤200ms p50 latency on flight-planner-kb (~1855 nodes).
- Deterministic output for fixed input.
- Outputs in the same shape as `qkb query --files` (`#docid,score,qkb://collection/path`) so it composes with the existing skill cohort.

## Non-goals

- Replacing `qkb query --graph`. That stays the primary hybrid retrieval path; PPR is a node-level companion.
- Re-ranking. PPR ranks by topology; downstream rerank (e.g. cross-encoder over the resulting docs) is a separate concern, out of scope for this command.
- Streaming output. Result set is small (N ≤ 50); single-shot return.
- Graph mutations. Read-only path.
- Cross-collection PPR. v1 scopes to a single collection; cross-collection PPR is straightforward to add later (see Future work).

## Proposed CLI

```
qkb graph rank <question> [flags]

Required positional:
  question                Natural-language question or compact keyword set.

Flags:
  -c, --collection NAME   Restrict to a collection (default: span all).
  -n, --num N             Number of results to return (default: 10).
  --seeds K               Number of BM25 seeds to use in the personalization vector (default: 8).
  --alpha FLOAT           Damping factor / persistence (default: 0.5; standard PageRank uses 0.85,
                          but PPR with strong seed bias works better near 0.5–0.7).
  --max-iter N            Maximum power iterations (default: 50; typically converges in ~20).
  --tol FLOAT             L1 convergence tolerance (default: 1e-6).
  --json                  Emit JSON instead of TTY format.
  --include-meta          Don't demote wiki/hot.md, wiki/index.md, wiki/log.md, wiki/meta/* in results.
  --edge-types LIST       Comma-separated edge types to use (default: LINKS_TO,EMBEDS,REFERENCES).
  --edge-weights JSON     Override edge weights (default: {"EMBEDS":0.9,"LINKS_TO":0.4,"REFERENCES":0.2}).
```

### Output format

Default (TTY):
```
#74fd74,0.087,qkb://flight-planner/wiki/concepts/Schema-Drift Manifest.md
#a23f41,0.064,qkb://flight-planner/wiki/concepts/Cycle-Aware Publication Refresh.md
...
```

With `--json`:
```json
[
  {
    "docid": "#74fd74",
    "graph_node_id": "doc:464",
    "score": 0.087,
    "title": "Schema-Drift Manifest",
    "path": "wiki/concepts/Schema-Drift Manifest.md",
    "collection": "flight-planner"
  },
  ...
]
```

## Algorithm

### Personalization vector construction

The spike (`test/spikes/probe-ppr.ts`) found pure BM25 seeding is insufficient — it returns zero hits on prosey vocabulary-mismatched questions, and meta-pages-only on long natural-language queries. The v1 implementation uses a **three-strategy seed union** with each strategy filtering meta-pages before contribution:

```
e = construct_personalization(Q, collection):
    e = zeros(N)
    sources = []
    
    # Strategy 1: BM25 (cheap, ~50ms)
    hits = qkb_search(Q, n=8, collection=collection)
    for hit in hits:
        if is_meta_page(hit.path): continue   # hot.md, index.md, log.md, meta/*, site/content/*
        idx = node_index_by_path(hit.path)
        if idx is not None:
            e[idx] += hit.score
    if any contributions: sources.append("BM25")
    
    # Strategy 2: title-match (always run, additive; cheap, ~10ms)
    for phrase in extract_capitalized_phrases(Q) ∪ extract_bigrams(Q):
        for node in nodes:
            if is_meta_page(node.path): continue
            if phrase in node.title.lower():
                weight = 1.0 if len(phrase) >= 8 else 0.3
                e[node.idx] += weight
    if any contributions: sources.append("title-match")
    
    # Strategy 3 (optional, --semantic flag): vector recall (~20-30s, includes LLM expansion)
    if semantic_flag:
        vec_hits = qkb_vsearch(Q, n=5, collection=collection)
        for hit in vec_hits:
            if is_meta_page(hit.path): continue
            idx = node_index_by_path(hit.path)
            if idx is not None:
                e[idx] += hit.score * 0.5   # half-weight to mix, not dominate
        if any contributions: sources.append("vector")
    
    if all(e == 0):
        return None   # nothing to seed → command exits with "no seeds found, escalate to qkb query --graph"
    
    L1_normalize(e)
    return e, sources
```

**Three observed seed-quality findings from the spike** (Q12 + Q13 on flight-planner-kb):

1. **BM25 alone is brittle.** On Q13 ("If I'm implementing a new FAA data source ingestion pipeline, what existing patterns should I follow and why?") it returned zero hits. On Q12 it returned only `hot.md` and `log.md` — meta-pages that would have seeded PPR into noise if not filtered. Pure BM25 seeding fails on prosey or vocabulary-mismatched questions.

2. **Title-match (with meta filtering) is the workhorse.** Extracting capitalized phrases ("Cycle-Aware Publication Refresh", "AIRAC Delta Polling") and bigrams of lowercased tokens, then matching against node titles, found the right seeds on Q12 even with zero BM25 hits to concept pages. On Q13, title-match found 22 candidate seeds (catalog pages like "Data Source Hierarchy") — these are *related* to the answer but not *the* answer (see hub-bias below).

3. **Vector recall (`qkb vsearch`) is slow and didn't rescue Q13.** Adding `qkb vsearch` seeds (at ~24s cost — it runs LLM expansion + sqlite-vec) did add 3 more seeds, but PPR diffusion still converged to the same hub-pages as title-match alone. The fundamental issue (hub-bias, below) isn't solved by better seeds — it's an artifact of PPR's mathematics.

**Meta-page filtering is essential.** `wiki/hot.md`, `wiki/index.md`, `wiki/log.md`, `wiki/meta/*`, and `site/content/*` are link hubs that score highly on BM25 (they mention everything) but propagate PPR mass globally rather than to question-specific neighborhoods. Filter these *from seeds* before constructing `e`, in addition to filtering from the *output ranking*.

### Adjacency matrix construction

Read the graph layer once per command invocation. In-memory representation as CSR (compressed sparse row):

```
edges = qkb_graph_query("MATCH (a)-[r]->(b) RETURN a.id, type(r), b.id")
N = count(nodes)
edge_weights_lookup = {"EMBEDS": 0.9, "LINKS_TO": 0.4, "REFERENCES": 0.2}

# Build weighted, column-normalized transition matrix M (where M[i][j] = P(go to i | at j))
W = sparse_matrix(N, N)
for (src, type, dst) in edges:
    if type not in edge_types_filter: continue
    W[dst][src] += edge_weights_lookup[type]   # column = source, row = destination
    # transposed because we propagate FROM source TO destination in the matrix-vector product

# Column-normalize: each column should sum to 1 (out-edges from each node sum to 1)
for col in 0..N-1:
    s = W[:][col].sum()
    if s > 0:
        W[:][col] /= s
    else:
        # Dangling node: treat as if linking to all nodes uniformly
        W[:][col] = 1.0 / N
```

CSR overhead for 14K edges: ~120KB. Reading + constructing this every call is ~10–20ms. Negligible for our latency budget. Future optimization: cache the CSR (Future work §3).

### Power iteration

```
p = e                                # initial distribution
for k in 1..max_iter:
    p_new = alpha * (W @ p) + (1 - alpha) * e
    if ||p_new - p||_1 < tol: break
    p = p_new
return top_N_indices(p, N=n)
```

Computational cost per iteration: ~|E| float ops (a sparse mat-vec). For 14K edges × 20 iterations = 280K ops. Sub-millisecond on any modern CPU.

**Default α = 0.7** (per spike measurement, see Spike findings below). On Q12-style pairwise-comparison questions with well-seeded personalization, α = 0.7 returns 5/5 ground-truth pages in top-6, vs 3/5 for α ∈ {0.3, 0.5, 0.85}. Intuition: α = 0.3–0.5 stays too close to the seed set (PPR ≈ BM25); α = 0.85 diffuses too far and gets pulled into hub nodes by topology. 0.7 hits the sweet spot of "trust the seeds, but let topology surface their immediate neighborhoods."

### Result filtering and shaping

```
ranked = top_N_indices(p, N=n)
results = []
for node_idx in ranked:
    node = graph_node_at_index[node_idx]
    if node.path matches one of [hot.md, index.md, log.md, meta/*] and not --include-meta:
        continue
    results.append({
        docid: lookup_fts_docid_for_node(node),
        graph_node_id: node.id,
        score: p[node_idx],
        title: node.title,
        path: node.path,
        collection: node.collection
    })
return results[:n]
```

**FTS docid lookup**: maps the graph node ID (`doc:464`) back to the FTS-side `#hash` docid for compatibility with downstream skill machinery. The hybrid pipeline already does this — reuse that path.

**Meta demotion**: same hygiene as the skill cohort applies — `hot.md`, `index.md`, `log.md`, and `wiki/meta/*` are link hubs that PPR will rank high but that aren't synthesis-ready. Drop them by default, `--include-meta` to override.

## Implementation plan

### Phase 1: in-process implementation (TypeScript, fits in qkb's existing CLI)

**Files to add:**
- `src/internals/graph-rank.ts` — core PPR algorithm + CSR construction
- `src/cli/qkb.ts` — wire up `graph rank` subcommand

**Files to read for reference:**
- `src/internals/graph/*` — existing graph layer access
- `src/internals/store-engine.ts` — store/collection interfaces
- The BM25 path already exposed by `qkb search`

Sparse linear algebra in TypeScript: no external dep needed. CSR is two `Int32Array`s (`indptr`, `indices`) and one `Float64Array` (`values`). Sparse mat-vec is a 4-line loop. Power iteration is another 5 lines. Whole core algorithm is ~80 lines.

**No new dependencies.** PPR is small enough to write by hand.

### Phase 2: validation against existing benchmarks

- Reproduce v3 Q12/Q13 with the graph skill modified to use `graph rank` as its seed-discovery step. Expect:
  - Q13 coverage to improve (graph found `Cycle-Aware Publication Refresh` via PPR diffusion from "FAA"/"pipeline"/"ingestion" seeds even though it wasn't a lexical hit)
  - Latency to stay under skill budget (PPR adds <200ms to the existing graph workflow)
- Add synthetic graph tests under `test/`: star, chain, two-disconnected-components, dense clique. Verify PPR distributions match textbook closed-form solutions where they exist.

### Phase 3: skill integration

Update `vault-query-graph` (in `flight-planner-kb/.claude/skills/vault-query-graph/`) to use `qkb graph rank` for question-driven candidate retrieval as a complement to manual `graph neighbors` walks. The two are complementary:
- `graph rank "question"` → "what nodes are relevant to my question" (question-led, no manual seed)
- `graph neighbors doc:X` → "what's adjacent to X" (seed-led, structural exploration)

Workflow becomes: rank to find candidates → optionally walk neighbors of top candidates to expand context → read 3–5 pages.

## Performance targets

Two latency profiles — the difference is whether vector seeding (`--semantic`) is on:

**Default mode (BM25 + title-match seeding):**

| Operation | Measured (spike) | Reasoning |
|---|--:|---|
| BM25 seed lookup | 600–1300ms | Q12: 559ms; Q13: 1280ms. Higher than spec's 50ms estimate — qkb's BM25 includes some startup overhead |
| Adjacency load + CSR build | 24ms | 1343 nodes, 12.5K edges (single-collection scope) |
| Title-match scan | 5–15ms | 1300 nodes × ~15 phrases, substring contains |
| Power iteration (20 iters) | 2–13ms | Sub-linear in α (smaller α → faster convergence) |
| Result shaping | <10ms | top-N from float array + path filter |
| **Total p50** | **~700–1500ms** | Compared to `qkb query --graph` at 30–60s, this is ~25–80× faster |

**Semantic mode (`--semantic`, adds vsearch):**

| Operation | Measured (spike) | Reasoning |
|---|--:|---|
| `qkb vsearch` (LLM expansion + sqlite-vec) | 2000–6000ms | Q12: 6074ms; Q13: 2128ms — wide variance, depends on LLM warm/cold state |
| Everything else (above) | ~700ms | unchanged |
| **Total p50** | **~3–7s** | Still 5–10× faster than hybrid; semantic recall on by user choice |

The spec's earlier <200ms target was optimistic about BM25 startup. Realistic targets are documented above. Default mode remains substantially faster than the hybrid pipeline.

## Spike findings (validates and tightens the spec)

A spike implementation at `test/spikes/probe-ppr.ts` validated the core algorithm against the v3 bench questions (Q12 pairwise comparison, Q13 multi-pattern synthesis). Headline findings:

### What works (confirmed)

- **Algorithm correctness**: PPR converges in 9–25 iterations at α=0.5 (tolerance 1e-6) on flight-planner-kb's 1343-node graph. Power iteration in TypeScript with sparse CSR is ~5ms.
- **Q12 (pairwise comparison, ground truth = 5 named concepts)**: PPR with α=0.7 returns **5/5 ground-truth pages in top-6** (`Cycle-Aware Publication Refresh`, `AIRAC Delta Polling`, `FAA NMS`, `Two-Tier Storage`, `AIRAC Cycle`). This is the question shape PPR is designed for and it dominates.
- **Determinism**: identical input produces identical output across runs (verified across 4 α values).

### What doesn't work (and why this changes the spec)

- **Q13 (vocabulary-mismatched synthesis, ground truth = 5 named pattern pages)**: PPR returned **0/5 ground-truth pages in top-10** at every α tested. Title-match seeded PPR from 22 catalog-page hits (`Data Source Hierarchy`, `NOTAM Sources`, `Free vs Paid Data Sources`, etc.) — pages that *link to* the canonical pattern pages but aren't themselves the answer. Adding vector seeding (`qkb vsearch`) at 6s cost didn't change the outcome.

  **Root cause**: PPR is mathematically biased toward **high-in-degree nodes** (this is its defining property — it's the stationary distribution of a random walk, which concentrates on well-connected nodes). The canonical pattern pages (`Atomic Pipeline Handler`, `Schema-Drift Manifest`) have LOWER in-degree than the catalog pages that reference them — PPR will not promote them above their referrers.

- **Pure BM25 seeding is unreliable**: 0 hits for Q13's prosey form; only meta-pages for Q12's natural form. The original spec underestimated this. Title-match is the actual workhorse strategy; BM25 is supplementary.

### What this means for scope

PPR's niche is narrower than the spec originally claimed. It is **not** a general replacement for the hybrid pipeline. Specifically:

- ✅ **PPR wins** when: question contains named entities or canonical phrases; the answer is at or near those entities in the graph; the user wants relational context (pairwise, multi-hop, "what's connected to X").
- ❌ **PPR doesn't help** when: the question uses vocabulary the vault doesn't (Q13 said "patterns"; vault uses "Atomic Pipeline Handler", "Schema-Drift Manifest" — different vocabulary spaces); when the answer is a low-in-degree concept page hidden behind high-in-degree catalogs.

For the latter, the hybrid pipeline (`qkb query --graph`) remains the right tool. The v1 implementation should **explicitly recommend escalation** when PPR returns weak signals (e.g. top-K scores are all under a threshold, or top-K is dominated by catalog/hub pages).

### Tunings derived from the spike

- **Default α = 0.7** (not 0.5 as originally specced). Validated on Q12; ties on Q13 (which doesn't work for any α).
- **Default seed strategies = BM25 + title-match** (vector via `--semantic` opt-in only, given its 5–10× latency cost and minimal accuracy lift in the spike).
- **Meta-page filter applies to seeds, not just outputs.** Filtering only the output (as originally specced) doesn't prevent meta-pages from poisoning the diffusion.
- **Realistic latency p50 ≈ 700–1500ms** in default mode (BM25 lookup dominates), not the 200ms originally targeted.

### Future-work item promoted

The spike makes it clear that **degree-normalized PPR** (or symmetric-normalized PageRank, sometimes called SimRank-flavored PPR) is worth implementing in v2 to address the hub-bias. Standard PPR transition matrix is column-normalized; replacing it with `D^(-1/2) A D^(-1/2)` (symmetric normalization) reduces the dominance of high-degree nodes. This is a 3-line algorithm change with potentially significant accuracy lift for Q13-shape questions, but it shifts PPR's semantics — should ship as a `--normalization symmetric|standard` flag and benched separately.

## Test plan

### Unit tests
- PPR on a star graph (one center, N leaves) → center gets mass × N + persistence; leaves equal
- PPR on a chain (A → B → C → D) seeded at A with α = 0.5 → check geometric decay
- PPR on disconnected components → mass stays in seeded component
- PPR on dense clique → mass distributes uniformly (modulo personalization)
- Convergence: 20 iterations reaches tol < 1e-6 on synthetic 1000-node graph

### Integration tests
- `qkb graph rank "FAA NMS authentication"` on flight-planner-kb → expect `[[FAA NMS]]`, `[[Token Cache Refresh]]`, `[[NOAA Aviation Weather API]]` (the auth-comparison neighborhood) in top-10
- `qkb graph rank "new FAA pipeline patterns"` on flight-planner-kb → expect `[[Cycle-Aware Publication Refresh]]`, `[[Atomic Pipeline Handler]]`, `[[Schema-Drift Manifest]]`, `[[Lineage Invariant]]` in top-10 (the Q13 ground-truth pattern set)
- `--alpha 0.5` vs `--alpha 0.85` produce *different* rankings on the same query (sanity check that α is doing something)
- Empty BM25 → fuzzy fallback → graceful empty result

### Bench integration
- Re-run v3 Q12/Q13 with the graph skill using `graph rank`. Compare coverage + latency + token count against v3 baseline.
- Add a new question class to the bench template: "vague conceptual query" (questions where the answer isn't a named entity) — measure if PPR-augmented graph beats hybrid here.

## Open questions

1. **Default α**: 0.5 vs 0.7 vs corpus-specific. Bench across α ∈ {0.3, 0.5, 0.7, 0.85} on the v1/v2/v3 questions; pick the one with best aggregate coverage.

2. **Personalization vector for very-short questions** (e.g. "NOTAMs"): one BM25 hit is a degenerate personalization vector. Should we apply minimum-K floor (always use ≥3 seeds even on weak matches) or just trust BM25?

3. **Cross-collection ranking**: with `-c` omitted, do we run PPR on the combined cross-collection graph, or run per-collection and merge? The combined graph is mathematically cleaner; the per-collection approach is faster and surfaces per-collection winners.

4. **Result rerank or no?** PPR returns nodes in topology-relevance order. Should we tie-break or boost by chunk-level BM25 score on the candidate nodes? Probably no for v1 (keep the signal pure) but worth testing.

5. **`--seeds K` default**: 5 is what `qkb search` returns by default; 8 gives more diffusion. Bench to pick.

6. **Edge-weight tuning**: the existing defaults (`EMBEDS=0.9, LINKS_TO=0.4, REFERENCES=0.2`) come from RFC-0008 strategy #2 for the hybrid pipeline. PPR may want different weights — `LINKS_TO` is the dominant edge type in Obsidian vaults, so the relative weighting matters more. Test default vs `LINKS_TO=0.7`.

7. **Caching the CSR**: a 14K-edge graph takes ~20ms to construct. If the same CSR is used across N queries in a session, caching saves 20·(N–1)ms. For the typical 1–3 queries per session, this is in the noise. Skip for v1.

## Future work

1. **Topic-sensitive PPR (pre-computed)**: pre-compute PPR vectors for the top-K most-common topic seeds (e.g. "NOTAM", "weather", "briefing", "ingestion") at `graph link` time. At query time, fuzzy-match the question to the closest pre-computed topic and return the cached vector. ~1ms instead of ~200ms for hot topics. Worth doing if PPR becomes a hot path.

2. **PPR + vector fusion**: combine PPR score with cosine similarity from sqlite-vec for a hybrid score:
   ```
   final = β · ppr_score(node) + (1 - β) · vector_sim(question, node_chunks)
   ```
   Cheaper than the full hybrid pipeline; richer than pure PPR. v1 ships PPR-only; this is a clear v2.

3. **Adjacency caching**: maintain the CSR across CLI invocations via a small on-disk cache (invalidate on `graph link`). Drops the per-call overhead from ~20ms to ~2ms. Marginal at current scale; worth it for graphs > 100K nodes.

4. **Cross-collection PPR with collection-aware damping**: when running across collections, set the teleport vector to bias toward the seeded collection. Prevents the personal-notes collection from polluting flight-planner queries even though they share the graph.

5. **Inbound-vs-outbound asymmetry**: by default PPR treats the graph as directed (M @ p flows along edge direction). For questions like "what depends on X" (inbound), use M.T @ p. Expose via `--direction outbound|inbound|both`.

6. **HITS hybrid**: combine PPR (authority-style relevance) with hub scores (link-out concentration) for questions like "which page is the canonical index for X?". Niche but useful.

7. **Subgraph extraction**: given PPR results, extract the induced subgraph over the top-N nodes plus their interconnecting edges. Emit as Graphviz / Mermaid for visual exploration. Useful for "show me the FAA NMS neighborhood" diagrammatic queries.

## Why this is the right intervention (post-spike rewrite)

The original framing was wrong in one important way: I claimed PPR would address Q13's failure mode (graph missed `Cycle-Aware Publication Refresh`). The spike disproved this — PPR's hub-bias means it converges to catalog pages, not buried-but-canonical concept pages. Q13 stays the hybrid pipeline's territory.

What PPR *does* address is a real and adjacent failure mode: questions where the agent **knows the seeds but the manual graph walk is tedious**. The v3 graph skill's Q9, Q10, Q12 all required the agent to manually run `qkb search` → `qkb graph query` to find node IDs → `qkb graph neighbors` → resolve IDs to titles via another Cypher → filter → read. PPR collapses the seed-finding + diffusion + ranking into one command at ~1s.

So the v1 shipping pitch is:

- **For relational/pairwise questions where seeds are lexically findable** (Q9, Q10, Q12 shape): PPR is a 5–10× latency improvement over manual graph walks, *and* often surfaces 2-hop-relevant nodes the agent wouldn't have walked to manually.
- **Not** a replacement for `qkb query --graph` on vocabulary-mismatched synthesis (Q13 shape).
- **Cheap to implement, small risk surface, additive command, no existing path changes.**

The spike proved the algorithm works and exposed the hub-bias limitation honestly. The spec is now defensible; the implementation is straightforward.

## References

- Haveliwala, T. (2002). *Topic-Sensitive PageRank.* WWW 2002 — foundational PPR paper.
- Microsoft Research (2024). *GraphRAG.* Uses PPR-style diffusion for entity-anchored RAG.
- RFC-0007: GraphQLite graph layer — schema + edge types this command consumes.
- RFC-0008: Hybrid graph query strategies — the complementary chunk-level path.
- `bench/results/skill-bench-v3-2026-05-13.html` — bench data showing Q13 failure mode this command addresses.
