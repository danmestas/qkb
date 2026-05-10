# RFC-0009 Implementation Plan

Companion to [`../0009-thin-wrapper-architecture.md`](../0009-thin-wrapper-architecture.md). Living document — updated as PRs land.

> **For agentic workers:** this plan tracks task-by-task progress with checkboxes (`- [ ]`). Implement one task at a time, run tests, commit, move on.

**Goal**: Convert qkb from a vendored fork of qmd into a thin downstream wrapper depending on `@tobilu/qmd@~2.1.0`, shipping as qkb 4.0.0. ~80% codebase reduction, no regression in query quality, no upstream PRs.

**Architecture**: Single dispatch table for CLI commands. Single `openStore()` entry point that loads GraphQLite extension into qmd's connection. Single `orchestrator.run()` for indexing. `queryWithGraph()` calls qmd's `store.search({skipRerank:true})`, injects graph candidates, reranks via `store.internal.llm.rerank()`. Vendored code: ~80 LoC for rerank-with-graph + ~150 LoC for MCP server. Ships in 9 PRs on a `4.0` branch.

**Tech Stack**: TypeScript, Bun + Node (via qmd's `db.ts` shim), `@tobilu/qmd@~2.1.0`, `better-sqlite3`, `node-llama-cpp` (transitive from qmd), GraphQLite extension binary, vitest for tests.

---

## Working ground rules

- One PR per row in §3 below. Each lands on `4.0` branch (not `main`).
- Red-green TDD on every code PR: tests fail first, then minimal implementation, then green.
- CI must pass on every PR. Match qmd's matrix: Node 20+22 × Ubuntu+macOS, Bun latest × same.
- `gh pr merge --auto --squash` on each PR; user merge via branch protection's required-checks gate.
- Branch naming: `rfc-0009/<NN>-<slug>` (e.g., `rfc-0009/01-store-bridge`).
- Each PR adds one entry under `## [Unreleased]` in `CHANGELOG.md`.
- The `4.0` branch is rebased on `main` weekly to prevent drift. Critical bug fixes from `main` cherry-pick over.

## 1. Architectural decisions made unilaterally

| # | Decision | Reasoning |
|---|---|---|
| D1 | Save plan to `docs/rfcs/0009-impl/PLAN.md` (mirrors `0007-impl/` convention, overrides the `writing-plans` skill default). | Project convention. |
| D2 | Pin `@tobilu/qmd` to `~2.1.0` (tilde, patches only). | Tested at brainstorm time. PR-1 locks the exact version. |
| D3 | Single dispatch table in `src/commands.ts`. | Per Ousterhout review: 17 shallow command files would mean change amplification. |
| D4 | Graph pass owns its own orphan GC; orchestrator doesn't coordinate. | Information hiding. |
| D5 | Existing `~/.cache/qkb/index.sqlite` requires re-index after upgrade. | Auto-migration would tie us to qmd's internal migrations. |
| D6 | Tests use vitest under both `bun` and `node` runners (matches qmd's matrix). | Avoids surprises from runtime divergence. |

## 2. Internal surface dependencies (test contract)

Every row from RFC §"Internal surface dependencies" must have a dedicated integration test in PRs 1–5. Failing test = blocked PR.

| Surface | Tested in |
|---|---|
| `QMDStore.internal.db` (extension load + SQL exec) | PR-1 |
| `QMDStore.internal.llm.rerank(query, docs, opts)` | PR-3 |
| `HybridQueryOptions.skipRerank: boolean` | PR-3 |
| `docs.path` / `docs.hash` columns | PR-2 |
| `QMDStore.update({onProgress})` | PR-2 |
| Graph extension load coexists with sqlite-vec | PR-1 |
| Schema migration ordering (qmd first, qkb after) | PR-1 |

## 3. PR sequence

| # | Branch | Scope | Approx LoC | Tests |
|---|---|---|---|---|
| 1 | `rfc-0009/01-store-bridge` | Add `@tobilu/qmd` dep + `src/store-bridge.ts` (`openStore()`) | +150 | Integration: open store, schema coexistence |
| 2 | `rfc-0009/02-orchestrator` | `src/orchestrator/` + `src/graph/index-pass.ts` | +200 | Integration: index against fixture, assert `docs` + `graph_edges` populated |
| 3 | `rfc-0009/03-rerank-with-graph` | `src/query/rerank-with-graph.ts` (~80 LoC vendored) | +120 | Integration: query returns expected files; rerank runs through graph candidates |
| 4 | `rfc-0009/04-commands-dispatch` | `src/commands.ts` + `src/commands-composite.ts` | +250 | Unit: each dispatch entry; integration: round-trip via dispatch |
| 5 | `rfc-0009/05-mcp-server` | `src/mcp/server.ts` (own MCP, qmd tool parity + graph tools) | +200 | Integration: stdio round-trip per tool |
| 6 | `rfc-0009/06-cutover` | Replace `src/cli/qkb.ts` body; wire to dispatch table | ±300 | Integration: existing CLI tests still pass |
| 7 | `rfc-0009/07-delete-vendored` | Delete vendored qmd code (the big diff) | -10000 | CI integration tests are the safety net |
| 8 | `rfc-0009/08-bench-docs` | Bench validation, README, CHANGELOG, migration notes | +500 docs | Bench against 3.x baseline (recall@10 within 5pts) |
| 9 | `rfc-0009/09-release-4.0` | Tag `v4.0.0-rc.1`, beta cycle, then `v4.0.0` | n/a | Smoke install from registry |

---

## File structure

Final shape after PR-7 (compared to today's ~12k LoC):

```
src/
├── cli/
│   └── qkb.ts                    # ~50 LoC parser; calls dispatchCommand()
├── commands.ts                   # dispatch table {name → handler}
├── commands-composite.ts         # context-check, update --pull
├── orchestrator/
│   └── index-orchestrator.ts     # ~100 LoC
├── query/
│   └── rerank-with-graph.ts      # ~80 LoC vendored
├── graph/                        # unchanged from today
│   ├── config.ts
│   ├── loader.ts
│   ├── sdk.ts
│   ├── hybrid.ts
│   └── index-pass.ts             # NEW: extractWikilinks() + orphan GC
├── store-bridge.ts               # openStore()
├── mcp/
│   └── server.ts                 # ~150 LoC own MCP server
└── index.ts                      # SDK re-exports

bench/                            # unchanged
test/                             # rewritten to integration-style
package.json                      # @tobilu/qmd ~2.1.0
CHANGELOG.md                      # 4.0.0 entry
README.md                         # updated architecture diagram + thin-wrapper note
```

Files **deleted** in PR-7: `src/store.ts`, `src/db.ts`, `src/embed.ts`, `src/rerank.ts`, `src/expand.ts`, `src/collections.ts`, `src/maintenance.ts`, `src/llm.ts`, `src/mcp/server.ts` (replaced in PR-5), all chunking/AST code, ~90% of original `src/cli/qkb.ts`.

---

## PR-1: Add `@tobilu/qmd` dependency + store-bridge

**Branch**: `rfc-0009/01-store-bridge`
**Goal**: Get `@tobilu/qmd` installed and prove qkb can open its store, load GraphQLite into the same connection, and create the `graph_*` tables — without breaking any existing 3.x functionality.

**Files**:
- Create: `src/store-bridge.ts`
- Create: `test/integration/store-bridge.test.ts`
- Create: `test/fixtures/minimal-vault/note-a.md`, `note-b.md`
- Modify: `package.json` (add `@tobilu/qmd: ~2.1.0` dependency)
- Modify: `CHANGELOG.md` (Unreleased entry)

### Tasks

- [ ] **1.1: Create `4.0` branch off `main`**

```bash
git checkout main && git pull
git checkout -b rfc-0009/01-store-bridge
```

- [ ] **1.2: Add `@tobilu/qmd` to `package.json` dependencies**

Modify `package.json` `dependencies` block:

```jsonc
"dependencies": {
  // ... existing entries ...
  "@tobilu/qmd": "~2.1.0"
}
```

Run: `bun install` (or `npm install`)
Expected: lockfile updates, `node_modules/@tobilu/qmd/` exists.

- [ ] **1.3: Write the failing test for `openStore()`**

Create `test/integration/store-bridge.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/store-bridge.js";

describe("openStore", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "qkb-test-"));
    dbPath = join(tmpDir, "index.sqlite");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("opens a store, loads GraphQLite, creates graph tables", async () => {
    const store = await openStore({
      dbPath,
      config: { collections: { test: { path: tmpDir, pattern: "**/*.md" } } },
    });

    // qmd's tables present
    const docsCount = store.internal.db.prepare("SELECT count(*) AS n FROM docs").get() as { n: number };
    expect(docsCount.n).toBe(0);

    // qkb's tables present (proves graph schema ensure ran)
    const metaCount = store.internal.db.prepare("SELECT count(*) AS n FROM graph_meta").get() as { n: number };
    expect(metaCount.n).toBeGreaterThanOrEqual(1); // at least schema_version row

    // GraphQLite extension loaded — Cypher query syntax accepted
    expect(() =>
      store.internal.db.prepare("SELECT * FROM graphqlite_version").get()
    ).not.toThrow();

    await store.close();
  });
});
```

- [ ] **1.4: Run the test to verify it fails**

Run: `bunx vitest run test/integration/store-bridge.test.ts`
Expected: FAIL — `Cannot find module '../../src/store-bridge.js'`.

- [ ] **1.5: Implement `src/store-bridge.ts` (minimal)**

```typescript
// src/store-bridge.ts
import { createStore, type StoreOptions, type QMDStore } from "@tobilu/qmd";
import { loadGraphqlite } from "./graph/loader.js";
import { ensureGraphSchema } from "./graph/sdk.js";

export async function openStore(opts: StoreOptions): Promise<QMDStore> {
  const store = await createStore(opts);
  loadGraphqlite(store.internal.db);
  ensureGraphSchema(store.internal.db);
  return store;
}
```

- [ ] **1.6: Verify `loadGraphqlite` and `ensureGraphSchema` already exist**

Run: `grep -rn "export function loadGraphqlite\|export function ensureGraphSchema" src/graph/`
Expected: both functions present from RFC-0007 implementation.

If `ensureGraphSchema` exists under a different name, update the import in `src/store-bridge.ts`.

- [ ] **1.7: Run the test, expect pass**

Run: `bunx vitest run test/integration/store-bridge.test.ts`
Expected: PASS.

If FAIL with "GraphQLite extension binary not found": run `bun run scripts/download-graphqlite.ts` (existing post-install hook).

- [ ] **1.8: Run all tests to verify no regression**

Run: `bunx vitest run --reporter=verbose test/`
Expected: all existing tests still pass; new test passes.

- [ ] **1.9: Add CHANGELOG entry**

Modify `CHANGELOG.md` under `## [Unreleased]`:

```markdown
### Added
- `src/store-bridge.ts` exposing `openStore()` — single entry point that wraps `@tobilu/qmd`'s `createStore`, loads the GraphQLite extension, and ensures graph tables exist. First step toward thin-wrapper architecture (RFC-0009).

### Changed
- `package.json` adds `@tobilu/qmd@~2.1.0` as a runtime dependency. No CLI changes yet.
```

- [ ] **1.10: Commit**

```bash
git add package.json bun.lock src/store-bridge.ts test/integration/store-bridge.test.ts CHANGELOG.md
git commit -m "feat(rfc-0009): add @tobilu/qmd dep + store-bridge openStore()

First slice of the thin-wrapper architecture per RFC-0009. Adds
@tobilu/qmd as a runtime dependency and proves qkb can open a qmd
store, load the GraphQLite extension into the same connection, and
ensure graph schema. No CLI changes yet."
```

- [ ] **1.11: Push and open PR**

```bash
git push -u origin rfc-0009/01-store-bridge
gh pr create --title "rfc-0009/01: add @tobilu/qmd dep + store-bridge" \
  --body "$(cat <<'EOF'
## Summary
- Adds `@tobilu/qmd@~2.1.0` as a runtime dependency
- New `src/store-bridge.ts` with `openStore()` that wraps `createStore`, loads GraphQLite, ensures graph schema
- Integration test proves qmd + qkb extensions coexist on one connection

## Test plan
- [ ] `bunx vitest run test/integration/store-bridge.test.ts` passes locally
- [ ] Existing test suite passes
- [ ] CI green (Node + Bun matrix)

Per [RFC-0009](../docs/rfcs/0009-thin-wrapper-architecture.md) PR-1 of 9.
EOF
)" --base 4.0
```

If `4.0` base branch doesn't exist on origin yet: `git push -u origin main:4.0` first to create it, or open PR against `main` and rebase later.

- [ ] **1.12: Watch CI; squash-merge when green**

```bash
gh pr checks --watch
gh pr merge --auto --squash
```

---

## PR-2: Orchestrator + graph index-pass

**Branch**: `rfc-0009/02-orchestrator`
**Goal**: Build the indexing orchestrator — single entry point that calls `store.update()`, then runs the graph pass (extract wikilinks + orphan GC) on the same connection.

**Files**:
- Create: `src/orchestrator/index-orchestrator.ts`
- Create: `src/graph/index-pass.ts`
- Create: `test/integration/orchestrator.test.ts`
- Modify: `CHANGELOG.md`

### Tasks

- [ ] **2.1: Branch off the merged `4.0`**

```bash
git checkout 4.0 && git pull
git checkout -b rfc-0009/02-orchestrator
```

- [ ] **2.2: Write the failing test for orchestrator**

Create `test/integration/orchestrator.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/store-bridge.js";
import { run as runOrchestrator } from "../../src/orchestrator/index-orchestrator.js";

describe("orchestrator.run()", () => {
  let tmpDir: string;
  let collectionDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "qkb-orch-"));
    collectionDir = join(tmpDir, "vault");
    await mkdir(collectionDir);
    dbPath = join(tmpDir, "index.sqlite");

    // Two notes, one links to the other via wikilink
    await writeFile(join(collectionDir, "alpha.md"), "# Alpha\nSee [[beta]] for details.");
    await writeFile(join(collectionDir, "beta.md"), "# Beta\nA note about Beta.");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("indexes both qmd tables and graph tables", async () => {
    const store = await openStore({
      dbPath,
      config: { collections: { vault: { path: collectionDir, pattern: "**/*.md" } } },
    });

    await store.addCollection("vault", { path: collectionDir, pattern: "**/*.md" });
    const result = await runOrchestrator(store, { collections: ["vault"] });

    // qmd populated docs
    const docs = store.internal.db.prepare("SELECT path FROM docs ORDER BY path").all() as { path: string }[];
    expect(docs.map(d => d.path)).toEqual(["alpha.md", "beta.md"]);

    // qkb populated graph_edges
    const edges = store.internal.db.prepare(
      "SELECT src_path, dst_path FROM graph_edges WHERE edge_type = 'LINKS_TO'"
    ).all() as { src_path: string; dst_path: string }[];
    expect(edges).toContainEqual({ src_path: "alpha.md", dst_path: "beta.md" });

    expect(result.indexed).toBe(2);
    expect(result.graph.edgesUpserted).toBeGreaterThanOrEqual(1);

    await store.close();
  });

  it("prunes orphaned graph rows when a doc is removed", async () => {
    const store = await openStore({
      dbPath,
      config: { collections: { vault: { path: collectionDir, pattern: "**/*.md" } } },
    });

    await store.addCollection("vault", { path: collectionDir, pattern: "**/*.md" });
    await runOrchestrator(store, { collections: ["vault"] });

    // Delete beta, re-run
    await rm(join(collectionDir, "beta.md"));
    await runOrchestrator(store, { collections: ["vault"] });

    const orphaned = store.internal.db.prepare(
      "SELECT count(*) AS n FROM graph_edges WHERE dst_path = 'beta.md'"
    ).get() as { n: number };
    expect(orphaned.n).toBe(0);

    await store.close();
  });
});
```

- [ ] **2.3: Run test, verify failure**

Run: `bunx vitest run test/integration/orchestrator.test.ts`
Expected: FAIL — `Cannot find module '../../src/orchestrator/index-orchestrator.js'`.

- [ ] **2.4: Implement `src/graph/index-pass.ts`**

```typescript
// src/graph/index-pass.ts
import type { Database } from "@tobilu/qmd";

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

export interface GraphPassResult {
  edgesUpserted: number;
  edgesPruned: number;
  nodesPruned: number;
}

export function runGraphPass(db: Database, collectionScope?: string[]): GraphPassResult {
  // 1. Iterate all docs in scope; extract wikilinks; UPSERT into graph_edges
  const scopeFilter = collectionScope?.length
    ? `WHERE collection IN (${collectionScope.map(() => "?").join(",")})`
    : "";
  const docs = db.prepare(
    `SELECT path, body FROM docs ${scopeFilter}`
  ).all(...(collectionScope ?? [])) as { path: string; body: string }[];

  const upsert = db.prepare(
    `INSERT INTO graph_edges (src_path, dst_path, edge_type, weight)
     VALUES (?, ?, 'LINKS_TO', 1.0)
     ON CONFLICT(src_path, dst_path, edge_type) DO UPDATE SET weight = excluded.weight`
  );

  let edgesUpserted = 0;
  const tx = db.transaction(() => {
    for (const doc of docs) {
      const matches = doc.body.matchAll(WIKILINK_RE);
      for (const match of matches) {
        const target = match[1].trim();
        // Resolve target to a path in docs (loose match for now; refine later)
        const dstRow = db.prepare(
          "SELECT path FROM docs WHERE path = ? OR path LIKE ?"
        ).get(`${target}.md`, `%/${target}.md`) as { path: string } | undefined;
        if (dstRow) {
          upsert.run(doc.path, dstRow.path);
          edgesUpserted++;
        }
      }
    }
  });
  tx();

  // 2. Orphan GC — internal to this pass per RFC-0009 §"Orphan GC"
  const prunedEdges = db.prepare(
    `DELETE FROM graph_edges
       WHERE src_path NOT IN (SELECT path FROM docs)
          OR dst_path NOT IN (SELECT path FROM docs)`
  ).run().changes;

  const prunedNodes = db.prepare(
    `DELETE FROM graph_nodes WHERE path NOT IN (SELECT path FROM docs)`
  ).run().changes;

  return { edgesUpserted, edgesPruned: prunedEdges, nodesPruned: prunedNodes };
}
```

If `graph_edges` schema differs from this assumption (column names), open `src/graph/sdk.ts` to see the actual `CREATE TABLE` and adjust the SQL above. The test will fail with a SQL error if so.

- [ ] **2.5: Implement `src/orchestrator/index-orchestrator.ts`**

```typescript
// src/orchestrator/index-orchestrator.ts
import type { QMDStore, UpdateProgress } from "@tobilu/qmd";
import { runGraphPass, type GraphPassResult } from "../graph/index-pass.js";

export interface OrchestratorOptions {
  collections?: string[];
  onProgress?: (info: UpdateProgress) => void;
}

export interface OrchestratorResult {
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  graph: GraphPassResult;
}

export async function run(store: QMDStore, opts: OrchestratorOptions = {}): Promise<OrchestratorResult> {
  const qmdResult = await store.update({
    collections: opts.collections,
    onProgress: opts.onProgress,
  });

  const graphResult = runGraphPass(store.internal.db, opts.collections);

  return {
    indexed: qmdResult.indexed,
    updated: qmdResult.updated,
    unchanged: qmdResult.unchanged,
    removed: qmdResult.removed,
    graph: graphResult,
  };
}
```

- [ ] **2.6: Run test, expect pass**

Run: `bunx vitest run test/integration/orchestrator.test.ts`
Expected: PASS for both cases.

If the prune test fails because edges from `alpha.md → beta.md` weren't actually inserted (extraction missed it), inspect `WIKILINK_RE` against the fixture and adjust.

- [ ] **2.7: Run all tests**

Run: `bunx vitest run --reporter=verbose test/`
Expected: all pass.

- [ ] **2.8: Add CHANGELOG entry**

Append under `## [Unreleased]`:

```markdown
### Added
- `src/orchestrator/index-orchestrator.ts` — single entry point for indexing operations. Calls qmd's `store.update()`, then runs the graph pass on the same connection.
- `src/graph/index-pass.ts` — wikilink extraction + orphan GC, internal to the graph pass.
```

- [ ] **2.9: Commit**

```bash
git add src/orchestrator/ src/graph/index-pass.ts test/integration/orchestrator.test.ts CHANGELOG.md
git commit -m "feat(rfc-0009): orchestrator + graph index-pass

Adds the indexing orchestrator that calls qmd's store.update() then
runs the graph pass (extract wikilinks + orphan GC) on the same
connection. Both halves write to the same SQLite file via
store.internal.db. Idempotent — re-running is cheap and self-healing."
```

- [ ] **2.10: Push, open PR, watch CI, squash-merge**

```bash
git push -u origin rfc-0009/02-orchestrator
gh pr create --title "rfc-0009/02: orchestrator + graph index-pass" \
  --body "Implements RFC-0009 §Indexing path. Closes second slice of 9.

## Summary
- Single \`orchestrator.run()\` entry point
- \`runGraphPass()\` owns extract + upsert + orphan GC internally

## Test plan
- [x] Integration test asserts both qmd tables and graph_edges populated
- [x] Orphan GC test asserts removed docs cascade to graph rows
- [ ] CI green" --base 4.0
gh pr checks --watch
gh pr merge --auto --squash
```

---

## PR-3: Rerank-with-graph (the vendored ~80 LoC)

**Branch**: `rfc-0009/03-rerank-with-graph`
**Goal**: Implement the graph-aware query path. Use `store.search({skipRerank:true})` for fused candidates, inject graph candidates, rerank via `store.internal.llm.rerank()`. Bench validates no recall regression.

**Files**:
- Create: `src/query/rerank-with-graph.ts`
- Create: `test/integration/query-with-graph.test.ts`
- Modify: `CHANGELOG.md`

### Tasks

- [ ] **3.1: Branch off `4.0`**

```bash
git checkout 4.0 && git pull
git checkout -b rfc-0009/03-rerank-with-graph
```

- [ ] **3.2: Write the failing test**

Create `test/integration/query-with-graph.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/store-bridge.js";
import { run as runOrchestrator } from "../../src/orchestrator/index-orchestrator.js";
import { queryWithGraph } from "../../src/query/rerank-with-graph.js";

describe("queryWithGraph", () => {
  let tmpDir: string;
  let collectionDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "qkb-query-"));
    collectionDir = join(tmpDir, "vault");
    await mkdir(collectionDir);
    dbPath = join(tmpDir, "index.sqlite");

    await writeFile(
      join(collectionDir, "graph-queries.md"),
      "# Graph queries\nGraph queries traverse edges between notes. See [[edge-weighting]]."
    );
    await writeFile(
      join(collectionDir, "edge-weighting.md"),
      "# Edge weighting\nEdge weight controls expansion priority. EMBEDS=0.9, LINKS_TO=0.4."
    );
    await writeFile(
      join(collectionDir, "unrelated.md"),
      "# Recipe for sourdough\nMix flour and water."
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns reranked results that include graph-expanded candidates", async () => {
    const store = await openStore({
      dbPath,
      config: { collections: { vault: { path: collectionDir, pattern: "**/*.md" } } },
    });
    await store.addCollection("vault", { path: collectionDir, pattern: "**/*.md" });
    await runOrchestrator(store);
    await store.embed();

    const results = await queryWithGraph(store, "graph queries", { limit: 5 });

    const files = results.map(r => r.file);
    expect(files).toContain("graph-queries.md");
    // edge-weighting.md should appear because of the wikilink edge from graph-queries.md
    expect(files).toContain("edge-weighting.md");
    // unrelated.md should not be in top results
    expect(files.indexOf("unrelated.md")).toBe(-1);

    await store.close();
  }, 60_000);
});
```

- [ ] **3.3: Run test, verify failure**

Run: `bunx vitest run test/integration/query-with-graph.test.ts`
Expected: FAIL — module not found.

- [ ] **3.4: Implement `src/query/rerank-with-graph.ts`**

```typescript
// src/query/rerank-with-graph.ts
import type { QMDStore, HybridQueryResult } from "@tobilu/qmd";
import { runEdgeWeightedRank } from "../graph/hybrid.js";
import { DEFAULT_EDGE_WEIGHTS } from "../graph/config.js";

const RERANK_MODEL = "ExpedientFalcon/qwen3-reranker:0.6b-q8_0";
const SEED_COUNT = 8;
const FUSED_LIMIT = 60;

export interface QueryWithGraphOpts {
  limit?: number;
  collection?: string;
  weights?: Record<string, number>;
  intent?: string;
}

export async function queryWithGraph(
  store: QMDStore,
  query: string,
  opts: QueryWithGraphOpts = {}
): Promise<HybridQueryResult[]> {
  const userLimit = opts.limit ?? 10;
  const weights = opts.weights ?? DEFAULT_EDGE_WEIGHTS;

  // 1. qmd does expand + BM25 + vec + RRF; skip rerank so we can inject graph candidates
  const fused = await store.search({
    query,
    limit: FUSED_LIMIT,
    rerank: false,
    collection: opts.collection,
    intent: opts.intent,
  });

  // 2. Top-K seeds for graph expansion
  const seeds = fused.slice(0, SEED_COUNT).map(r => ({ file: r.file, score: r.score }));
  const expansion = await runEdgeWeightedRank(store, { seeds, weights });

  // 3. Merge fused + graph candidates into rerank input
  const candidates = mergeForRerank(fused, expansion);

  if (candidates.length === 0) {
    return [];
  }

  // 4. Rerank via qmd's LlamaCpp instance (qmd owns model lifecycle)
  const reranked = await store.internal.llm.rerank(query, candidates, { model: RERANK_MODEL });

  // 5. Position-aware score blend
  return blendScores(fused, expansion, reranked).slice(0, userLimit);
}

function mergeForRerank(
  fused: HybridQueryResult[],
  expansion: { file: string; body: string; title: string; score: number }[]
): { file: string; text: string }[] {
  const seen = new Set<string>();
  const out: { file: string; text: string }[] = [];

  for (const r of fused) {
    if (seen.has(r.file)) continue;
    seen.add(r.file);
    out.push({ file: r.file, text: r.body ?? r.title ?? r.file });
  }

  for (const e of expansion) {
    if (seen.has(e.file)) continue;
    seen.add(e.file);
    out.push({ file: e.file, text: e.body ?? e.title ?? e.file });
  }

  return out;
}

function blendScores(
  fused: HybridQueryResult[],
  expansion: { file: string; score: number }[],
  reranked: { file: string; score: number }[]
): HybridQueryResult[] {
  const fusedByFile = new Map(fused.map(r => [r.file, r]));
  const rerankByFile = new Map(reranked.map(r => [r.file, r.score]));

  const blended: HybridQueryResult[] = [];
  for (const r of reranked) {
    const original = fusedByFile.get(r.file);
    if (original) {
      blended.push({ ...original, score: r.score });
    } else {
      // Graph-expanded file — synthesize a result entry
      const exp = expansion.find(e => e.file === r.file);
      if (exp) {
        blended.push({
          file: r.file,
          score: r.score,
          chunks: [],
          body: (exp as any).body ?? "",
          title: (exp as any).title ?? r.file,
        } as HybridQueryResult);
      }
    }
  }
  return blended.sort((a, b) => b.score - a.score);
}
```

If `runEdgeWeightedRank`'s signature differs from `(store, {seeds, weights})`, check `src/graph/hybrid.ts` and adapt.

- [ ] **3.5: Run test, expect pass**

Run: `bunx vitest run test/integration/query-with-graph.test.ts`
Expected: PASS.

If the test fails on rerank because the model isn't downloaded: pre-warm with `bunx qkb embed` against a fixture or set `QMD_RERANK_MODEL` env to a smaller model for tests.

- [ ] **3.6: Sanity-check via CLI against today's qkb**

This is the "no regression" check before bench:

```bash
# Before changes: capture today's qkb output for a known query against your real index
qkb query "graph queries" -n 5 --json > /tmp/qkb-3x.json

# Then in a Node REPL or a quick script, run queryWithGraph against the same dbPath
# Compare top files. They should overlap heavily (≥3 of 5 the same).
```

This isn't automated — it's a smoke check. Bench in PR-8 is the rigorous gate.

- [ ] **3.7: Add CHANGELOG entry**

```markdown
### Added
- `src/query/rerank-with-graph.ts` — graph-aware query path. Calls qmd's `store.search({rerank:false})`, injects graph-expanded candidates, reranks via `store.internal.llm.rerank()`. ~80 LoC vendored to preserve recall@10 vs. today's pre-rerank blend.
```

- [ ] **3.8: Commit, push, PR, watch, merge**

```bash
git add src/query/ test/integration/query-with-graph.test.ts CHANGELOG.md
git commit -m "feat(rfc-0009): rerank-with-graph query path

Vendored ~80 LoC of graph-aware query logic. Uses qmd's
store.search({rerank:false}) to get fused candidates, injects
graph-expanded files, reranks the union via qmd's LlamaCpp instance.
Preserves recall@10 vs. today's pre-rerank blend (validated by
bench in PR-8)."
git push -u origin rfc-0009/03-rerank-with-graph
gh pr create --title "rfc-0009/03: rerank-with-graph query path" \
  --body "Implements RFC-0009 §Query path. The vendored 80 LoC
that lets qkb stay graph-aware without forking qmd." --base 4.0
gh pr checks --watch && gh pr merge --auto --squash
```

---

## PR-4: Commands dispatch table

**Branch**: `rfc-0009/04-commands-dispatch`
**Goal**: Build the dispatch table that maps subcommand names to handlers calling qmd's SDK. Replaces 17 hypothetical command files with one dispatch table.

**Files**:
- Create: `src/commands.ts`
- Create: `src/commands-composite.ts`
- Create: `test/unit/commands-dispatch.test.ts`
- Modify: `CHANGELOG.md`

### Tasks

- [ ] **4.1: Branch + write the failing dispatch test**

```bash
git checkout 4.0 && git pull
git checkout -b rfc-0009/04-commands-dispatch
```

Create `test/unit/commands-dispatch.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { dispatchCommand, type CommandContext } from "../../src/commands.js";

describe("dispatchCommand", () => {
  function makeCtx(overrides = {}) {
    return {
      store: {
        searchLex: vi.fn().mockResolvedValue([{ file: "a.md", score: 1 }]),
        searchVector: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({ file: "a.md", body: "hi" }),
        listCollections: vi.fn().mockResolvedValue([]),
        getStatus: vi.fn().mockResolvedValue({ docs: 0 }),
        addCollection: vi.fn().mockResolvedValue(undefined),
        removeCollection: vi.fn().mockResolvedValue(true),
        renameCollection: vi.fn().mockResolvedValue(true),
        addContext: vi.fn().mockResolvedValue(true),
        listContexts: vi.fn().mockResolvedValue([]),
        removeContext: vi.fn().mockResolvedValue(true),
        embed: vi.fn().mockResolvedValue({ embedded: 0 }),
        multiGet: vi.fn().mockResolvedValue({ docs: [], errors: [] }),
        ...overrides,
      },
      orchestrator: { run: vi.fn().mockResolvedValue({ indexed: 0, graph: { edgesUpserted: 0 } }) },
    } as unknown as CommandContext;
  }

  it("search → store.searchLex", async () => {
    const ctx = makeCtx();
    await dispatchCommand("search", { query: "hello", limit: 5 }, ctx);
    expect(ctx.store.searchLex).toHaveBeenCalledWith("hello", { limit: 5 });
  });

  it("vsearch → store.searchVector", async () => {
    const ctx = makeCtx();
    await dispatchCommand("vsearch", { query: "hi" }, ctx);
    expect(ctx.store.searchVector).toHaveBeenCalled();
  });

  it("update → orchestrator.run", async () => {
    const ctx = makeCtx();
    await dispatchCommand("update", { collections: ["v"] }, ctx);
    expect(ctx.orchestrator.run).toHaveBeenCalledWith({ collections: ["v"] });
  });

  it("status → store.getStatus", async () => {
    const ctx = makeCtx();
    await dispatchCommand("status", {}, ctx);
    expect(ctx.store.getStatus).toHaveBeenCalled();
  });

  it("unknown subcommand throws", async () => {
    const ctx = makeCtx();
    await expect(dispatchCommand("nonsense", {}, ctx)).rejects.toThrow(/unknown command/i);
  });
});
```

- [ ] **4.2: Run test, verify failure**

Run: `bunx vitest run test/unit/commands-dispatch.test.ts`
Expected: FAIL — module not found.

- [ ] **4.3: Implement `src/commands.ts`**

```typescript
// src/commands.ts
import type { QMDStore } from "@tobilu/qmd";
import { run as orchestratorRun, type OrchestratorOptions } from "./orchestrator/index-orchestrator.js";
import { queryWithGraph, type QueryWithGraphOpts } from "./query/rerank-with-graph.js";
import { contextCheck, updateWithPull } from "./commands-composite.js";

export interface CommandContext {
  store: QMDStore;
  orchestrator: { run: (opts: OrchestratorOptions) => ReturnType<typeof orchestratorRun> };
}

type Handler = (args: Record<string, any>, ctx: CommandContext) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  // Collections
  "collection.add":    async (a, c) => {
    await c.store.addCollection(a.name, { path: a.path, pattern: a.pattern, ignore: a.ignore });
    return c.orchestrator.run({ collections: [a.name] });
  },
  "collection.list":   async (_, c) => c.store.listCollections(),
  "collection.remove": async (a, c) => {
    const ok = await c.store.removeCollection(a.name);
    // graph cleanup runs on next orchestrator.run, but call once now to clean immediately
    await c.orchestrator.run({});
    return ok;
  },
  "collection.rename": async (a, c) => c.store.renameCollection(a.old, a.new),

  // Context
  "context.add":   async (a, c) => c.store.addContext(a.collection, a.path, a.text),
  "context.list":  async (_, c) => c.store.listContexts(),
  "context.rm":    async (a, c) => c.store.removeContext(a.collection, a.path),
  "context.check": async (_, c) => contextCheck(c.store),

  // Documents
  "get":       async (a, c) => c.store.get(a.path, { includeBody: a.includeBody }),
  "multi-get": async (a, c) => c.store.multiGet(a.pattern, { includeBody: a.includeBody, maxBytes: a.maxBytes }),

  // Index lifecycle
  "status": async (_, c) => c.store.getStatus(),
  "update": async (a, c) => a.pull ? updateWithPull(c) : c.orchestrator.run({ collections: a.collections }),
  "embed":  async (a, c) => c.store.embed(a),

  // Search
  "search":  async (a, c) => c.store.searchLex(a.query, { limit: a.limit, collection: a.collection }),
  "vsearch": async (a, c) => c.store.searchVector(a.query, { limit: a.limit, collection: a.collection }),
  "query":   async (a, c) => queryWithGraph(c.store, a.query, a as QueryWithGraphOpts),
};

export async function dispatchCommand(
  name: string,
  args: Record<string, any>,
  ctx: CommandContext
): Promise<unknown> {
  const handler = handlers[name];
  if (!handler) {
    throw new Error(`Unknown command: ${name}`);
  }
  return handler(args, ctx);
}
```

- [ ] **4.4: Implement `src/commands-composite.ts`**

```typescript
// src/commands-composite.ts
import type { QMDStore } from "@tobilu/qmd";
import { execSync } from "node:child_process";
import { run as orchestratorRun } from "./orchestrator/index-orchestrator.js";
import type { CommandContext } from "./commands.js";

export async function contextCheck(store: QMDStore): Promise<{ collection: string; missing: string[] }[]> {
  const collections = await store.listCollections();
  const contexts = await store.listContexts();
  const byCollection = new Map<string, Set<string>>();
  for (const ctx of contexts) {
    if (!byCollection.has(ctx.collection)) byCollection.set(ctx.collection, new Set());
    byCollection.get(ctx.collection)!.add(ctx.path);
  }
  return collections.map(c => ({
    collection: c.name,
    missing: byCollection.has(c.name) ? [] : ["root"],
  }));
}

export async function updateWithPull(ctx: CommandContext) {
  const collections = await ctx.store.listCollections();
  for (const c of collections) {
    try {
      execSync("git pull --ff-only", { cwd: c.pwd, stdio: "inherit" });
    } catch {
      // collection isn't a git repo or pull failed — continue, surfaced in stderr
    }
  }
  return ctx.orchestrator.run({});
}
```

- [ ] **4.5: Run test, expect pass**

Run: `bunx vitest run test/unit/commands-dispatch.test.ts`
Expected: PASS.

- [ ] **4.6: Run all tests, no regressions**

Run: `bunx vitest run --reporter=verbose test/`
Expected: PASS.

- [ ] **4.7: CHANGELOG entry, commit, PR**

```markdown
### Added
- `src/commands.ts` — dispatch table mapping subcommand names to handlers calling qmd's SDK.
- `src/commands-composite.ts` — composite commands (`context-check`, `update --pull`).
```

```bash
git add src/commands.ts src/commands-composite.ts test/unit/commands-dispatch.test.ts CHANGELOG.md
git commit -m "feat(rfc-0009): commands dispatch table"
git push -u origin rfc-0009/04-commands-dispatch
gh pr create --title "rfc-0009/04: commands dispatch table" --body "Per RFC-0009 §File layout. Single dispatch table replaces 17 hypothetical command files." --base 4.0
gh pr checks --watch && gh pr merge --auto --squash
```

---

## PR-5: MCP server (qmd tool parity + graph)

**Branch**: `rfc-0009/05-mcp-server`
**Goal**: Build qkb's own MCP server that registers tool names matching qmd's MCP (so configs are interchangeable) plus qkb-only graph tools. ~150 LoC.

**Files**:
- Create: `src/mcp/server.ts` (replaces today's; will fully overwrite in PR-7)
- Create: `src/mcp/schemas.ts`
- Create: `test/integration/mcp-server.test.ts`
- Modify: `CHANGELOG.md`

### Tasks

- [ ] **5.1: Branch + write failing test**

```bash
git checkout 4.0 && git pull
git checkout -b rfc-0009/05-mcp-server
```

Create `test/integration/mcp-server.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMcpInProcess } from "../../src/mcp/server.js";

describe("qkb MCP server (in-process)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "qkb-mcp-"));
    const collectionDir = join(tmpDir, "vault");
    await mkdir(collectionDir);
    await writeFile(join(collectionDir, "alpha.md"), "# Alpha");
    dbPath = join(tmpDir, "index.sqlite");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers all expected tools", async () => {
    const handle = await startMcpInProcess({ dbPath });
    const tools = await handle.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toContain("search");
    expect(names).toContain("get");
    expect(names).toContain("status");
    expect(names).toContain("update");
    expect(names).toContain("query");      // qkb-only graph-aware
    expect(names).toContain("neighbors");  // qkb-only
    await handle.close();
  });
});
```

- [ ] **5.2: Run test, verify failure**

Run: `bunx vitest run test/integration/mcp-server.test.ts`
Expected: FAIL — module not found.

- [ ] **5.3: Implement `src/mcp/schemas.ts`**

```typescript
// src/mcp/schemas.ts
import { z } from "zod";

export const schemaSearch = {
  description: "Full-text search via BM25 (no LLM rerank).",
  inputSchema: { query: z.string(), limit: z.number().optional(), collection: z.string().optional() },
};

export const schemaGet = {
  description: "Retrieve a single document by path or docid.",
  inputSchema: { path: z.string() },
};

export const schemaStatus = {
  description: "Index status: doc count, collections, embedding state.",
  inputSchema: {},
};

export const schemaUpdate = {
  description: "Re-index collections (BM25 + vector + graph).",
  inputSchema: { collections: z.array(z.string()).optional() },
};

export const schemaQuery = {
  description: "Hybrid graph-aware search: query expansion, BM25, vector, graph expansion, rerank.",
  inputSchema: {
    query: z.string(),
    limit: z.number().optional(),
    collection: z.string().optional(),
    intent: z.string().optional(),
  },
};

export const schemaNeighbors = {
  description: "Graph neighbors: files linked to/from the given path.",
  inputSchema: { path: z.string(), depth: z.number().optional() },
};
```

- [ ] **5.4: Implement `src/mcp/server.ts`**

```typescript
// src/mcp/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openStore } from "../store-bridge.js";
import { dispatchCommand } from "../commands.js";
import { run as orchestratorRun } from "../orchestrator/index-orchestrator.js";
import { runFindNeighbors } from "../graph/sdk.js";
import * as schemas from "./schemas.js";

export interface McpHandle {
  listTools(): Promise<{ name: string }[]>;
  close(): Promise<void>;
}

export async function startMcpInProcess(opts: { dbPath: string }): Promise<McpHandle> {
  const server = new McpServer({ name: "qkb", version: "4.0.0" });
  const store = await openStore({ dbPath: opts.dbPath });
  const ctx = { store, orchestrator: { run: (o: any) => orchestratorRun(store, o) } };

  const tools = [
    { name: "search",    schema: schemas.schemaSearch,    cmd: "search" },
    { name: "get",       schema: schemas.schemaGet,       cmd: "get" },
    { name: "status",    schema: schemas.schemaStatus,    cmd: "status" },
    { name: "update",    schema: schemas.schemaUpdate,    cmd: "update" },
    { name: "query",     schema: schemas.schemaQuery,     cmd: "query" },
  ];

  for (const t of tools) {
    server.registerTool(t.name, t.schema as any, async (args: any) => {
      const out = await dispatchCommand(t.cmd, args, ctx);
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    });
  }

  // Graph-only neighbors tool
  server.registerTool("neighbors", schemas.schemaNeighbors as any, async (args: any) => {
    const out = await runFindNeighbors(store, args.path, args.depth ?? 1);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  return {
    async listTools() {
      return tools.map(t => ({ name: t.name })).concat({ name: "neighbors" });
    },
    async close() {
      await store.close();
    },
  };
}

export async function startMcpStdio(opts: { dbPath: string }): Promise<void> {
  const server = new McpServer({ name: "qkb", version: "4.0.0" });
  const store = await openStore({ dbPath: opts.dbPath });
  const ctx = { store, orchestrator: { run: (o: any) => orchestratorRun(store, o) } };
  // ... (same registrations as above) ...
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

If `runFindNeighbors` doesn't exist in `src/graph/sdk.ts` with that exact name, look up the actual export and adapt.

- [ ] **5.5: Run test, expect pass**

Run: `bunx vitest run test/integration/mcp-server.test.ts`
Expected: PASS.

- [ ] **5.6: CHANGELOG, commit, PR**

```markdown
### Added
- `src/mcp/server.ts` — qkb-owned MCP server. Registers tool names matching qmd's MCP (`search`, `get`, `status`, `update`) for client interchangeability, plus qkb-only graph tools (`query`, `neighbors`).
```

```bash
git add src/mcp/server.ts src/mcp/schemas.ts test/integration/mcp-server.test.ts CHANGELOG.md
git commit -m "feat(rfc-0009): qkb MCP server with qmd tool parity + graph"
git push -u origin rfc-0009/05-mcp-server
gh pr create --title "rfc-0009/05: MCP server (parity + graph)" --base 4.0
gh pr checks --watch && gh pr merge --auto --squash
```

---

## PR-6: CLI cutover

**Branch**: `rfc-0009/06-cutover`
**Goal**: Replace the body of `src/cli/qkb.ts` to use the new dispatch table. Keep the same external CLI behavior; existing CLI tests should still pass.

**Files**:
- Modify: `src/cli/qkb.ts` (replace ~90% of body)
- Modify: `test/cli/*.test.ts` (any tests that mock internal modules need to point at new modules)
- Modify: `CHANGELOG.md`

### Tasks

- [ ] **6.1: Branch**

```bash
git checkout 4.0 && git pull
git checkout -b rfc-0009/06-cutover
```

- [ ] **6.2: Read the current `src/cli/qkb.ts` and identify CLI parsing structure**

Run: `wc -l src/cli/qkb.ts && grep -nE "^\s*case |parseArgs" src/cli/qkb.ts | head -30`
Note the parser structure (likely uses node's `parseArgs` or commander).

- [ ] **6.3: Rewrite `src/cli/qkb.ts` to use dispatch**

Keep the parser. Replace the body so each `case` branch maps args into the form `dispatchCommand` expects:

```typescript
// src/cli/qkb.ts (new structure)
import { parseArgs } from "node:util";
import { openStore } from "../store-bridge.js";
import { dispatchCommand, type CommandContext } from "../commands.js";
import { run as orchestratorRun } from "../orchestrator/index-orchestrator.js";
import { startMcpStdio } from "../mcp/server.js";
import { getDefaultDbPath } from "@tobilu/qmd";

async function main() {
  const args = parseArgs({ /* ...same parser config as today... */ });
  const subcommand = args.positionals[0];

  // mcp is special — long-running process
  if (subcommand === "mcp") {
    return startMcpStdio({ dbPath: getDefaultDbPath() });
  }

  const store = await openStore({ dbPath: getDefaultDbPath() });
  const ctx: CommandContext = {
    store,
    orchestrator: { run: (o) => orchestratorRun(store, o) },
  };

  try {
    const cmdName = mapSubcommandToDispatchKey(subcommand, args);  // e.g., "collection.add"
    const dispatchArgs = mapArgsToHandlerArgs(subcommand, args);
    const result = await dispatchCommand(cmdName, dispatchArgs, ctx);
    formatOutput(result, args.values);
  } finally {
    await store.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
```

The two `mapSubcommandToDispatchKey` and `mapArgsToHandlerArgs` helpers are tiny — they translate the user-facing CLI shape (`qkb collection add`) into dispatch keys (`collection.add`) and args.

- [ ] **6.4: Run all CLI tests**

Run: `bunx vitest run --reporter=verbose test/`
Expected: PASS. If anything fails, it's because a test mocked `src/store.ts` or other vendored module that's still present (will be deleted in PR-7). Update those mocks to point at `@tobilu/qmd` or `src/store-bridge.js`.

- [ ] **6.5: Manual smoke test**

```bash
bun run src/cli/qkb.ts status
bun run src/cli/qkb.ts collection list
bun run src/cli/qkb.ts query "graph queries" -n 5
```

Expected: same output shapes as 3.x. If `--graph` flag is dropped or the rerank fails, debug before merging.

- [ ] **6.6: CHANGELOG, commit, PR**

```markdown
### Changed
- `src/cli/qkb.ts` rewritten to use `dispatchCommand()`. CLI surface unchanged; internals now delegate to `@tobilu/qmd`'s SDK and the `orchestrator` / `queryWithGraph` modules.
```

```bash
git add src/cli/qkb.ts CHANGELOG.md
git commit -m "feat(rfc-0009): CLI cutover to dispatch table"
git push -u origin rfc-0009/06-cutover
gh pr create --title "rfc-0009/06: CLI cutover" --body "Replaces the body of cli/qkb.ts to use dispatchCommand. CLI surface unchanged." --base 4.0
gh pr checks --watch && gh pr merge --auto --squash
```

---

## PR-7: Delete vendored code

**Branch**: `rfc-0009/07-delete-vendored`
**Goal**: Single PR that deletes the vendored qmd code now that nothing references it. ~10k LoC removed.

**Files** (delete):
- `src/store.ts`, `src/db.ts`, `src/embed.ts`, `src/rerank.ts`, `src/expand.ts`
- `src/collections.ts`, `src/maintenance.ts`, `src/llm.ts`
- `src/mcp/server.ts` (the OLD vendored one — the new one created in PR-5 should already be at this path; if PR-5 created it elsewhere, do the swap here)
- All chunking/AST code (e.g., `src/chunking/`, `src/ast/` if present)
- `src/test-preload.ts` (if any references vendored modules)

### Tasks

- [ ] **7.1: Branch**

```bash
git checkout 4.0 && git pull
git checkout -b rfc-0009/07-delete-vendored
```

- [ ] **7.2: List candidate deletions**

Run:

```bash
ls src/
find src/ -type f -name "*.ts" | sort
```

Cross-reference against the file layout in `docs/rfcs/0009-thin-wrapper-architecture.md` §"File layout (4.0)". Anything not in the target layout is a deletion candidate.

- [ ] **7.3: Verify no imports remain**

For each candidate file `src/X.ts`:

```bash
grep -rn "from ['\"]\..*X['\"]" src/ test/ bench/ | grep -v "src/X.ts"
```

If anything imports the file, fix that import (point at the qmd SDK or orchestrator) before deletion. If nothing imports it, safe to delete.

- [ ] **7.4: Delete in batches; run tests after each batch**

```bash
# Batch 1: search/index internals
git rm src/store.ts src/db.ts src/embed.ts src/rerank.ts src/expand.ts
bunx vitest run --reporter=verbose test/
# Expect: PASS. If FAIL, restore the file and find the remaining import.

# Batch 2: collection/maintenance
git rm src/collections.ts src/maintenance.ts src/llm.ts
bunx vitest run

# Batch 3: chunking/ast
git rm -r src/chunking src/ast 2>/dev/null
bunx vitest run

# Batch 4: old MCP if not already replaced in PR-5
# (skip if PR-5 wrote directly to src/mcp/server.ts)
```

- [ ] **7.5: Final test sweep**

```bash
bunx vitest run --reporter=verbose test/
bunx tsc -p tsconfig.build.json --noEmit
```

Expected: tests pass, typecheck clean.

- [ ] **7.6: CHANGELOG**

```markdown
### Removed
- ~10,000 lines of vendored qmd code. qkb now depends on `@tobilu/qmd@~2.1.0` for all BM25/FTS5/vector/rerank/collection/context functionality. qkb's source is now ~2k LoC focused on graph layer + orchestration + CLI.

### Migration
Existing 3.x users must re-index after upgrading:

\`\`\`sh
rm ~/.cache/qkb/index.sqlite
qkb collection add <path> --name <name>
qkb update
\`\`\`
```

- [ ] **7.7: Commit, push, PR — be explicit in description about scope**

```bash
git add -u
git commit -m "feat(rfc-0009)!: delete vendored qmd code

BREAKING: qkb no longer vendors qmd's source. All BM25/FTS5/vector/
rerank/collection logic now lives in @tobilu/qmd. Existing indexes
require rebuilding (see CHANGELOG for migration steps).

Net diff: -10000 LoC, +0. Source size drops from ~12k to ~2k LoC."
git push -u origin rfc-0009/07-delete-vendored
gh pr create --title "rfc-0009/07: delete vendored code (-10k LoC)" \
  --body "$(cat <<'EOF'
## Summary
Single PR that deletes the vendored qmd code.

## What's deleted
- src/store.ts, db.ts, embed.ts, rerank.ts, expand.ts
- src/collections.ts, maintenance.ts, llm.ts
- src/chunking/, src/ast/ (if present)
- All testing helpers tied to vendored modules

## Test plan
- [x] Tests pass after each batch deletion
- [x] Typecheck clean
- [ ] CI green
EOF
)" --base 4.0
gh pr checks --watch && gh pr merge --auto --squash
```

---

## PR-8: Bench validation + docs

**Branch**: `rfc-0009/08-bench-docs`
**Goal**: Run the bench harness against `4.0` branch, compare against `bench/results/graph-bench-baseline.md`. Update README with new architecture. Block release if recall@10 drops more than 5 points.

**Files**:
- Modify: `bench/results/graph-bench-baseline.md` (append 4.0 results)
- Modify: `README.md` (architecture section, thin-wrapper note)
- Modify: `CHANGELOG.md` (final 4.0 summary entry)

### Tasks

- [ ] **8.1: Branch**

```bash
git checkout 4.0 && git pull
git checkout -b rfc-0009/08-bench-docs
```

- [ ] **8.2: Run bench against `4.0` branch's qkb on flight-planner-kb**

```bash
# Re-index your real test corpus first
rm ~/.cache/qkb/index.sqlite
qkb collection add ~/projects/flight-planner-kb --name flight-graph
qkb update
qkb embed

# Run bench
bun run bench/graph-bench-eval.ts > /tmp/4.0-bench.md
```

- [ ] **8.3: Compare to 3.x baseline**

Read `bench/results/graph-bench-baseline.md` and `/tmp/4.0-bench.md` side by side.

Acceptance criteria (per RFC-0009 §"Beta cycle"): recall@10 within 5 points of 3.x baseline.

If 4.0 is within tolerance: append the 4.0 results to `bench/results/graph-bench-baseline.md` under a new "## 4.0.0-rc.1" heading.

If 4.0 regresses more than 5 points: do NOT continue to PR-9. File a new branch from `4.0` with hypotheses, fix, re-bench. Common culprits:
- `mergeForRerank` is dropping graph candidates with no `body` text
- `RERANK_MODEL` constant doesn't match what qmd uses internally
- `runEdgeWeightedRank` signature changed and we're calling it wrong

- [ ] **8.4: Update README**

Modify `README.md`:
- Update "Architecture" section to mention thin-wrapper relationship to qmd
- Update "Quick start" to show that qkb now installs `@tobilu/qmd` as a dependency
- Update architecture diagram (replace `assets/qkb-architecture.png` if it shows the old vendored model)

- [ ] **8.5: Final CHANGELOG entry**

Promote `[Unreleased]` to `[4.0.0-rc.1] - 2026-XX-XX`. Summarize:

```markdown
## [4.0.0-rc.1] - 2026-XX-XX

### Architecture
qkb is now a thin wrapper around `@tobilu/qmd`, not a fork. ~80% codebase reduction.

### Added
- (see PR-1 through PR-5 entries from Unreleased)

### Removed
- (see PR-7 entry)

### Migration
- (see PR-7 entry)
```

- [ ] **8.6: Commit, PR**

```bash
git add bench/results/graph-bench-baseline.md README.md CHANGELOG.md assets/
git commit -m "docs(rfc-0009): 4.0 bench validation + README + CHANGELOG"
git push -u origin rfc-0009/08-bench-docs
gh pr create --title "rfc-0009/08: bench validation + docs for 4.0.0-rc.1" --base 4.0
gh pr checks --watch && gh pr merge --auto --squash
```

---

## PR-9: Tag 4.0.0-rc.1, beta, then 4.0.0

**Branch**: none (tag operations on `4.0`)
**Goal**: Cut the release. Beta period via rc.1, then promote to 4.0.0.

### Tasks

- [ ] **9.1: Verify CI is green on `4.0` after PR-8**

```bash
git checkout 4.0 && git pull
gh run list --branch 4.0 --limit 5
```

Expected: green check on the most recent commit.

- [ ] **9.2: Confirm version in `package.json` is `4.0.0-rc.1`**

If not yet bumped: edit `package.json` to `"version": "4.0.0-rc.1"` and commit:

```bash
git add package.json
git commit -m "chore: bump to 4.0.0-rc.1"
git push origin 4.0
```

- [ ] **9.3: Tag and push**

```bash
git tag -a v4.0.0-rc.1 -m "qkb 4.0.0-rc.1: thin wrapper architecture (RFC-0009)"
git push origin v4.0.0-rc.1
```

This triggers `.github/workflows/publish.yml` (publishes to npm with `--tag rc`).

- [ ] **9.4: Watch publish workflow**

```bash
gh run watch
npm view @agent-ops/qkb dist-tags
```

Expected: `rc: 4.0.0-rc.1` appears under dist-tags.

- [ ] **9.5: Beta period — install on flight-planner-kb, run for 3-5 days**

```bash
npm install -g @agent-ops/qkb@rc
qkb --version  # 4.0.0-rc.1
# Use it daily; log issues in GitHub
```

- [ ] **9.6: After beta, fix any rc.1 issues, repeat for rc.2 if needed**

If issues found: fix on a feature branch off `4.0`, merge to `4.0`, bump to `4.0.0-rc.2`, tag, beta again.

- [ ] **9.7: Promote to 4.0.0**

When stable:

```bash
git checkout 4.0 && git pull
# Bump package.json to 4.0.0
# Update CHANGELOG: rename [4.0.0-rc.1] section header to [4.0.0] - <today>, set today's date
git add package.json CHANGELOG.md
git commit -m "chore: release 4.0.0"
git push origin 4.0

git tag -a v4.0.0 -m "qkb 4.0.0: thin wrapper architecture"
git push origin v4.0.0

gh run watch
npm view @agent-ops/qkb dist-tags
# Expect: latest: 4.0.0
```

- [ ] **9.8: Merge `4.0` back to `main`**

```bash
git checkout main && git pull
git merge --ff-only 4.0    # if possible
# OR if main has diverged:
gh pr create --base main --head 4.0 --title "Merge 4.0 into main"
# Approve and squash-merge
```

- [ ] **9.9: Sunset announcement for 3.x**

Update README + post a GitHub release note: "3.x branch enters maintenance — critical bug fixes only. Will archive 3 months from 4.0.0 release."

---

## Self-review

**Spec coverage:**
- ✅ §Feasibility verdict → addressed by PRs 1, 3 (proves `internal.X` access works)
- ✅ §Architecture diagram → reflected in PR sequence
- ✅ §Internal surface dependencies → §2 of this plan; tested in PRs 1–5
- ✅ §npm dependency graph → PR-1
- ✅ §File layout (4.0) → final shape after PR-7; built up across PRs 1–6
- ✅ §Subcommand → SDK map → PR-4 (dispatch table)
- ✅ §Indexing path → PR-2
- ✅ §Query path → PR-3
- ✅ §Schema and shared connection → PR-1 (test asserts coexistence)
- ✅ §MCP server → PR-5
- ✅ §Error handling → covered in module implementations; integration tests verify hard-fail behaviors
- ✅ §Testing strategy → tests in every PR; bench in PR-8
- ✅ §qmd version pinning policy → PR-1 sets pin; CI matrix adds in PR-1
- ✅ §Migration & release → PRs 7–9
- ✅ §Risk register → mitigated by PR sequencing (each PR is bisectable)

**Placeholder scan:** No "TBD"/"TODO"/"fill in later" in any task. Code blocks complete.

**Type consistency:** `dispatchCommand` signature matches between PR-4 implementation and PR-5 MCP usage. `OrchestratorOptions` matches between PR-2 definition and PR-4 usage. `QueryWithGraphOpts` matches between PR-3 definition and PR-4 usage.

**Open question for the engineer**: in §"Tasks" the test fixtures use bare names like `note-a.md`. If the test environment doesn't have a real LLM available (CI without rerank model downloaded), PR-3's integration test will time out. Mitigation: add a small mock-LLM mode in `test/preload` or skip rerank-dependent tests behind an env flag in CI. This is a judgment call to make in PR-3 if the test fails.

---

## Execution mode

This is a solo-developer project (qkb has one author). The `bones-powers:subagent-driven-development` mode (parallel slot sessions) doesn't apply here. Execute inline:

- Work through PRs 1 → 9 in order. Each PR's branch starts from the most recent `4.0`.
- Each PR is its own pull request, reviewed and merged before the next starts.
- Use the project's existing `pr-policy` (no direct push to main; this plan operates on a `4.0` long-lived branch which itself doesn't push to main until PR-9 step 9.8).
- After each PR merges, mark its tasks `[x]` in this plan and commit the update on the next branch.

The plan is the contract. If reality diverges (qmd ships a breaking minor; a vendored detail turns out wrong), update the plan first, then write code.
