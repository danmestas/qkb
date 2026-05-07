# RFC-0007 Implementation Plan

Companion to [`../0007-graphqlite-graph-layer.md`](../0007-graphqlite-graph-layer.md).
This is a living document — updated as PRs land and decisions resolve.

## Working ground rules

- One PR per row in §3 below. Each is feature-flagged to be a no-op when
  `graph.enabled=false`.
- Red-green TDD on every code PR: tests written and failing first, then minimal
  implementation, then refactor with tests still green.
- CI must pass on every PR (Node 22+23 × Ubuntu+macOS, Bun latest × Ubuntu+macOS,
  CHANGELOG gate).
- `gh pr merge --auto --squash` on each PR; user merge is via branch protection's
  required-checks gate.
- Branch naming: `rfc-0007/<NN>-<slug>` (e.g. `rfc-0007/03-config-flag`).
- Each PR adds one entry under `## [Unreleased]` in `CHANGELOG.md`.

## 1. Architectural decisions made unilaterally

These are framed for the record so future readers don't have to reconstruct them.
Each was made because the original draft's QMD-targeted text didn't survive contact
with QKB's actual code; none of them are taste calls (those go to §4 below).

| # | Decision | Reasoning |
|---|---|---|
| D1 | Version targets: v2.2.0 / v2.3.0 / v3.0.0 across phases (not "v3.x") | Current QKB is at 2.1.0; opt-in feature is a minor bump; major flip aligns with default-on |
| D2 | Chunk node ID = `chunk:{content.hash}:{seq}` | No `chunks` table exists; `content_vectors` is the analog and is keyed `(hash, seq)` |
| D3 | Drop Windows from initial vendoring matrix | Existing CI is Ubuntu + macOS only; matches current `sqlite-vec` reality. Future RFC can add. |
| D4 | Schema bootstrap via existing `CREATE IF NOT EXISTS` in `openDatabase()` | Repo has no versioned migration system; `migrate-schema.ts` is a one-off historical script |
| D5 | Config path is `~/.config/qkb/index.yml` (not `qkb.yml`) | Actual QKB config location |
| D6 | Reuse the existing `_sqliteVecLoad` pattern in `src/db.ts` for `_graphqliteLoad` | The dual-runtime + macOS-Bun complexity is already solved; mirror it, don't reinvent |
| D7 | Vendoring approach: A+C hybrid (postinstall download with SHA-256 + `QKB_GRAPHQLITE_PATH` escape hatch) | GraphQLite has no upstream npm packages (PR-2 confirmed); A is the lowest-maintenance fit for §7's "verified binaries from upstream releases"; C handles airgapped/corp environments where postinstall is disabled |
| D8 | Single-graph-per-DB; the `qkb` namespace concept is removed | `cypher()` is `(query, params)` not `(namespace, query, params)` — the RFC was wrong. Multi-graph is via Cypher's `FROM` clause (read-only, ~10 max) and not a fit for our use case |
| D9 | §10 empty-graph file-size budget revised from 64 KB to 256 KB | PR-2 measured 184 KB delta on macOS arm64 / v0.4.4. Original budget was a hand-waved guess; revising matches reality with comfortable headroom. RFC §10 updated. |
| D10 | Dump format: QKB-defined NDJSON (subject to repo-owner ack — see C1) | Proposed in SPIKE-RESULTS Q3. Decouples from GraphQLite changes; makes the §7 "exit plan" framing meaningful. |

## 2. Open questions and their owning PR

| Q from §14 | Question | Status | Outcome |
|---|---|---|---|
| Q1 | GraphQLite `cypher()` inside nested SAVEPOINTs | **Resolved (PR-2)** | YES — SAVEPOINT semantics are preserved across SQL/Cypher boundary |
| Q2 | Empty graph on-disk size | **Resolved (PR-2)** | 184 KB observed; §10 budget revised to 256 KB (D9) |
| Q3 | Dump format: GraphQLite-native or QKB-defined? | **Pending owner ack (C1)** | Proposed: QKB-defined NDJSON (D10) |
| Q4 | sqlite-vec × graphqlite ABI compatibility | **Resolved (PR-2)** | YES — coexist + atomic rollback both verified |
| Q5 | GraphQLite per-platform npm packages? | **Resolved (PR-2)** | NO — vendoring is A+C hybrid (D7) |

## 3. PR sequence

Each PR is independent in terms of merge order *for a phase*, but most have
dependencies. Where two rows could go in either order I note it.

### Phase 1 — Foundation (target: v2.2.0)

| PR | Branch | Scope | Depends on | Tests |
|----|--------|-------|-----------|-------|
| 1 | `rfc-0007/01-translate` | RFC translation + this PLAN.md | — | (doc-only, CHANGELOG entry) |
| 2 | `rfc-0007/02-spikes` | Research spikes for Q1/Q2/Q4/Q5; escalate Q3 | 1 | `test/spikes/*.test.ts` (gated by env var so they don't fire in CI) |
| 3 | `rfc-0007/03-config-flag` | `graph.enabled` config schema + `GraphDisabledError` stub | 2 (Q3 resolved) | YAML round-trip; method-throws-when-disabled; default false |
| 4 | `rfc-0007/04-extension-loading` | `loadGraphqlite(db)` mirroring `loadSqliteVec`; vendoring (per Q5 outcome) | 2, 3 | L1/L3/L4 cases; `:memory:` load test; missing-extension error path |
| 5 | `rfc-0007/05-schema-bootstrap` | `qkb` namespace registration + `graph_meta` table | 4 | Clean DB init; existing-DB upgrade path; downgrade leaves graph tables inert |
| 6 | `rfc-0007/06-sdk-core` | `upsertNode`, `upsertEdge`, `cypher` template tag, branded query type | 5 | Round-trip; param injection rejected at type level; runtime parameterization |
| 7 | `rfc-0007/07-tx-cascade` | Cross-extension transaction + delete cascade integration tests | 6 | Three-way commit; three-way rollback; document delete cascades graph |
| 8 | `rfc-0007/08-algos-safety` | `pageRank` wrapper, `query_timeout_ms`, `max_path_length` rewriter | 6 | PageRank correctness; timeout fires; path-cap rejects; rewriter unit tests |
| 9 | `rfc-0007/09-cli` | `qkb graph status/query/pagerank/gc` | 6, 8 | Each subcommand; `--params` enforcement; gc dry-run |
| 10 | `rfc-0007/10-mcp` | `graph_query`, `graph_neighbors` MCP tools | 6, 8 | Tool registration; param rules; hops cap; algorithm not exposed |
| 11 | `rfc-0007/11-dump-restore` | `qkb graph dump/restore` (exit plan from §7) | 6 (or after Q3) | Round-trip; empty-graph dump; corrupted-input refusal |
| 12 | `rfc-0007/12-perf-harness` | `bench/` directory; §10 metrics; CI gate (small corpus) | 4–11 | Harness self-test; baseline regression detector |
| 13 | `rfc-0007/13-release-2.2.0` | `/release 2.2.0` — CHANGELOG roll-up; tutorial/how-to/reference docs | 12 | Release script smoke; docs build |

### Phase 2 — Indexing integration (target: v2.3.0, deferred)

Will be expanded into discrete PRs once Phase 1 ships. Sketch:

- `rfc-0007/14-entity-extraction` — entity-extraction step in `qkb embed` (off by default)
- `rfc-0007/15-bulk-insert` — wire GraphQLite bulk-insert API into indexing pipeline
- `rfc-0007/16-hybrid-query` — filter-then-rank + rank-then-rerank
- `rfc-0007/17-soak-nightly` — 24-hour soak in nightly CI
- `rfc-0007/18-release-2.3.0`

### Phase 3 — Default-on (target: v3.0.0, gated)

Requires a separate decision RFC and the §13 success criteria to hold for six
months after Phase 2 ships. Not authorized by RFC-0007.

## 4. Checkpoints — places I'll stop and ask

I'll continue without asking on anything in §1 above. I will stop and bring
the question to the owner at any of these points:

| Checkpoint | Located in | Question class |
|---|---|---|
| C1 | After PR-2 lands | Q3 (dump format): GraphQLite-native vs QKB-defined NDJSON. **Taste** |
| C2 | If PR-2 reveals Q5 has no upstream npm packages | Architecture: postinstall download with checksum, or fork-and-republish under `@danmestas/graphqlite-*`? **Architecture + supply chain** |
| C3 | If §10 thresholds are missed by >20% on initial benchmarks | Architecture: descope, raise thresholds, or pause Phase 1? **Architecture** |
| C4 | Before PR-13 (v2.2.0 release) | Final go/no-go on shipping Phase 1. **Reversibility** (npm publish) |
| C5 | Before any Phase 2 work begins | Confirm Phase 1 is healthy in real-world use. **Reversibility (further investment)** |
| C6 | Before any Phase 3 work begins | Default-on RFC. **Reversibility (changes user-visible default behavior)** |

Anything that *isn't* a §1 decision or a §4 checkpoint and *also* isn't pure
implementation detail goes through `state-and-proceed` per the global question
discipline rules.

## 5. CHANGELOG strategy

Every PR adds an entry under `## [Unreleased]`. PR-13 (release) collapses these
into the `## [2.2.0]` section per the release script. Sample entries:

- `### Changes — RFC-0007: graph.enabled config flag introduced (default: false; no behavior change).`
- `### Changes — RFC-0007: GraphQLite extension loader; runtime probes mirror sqlite-vec setup.`
- `### Changes — RFC-0007: typed graph SDK (upsertNode/upsertEdge/cypher).`

## 6. Status

Updated as PRs land. Format: `PR-N: <state> [link]`.

- PR-1: **merged** ([#21](https://github.com/danmestas/qkb/pull/21))
- PR-2: in flight — research spikes resolve Q1/Q2/Q4/Q5; Q3 escalated as C1
- PR-3 onward: queued
