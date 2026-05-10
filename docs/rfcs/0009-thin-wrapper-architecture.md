# RFC-0009: Thin Wrapper Architecture (qkb 4.0)

**Status**: Draft
**Date**: 2026-05-09
**Author**: Dan Mestas
**Supersedes**: implicit fork relationship with `tobi/qmd` established at qkb's inception

## Summary

Convert qkb from a vendored fork of `tobi/qmd` into a thin downstream wrapper that depends on `@tobilu/qmd` via npm and adds a graph layer (RFC-0007 + RFC-0008) on top of qmd's published SDK. Target: qkb 4.0.0, ~80% codebase reduction, no upstream changes to qmd, no regression in query quality.

## Motivation

qkb began as a fork of qmd. The graph layer (RFC-0007) and hybrid graph queries (RFC-0008) were added on top of the vendored copy. As qmd evolves, qkb's vendored code drifts — every qmd improvement requires manual catch-up.

If qmd's published SDK is sufficient to host the graph layer as a downstream wrapper, we eliminate the drift forever: qkb owns only what's actually qkb-specific (the graph), and qmd improvements arrive via `npm update`.

This RFC validates feasibility, lays out the architecture, and sequences the migration.

## Non-goals

- Upstream PRs to qmd. We work around qmd's published surface as-is.
- Auto-migration of existing qkb 3.x indexes. Re-indexing on upgrade is acceptable.
- Replacing qkb's CLI surface. CLI commands and flags stay backward-compatible where possible.
- Adding a file watcher (`qkb watch`). Deferred to 4.1.

## Feasibility verdict

**Feasible with no upstream changes.** qmd's SDK exposes:

- `createStore({dbPath, config})` returning `QMDStore`
- `QMDStore.internal: InternalStore` ("for advanced use") — the underlying `Store` instance with direct DB access
- `QMDStore.search({skipRerank})` — returns RRF-fused candidates without LLM reranking
- `QMDStore.internal.db` — the `better-sqlite3` connection
- `QMDStore.internal.llm` — the `LlamaCpp` instance with `.rerank()` method
- `QMDStore.update({collections, onProgress})` — does file walk, hash, BM25/vector indexing
- All other SDK methods needed for collection/context/get/multi-get/embed operations

Constraints discovered:

- qmd's `package.json` `exports` field is strictly `.`-only — no sub-path imports
- `SearchHooks` is observability-only (no candidate-mutation hook)
- `createMcpServer()` is not exported (only `startMcpServer()`)

These constraints shape the design but do not block it.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ qkb (npm pkg @agent-ops/qkb v4.0.0)                      │
│                                                          │
│  ┌──────────────┐                                        │
│  │ qkb CLI      │                                        │
│  │ (own parser) │                                        │
│  └──────┬───────┘                                        │
│         ▼                                                │
│  ┌────────────────────────────────────────────────┐      │
│  │ Index Orchestrator (qkb-owned)                 │      │
│  │   single entry point for all indexing paths    │      │
│  │   • CLI: `qkb update`, `qkb collection add`    │      │
│  │   • MCP: update tool                           │      │
│  │   • Future: `qkb watch`                        │      │
│  └────┬───────────────────────────┬───────────────┘      │
│       ▼                           ▼                      │
│  ┌─────────────┐           ┌──────────────────────┐      │
│  │ qmd SDK     │           │ qkb graph layer      │      │
│  │ store.update│           │ extractWikilinks()   │      │
│  │ store.search│           │ runEdgeWeightedRank()│      │
│  └──────┬──────┘           └──────────┬───────────┘      │
│         └────────────┬─────────────────┘                 │
│                      ▼                                   │
│        shared SQLite (qmd tables + graph_* tables)       │
└──────────────────────────────────────────────────────────┘
```

### qkb owns

- CLI parsing, help text, output formatting
- Index orchestrator (single entry point invariant)
- Graph layer (`src/graph/`, unchanged from today)
- Graph indexing pass (wikilink extraction, edge upsert, orphan GC)
- Schema for `graph_*` tables, schema versioning
- Vendored rerank-with-graph module (~80 LoC; see Query Path)
- MCP server (registers qmd-equivalent tools + graph-aware tools)

### qmd owns (via SDK)

- BM25/FTS5 indexing
- Vector embedding + sqlite-vec storage
- Query expansion
- RRF fusion of BM25 + vector results
- Cross-encoder reranker (model lifecycle, inactivity reload)
- Collection / context / document management
- DB connection lifecycle, sqlite-vec extension load
- All schema for `docs`, `chunks`, `vec_chunks`, `store_*` tables

### qkb-owned utilities (`src/internals/`)

qmd's `package.json` `exports` field is strictly `.`-only — sub-path imports are blocked. qmd's public SDK surface is small (~30 symbols: `createStore`, `QMDStore`, `Maintenance`, `extractSnippet`, `addLineNumbers`, `getDefaultDbPath`, `DEFAULT_MULTI_GET_MAX_BYTES`, plus types). qkb's CLI body uses dozens of helpers that aren't on that surface — module-level utilities for path parsing, docid hashing, the LlamaCpp lifecycle, YAML config loading, FTS/vector search internals, AST chunking, and so on.

Per the no-upstream-PR rule, qkb carves all of these into `src/internals/*.ts` with attribution headers ("carved from qmd's vendored fork during the RFC-0009 thin-wrapper migration"). They no longer track upstream qmd.

The carved set falls in two tiers:

**Tier 1 — small leaf modules** (carved in PR-7b, ~440 LoC):

- `src/internals/paths.ts` — cross-platform path helpers (`homedir`, `isAbsolutePath`, `normalizePathSeparators`, `getRelativePathFromPrefix`, `resolve`, `getPwd`, `getRealPath`)
- `src/internals/virtual-paths.ts` — `qkb://` URL parsing
- `src/internals/docids.ts` — short docid hashing
- `src/internals/handelize.ts` — token-friendly filename slugging
- `src/internals/cache.ts` — LLM-cache key derivation
- `src/internals/title.ts` — markdown / org title extraction

**Tier 2 — large modules** (consolidated in PR-7d, ~7400 LoC):

- `src/internals/store-engine.ts` (4667 LoC) — `createStore`, full `Store` type, FTS/vector search, document/index/cache operations
- `src/internals/llm.ts` (1665 LoC) — `LlamaCpp` class, model lifecycle, default-model URIs, embed/rerank/expand wrappers
- `src/internals/collections-yaml.ts` (533 LoC) — YAML config loading and persistence (qmd's `NamedCollection` doesn't carry the field set qkb's config supports)
- `src/internals/db.ts` (97 LoC) — `Database` shim, `openDatabase`, `loadSqliteVec`
- `src/internals/maintenance.ts` (54 LoC) — qkb's local `Maintenance` class wrapping the carved store ops
- `src/internals/ast.ts` (391 LoC) — tree-sitter chunking for code files

The architectural boundary in 4.0:

- **qmd via SDK** (`@tobilu/qmd`): exists when qmd's public surface covers it — `createStore`, `QMDStore` methods, `Maintenance` (qmd's), `extractSnippet`, types
- **qkb internal** (`src/internals/`): everything else — and "everything else" turns out to be most of qkb's runtime, because qmd's public surface is narrow

The honest framing: qkb depends on qmd for the **state engine creation and schema** (`createStore` opens the DB and creates qmd's tables), and uses qmd's published interface (`QMDStore`) where convenient. But qkb's CLI body still calls into the carved helpers heavily. The "thin wrapper" claim is most true for the state engine; less so for the CLI surface.

Original RFC estimate of "~80% deletion" was based on assuming qmd's `.` SDK covered enough surface area. It doesn't, and the no-upstream-PR rule precludes negotiating. Actual delta after the 7-series PRs land: ~850 LoC pure deletion (legacy MCP server) + ~7800 LoC reorganized into a clean carve boundary. Net source size roughly the same; the win is architectural clarity — every line of qkb code now has a clear ownership story.

## Internal surface dependencies

qkb depends on a precise set of "advanced use" lever points that qmd exposes via `QMDStore.internal` and certain SDK options. Each is a contract that integration tests must exercise on every qmd version bump. If qmd removes or renames any of these, qkb breaks — but in a way our tests catch on the next push, not silently in production.

| Surface | Used by | Why we need it |
|---|---|---|
| `QMDStore.internal.db` | `openStore`, `runGraphPass`, `runEdgeWeightedRank`, MCP, all graph SQL | Load GraphQLite extension; CRUD on graph tables; orphan GC joins against `docs` |
| `QMDStore.internal.llm` | `queryWithGraph` | Reranker LLM instance (lifecycle owned by qmd) |
| `QMDStore.internal.llm.rerank(query, docs, opts)` | `queryWithGraph` step 4 | Score graph candidates head-to-head with lexical/vector hits |
| `HybridQueryOptions.skipRerank: boolean` | `queryWithGraph` step 1 | Get RRF-fused candidates without qmd's rerank, so qkb can rerank with graph candidates injected |
| `docs.path` (column) | `runGraphPass`, orphan GC | Stable doc identifier for join keys |
| `docs.hash` (column) | optional progress observability | Detect change set if we ever want per-file targeting |
| `QMDStore.update({onProgress})` callback shape | `orchestrator.run` | File-by-file progress for UI; not load-bearing |

**Test coverage requirement**: every row above gets a dedicated integration test in PR-1 through PR-5. The "next-minor probe" CI job runs the same tests against qmd's latest minor; failures surface immediately when this contract drifts.

## npm dependency graph

```jsonc
// package.json
{
  "name": "@agent-ops/qkb",
  "version": "4.0.0",
  "dependencies": {
    "@tobilu/qmd": "~2.1.0",         // tilde-pinned (patches only); locked at PR-1 time
    "better-sqlite3": "^12.8.0"      // peer with qmd
    // node-llama-cpp inherited transitively from qmd
    // sqlite-vec inherited transitively from qmd
    // GraphQLite extension binary downloaded post-install (qkb-owned)
  }
}
```

## File layout (4.0)

```
src/
├── cli/
│   └── qkb.ts                    # parser; calls dispatchCommand()
├── commands.ts                   # dispatch table: {name → handler}; thin SDK calls inline
├── commands-composite.ts         # only commands with real composite logic
│                                 # (e.g., context-check, update --pull)
├── orchestrator/
│   └── index-orchestrator.ts     # ~100 LoC, single indexing entry point
├── query/
│   └── rerank-with-graph.ts      # ~80 LoC vendored: graph-aware rerank
├── graph/                        # UNCHANGED from today
│   ├── config.ts
│   ├── loader.ts                 # loadGraphqlite(db)
│   ├── sdk.ts
│   ├── hybrid.ts                 # runEdgeWeightedRank()
│   └── index-pass.ts             # extractWikilinks() + orphan GC (internal)
├── store-bridge.ts               # openStore() — single store entry point
├── mcp/
│   └── server.ts                 # qkb-owned MCP server (qmd tool parity + graph)
└── index.ts                      # qkb SDK: re-exports qmd SDK + graph helpers
```

**Why a single dispatch table instead of one file per subcommand**: most subcommands are 1–3 line dispatches to qmd's SDK. A 17-file `commands/` directory would be 17 shallow modules with high change amplification (a global `--quiet` flag would mean 17 edits). A single dispatch table keeps related dispatches co-located; only commands with genuine composite logic earn their own file (`commands-composite.ts`).

## Subcommand → qmd SDK map

| qkb subcommand | Implementation |
|---|---|
| `qkb collection add <path> --name N` | `store.addCollection(N, ...)` + `orchestrator.run({collections: [N], full: true})` |
| `qkb collection list` | `store.listCollections()` + qkb adds graph stats column |
| `qkb collection remove <name>` | `store.removeCollection(name)` + graph pass cleanup (internal) |
| `qkb collection rename <old> <new>` | `store.renameCollection(old, new)` |
| `qkb context add/list/rm` | `store.addContext` / `listContexts` / `removeContext` |
| `qkb context check` | qkb-only composite (listCollections × listContexts diff) |
| `qkb get <file>` | `store.get(pathOrDocid)` |
| `qkb multi-get <pat>` | `store.multiGet(pattern, ...)` |
| `qkb status` | `store.getStatus()` + qkb appends graph row counts |
| `qkb update [--pull]` | (`--pull` → git pull) → `orchestrator.run({collections})` |
| `qkb embed` | `store.embed({...})` |
| `qkb search <q>` | `store.searchLex(q, {limit, collection})` |
| `qkb vsearch <q>` | `store.searchVector(q, {limit, collection})` |
| `qkb query <q>` | `queryWithGraph(store, q, opts)` (see Query Path) |
| `qkb query --no-graph <q>` | `store.search(q, opts)` (full qmd pipeline, no graph) |
| `qkb mcp [--http]` | qkb-owned MCP server, qmd tool parity + graph tools |
| `qkb graph neighbors` | qkb-only, hits `runFindNeighbors()` directly |

## Indexing path

```
qkb update / qkb collection add
    → orchestrator.run({collections, full?})
        → store.update({collections, onProgress})    [qmd: walk + hash + BM25/vec]
        → runGraphPass(store.internal.db, scope)     [qkb: extract + upsert + prune orphans]
```

qmd's `reindexCollection()` already handles change detection: filesystem walk, content hash, hash compare against `docs.hash`. We do not duplicate that.

`runGraphPass()` is one logical step from the orchestrator's perspective. Internally it (a) iterates all docs in scope, (b) extracts wikilinks via idempotent `INSERT OR REPLACE INTO graph_edges`, and (c) prunes orphaned graph rows for files no longer in `docs`. All three substeps are orphan-GC and self-healing — re-running is cheap. The orchestrator doesn't need to know about the substeps; the graph pass owns its own lifecycle.

## Query path (the rerank-with-graph constraint)

qmd's `SearchHooks` is observability-only, and qmd's exports field blocks sub-path imports. We cannot mutate qmd's candidate pool inside `hybridQuery()` from outside. Therefore we vendor a tightly-scoped rerank step that uses `skipRerank: true` on qmd's search, injects graph candidates, and runs reranking ourselves via `store.internal.llm.rerank()`.

```typescript
// src/query/rerank-with-graph.ts (~80 LoC)
async function queryWithGraph(store: QMDStore, query: string, opts: QueryOpts) {
  // 1. qmd does expand + BM25 + vec + RRF, returns fused candidates without reranking
  const fused = await store.search({ query, limit: 60, skipRerank: true, ...opts });

  // 2. Top-K seeds for graph expansion
  const seeds = fused.slice(0, 8).map(r => ({ file: r.file, score: r.score }));
  const expansion = await runEdgeWeightedRank(store.internal.db, { seeds, weights });

  // 3. Build rerank input — fused + graph candidates with chunk text
  const candidates = mergeForRerank(fused, expansion, store.internal);

  // 4. Rerank via qmd's LlamaCpp instance (qmd owns model lifecycle)
  const reranked = await store.internal.llm.rerank(query, candidates, { model: rerankModel });

  // 5. Position-aware score blend (existing logic from src/graph/hybrid.ts)
  const blended = blendScores(fused, reranked);
  return blended.slice(0, opts.userLimit);
}
```

What we vendor: `mergeForRerank` (assemble `{file, text}[]` from fused chunks + graph file bodies) and the score-blend logic (already exists in qkb's `src/graph/hybrid.ts`). What we don't reimplement: query expansion, BM25, vector search, RRF, model lifecycle — all delegated to qmd via stable lever points (`store.search`, `store.internal.llm`).

## Schema and shared connection

### Single connection

qmd opens the SQLite file via `createStore()`. qkb never opens a second handle. We get `store.internal.db` and load GraphQLite into the same connection.

```
file: ~/.cache/qkb/index.sqlite
  └─ one better-sqlite3 connection (qmd-owned)
      ├─ extension: sqlite-vec       (loaded by qmd in createStore)
      └─ extension: graphqlite       (loaded by qkb in openStore)
```

Three extensions on one handle is fine. WAL mode + sqlite's per-connection serialization handles concurrency without app-level locks.

### Single entry point: openStore()

Every qkb subcommand opens the store via `openStore()`, never bare `createStore()`:

```typescript
// src/store-bridge.ts
export async function openStore(opts: StoreOptions): Promise<QMDStore> {
  const store = await createStore(opts);          // qmd creates its tables, loads sqlite-vec
  loadGraphqlite(store.internal.db);              // qkb loads GraphQLite extension
  ensureGraphSchema(store.internal.db);           // qkb creates graph_* tables, runs migrations
  return store;
}
```

Migration ordering is automatic: qmd migrates first (inside `createStore`), qkb migrates after. They own disjoint table sets.

### Table ownership

| Owner | Tables |
|---|---|
| qmd | `docs`, `chunks`, `vec_chunks`, `store_collections`, `store_contexts`, `store_global_context`, FTS5 internals (`fts_chunks*`), embedding cache, LLM cache |
| qkb | `graph_meta`, `graph_nodes`, `graph_edges`, plus GraphQLite-managed tables |

**Naming rule for qkb-owned tables**: prefix `graph_`. No exceptions. Avoids any current or future qmd table name collision.

### Schema versioning

```sql
CREATE TABLE IF NOT EXISTS graph_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Rows: ('schema_version', '4'), ('graphqlite_version', '0.4.4'), ...
```

`ensureGraphSchema()` reads `schema_version`, runs forward migrations, idempotent.

### Orphan GC (internal to runGraphPass)

qmd's collection-remove cascades chunks/vectors but not graph rows. The graph pass (and `removeCollection` command, internally) issues:

```sql
DELETE FROM graph_edges
 WHERE src_path NOT IN (SELECT path FROM docs)
    OR dst_path NOT IN (SELECT path FROM docs);
DELETE FROM graph_nodes
 WHERE path NOT IN (SELECT path FROM docs);
```

This is hidden inside `runGraphPass()` — callers don't coordinate it.

## MCP server

qmd's `createMcpServer()` is not exported (only `startMcpServer()`), so we cannot register additional tools on a qmd-built MCP instance. qkb runs its own MCP server, registering all tool names that qmd's MCP exposes (so MCP clients are interchangeable) plus qkb-specific tools.

```typescript
// src/mcp/server.ts
const server = new McpServer({ name: "qkb", version: "4.0.0" });
const store = await openStore({ dbPath });

// qmd-equivalent tools — same names/schemas, handlers delegate to SDK
server.registerTool("search", schemaSearch, async ({query, ...}) => store.searchLex(query, ...));
server.registerTool("get",    schemaGet,    async ({path})       => store.get(path));
server.registerTool("status", schemaStatus, async ()             => store.getStatus());
server.registerTool("update", schemaUpdate, async (opts)         => orchestrator.run(opts));

// qkb-only tools — graph-aware
server.registerTool("query",     schemaQuery,     async (opts)   => queryWithGraph(store, opts));
server.registerTool("neighbors", schemaNeighbors, async ({path}) => runFindNeighbors(store, path));
```

What's "vendored": tool names + JSON schemas, copied to match qmd's MCP surface. Handler bodies are 1–3 line SDK dispatches. ~100–150 LoC total. HTTP/stdio/daemon modes follow today's qkb patterns.

## Error handling

| Failure | Behavior |
|---|---|
| GraphQLite extension binary missing | `loadGraphqlite()` throws with install hint. Graph queries fail loudly. Don't silently degrade — masks the install issue. |
| qmd version drift breaks `internal.X` | Integration tests in CI catch on push. Pinning policy below limits exposure. |
| `ensureGraphSchema()` fails | Hard error with hint: "Run `qkb maintenance reset-graph` to drop and rebuild graph tables." |
| Mid-orchestration crash | qmd per-file transactions keep BM25/vector consistent. Graph pass uses `INSERT OR REPLACE` so it's idempotent — next `qkb update` recovers. |
| `internal.llm.rerank()` unavailable | Propagate. The reranker is required for `qkb query` quality; failing fast is correct. |
| Concurrent processes (CLI + MCP daemon) | SQLite WAL handles cross-process serialization. Each process runs its own `openStore()`. Standard sqlite concurrency. |

## Testing

### Unit tests (fast, mocked qmd)

For qkb's own modules: orchestrator dispatching, graph extraction (regex correctness), score blending math, MCP tool dispatch. Mock `QMDStore`. Run on every commit.

### Integration tests (real qmd, real sqlite)

The critical layer. Build a real index from a fixture corpus, run end-to-end:

- `openStore()` succeeds against a fresh DB
- Schema co-exists: qmd's tables + `graph_*` tables, no collisions
- `qkb update` populates both `docs` and `graph_edges`
- `qkb query` returns expected files with `--graph` and `--no-graph`
- `qkb collection remove` cascades to graph rows
- All MCP tools round-trip via stdio transport

Run on PR and nightly (slower; loads real LLM models).

### Bench harness (existing)

`bench/graph-bench-eval.ts` against `bench/results/graph-bench-baseline.md`. Block release if recall@10 drops more than 5 points.

## qmd version pinning policy

```jsonc
"@tobilu/qmd": "~2.1.0"   // tilde — patches only auto-accepted; locked at PR-1 time
```

Minors require manual integration-test pass before bump. CI runs against the current pin + a "next-minor probe" job that pulls qmd's latest minor and reports failures (informational, not blocking).

When a qmd minor breaks `internal.X`, options:
1. Update qkb to the new API surface (ship qkb 4.x.y).
2. Stay pinned to the older qmd; qkb users keep working.

## CI matrix

```yaml
matrix:
  runtime: [node-20, node-22, bun-1.x]
  qmd: ["pinned", "next-minor-probe"]
  os: [ubuntu-latest, macos-latest]
```

Match qmd's own CI shape (Bun + Node) so we're not surprised by runtime differences.

## Migration & release

### Sequencing

```
main (3.x)                    4.0 branch
   │                              ├─ PR-1: add @tobilu/qmd dep + store-bridge
   │                              ├─ PR-2: orchestrator + indexing pass
   │                              ├─ PR-3: rerank-with-graph (vendored ~80 LoC)
   │                              ├─ PR-4: src/commands/ dispatchers
   │                              ├─ PR-5: MCP server (qmd-tool-parity + graph)
   │                              ├─ PR-6: CUTOVER — replace cli/qkb.ts body
   │                              ├─ PR-7: DELETE vendored code (the big diff)
   │                              ├─ PR-8: bench validation + README + CHANGELOG
   │                              └─ PR-9: tag 4.0.0-rc.1 → beta → 4.0.0
   ▼                              ▼
3.x.y patches stay available    npm publishes 4.0.0
```

Each PR has a single deliverable + integration tests. The `4.0` branch is rebased on `main` weekly.

### Existing-user upgrade path

Re-index required on upgrade. Release notes:

```
qkb 4.0 changes the underlying engine integration.
On first run after upgrade, delete the existing index and re-run:

  rm ~/.cache/qkb/index.sqlite
  qkb collection add <path> --name <name>
  qkb update
```

Why not auto-migrate: qmd's schema may have evolved since qkb 3.x's vendored fork. Auto-migrating across that gap means tracking qmd's internal migrations — exactly the coupling we're avoiding. Re-indexing is fast.

### Beta cycle

```
4.0.0-rc.1   → install on flight-planner-kb, run for 3-5 days
4.0.0-rc.2   → fix issues from rc.1; bench against 3.x baseline
4.0.0        → public release
```

Bench is the gate. If recall@10 drops more than 5 points vs. 3.x baseline, do not ship.

### Deprecation

PR-7 deletes (~10k LoC removed):

- `src/store.ts`, `src/db.ts`, `src/embed.ts`, `src/rerank.ts`, `src/expand.ts`
- `src/collections.ts`, `src/maintenance.ts`, `src/llm.ts`
- `src/mcp/server.ts` (replaced in PR-5)
- All chunking/AST code
- 90% of `src/cli/qkb.ts` (replaced in PR-6)

Single PR, big diff. CI integration tests are the safety net.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| qmd ships breaking minor mid-rollout | Medium | Pin to specific version in PR-1; freeze the pin until 4.0.0 ships |
| Bench shows recall regression we can't fix | Low | Vendor more if needed. Ship only when bench is green. |
| Existing users hate re-index requirement | Medium | Document loudly; one-liner script; keep 3.x available on npm |
| Hidden coupling to `internal.X` we didn't catch | Medium | PR-1 through PR-5 each exercise different `internal.X` paths before cutover |
| MCP tool drift if qmd adds tools post-4.0 | Low | Periodic audit when bumping qmd pin; documented in CHANGELOG |

## Maintenance commitment

- **3.x branch**: critical bug fixes only. Sunset announcement at 4.0; archive 3 months later.
- **4.x line**: minor releases for refinements; patches as needed.
- **qmd upgrade cadence**: integration-test against next-minor probe job; bump when green.

## Version & naming

- Version: **4.0.0** (current is 3.0.0). Architectural change merits major bump.
- npm package name: unchanged (`@agent-ops/qkb`).
- Binary name: unchanged (`qkb`).
- CLI: backward-compatible where possible. `--graph` default-on; `--no-graph` opt-out; subcommand names unchanged.

## References

- RFC-0007: GraphQLite graph layer (current implementation)
- RFC-0008: Hybrid graph queries (edge-weighted 1-hop expansion)
- `tobi/qmd` upstream: https://github.com/tobi/qmd
- `@tobilu/qmd` on npm: https://www.npmjs.com/package/@tobilu/qmd
