# RFC-0007: Optional Graph Layer for QKB via GraphQLite

| Field | Value |
|---|---|
| Author | Dan Mestas <dan5446@gmail.com> |
| Reviewers | QKB maintainers; one external reviewer with embedded-DB experience |
| Status | Draft → seeking review |
| Created | 2026-05-07 |
| Target | QKB v2.2.x (Phase 1), v2.3.x (Phase 2), v3.0.0 (Phase 3 default-on flip) — gated behind feature flag through at least one minor release before any default-on consideration |
| Related | sqlite-vec integration (existing); FTS5/BM25 indexing path (existing); MCP tool surface in `src/mcp/server.ts` |

## 1. Summary

Add an **optional, off-by-default** graph storage and query layer to QKB by loading the [GraphQLite](https://github.com/colliery-io/graphqlite) SQLite extension into the same database file QKB already manages. The feature exposes (a) a typed SDK for nodes/edges scoped to a namespace, (b) parameterized Cypher query execution, and (c) a small set of graph algorithms surfaced through a stable wrapper. The feature is gated behind `graph.enabled`, ships disabled by default, and goes through at least one minor release before any default-on decision.

We are *not* proposing: replacing recursive CTE patterns that work today, mandating entity extraction during indexing, exposing raw Cypher to MCP tool callers without a sandbox, or making GraphQLite a required runtime dependency on any platform.

## 2. Motivation

### 2.1 Concrete user requests

This RFC exists because of three categories of query QKB users have asked about on issues #*(fill in)* and in the project's discussion channels:

1. **"Find all documents that mention an entity also mentioned by document X."** Today this requires either an external entity store or an N+1 query pattern in application code. The relational form is a 4-way self-join on a hypothetical `mentions` table; the recursive form (entities-of-entities) becomes a CTE that is awkward to write and hard to bound.

2. **"Rank documents by graph centrality on the citation/mention graph, then re-rank by BM25."** This is GraphRAG. There is no reasonable way to do it in QKB today.

3. **"Walk from a chunk to related chunks via shared entities, with a hop limit."** Variable-length path queries are the textbook case where Cypher beats SQL on expressivity, even where the SQL is possible.

### 2.2 Why this can't wait for "users to ask louder"

Agent memory is the use case driving QKB adoption. Agents specifically benefit from explicit relationship modeling because their reasoning traces are graph-shaped, not document-shaped. Every month QKB does not have this, users are either bolting on a separate Neo4j or moving off QKB. We have evidence of both.

### 2.3 Why GraphQLite specifically

See §6 (Alternatives). Short version: GraphQLite is the only option that (a) loads as a SQLite extension into the *same connection* as `sqlite-vec` and FTS5, (b) speaks Cypher, and (c) does not require running a second process or a second `.db` file. The cost is that it is pre-1.0; we manage that with a vendoring strategy and a clean abstraction boundary (§7).

## 3. Non-goals

- Replacing existing relational paths. Documents (`documents`), content (`content`), content vectors (`content_vectors` / `vectors_vec`), and FTS (`documents_fts`) stay where they are.
- Cross-database graphs. Graphs live in the same `index.sqlite` as the QKB index they describe.
- Hiding Cypher from advanced users; we expose it, but with parameter binding mandatory at the SDK level.
- Default-on behavior in v2.x. This is a flagged feature for at least the v2.2 → v2.3 release window.

## 4. Design

### 4.1 Architecture overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                         QKB SDK (TypeScript)                           │
├──────────────┬───────────────┬────────────────────────┬────────────────┤
│  documents   │   content     │   content_vectors      │ graph (NEW)    │
│  collections │   FTS5/BM25   │   + vectors_vec (vec)  │ nodes, edges   │
└──────┬───────┴───────┬───────┴────────────┬───────────┴───────┬────────┘
       │               │                    │                   │
       └───────────────┴───── one DB ───────┴───────────────────┘
                       index.sqlite (single file, ~/.cache/qkb/index.sqlite)
                       │
                       ├── connection: bun:sqlite OR better-sqlite3
                       │     ├── extension: sqlite-vec   (existing)
                       │     └── extension: graphqlite   (NEW, optional)
                       └── WAL mode (existing)
```

The graph layer is one more extension on the same connection, not a sidecar database. This is the central design choice and the source of most of this RFC's complexity.

### 4.2 Data model

GraphQLite stores nodes and edges in tables it manages, scoped by a **namespace** string (its native isolation primitive — we use it directly rather than inventing our own).

We define a single QKB-owned namespace per database, named `qkb`. Multi-namespace support is deferred to a future RFC; we don't need it for the use cases in §2.

Reference convention between QKB-managed tables and the graph:

- A graph node representing a QKB chunk uses the external ID `chunk:{content.hash}:{seq}` (matching the `content_vectors` composite key) and carries `{kind: "chunk", hash: <h>, seq: <n>}` as properties. There is no `chunks` table; this is the closest stable identifier.
- A graph node representing a QKB document uses `doc:{documents.id}` with `{kind: "doc", collection, path}` as properties.
- A graph node representing an extracted entity uses `entity:{type}:{normalized_name}`.
- Edges between chunks and entities are typed `MENTIONS`; edges between chunks via shared entities are *not* materialized (computed via 2-hop Cypher).
- Soft references only. We do not declare SQLite foreign keys from GraphQLite tables to `content`, `content_vectors`, or `documents` because (a) GraphQLite owns its schema and we should not depend on its internals, and (b) FK enforcement across an extension boundary is not something we want to debug.

### 4.3 Referential integrity and deletion semantics

Because we use soft references, deletion safety is QKB's job, not SQLite's. Three paths:

1. **Document deletion** triggers a cascade in the SDK: enumerate the document's chunks (via `content_vectors` for `content.hash`), delete each chunk's corresponding `chunk:*` graph node (which GraphQLite handles by also removing incident edges), then delete the chunk vectors and document via the existing relational path. All in one `BEGIN ... COMMIT`. The existing `documents.hash → content(hash) ON DELETE CASCADE` FK is unchanged; we hook into the same transaction that triggers it.
2. **Entity nodes are not deleted** when their last referencing chunk goes away (they may be referenced by future chunks). A periodic `qkb graph gc` command sweeps orphan entity nodes; this is opt-in and documented.
3. **Schema corruption recovery**: if the SDK detects a `chunk:{hash}:{seq}` node whose `(hash, seq)` does not resolve in `content_vectors`, it logs a warning and treats the node as a tombstone for read paths. We do not auto-delete on read because read paths must not write.

### 4.4 Concurrency and transactions

GraphQLite's `cypher()` SQL function executes within the calling transaction. This means:

- A multi-statement transaction can mix INSERT into `content`, INSERT into `content_vectors` + `vectors_vec`, and `cypher('CREATE ...')`, and all participate in the same atomic unit. We rely on this and **add a test that asserts it** rather than assuming it.
- WAL mode (already enabled by QKB) is unaffected. The `-wal` and `-shm` files cover all writes including extension-owned tables.
- Single-writer SQLite still applies. The graph layer does not change concurrency guarantees; it inherits them.
- Bulk insert during indexing uses GraphQLite's documented bulk-insert API (bypasses Cypher parsing), wrapped in the same transaction as the chunk insert. Performance budget in §10.

### 4.5 Extension loading

QKB already supports two SQLite runtimes (see `src/db.ts`):

- **Node**: `better-sqlite3` 12.8.0 — `loadExtension(path)` works directly with no quirks.
- **Bun**: `bun:sqlite` — Apple's stock SQLite on macOS lacks extension support; QKB already calls `BunDatabase.setCustomSQLite()` at module init to swap in Homebrew's full-featured build, gracefully degrading vector search if neither is available.

The graph layer reuses this infrastructure. The loading code must handle four cases. We name them so the test matrix can refer to them.

| Case | Runtime / Platform | SQLite source | Behavior |
|---|---|---|---|
| L1 | Node (any OS) **or** Bun on Linux/Windows | bundled / system | `loadExtension(path)` works |
| L2 | Bun on macOS, Apple SQLite | default | **Must not call `loadExtension` — historical segfault.** `setCustomSQLite()` already runs at module init; if it failed and the user has `graph.enabled=true`, throw a typed `GraphExtensionUnavailable` error with a docs link, not a segfault. |
| L3 | Bun on macOS, Homebrew SQLite | user ran `brew install sqlite` | Existing `setCustomSQLite()` succeeds; `loadExtension` works |
| L4 | Any | extension file missing / wrong ABI | Clean `GraphExtensionUnavailable` error; QKB continues to function with `graph.enabled=false` semantics |

Implementation: a single `loadGraphqlite(db)` helper in `src/db.ts` mirroring the existing `loadSqliteVec(db)` pattern. The runtime probe (Bun vs Node) and macOS fallback path are already in place; we extend them.

### 4.6 Public API

#### 4.6.1 SDK

```ts
// All graph methods are no-ops or throw `GraphDisabledError` when graph.enabled=false.
const store = await openStore({
  dbPath: "./index.sqlite",
  graph: { enabled: true },  // default: false
});

// Typed wrappers — no raw Cypher needed for the common path.
await store.graph.upsertNode({
  id: "entity:person:alice",
  label: "Person",
  properties: { name: "Alice" },
});

await store.graph.upsertEdge({
  from: "chunk:abc123:0",
  to:   "entity:person:alice",
  type: "MENTIONS",
  properties: { confidence: 0.92 },
});

// Cypher escape hatch — parameters are mandatory; string interpolation is rejected at the type level.
const rows = await store.graph.cypher<{ title: string; name: string }>(
  cypher`MATCH (c:Chunk)-[:MENTIONS]->(e:Entity)
         WHERE e.name = $name
         RETURN c.title AS title, e.name AS name
         LIMIT 50`,
  { name: "ProjectX" },
);

// Algorithms are wrapped — no JSON extraction at the call site.
const ranks = await store.graph.pageRank({ damping: 0.85, iterations: 20 });
```

The TypeScript types reject `store.graph.cypher(\`MATCH ... WHERE name='${userInput}'\`)` because the `cypher` argument is a branded `CypherQuery` type produced only by the `cypher` template-tag helper, which refuses interpolations at value positions. (Implementation: branded string + tagged-template guard.)

#### 4.6.2 CLI

```bash
qkb graph status                     # is the extension loaded? what version?
qkb graph query --params '{"name":"ProjectX"}' \
  "MATCH (e:Entity {name: \$name}) RETURN e LIMIT 10"
qkb graph pagerank --top 20
qkb graph gc --dry-run               # orphan sweep
qkb graph dump > graph.ndjson        # exit-plan tool (§7)
qkb graph restore < graph.ndjson
```

`qkb graph query` requires `--params` for any query containing a `$`-prefixed identifier; it refuses to run otherwise.

#### 4.6.3 MCP surface

Two tools are exposed to agents via `src/mcp/server.ts`:

- `graph_query(cypher: string, params: object)` — same parameterization rules as SDK.
- `graph_neighbors(node_id: string, hops: int <= 3, edge_types?: string[])` — a constrained traversal that does not require Cypher knowledge.

`graph_query` is a privileged tool; the MCP surface gates it behind a per-tool permission so agents that only need neighbors don't get raw Cypher. **PageRank and other O(N) algorithms are not exposed to MCP** in v2.x; they are too easy to abuse for resource exhaustion.

### 4.7 Configuration

Lives in QKB's existing YAML config at `~/.config/qkb/index.yml`:

```yaml
# ~/.config/qkb/index.yml
graph:
  enabled: false              # default
  bulk_insert_threshold: 64   # nodes-per-call above which bulk path is used
  query_timeout_ms: 5000      # SQLite progress handler enforces this
  max_path_length: 6          # cap on variable-length paths to prevent runaway
```

`max_path_length` is enforced by static rewriting in the SDK before queries reach GraphQLite (we walk the parse tree and reject `*` quantifiers exceeding the cap). Raw CLI users can bypass it; MCP callers cannot.

## 5. Hybrid query: how graph and vector results combine

This is called out separately because the original draft hand-waved it.

We support two combination strategies, both implemented in QKB code, neither requiring GraphQLite to know about vectors:

1. **Filter-then-rank**: a Cypher query produces a candidate `(hash, seq)` set; the existing vector + BM25 path scores those candidates. This is the cheap path and the one we recommend.
2. **Rank-then-rerank**: existing hybrid search produces a top-K; a Cypher query expands to neighbors via the graph; a final RRF combines. This is more expensive and is gated behind an explicit `mode: "graph_rerank"` argument.

We do **not** materialize vector-similarity edges into the graph. The original draft suggested this; we considered it and rejected it because (a) it doubles storage, (b) embeddings change when the model changes and the edges silently go stale, and (c) the same answer can be computed at query time through filter-then-rank without precomputation.

## 6. Alternatives considered

### 6.1 Recursive CTEs only (status quo)
Adequate for fixed-depth reachability. Becomes unreadable for variable-length patterns and offers no PageRank/centrality. Keeps single-extension simplicity. **Rejected** for the §2 use cases; **kept** as the path for users who set `graph.enabled=false`, which remains supported indefinitely.

### 6.2 Kùzu (embedded, columnar, Cypher)
Mature, peer-reviewed, has v0.x but with a research lineage and active commercial backing. Genuine alternative.
**Rejected** because Kùzu is its own database, not a SQLite extension. Adopting it means QKB ships with two storage engines, two file formats, two backup stories, and two transaction scopes. The single-file invariant (`index.sqlite` is everything) is core to QKB's positioning.

### 6.3 CozoDB
Embeddable, supports Datalog and a graph algorithm library. Datalog has expressive advantages over Cypher for some traversals.
**Rejected** for the same reason as Kùzu (separate engine), plus a smaller community and steeper learning curve for agents whose training data is mostly Cypher.

### 6.4 sqlite-graph (agentflare/simonw)
Lighter-weight SQLite extension for graph patterns. **Rejected** because it does not implement Cypher or a graph algorithm library; we'd be reinventing both.

### 6.5 Neo4j as a sidecar
Industry standard, most mature option. **Rejected** because requiring a JVM and a server process for a tool that today is a single `npm install` is a category change in deployment complexity, not an incremental feature.

### 6.6 Build it ourselves on top of SQLite
We have neither the resources nor the comparative advantage. **Rejected.**

GraphQLite wins on the specific axis that matters: same connection, same file, Cypher-fluent. It loses on maturity. We accept that loss with the mitigations in §7.

## 7. Pre-1.0 dependency: explicit risk acceptance

GraphQLite is at v0.4.4, MIT-licensed, with one primary maintainer organization. We mitigate this risk in four ways:

1. **Pinned version + checksum.** We pin the exact GraphQLite shared library version and verify its checksum on load. Upgrades go through a deliberate review.
2. **Vendored binaries.** For the supported platforms — **Linux x86_64, Linux aarch64, macOS arm64, macOS x86_64** (matching QKB's existing `optionalDependencies` matrix for `sqlite-vec-*`) — we ship verified binaries. Mechanism is decided in PR-2 (research spike): either upstream-published per-platform npm packages (preferred, mirrors `sqlite-vec`) or a `postinstall` script that downloads from GitHub releases with checksum verification (fallback). Windows support is **deferred** — current QKB CI does not test Windows; we can add it in a follow-up RFC once the rest stabilizes.
3. **Abstraction boundary.** The SDK never exposes a GraphQLite-specific type to callers. If we need to swap the backend later (e.g. to Kùzu), the public surface in §4.6 is unchanged.
4. **Exit plan.** If GraphQLite is abandoned, the migration path is `qkb graph dump | qkb-next graph restore` through the SDK abstraction. We commit to writing the dump tool in Phase 1 specifically so the exit door exists from day one.

## 8. Security

- **Cypher injection**: the SDK accepts query + params, never a fully-formed query with values. The `cypher()` method's first argument is typed as a branded `CypherQuery` produced by a tagged-template helper that rejects interpolation in value positions. The CLI mirrors this with required `--params`.
- **Resource exhaustion**: `query_timeout_ms` (enforced via SQLite's progress handler) and `max_path_length` (enforced by query rewriting) bound worst-case queries. PageRank-like global algorithms are not exposed to MCP.
- **File-system trust**: extension loading uses an absolute path we control (vendored binary location resolved at install time), not a search path. We never call `loadExtension` with a user-supplied path.
- **No new network surface.** GraphQLite is in-process; this RFC adds no listeners, no sockets.

## 9. Migration and compatibility

QKB does not have a versioned migration system. Schema is created lazily via `CREATE TABLE IF NOT EXISTS` during `openDatabase()` in `src/store.ts`. The graph layer follows the same pattern.

- Existing QKB databases are unaffected when `graph.enabled=false`. No graph schema is created.
- When `graph.enabled` is set to true, the next `openDatabase()` call:
  1. Loads the GraphQLite extension (§4.5).
  2. Registers the `qkb` namespace (idempotent).
  3. Ensures a QKB-owned `graph_meta` table exists (one row, tracking the GraphQLite library version we initialized against). No existing tables are altered.
- Downgrade: setting `graph.enabled=false` after use leaves the GraphQLite tables in place, untouched. They're inert without the extension loaded. `qkb graph drop` exists for users who want to reclaim space.
- Backwards compatibility commitment: any QKB database created against this RFC's implementation must remain readable by the immediately preceding QKB version (with `graph.enabled` ignored — the extra tables are inert without the extension).

## 10. Performance budget

Hard requirements that must be met before merging Phase 1:

| Metric | Threshold | Measurement |
|---|---|---|
| Indexing throughput regression with `graph.enabled=false` | 0% | Existing benchmark harness, Linux x86_64, 10k-doc corpus |
| Indexing throughput regression with `graph.enabled=true` and entity extraction off | < 2% | Same harness, same corpus |
| Indexing throughput with entity extraction on, bulk path | ≥ 50% of `enabled=false` baseline | Same harness; full graph pipeline (Phase 2 metric) |
| Cold extension-load time | < 50 ms | Microbenchmark, measured at process start |
| 2-hop neighbor query, 10k-node graph | p95 < 25 ms | New benchmark, included in PR |
| PageRank, 10k-node graph | < 2 s | New benchmark |
| Database file size growth with empty graph layer | < 64 KB | Compare `index.sqlite` before/after enabling |

If any of these regress, the feature does not merge. CI runs the relevant subset on every PR (small reproducible corpus); the full corpus runs locally before each release tag.

## 11. Test plan

- **Unit**: SDK methods, parameter binding, query rewriter (path-length cap), Cypher injection attempts.
- **Integration**: load orderings L1–L4 from §4.5; cross-extension transactions with `sqlite-vec`; cascade-on-delete via document deletion; orphan-entity GC; downgrade with graph data present.
- **Property tests**: round-trip nodes/edges through the SDK match what's queryable via raw Cypher.
- **Failure injection**: kill the process mid-transaction across all three storage layers (`content` / `content_vectors` / graph); assert recovery to a consistent state on next open.
- **Long-running**: 24-hour soak with continuous indexing + querying to surface any extension-related leaks. (Phase 2 deliverable.)

## 12. Phased rollout

**Phase 1 — Foundation (target: QKB v2.2.0)**
- Extension loading (L1–L4), pinned binaries for the four supported platforms, `graph.enabled` flag, dump/restore tool from §7, performance harness baseline.
- SDK: `upsertNode`, `upsertEdge`, parameterized `cypher`, `pageRank` wrapper.
- CLI: `qkb graph status/query/pagerank/gc/dump/restore`.
- MCP: `graph_query`, `graph_neighbors`.
- Tests for everything in §11 except long-running soak.
- Docs: one tutorial, one how-to, one reference page.

**Phase 2 — Indexing integration (target: QKB v2.3.0)**
- Optional entity extraction during `qkb embed` (off by default; gated by `graph.entity_extraction.enabled`).
- Bulk insert path wired into the indexing pipeline.
- Hybrid query strategies (filter-then-rank, rank-then-rerank).
- 24-hour soak test in CI nightly.

**Phase 3 — Default-on consideration (target: QKB v3.0.0 or later)**
- *Only* if Phase 1 and 2 metrics from §13 are met and the GraphQLite project remains actively maintained.
- Default flips to `graph.enabled=true`. Feature flag remains, defaults inverted. The version bump to 3.0 is justified by the default-behavior change (no breaking API changes expected).

Each phase ships behind the flag. Phase 3 requires an explicit decision RFC; this RFC does not authorize it.

## 13. Success criteria

The feature is considered successful, and Phase 3 (default-on) becomes a candidate, only if **all** of the following hold six months after Phase 2 ships:

1. ≥ 50 distinct GitHub users have `graph.enabled=true` in telemetry-opt-in deployments (or, if telemetry is not available, ≥ 25 reactions on the announcement issue from users who confirm production use in a follow-up).
2. ≤ 3 unresolved P0/P1 bugs filed against the graph code path.
3. No measured regression beyond the §10 thresholds.
4. At least one public example or third-party integration that uses the graph API.

If criteria 1, 2, or 4 are not met, the feature stays opt-in indefinitely. If criterion 3 is breached at any point, the feature is rolled back to opt-in if it had been defaulted on, and the regression is fixed before any retry.

## 14. Open questions

These are not blockers for review but must be resolved before Phase 1 implementation begins. Each is owned by a research-spike PR (PR-2 in `docs/rfcs/0007-impl/PLAN.md`):

1. Does GraphQLite's `cypher()` correctly participate in nested SAVEPOINTs? (Test required; behavior undocumented upstream.)
2. What is the actual on-disk size of GraphQLite's empty `qkb` namespace? (Determines whether the §10 file-size budget of 64 KB is realistic.)
3. Should the dump format from §7 be GraphQLite-native or QKB-defined? (Defining our own decouples us from GraphQLite changes; using theirs is one fewer thing to maintain. **Taste call** — escalated to repo owner in PR-2.)
4. How do we handle the case where a user has `sqlite-vec` and `graphqlite` versions that target incompatible SQLite ABI versions? (Probably: assert at load and refuse with a clear error.)
5. Does GraphQLite publish per-platform npm packages (mirroring `sqlite-vec-darwin-arm64` etc.)? If not, we use a `postinstall` download-with-checksum script. PR-2 settles this and pins §7's vendoring approach.

## 15. References

- QKB source — https://github.com/danmestas/qkb
- GraphQLite — https://github.com/colliery-io/graphqlite, docs at https://colliery-io.github.io/graphqlite/latest/ (v0.4.4 at time of writing, MIT)
- bun:sqlite — https://bun.com/docs/runtime/sqlite (note `setCustomSQLite` and macOS extension caveats; QKB already uses this in `src/db.ts`)
- better-sqlite3 — https://github.com/WiseLibs/better-sqlite3 (Node runtime adapter)
- sqlite-vec — https://github.com/asg017/sqlite-vec
- Bun extension-load segfault history — https://github.com/oven-sh/bun/issues/5756
- Kùzu (alternative considered) — https://kuzudb.com
- SQLite run-time loadable extensions — https://sqlite.org/loadext.html

## 16. Document history

- 2026-05-07 — Initial draft authored for QKB. (Translated from a QMD-targeted draft, with corrections against actual QKB code shape: dual `bun:sqlite` / `better-sqlite3` runtime, `content` + `content_vectors` schema instead of a `chunks` table, lazy `CREATE IF NOT EXISTS` migration model instead of a versioned system, four-platform vendoring matrix matching existing CI, version targets aligned with the v2.1.0 baseline.)

---

*Reviewers: please leave comments inline. Specific feedback wanted on §4.5 (load matrix), §10 (whether thresholds are right), and §13 (whether the gates are too strict, too loose, or wrong-shaped).*
