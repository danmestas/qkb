# Changelog

## [Unreleased]

### Fixes

- **`qkb query --graph` now actually changes top-N results.** Surfaced
  by running 12 demo queries on flight-planner-kb: post-PR-#53, the
  graph expansion fired (40-49 novel candidates per query) but they
  got appended after the existing 40 RRF candidates and sliced out
  before reaching the reranker — the flag was effectively a no-op at
  default `--candidate-limit`. Fix: blend the graph expansion as a
  second list into the existing RRF rather than appending. Graph
  candidates compete for slots in the rerank pool by their per-edge-
  weighted rank; the reranker stays the final arbiter (so bad graph
  promotions get demoted by the cross-encoder). Logic extracted into
  testable `mergeFusedWithGraphExpansion` helper. After the fix,
  "flight safety regulations" surfaces ICAO and country-united-states
  as graph-injected top-5 hits that pure lexical/vector missed.

### Changes

- **`qkb query --graph` — edge-weighted graph expansion (RFC-0008 strategy #2).**
  Optional flag that injects 1-hop graph-derived candidates into the
  hybrid retrieval pool, weighted by edge type. After the existing
  RRF fuse produces post-vector/BM25 candidates, the top-20 seed an
  outgoing-edge expansion: each `EMBEDS` neighbor contributes 0.9,
  `LINKS_TO` 0.4, `REFERENCES` 0.2 (tunable via `--graph-weights`).
  Novel docs (not already in the candidate pool) get appended for the
  reranker to consider. Single batched Cypher call (~10ms) + two SQL
  joins (~5ms) — well under the latency budget. No-op when the graph
  layer is empty/unavailable; failures during expansion log a warning
  and the query proceeds without it.

  RFC-0008 (`docs/rfcs/0008-hybrid-graph-query.md`) documents this
  strategy plus three more (Personalized PageRank, subgraph-as-context
  for the reranker, GraphRAG-lite community summaries) for future work.

  Examples:
  ```
  qkb query "FAA NMS landing requirements" --graph
  qkb query "..." --graph --graph-weights '{"EMBEDS": 1.0, "LINKS_TO": 0.3}'
  ```

- **`qkb update` now auto-runs `graph link` when the graph layer is enabled.**
  After every collection re-index, the structural graph is refreshed
  in-place — wikilinks, embeds, and frontmatter labels stay in sync
  with the corpus without a manual step. Idempotent and fast (~28s
  on flight-planner-kb's 638 docs / 5,140 edges since the multi-MERGE
  bulk path landed). Soft-failure: if the link step throws, update
  prints a warning and continues — the search index itself is correct
  regardless. Opt out by setting `graph.enabled: false`.

- **`qkb graph neighbors <id> [--hops N] [--edge-types T1,T2] [--json]`.**
  CLI exposure of the existing MCP `graph_neighbors` tool path. Drops a
  Cypher-fluency requirement for "what does this doc link to?" — users
  pass a node id and hop count, the helper handles the v0.4.4
  var-length-relationship + `type(r)` quirks internally. Hops capped at
  3 (use `graph query` for deeper traversal). Single shared
  implementation (`findNeighbors`) in the SDK; MCP and CLI both
  delegate, so v0.4.4 quirks are pinned in one place.

  Examples:
  ```
  qkb graph neighbors doc:531 --hops 1
  qkb graph neighbors doc:531 --hops 2 --edge-types LINKS_TO --json
  ```

- **`qkb graph link` — vault-aware structural graph extraction (no LLM).**
  Bug-watch on flight-planner-kb (124 MB, 638 docs) found 8,964
  `[[wikilinks]]` and 38 `![[embeds]]` entirely unused by the graph
  layer. Phase 2D's LLM extraction can't run on real corpora (model
  capability gap), but Obsidian-style vaults already encode the graph
  in markdown — every `[[Page]]` is a relationship. New CLI command
  walks the document table, parses YAML frontmatter (`type:`, `aliases:`,
  `title:`), classifies docs by frontmatter-type or path
  (`wiki/entities/*` → Entity, `wiki/concepts/*` → Concept, etc.),
  extracts wikilinks/embeds/markdown-refs, resolves them via Obsidian's
  filename-stem rule plus aliases, and bulk-upserts:

  ```
  (:Entity)-[:LINKS_TO]->(:Concept)        — resolved wikilink
  (:Source)-[:EMBEDS]->(:Note)             — resolved ![[X]]
  (:Note)-[:REFERENCES]->(:Note)           — resolved ](rel.md)
  (:Note)-[:LINKS_TO]->(:WikiTarget)       — unresolved (dead refs)
  ```

  On flight-planner-kb: 639 docs → 703 typed nodes (19 distinct labels)
  + 5,090 LINKS_TO edges + 64 unresolved wikilinks (dead refs surfaced
  as `:WikiTarget` placeholders). Inspired by the `vault-ingest` and
  `vault-query` skills in the flight-planner-kb itself. Pure regex +
  YAML parsing — no LLM in the loop.

- **Graph bulk-insert is ~25× faster (14m45s → 35s on flight-planner-kb).**
  `store.graph.upsertNodesBulk` and `upsertEdgesBulk` now issue one
  Cypher call per chunk of 25 (edges) or 100 (new nodes), using a
  single MATCH clause + comma-separated MERGE/SET patterns rather than
  one Cypher round-trip per element. The interface is unchanged — every
  caller (`graph link`, `graph extract`, `graph restore`) gets the
  speedup automatically. Chunk caps are tuned to SQLite's
  `at most 64 tables in a join` limit; v0.4.4 quirks empirically pinned
  in `test/spikes/probe-multi-merge.ts` and `probe-limit.ts`.

### Fixes

- **`store.graph.cypher()` no longer crashes on write queries.**
  GraphQLite returns a status string like
  `"Query executed successfully - nodes created: N, ..."` for write
  queries with no `RETURN` clause. `runCypher()` did `JSON.parse(row.r)`
  unconditionally, which threw on the status text. The CLI surfaced
  this as `graph query: JSON Parse error: Unexpected identifier "Query"`.
  Fix: wrap the parse in try/catch, return `[]` on parse failure
  (consistent with the existing non-array fallback). Test added.

- **`qkb graph` subcommands now respect `--index`.** Previously the
  `case "graph"` block in the CLI dispatcher used `createStore()`
  directly instead of the cached `getStore()`, which meant
  `--index foo` was silently ignored — all graph subcommands operated
  on the default `~/.cache/qkb/index.sqlite` regardless of which
  index the user selected. Surfaced in production via a real-corpus
  bug-watch session: `qkb --index flight-extract graph extract` saw
  0 documents because the empty default index was queried instead of
  the 638-doc flight-planner index. One-line fix in `src/cli/qkb.ts`.

- **Entity-extraction parser now accepts NDJSON.** Small generate
  models (notably the default 1.7B `qmd-query-expansion`) emit one
  `{"type":"...","name":"..."}` per line instead of a JSON array
  even when prompted for an array. The parser now tries the JSON-
  array form first, then falls back to line-by-line parsing.
  Surrounding prose, blank lines, and bare top-level objects are all
  tolerated. **Note**: the 1.7B query-expansion model isn't a
  capable enough entity extractor for documents over ~500 chars
  (returns empty string on most real documents) — a stronger
  `models.generate` is needed for production extraction. The parser
  fix is what unblocks users who DO have a capable model configured.

## [3.0.0] - 2026-05-08

### BREAKING

- **RFC-0007 PR-20 (Phase 3): `graph.enabled` default flipped to true.**
  Users with no `graph` block in their config now get the graph layer
  enabled by default. Behavior gracefully degrades to "unavailable"
  when the GraphQLite extension can't be loaded, so this is safe for
  users without graphqlite installed — they see no functional change.
  Users who want to opt out explicitly should set:

  ```yaml
  graph:
    enabled: false
  ```

  in `~/.config/qkb/index.yml`. The version bump to v3.0.0 is justified
  by this default-behavior change alone — no API-surface breaks.

## [2.3.0] - 2026-05-08

### Changes

- **RFC-0007 PR-18 (Phase 2E): 24-hour soak harness + nightly CI.**
  `bench/graph-soak.ts` runs continuous indexing + querying with
  RSS / file size / query p95 sampling. Pass criteria: 0 errors, RSS
  growth < 50 MB/hr, p95 drift < 3x. `--full` enables the 24-hour
  validation mode for local pre-release runs; default 30 min suits CI.
  New nightly workflow `.github/workflows/graph-soak-nightly.yml` runs
  the 30-min soak on macos-latest with brew-installed graphqlite at
  04:17 UTC daily; results uploaded as artifacts (30-day retention).

- **RFC-0007 PR-17 (Phase 2D): LLM entity extraction + `qkb graph extract`.**
  New module `src/graph/entity-extraction.ts` exports `extractEntities(llm,
  text, types, options?)` and a parser tolerant of `\`\`\`json` fences,
  leading prose, and malformed JSON (degrades to `[]`). New CLI command
  `qkb graph extract [collection] [-n N]` iterates active documents,
  invokes the configured generate model, and bulk-upserts `entity:{type}:
  {normalized_name}` nodes linked from `doc:{id}` via MENTIONS. Document-
  level (not chunk-level) — the natural granularity for "find docs that
  mention X" queries. Extraction is opportunistic: LLM unavailable or
  malformed output simply produces 0 entities for that doc; doesn't abort.
  **NOT** wired into the `qkb embed` loop — keeps embed perf characteristics
  unchanged and makes resource cost visible.

- **RFC-0007 PR-16 (Phase 2C): entity extraction config flag.** Adds
  `graph.entity_extraction.{enabled, model, types}` to the YAML config
  schema. Defaults: enabled=false, types=`[Person, Organization, Concept]`.
  `model` is an optional URI override; when unset, falls back to the
  global `models.generate`. Type entries validated against the Cypher
  identifier regex (alphanumeric + underscore, leading non-digit).
  Scaffold only — actual extraction logic lands in PR-17.

- **RFC-0007 PR-15 (Phase 2B): hybrid query strategies.** Adds two
  graph-aware composition primitives. `store.graph.filterThenRank({cypher,
  params})` runs a Cypher query and returns the resulting `(hash, seq)`
  candidate set; the caller passes those to existing FTS/vector scoring
  for the cheap "filter first, then rank" path. `store.graph.rankThenRerank
  ({seeds, hops?, edgeTypes?, rrfK?})` blends a precomputed seed-list
  ranking with a graph-neighbor expansion via Reciprocal Rank Fusion
  (k=60 by default). Both are additive — existing `store.search()`
  defaults are unchanged. Edge-type whitelist validates against the
  Cypher identifier regex.

- **RFC-0007 PR-14 (Phase 2A): bulk insert SDK.** Adds
  `store.graph.upsertNodesBulk(nodes[])` and
  `store.graph.upsertEdgesBulk(edges[])`. Wraps the per-call upsert in
  a single SQLite transaction, amortizing per-statement fsync overhead
  across the batch. Atomicity preserved — invalid input rejects the
  whole batch (no partial commit). Indexing pipeline (PR-17) uses this
  path for entity-extraction-time emissions.

## [2.2.0] - 2026-05-07

### Changes

- **Dependency refresh.** Bumped to latest patch/minor/major where safe:
  `better-sqlite3 12.8.0 → 12.9.0`, `web-tree-sitter 0.26.7 → 0.26.8`,
  `yaml 2.8.3 → 2.8.4`, `tree-sitter-{go,python} 0.23.4 → 0.25.0`, and
  the major bump `vitest 3.2.4 → 4.1.5` (test runner). All 879 tests
  pass under vitest 4. **zod stays at 4.2.1** — bumping to 4.4.3 broke
  the type contract with `@modelcontextprotocol/sdk` 1.29.0's
  `AnySchema` expectations (caught by `npm run build` in `publish.yml`,
  not by vitest which uses esbuild and skips strict typecheck). Revisit
  in a future release once MCP SDK ships zod-4.4-compatible typings.
  TypeScript peer requirement left at `^5.9.3` — bumping to TS 6
  unverified-locally would exclude TS 5 consumers.

- **RFC-0007 D11: hard-pin GraphQLite version.** New
  `scripts/graphqlite-versions.json` is the single source of truth for
  the pinned GraphQLite version (currently 0.4.4). `graph_meta` now
  records the pinned version read from this file rather than a
  hardcoded literal. Bumping requires re-running
  `test/spikes/probe-merge-syntax.ts` to verify the documented v0.4.4
  workarounds still apply. PR-4b's lazy postinstall will populate the
  `checksums` field for verified-binary downloads.

- **RFC-0007 PR-12: graph performance harness.** Adds `bench/graph-bench.ts`
  + `src/graph/bench.ts` — measures the four runtime metrics from RFC §10
  (cold extension load, 2-hop neighbor p95, PageRank latency, empty-graph
  on-disk delta) against a synthetic corpus. Two modes: `--full` enforces
  the production §10 thresholds against a 10k-node graph; default (CI)
  mode uses 500 nodes with looser thresholds for deterministic runner
  performance. Exits non-zero on any threshold violation. Local CI-mode
  run confirms all thresholds pass with comfortable headroom (cold-load
  15 ms vs 500 ms; pagerank 1 ms vs 5000 ms; 2-hop p95 4 ms vs 100 ms;
  file delta 184 KB vs 256 KB). CI workflow integration deferred to PR-4b
  (which installs graphqlite on runners).

- **RFC-0007 PR-11: `qkb graph dump` / `qkb graph restore` (exit-plan
  tool).** RFC §7 commitment — the exit door from GraphQLite. Dump
  emits the entire graph as QKB-defined NDJSON to stdout (header line
  + one node-or-edge object per line). Restore reads the same format
  from stdin and replays it through the SDK upsert calls. Format is
  versioned (`format_version: 1`) and decoupled from GraphQLite, so a
  future Kùzu/Cozo backend can consume it directly. Round-trip
  preserves nodes (idempotent — upsert), edges (idempotent because
  inline-property MERGE matches), and properties.

- **RFC-0007 PR-10: graph MCP tools (`graph_query`, `graph_neighbors`).**
  Two MCP tools exposing the graph layer to agents. `graph_query(cypher,
  params)` mirrors the SDK rules — refuses queries with `$param`
  references when params is empty. `graph_neighbors(node_id, hops,
  edge_types?)` is a constrained traversal that doesn't require
  Cypher knowledge; hops capped at 3. PageRank and `gc` are
  **deliberately not exposed** via MCP per RFC §4.6.3 (resource
  exhaustion + mutation surface). When the layer is unavailable,
  tools return `isError: true` with the unavailable reason so agents
  can discover and request enablement.

- **RFC-0007 PR-9: `qkb graph` CLI subcommands.** Adds four subcommands
  surfacing the graph layer at the command line:
  `qkb graph status` (layer state, version, node+edge counts);
  `qkb graph query [--params '{...}'] "<cypher>"` (runs a Cypher query;
  refuses if `$param` references present without `--params`);
  `qkb graph pagerank [--top N]` (default N=20);
  `qkb graph gc [--dry-run]` (sweep orphan `chunk:*` nodes per
  RFC §4.3). Logic in `src/graph/cli.ts` is unit-testable via pure
  functions; the dispatcher in `src/cli/qkb.ts` parses argv, calls them,
  exits with the returned code.

### Docs

- **RFC-0007 PR-8: graph algorithms + path-length cap.** Adds
  `store.graph.pageRank({damping?, iterations?})` returning typed
  `[{node_id, user_id, score}]`. Adds `validateMaxPathLength(query, max)`
  in `src/graph/safety.ts` — wired into `store.graph.cypher()` so any
  variable-length pattern (`*N..M`, `*..M`, `*N`, bare `*`) exceeding
  the configured cap throws `CypherPathLengthError` at the SDK
  boundary. Default `max_path_length=6`, ceiling 12. `query_timeout_ms`
  enforcement is deferred — neither bun:sqlite nor better-sqlite3
  exposes SQLite's progress-handler in a portable way; tracked in PLAN.md.

- **RFC-0007 PR-7: cross-extension transactions + cascade cleanup.** Adds
  `cleanupOrphanedChunkNodes(db)` to remove `chunk:*` graph nodes whose
  `hash` no longer exists in `content` (RFC §4.3 soft-reference cleanup).
  Integration tests verify that a transaction spanning `content` +
  `content_vectors` + a graph `cypher()` write commits and rolls back
  atomically, and that the cleanup leaves non-chunk nodes (entities) and
  alive chunks alone.

- **RFC-0007 PR-6: typed graph SDK.** Adds `store.graph.upsertNode()`,
  `store.graph.upsertEdge()`, `store.graph.cypher<T>()` and the `cypher`
  tagged-template helper. The branded `CypherQuery` type rejects raw
  string interpolation in value positions at compile time; the runtime
  guard in `cypher` catches `as any` bypasses. All methods throw
  `GraphDisabledError` when the layer is unavailable. Documents three
  GraphQLite v0.4.4 quirks (`MERGE` + `$param` in inline pattern,
  chained MERGE variable propagation, `CREATE` + `SET` combined call —
  see `test/spikes/probe-merge-syntax.ts`) and works around each one.

- **RFC-0007: Optional Graph Layer for QKB via GraphQLite.** Initial draft of
  the design for an opt-in graph layer (off-by-default `graph.enabled` flag,
  GraphQLite SQLite extension on the same connection as `sqlite-vec`, typed
  SDK with parameterized Cypher, MCP tool surface). Roadmap and per-PR plan
  in `docs/rfcs/0007-impl/PLAN.md`. No code changes yet.
- **RFC-0007 PR-5: graph schema bootstrap.** When `graph.enabled=true`,
  `initializeDatabase()` now attempts to load GraphQLite via the PR-4
  loader and creates a `graph_meta` singleton-row table tracking which
  GraphQLite version initialized the DB. Mirrors the `sqlite-vec`
  graceful-degrade pattern: missing binary or invalid graph config
  warns and continues; non-graph features unaffected. Idempotent across
  re-opens. Adds `isGraphLayerAvailable()` / `getGraphLayerUnavailableReason()`
  for future SDK methods to gate on.

- **RFC-0007 PR-4: GraphQLite extension loader.** Adds
  `src/graph/loader.ts` with `loadGraphqlite(db)` and
  `resolveGraphqlitePath()`. Path resolution: `QKB_GRAPHQLITE_PATH` env
  var (the C-mode escape hatch from D7) → platform-default Homebrew /
  Linux paths. `GraphExtensionUnavailableError` thrown with attempted
  path + install hint when binary is missing. **No callers yet** —
  PR-5 wires it into `openDatabase()` behind `graph.enabled`. Lazy
  postinstall download is deferred to PR-4b.

- **RFC-0007 PR-3: `graph.enabled` config flag.** YAML `graph:` block now
  recognized in `~/.config/qkb/index.yml` with fields `enabled` (default
  `false`), `bulk_insert_threshold` (default 64), `query_timeout_ms`
  (default 5000), `max_path_length` (default 6, ceiling 12). Validated via
  zod; misconfigured fields throw at config load. Adds `GraphDisabledError`
  for future SDK methods. No behavior change yet (no extension loaded).

- **RFC-0007 spikes (Q1/Q2/Q4/Q5).** `test/spikes/graphqlite-spikes.test.ts`
  (skip-by-default; opt in via `QKB_RUN_SPIKES=1`) verifies that GraphQLite
  participates in nested SAVEPOINTs, coexists with sqlite-vec on a single
  connection, and shares atomic-rollback semantics. Empty-graph on-disk
  delta measured at 184 KB (RFC §10 budget revised from 64 KB to 256 KB).
  Vendoring resolved as A+C hybrid (lazy postinstall + `QKB_GRAPHQLITE_PATH`
  env-var override) since GraphQLite publishes no npm packages. Single-graph
  per DB (the `qkb` namespace concept removed — the actual `cypher()` SQL
  signature is `(query, params)`, not `(namespace, query, params)`).
  Findings in `docs/rfcs/0007-impl/SPIKE-RESULTS.md`.

### BREAKING

- **Project rename: `qmd` → `qkb` (Query Knowledge Base).** This is a hard
  rename of every user-facing surface; consumers must update their setup.
  - Package: `@tobilu/qmd` → `@tobilu/qkb`. Reinstall with
    `npm install -g @tobilu/qkb` (or the bun equivalent).
  - CLI binary: `qmd` → `qkb`. All command examples in docs and skills
    updated. Old `qmd` invocations no longer resolve.
  - Environment variables: every `QMD_*` env var is now `QKB_*`
    (`QMD_EMBED_MODEL` → `QKB_EMBED_MODEL`, `QMD_LLAMA_GPU` →
    `QKB_LLAMA_GPU`, `QMD_RERANK_CONTEXT_SIZE` → `QKB_RERANK_CONTEXT_SIZE`,
    `QMD_EMBED_CONTEXT_SIZE` → `QKB_EMBED_CONTEXT_SIZE`,
    `QMD_GENERATE_MODEL` → `QKB_GENERATE_MODEL`, `QMD_RERANK_MODEL` →
    `QKB_RERANK_MODEL`, `QMD_EDITOR_URI` → `QKB_EDITOR_URI`,
    `QMD_STATUS_DEVICE_PROBE` → `QKB_STATUS_DEVICE_PROBE`, etc.).
  - Disk paths: cache moved from `~/.cache/qmd/` to `~/.cache/qkb/`,
    config from `~/.config/qmd/` to `~/.config/qkb/`. Existing index DBs
    will need to be moved or rebuilt; the SQLite schema is unchanged.
  - Virtual URL scheme: `qmd://` → `qkb://` everywhere (search results,
    `get`/`multi-get` arguments, context paths, MCP resource URIs). The
    store opens with a one-shot data migration that rewrites legacy
    `qmd://` literals stored in `store_collections.context`,
    `store_collections.update_command`, and `store_config` to `qkb://`,
    so previously-saved contexts continue to resolve.
  - Embedded skill: `skills/qmd/` → `skills/qkb/`; the skill installer
    now writes to `.agents/skills/qkb` and `.claude/skills/qkb`.
  - MCP server identity: `serverInfo.name` is now `"qkb"`.

### Changes

- CD: `Changelog Gate` workflow now blocks PRs to `main` that don't add an
  entry under `## [Unreleased]`. Apply the `skip-changelog` label for
  cosmetic-only PRs (typos, CI tweaks, internal refactors).
- CD: `publish.yml` now smoke-installs the freshly-published package from
  the npm registry and runs `qkb --help` before creating the GitHub
  release. Catches the "publish succeeded but the artifact is broken" class.
- CD: `scripts/dora.sh` extracts DORA-lite metrics (lead time, deployment
  frequency, change failure rate, MTTR) from the GitHub API. Defaults to
  the last 90 days. Use `--days N` for custom windows or `--json` for
  machine-readable output.
- CD: added `.github/CODEOWNERS` and `.github/pull_request_template.md`.
  CODEOWNERS auto-requests review on every PR; PR template prompts for
  summary, verification, and changelog discipline.

### Fixes

- GPU: respect explicit `QKB_LLAMA_GPU=metal|vulkan|cuda` backend overrides instead of always using auto GPU selection. #529
- Fix: preserve original filename case in `handelize()`. The previous
  `.toLowerCase()` call made indexed paths unreachable on case-sensitive
  filesystems (Linux). `qkb update` automatically migrates legacy
  lowercase paths without re-embedding.
- CLI: make `qkb status` skip native `node-llama-cpp` device probing by
  default so status stays safe on machines with broken or unsupported GPU
  drivers. Set `QKB_STATUS_DEVICE_PROBE=1` to opt in.

## [2.1.0] - 2026-04-05

Code files now chunk at function and class boundaries via tree-sitter,
clickable editor links land you at the right line from search results,
and per-collection model configuration means you can point different
collections at different embedding models. 25+ community PRs fix
embedding stability, BM25 accuracy, and cross-platform launcher issues.

### Changes

- AST-aware chunking for code files via `web-tree-sitter`. Supported
  languages: TypeScript/JavaScript, Python, Go, and Rust. Code files
  are chunked at function, class, and import boundaries instead of
  arbitrary text positions. Markdown and unknown file types are unchanged.
  `--chunk-strategy <auto|regex>` flag on `qmd embed` and `qmd query`
  (default `regex`). SDK: `chunkStrategy` option on `embed()` and
  `search()`. `qmd status` shows grammar availability.
- `qmd bench <fixture.json>` command for search quality benchmarks.
  Measures precision@k, recall, MRR, and F1 across BM25, vector, hybrid,
  and full pipeline backends. Ships with an example fixture against
  the eval-docs test collection. #470 (thanks @jmilinovich)
- `models:` section in `index.yml` lets you configure `embed`, `rerank`,
  and `generate` model URIs per collection. Resolution order is
  config > env var (`QMD_EMBED_MODEL`, `QMD_RERANK_MODEL`,
  `QMD_GENERATE_MODEL`) > built-in default. #502
  (thanks @JohnRichardEnders)
- CLI search output now emits clickable OSC 8 terminal hyperlinks when
  stdout is a TTY. Links resolve `qmd://` paths to absolute filesystem
  paths and open in editors via URI templates (default:
  `vscode://file/{path}:{line}:{col}`). Configure with `QMD_EDITOR_URI`
  or `editor_uri` in the YAML config. #508 (thanks @danmackinlay)
- `--no-rerank` flag skips the reranking step in `qmd query` — useful
  when you want fast results or don't have a GPU. Also exposed as
  `rerank: false` on the MCP `query` tool. #370 (thanks @mvanhorn),
  #478 (thanks @zestyboy)
- ONNX conversion script for deploying embedding models via
  Transformers.js. #399 (thanks @shreyaskarnik)
- GitHub Actions workflow to build the Nix flake on Linux and macOS.

### Fixes

- Embedding: prevent `qmd embed` from running indefinitely when the
  embedding loop stalls. #458 (thanks @ccc-fff)
- Embedding: truncate oversized text before embedding to prevent GGML
  crash, and bound memory usage during batch embedding. #393
  (thanks @lskun), #395 (thanks @ProgramCaiCai)
- Embedding: set explicit embed context size (default 2048, configurable
  via `QMD_EMBED_CONTEXT_SIZE`) instead of using the model's full
  window. #500
- Embedding: error on dimension mismatch instead of silently rebuilding
  the vec0 table. #501
- Embedding: handle vec0 `OR REPLACE` limitation in `insertEmbedding`.
  #456 (thanks @antonio-mello-ai)
- Embedding: fix model selection when multiple models are configured.
  #494
- BM25: correct field weights to include all 3 FTS columns — title,
  body, and path were not weighted correctly. #462 (thanks @goldsr09)
- BM25: handle hyphenated tokens in FTS5 lex queries so terms like
  "real-time" match correctly. #463 (thanks @goldsr09)
- BM25: preserve underscores in search terms instead of stripping them.
  #404
- BM25: use CTE in `searchFTS` to prevent query planner regression with
  collection filter.
- Reranker: increase default context size 2048→4096 and make
  configurable via `QMD_RERANK_CONTEXT_SIZE`. Fix template overhead
  underestimate 200→512. #453 (thanks @builderjarvis)
- GPU: catch initialization failures and fall back to CPU instead of
  crashing.
- MCP: read version from `package.json` instead of hardcoding. #431
- MCP: include collection name in status output. #416
- Multi-get: support brace expansion patterns in glob matching. #424
- Launcher: prioritize `package-lock.json` to prevent Bun false
  positive. #385 (thanks @rymalia)
- Launcher: remove `$BUN_INSTALL` check that caused false Bun detection.
  #362 (thanks @syedair)
- Launcher: skip Git Bash path detection on WSL. #371
  (thanks @oysteinkrog)
- Model cache: respect `XDG_CACHE_HOME` for model cache directory. #457
  (thanks @antonio-mello-ai)
- SQLite: add macOS Homebrew SQLite support for Bun and restore
  actionable errors. #377 (thanks @serhii12)
- Pin zod to exact 4.2.1 to fix `tsc` build failure. #382
  (thanks @rymalia)
- Preserve dots and original case in `handelize()` — filenames like
  `MEMORY.md` no longer become `memory-md`. #475 (thanks @alexei-led)
- Include `line` in `--json` search output so editor integrations can
  jump directly to `file:line`. #506 (thanks @danmackinlay)
- Nix: fix paths in flake and make Bun dependency a fixed-output
  derivation so sandboxed Linux builds work offline. #479
  (thanks @surma-dump)
- Sync stale `bun.lock` (`better-sqlite3` 11.x → 12.x). CI and release
  script now use `--frozen-lockfile` to prevent recurrence. #386
  (thanks @Mic92)
- Approve native build scripts in pnpm so `better-sqlite3` and
  tree-sitter modules compile correctly. Update vitest ^3.0.0 → ^3.2.4.

## [2.0.1] - 2026-03-10

### Changes

- `qmd skill install` copies the packaged QMD skill into
  `~/.claude/commands/` for one-command setup. #355 (thanks @nibzard)

### Fixes

- Fix Qwen3-Embedding GGUF filename case — HuggingFace filenames are
  case-sensitive, the lowercase variant returned 404. #349 (thanks @byheaven)
- Resolve symlinked global launcher path so `qmd` works correctly when
  installed via `npm i -g`. #352 (thanks @nibzard)

## [2.0.0] - 2026-03-10

QMD 2.0 declares a stable library API. The SDK is now the primary interface —
the MCP server is a clean consumer of it, and the source is organized into
`src/cli/` and `src/mcp/`. Also: Node 25 support and a runtime-aware bin wrapper
for bun installs.

### Changes

- Stable SDK API with `QMDStore` interface — search, retrieval, collection/context
  management, indexing, lifecycle
- Unified `search()`: pass `query` for auto-expansion or `queries` for
  pre-expanded lex/vec/hyde — replaces the old query/search/structuredSearch split
- New `getDocumentBody()`, `getDefaultCollectionNames()`, `Maintenance` class
- MCP server rewritten as a clean SDK consumer — zero internal store access
- CLI and MCP organized into `src/cli/` and `src/mcp/` subdirectories
- Runtime-aware `bin/qmd` wrapper detects bun vs node to avoid ABI mismatches.
  Closes #319
- `better-sqlite3` bumped to ^12.4.5 for Node 25 support. Closes #257
- Utility exports: `extractSnippet`, `addLineNumbers`, `DEFAULT_MULTI_GET_MAX_BYTES`

### Fixes

- Remove unused `import { resolve }` in store.ts that shadowed local export

## [1.1.6] - 2026-03-09

QMD can now be used as a library. `import { createStore } from '@tobilu/qmd'`
gives you the full search and indexing API — hybrid query, BM25, structured
search, collection/context management — without shelling out to the CLI.

### Changes

- **SDK / library mode**: `createStore({ dbPath, config })` returns a
  `QMDStore` with `query()`, `search()`, `structuredSearch()`, `get()`,
  `multiGet()`, and collection/context management methods. Supports inline
  config (no files needed) or a YAML config path.
- **Package exports**: `package.json` now declares `main`, `types`, and
  `exports` so bundlers and TypeScript resolve `@tobilu/qmd` correctly.

## [1.1.5] - 2026-03-07

Ambiguous queries like "performance" now produce dramatically better results
when the caller knows what they mean. The new `intent` parameter steers all
five pipeline stages — expansion, strong-signal bypass, chunk selection,
reranking, and snippet extraction — without searching on its own. Design and
original implementation by Ilya Grigorik (@vyalamar) in #180.

### Changes

- **Intent parameter**: optional `intent` string disambiguates queries across
  the entire search pipeline. Available via CLI (`--intent` flag or `intent:`
  line in query documents), MCP (`intent` field on the query tool), and
  programmatic API. Adapted from PR #180 (thanks @vyalamar).
- **Query expansion**: when intent is provided, the expansion LLM prompt
  includes `Query intent: {intent}`, matching the finetune training data
  format for better-aligned expansions.
- **Reranking**: intent is prepended to the rerank query so Qwen3-Reranker
  scores with domain context.
- **Chunk selection**: intent terms scored at 0.5× weight alongside query
  terms (1.0×) when selecting the best chunk per document for reranking.
- **Snippet extraction**: intent terms scored at 0.3× weight to nudge
  snippets toward intent-relevant lines without overriding query anchoring.
- **Strong-signal bypass disabled with intent**: when intent is provided, the
  BM25 strong-signal shortcut is skipped — the obvious keyword match may not
  be what the caller wants.
- **MCP instructions**: callers are now guided to provide `intent` on every
  search call for disambiguation.
- **Query document syntax**: `intent:` recognized as a line type. At most one
  per document, cannot appear alone. Grammar updated in `docs/SYNTAX.md`.

## [1.1.2] - 2026-03-07

13 community PRs merged. GPU initialization replaced with node-llama-cpp's
built-in `autoAttempt` — deleting ~220 lines of manual fallback code and
fixing GPU issues reported across 10+ PRs in one shot. Reranking is faster
through chunk deduplication and a parallelism cap that prevents VRAM
exhaustion.

### Changes

- **GPU init**: use node-llama-cpp's `build: "autoAttempt"` instead of manual
  GPU backend detection. Automatically tries Metal/CUDA/Vulkan and falls back
  gracefully. #310 (thanks @giladgd — the node-llama-cpp author)
- **Query `--explain`**: `qmd query --explain` exposes retrieval score traces
  — backend scores, per-list RRF contributions, top-rank bonus, reranker
  score, and final blended score. Works in JSON and CLI output. #242
  (thanks @vyalamar)
- **Collection ignore patterns**: `ignore: ["Sessions/**", "*.tmp"]` in
  collection config to exclude files from indexing. #304 (thanks @sebkouba)
- **Multilingual embeddings**: `QMD_EMBED_MODEL` env var lets you swap in
  models like Qwen3-Embedding for non-English collections. #273 (thanks
  @daocoding)
- **Configurable expansion context**: `QMD_EXPAND_CONTEXT_SIZE` env var
  (default 2048) — previously used the model's full 40960-token window,
  wasting VRAM. #313 (thanks @0xble)
- **`candidateLimit` exposed**: `-C` / `--candidate-limit` flag and MCP
  parameter to tune how many candidates reach the reranker. #255 (thanks
  @pandysp)
- **MCP multi-session**: HTTP transport now supports multiple concurrent
  client sessions, each with its own server instance. #286 (thanks @joelev)

### Fixes

- **Reranking performance**: cap parallel rerank contexts at 4 to prevent
  VRAM exhaustion on high-core machines. Deduplicate identical chunk texts
  before reranking — same content from different files now shares a single
  reranker call. Cache scores by content hash instead of file path.
- Deactivate stale docs when all files are removed from a collection and
  `qmd update` is run. #312 (thanks @0xble)
- Handle emoji-only filenames (`🐘.md` → `1f418.md`) instead of crashing.
  #308 (thanks @debugerman)
- Skip unreadable files during indexing (e.g. iCloud-evicted files returning
  EAGAIN) instead of crashing. #253 (thanks @jimmynail)
- Suppress progress bar escape sequences when stderr is not a TTY. #230
  (thanks @dgilperez)
- Emit format-appropriate empty output (`[]` for JSON, CSV header for CSV,
  etc.) instead of plain text "No results." #228 (thanks @amsminn)
- Correct Windows sqlite-vec package name (`sqlite-vec-windows-x64`) and add
  `sqlite-vec-linux-arm64`. #225 (thanks @ilepn)
- Fix claude plugin setup CLI commands in README. #311 (thanks @gi11es)

## [1.1.1] - 2026-03-06

### Fixes

- Reranker: truncate documents exceeding the 2048-token context window
  instead of silently producing garbage scores. Long chunks (e.g. from
  PDF ingestion) now get a fair ranking.
- Nix: add python3 and cctools to build dependencies. #214 (thanks
  @pcasaretto)

## [1.1.0] - 2026-02-20

QMD now speaks in **query documents** — structured multi-line queries where every line is typed (`lex:`, `vec:`, `hyde:`), combining keyword precision with semantic recall. A single plain query still works exactly as before (it's treated as an implicit `expand:` and auto-expanded by the LLM). Lex now supports quoted phrases and negation (`"C++ performance" -sports -athlete`), making intent-aware disambiguation practical. The formal query grammar is documented in `docs/SYNTAX.md`.

The npm package now uses the standard `#!/usr/bin/env node` bin convention, replacing the custom bash wrapper. This fixes native module ABI mismatches when installed via bun and works on any platform with node >= 22 on PATH.

### Changes

- **Query document format**: multi-line queries with typed sub-queries (`lex:`, `vec:`, `hyde:`). Plain queries remain the default (`expand:` implicit, but not written inside the document). First sub-query gets 2× fusion weight — put your strongest signal first. Formal grammar in `docs/SYNTAX.md`.
- **Lex syntax**: full BM25 operator support. `"exact phrase"` for verbatim matching; `-term` and `-"phrase"` for exclusions. Essential for disambiguation when a term is overloaded across domains (e.g. `performance -sports -athlete`).
- **`expand:` shortcut**: send a single plain query (or start the document with `expand:` on its only line) to auto-expand via the local LLM. Query documents themselves are limited to `lex`, `vec`, and `hyde` lines.
- **MCP `query` tool** (renamed from `structured_search`): rewrote the tool description to fully teach AI agents the query document format, lex syntax, and combination strategy. Includes worked examples with intent-aware lex.
- **HTTP `/query` endpoint** (renamed from `/search`; `/search` kept as silent alias).
- **`collections` array filter**: filter by multiple collections in a single query (`collections: ["notes", "brain"]`). Removed the single `collection` string param — array only.
- **Collection `include`/`exclude`**: `includeByDefault: false` hides a collection from all queries unless explicitly named via `collections`. CLI: `qmd collection exclude <name>` / `qmd collection include <name>`.
- **Collection `update-cmd`**: attach a shell command that runs before every `qmd update` (e.g. `git stash && git pull --rebase --ff-only && git stash pop`). CLI: `qmd collection update-cmd <name> '<cmd>'`.
- **`qmd status` tips**: shows actionable tips when collections lack context descriptions or update commands.
- **`qmd collection` subcommands**: `show`, `update-cmd`, `include`, `exclude`. Bare `qmd collection` now prints help.
- **Packaging**: replaced custom bash wrapper with standard `#!/usr/bin/env node` shebang on `dist/qmd.js`. Fixes native module ABI mismatches when installed via bun, and works on any platform where node >= 22 is on PATH.
- **Removed MCP tools** `search`, `vector_search`, `deep_search` — all superseded by `query`.
- **Removed** `qmd context check` command.
- **CLI timing**: each LLM step (expand, embed, rerank) prints elapsed time inline (`Expanding query... (4.2s)`).

### Fixes

- `qmd collection list` shows `[excluded]` tag for collections with `includeByDefault: false`.
- Default searches now respect `includeByDefault` — excluded collections are skipped unless explicitly named.
- Fix main module detection when installed globally via npm/bun (symlink resolution).

## [1.0.7] - 2026-02-18

### Changes

- LLM: add LiquidAI LFM2-1.2B as an alternative base model for query
  expansion fine-tuning. LFM2's hybrid architecture (convolutions + attention)
  is 2x faster at decode/prefill vs standard transformers — good fit for
  on-device inference.
- CLI: support multiple `-c` flags to search across several collections at
  once (e.g. `qmd search -c notes -c journals "query"`). #191 (thanks
  @openclaw)

### Fixes

- Return empty JSON array `[]` instead of no output when `--json` search
  finds no results.
- Resolve relative paths passed to `--index` so they don't produce malformed
  config entries.
- Respect `XDG_CONFIG_HOME` for collection config path instead of always
  using `~/.config`. #190 (thanks @openclaw)
- CLI: empty-collection hint now shows the correct `collection add` command.
  #200 (thanks @vincentkoc)

## [1.0.6] - 2026-02-16

### Changes

- CLI: `qmd status` now shows models with full HuggingFace links instead of
  static names in `--help`. Model info is derived from the actual configured
  URIs so it stays accurate if models change.
- Release tooling: pre-push hook handles non-interactive shells (CI, editors)
  gracefully — warnings auto-proceed instead of hanging on a tty prompt.
  Annotated tags now resolve correctly for CI checks.

## [1.0.5] - 2026-02-16

The npm package now ships compiled JavaScript instead of raw TypeScript,
removing the `tsx` runtime dependency. A new `/release` skill automates the
full release workflow with changelog validation and git hook enforcement.

### Changes

- Build: compile TypeScript to `dist/` via `tsc` so the npm package no longer
  requires `tsx` at runtime. The `qmd` shell wrapper now runs `dist/qmd.js`
  directly.
- Release tooling: new `/release` skill that manages the full release
  lifecycle — validates changelog, installs git hooks, previews release notes,
  and cuts the release. Auto-populates `[Unreleased]` from git history when
  empty.
- Release tooling: `scripts/extract-changelog.sh` extracts cumulative notes
  for the full minor series (e.g. 1.0.0 through 1.0.5) for GitHub releases.
  Includes `[Unreleased]` content in previews.
- Release tooling: `scripts/release.sh` renames `[Unreleased]` to a versioned
  heading and inserts a fresh empty `[Unreleased]` section automatically.
- Release tooling: pre-push git hook blocks `v*` tag pushes unless
  `package.json` version matches the tag, a changelog entry exists, and CI
  passed on GitHub.
- Publish workflow: GitHub Actions now builds TypeScript, creates a GitHub
  release with cumulative notes extracted from the changelog, and publishes
  to npm with provenance.

## [1.0.0] - 2026-02-15

QMD now runs on both Node.js and Bun, with up to 2.7x faster reranking
through parallel GPU contexts. GPU auto-detection replaces the unreliable
`gpu: "auto"` with explicit CUDA/Metal/Vulkan probing.

### Changes

- Runtime: support Node.js (>=22) alongside Bun via a cross-runtime SQLite
  abstraction layer (`src/db.ts`). `bun:sqlite` on Bun, `better-sqlite3` on
  Node. The `qmd` wrapper auto-detects a suitable Node.js install via PATH,
  then falls back to mise, asdf, nvm, and Homebrew locations.
- Performance: parallel embedding & reranking via multiple LlamaContext
  instances — up to 2.7x faster on multi-core machines.
- Performance: flash attention for ~20% less VRAM per reranking context,
  enabling more parallel contexts on GPU.
- Performance: right-sized reranker context (40960 → 2048 tokens, 17x less
  memory) since chunks are capped at ~900 tokens.
- Performance: adaptive parallelism — context count computed from available
  VRAM (GPU) or CPU math cores rather than hardcoded.
- GPU: probe for CUDA, Metal, Vulkan explicitly at startup instead of
  relying on node-llama-cpp's `gpu: "auto"`. `qmd status` shows device info.
- Tests: reorganized into flat `test/` directory with vitest for Node.js and
  bun test for Bun. New `eval-bm25` and `store.helpers.unit` suites.

### Fixes

- Prevent VRAM waste from duplicate context creation during concurrent
  `embedBatch` calls — initialization lock now covers the full path.
- Collection-aware FTS filtering so scoped keyword search actually restricts
  results to the requested collection.

## [0.9.0] - 2026-02-15

First published release on npm as `@tobilu/qmd`. MCP HTTP transport with
daemon mode cuts warm query latency from ~16s to ~10s by keeping models
loaded between requests.

### Changes

- MCP: HTTP transport with daemon lifecycle — `qmd mcp --http --daemon`
  starts a background server, `qmd mcp stop` shuts it down. Models stay warm
  in VRAM between queries. #149 (thanks @igrigorik)
- Search: type-routed query expansion preserves lex/vec/hyde type info and
  routes to the appropriate backend. Eliminates ~4 wasted backend calls per
  query (10.0 → 6.0 calls, 1278ms → 549ms). #149 (thanks @igrigorik)
- Search: unified pipeline — extracted `hybridQuery()` and
  `vectorSearchQuery()` to `store.ts` so CLI and MCP share identical logic.
  Fixes a class of bugs where results differed between the two. #149 (thanks
  @igrigorik)
- MCP: dynamic instructions generated at startup from actual index state —
  LLMs see collection names, doc counts, and content descriptions. #149
  (thanks @igrigorik)
- MCP: tool renames (vsearch → vector_search, query → deep_search) with
  rewritten descriptions for better tool selection. #149 (thanks @igrigorik)
- Integration: Claude Code plugin with inline status checks and MCP
  integration. #99 (thanks @galligan)

### Fixes

- BM25 score normalization — formula was inverted (`1/(1+|x|)` instead of
  `|x|/(1+|x|)`), so strong matches scored *lowest*. Broke `--min-score`
  filtering and made the "strong signal" short-circuit dead code. #76 (thanks
  @dgilperez)
- Normalize Unicode paths to NFC for macOS compatibility. #82 (thanks
  @c-stoeckl)
- Handle dense content (code) that tokenizes beyond expected chunk size.
- Proper cleanup of Metal GPU resources on process exit.
- SQLite-vec readiness verification after extension load.
- Reactivate deactivated documents on re-index instead of creating duplicates.
- Bun UTF-8 path corruption workaround for non-ASCII filenames.
- Disable following symlinks in glob.scan to avoid infinite loops.

## [0.8.0] - 2026-01-28

Fine-tuned query expansion model trained with GRPO replaces the stock Qwen3
0.6B. The training pipeline scores expansions on named entity preservation,
format compliance, and diversity — producing noticeably better lexical
variations and HyDE documents.

### Changes

- LLM: deploy GRPO-trained (Group Relative Policy Optimization) query
  expansion model, hosted on HuggingFace and auto-downloaded on first use.
  Better preservation of proper nouns and technical terms in expansions.
- LLM: `/only:lex` mode for single-type expansions — useful when you know
  which search backend will help.
- LLM: HyDE output moved to first position so vector search can start
  embedding while other expansions generate.
- LLM: session lifecycle management via `withLLMSession()` pattern — ensures
  cleanup even on failure, similar to database transactions.
- Integration: org-mode title extraction support. #50 (thanks @sh54)
- Integration: SQLite extension loading in Nix devshell. #48 (thanks @sh54)
- Integration: AI agent discovery via skills.sh. #64 (thanks @Algiras)

### Fixes

- Use sequential embedding on CPU-only systems — parallel contexts caused a
  race condition where contexts competed for CPU cores, making things slower.
  #54 (thanks @freeman-jiang)
- Fix `collectionName` column in vector search SQL (was still using old
  `collectionId` from before YAML migration). #61 (thanks @jdvmi00)
- Fix Qwen3 sampling params to prevent repetition loops — stock
  temperature/top-p caused occasional infinite repeat patterns.
- Add `--index` option to CLI argument parser (was documented but not wired
  up). #84 (thanks @Tritlo)
- Fix DisposedError during slow batch embedding. #41 (thanks @wuhup)

## [0.7.0] - 2026-01-09

First community contributions. The project gained external contributors,
surfacing bugs that only appear in diverse environments — Homebrew sqlite-vec
paths, case-sensitive model filenames, and sqlite-vec JOIN incompatibilities.

### Changes

- Indexing: native `realpathSync()` replaces `readlink -f` subprocess spawn
  per file. On a 5000-file collection this eliminates 5000 shell spawns,
  ~15% faster. #8 (thanks @burke)
- Indexing: single-pass tokenization — chunking algorithm tokenized each
  document twice (count then split); now tokenizes once and reuses. #9
  (thanks @burke)

### Fixes

- Fix `vsearch` and `query` hanging — sqlite-vec's virtual table doesn't
  support the JOIN pattern used; rewrote to subquery. #23 (thanks @mbrendan)
- Fix MCP server exiting immediately after startup — process had no active
  handles keeping the event loop alive. #29 (thanks @mostlydev)
- Fix collection filter SQL to properly restrict vector search results.
- Support non-ASCII filenames in collection filter.
- Skip empty files during indexing instead of crashing on zero-length content.
- Fix case sensitivity in Qwen3 model filename resolution. #15 (thanks
  @gavrix)
- Fix sqlite-vec loading on macOS with Homebrew (`BREW_PREFIX` detection).
  #42 (thanks @komsit37)
- Fix Nix flake to use correct `src/qmd.ts` path. #7 (thanks @burke)
- Fix docid lookup with quotes support in get command. #36 (thanks
  @JoshuaLelon)
- Fix query expansion model size in documentation. #38 (thanks @odysseus0)

## [0.6.0] - 2025-12-28

Replaced Ollama HTTP API with node-llama-cpp for all LLM operations. Ollama
adds convenience but also a running server dependency. node-llama-cpp loads
GGUF models directly in-process — zero external dependencies. Models
auto-download from HuggingFace on first use.

### Changes

- LLM: structured query expansion via JSON schema grammar constraints.
  Model produces typed expansions — **lexical** (BM25 keywords), **vector**
  (semantic rephrasings), **HyDE** (hypothetical document excerpts) — so each
  routes to the right backend instead of sending everything everywhere.
- LLM: lazy model loading with 2-minute inactivity auto-unload. Keeps memory
  low when idle while avoiding ~3s model load on every query.
- Search: conditional query expansion — when BM25 returns strong results, the
  expensive LLM expansion is skipped entirely.
- Search: multi-chunk reranking — documents with multiple relevant chunks
  scored by aggregating across all chunks rather than best single chunk.
- Search: cosine distance for vector search (was L2).
- Search: embeddinggemma nomic-style prompt formatting.
- Testing: evaluation harness with synthetic test documents and Hit@K metrics
  for BM25, vector, and hybrid RRF.

## [0.5.0] - 2025-12-13

Collections and contexts moved from SQLite tables to YAML at
`~/.config/qmd/index.yml`. SQLite was overkill for config — you can't share
it, and it's opaque. YAML is human-readable and version-controllable. The
migration was extensive (35+ commits) because every part of the system that
touched collections or contexts had to be updated.

### Changes

- Config: YAML-based collections and contexts replace SQLite tables.
  `collections` and `path_contexts` tables dropped from schema. Collections
  support an optional `update:` command (e.g., `git pull`) before re-index.
- CLI: `qmd collection add/list/remove/rename` commands with `--name` and
  `--mask` glob pattern support.
- CLI: `qmd ls` virtual file tree — list collections, files in a collection,
  or files under a path prefix.
- CLI: `qmd context add/list/check/rm` with hierarchical context inheritance.
  A query to `qmd://notes/2024/jan/` inherits context from `notes/`,
  `notes/2024/`, and `notes/2024/jan/`.
- CLI: `qmd context add / "text"` for global context across all collections.
- CLI: `qmd context check` audit command to find paths without context.
- Paths: `qmd://` virtual URI scheme for portable document references.
  `qmd://notes/ideas.md` works regardless of where the collection lives on
  disk. Works in `get`, `multi-get`, `ls`, and context commands.
- CLI: document IDs (docid) — first 6 chars of content hash for stable
  references. Shown as `#abc123` in search results, usable with `get` and
  `multi-get`.
- CLI: `--line-numbers` flag for get command output.

## [0.4.0] - 2025-12-10

MCP server for AI agent integration. Without it, agents had to shell out to
`qmd search` and parse CLI output. The monolithic `qmd.ts` (1840 lines) was
split into focused modules with the project's first test suite (215 tests).

### Changes

- MCP: stdio server with tools for search, vector search, hybrid query,
  document retrieval, and status. Runs over stdio transport for Claude
  Desktop and MCP clients.
- MCP: spec-compliant with June 2025 MCP specification — removed non-spec
  `mimeType`, added `isError: true` to errors, `structuredContent` for
  machine-readable results, proper URI encoding.
- MCP: simplified tool naming (`qmd_search` → `search`) since MCP already
  namespaces by server.
- Architecture: extract `store.ts` (1221 LOC), `llm.ts` (539 LOC),
  `formatter.ts` (359 LOC), `mcp.ts` (503 LOC) from monolithic `qmd.ts`.
- Testing: 215 tests (store: 96, llm: 60, mcp: 59) with mocked Ollama for
  fast, deterministic runs. Before this: zero tests.

## [0.3.0] - 2025-12-08

Document chunking for vector search. A 5000-word document about many topics
gets a single embedding that averages everything together, matching poorly for
specific queries. Chunking produces one embedding per ~900-token section with
focused semantic signal.

### Changes

- Search: markdown-aware chunking — prefers heading boundaries, then paragraph
  breaks, then sentence boundaries. 15% overlap between chunks ensures
  cross-boundary queries still match.
- Search: multi-chunk scoring bonus (+0.02 per additional chunk, capped at
  +0.1 for 5+ chunks). Documents relevant in multiple sections rank higher.
- CLI: display paths show collection-relative paths and extracted titles
  (from H1 headings or YAML frontmatter) instead of raw filesystem paths.
- CLI: `--all` flag returns all matches (use with `--min-score` to filter).
- CLI: byte-based progress bar with ETA for `embed` command.
- CLI: human-readable time formatting ("15m 4s" instead of "904.2s").
- CLI: documents >64KB truncated with warning during embedding.

## [0.2.0] - 2025-12-08

### Changes

- CLI: `--json`, `--csv`, `--files`, `--md`, `--xml` output format flags.
  `--json` for programmatic access, `--files` for piping, `--md`/`--xml` for
  LLM consumption, `--csv` for spreadsheets.
- CLI: `qmd status` shows index health — document count, size, embedding
  coverage, time since last update.
- Search: weighted RRF — original query gets 2x weight relative to expanded
  queries since the user's actual words are a more reliable signal.

## [0.1.0] - 2025-12-07

Initial implementation. Built in a single day for searching personal markdown
notes, journals, and meeting transcripts.

### Changes

- Search: SQLite FTS5 with BM25 ranking. Chose SQLite over Elasticsearch
  because QMD is a personal tool — single binary, no server dependencies.
- Search: sqlite-vec for vector similarity. Same rationale: in-process, no
  external vector database.
- Search: Reciprocal Rank Fusion to combine BM25 and vector results. RRF is
  parameter-free and handles missing signals gracefully.
- LLM: Ollama for embeddings, reranking, and query expansion. Later replaced
  with node-llama-cpp in 0.6.0.
- CLI: `qmd add`, `qmd embed`, `qmd search`, `qmd vsearch`, `qmd query`,
  `qmd get`. ~1800 lines of TypeScript in a single `qmd.ts` file.

[Unreleased]: https://github.com/tobi/qmd/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/tobi/qmd/releases/tag/v1.0.0
[0.9.0]: https://github.com/tobi/qmd/compare/v0.8.0...v0.9.0
