/**
 * Integration test for the graph-aware query path — RFC-0009 PR-3.
 *
 * Asserts that `queryWithGraph(store, q)` returns reranked results that
 * include graph-expanded candidates: a doc reachable via a `[[wikilink]]`
 * from a fused-candidate seed must surface in the final top-N even
 * when its own BM25/vector score wouldn't have placed it there alone.
 *
 * Gated twice:
 *   1. GraphQLite must be installed (mirrors `orchestrator.test.ts`'s
 *      skip predicate). On Linux CI without the binary the whole suite
 *      is a no-op.
 *   2. The full query path loads three LLMs (expand, rerank, embed)
 *      and the reranker round-trips ~5 docs. CI doesn't have those
 *      models cached, so we follow the same `process.env.CI` gate as
 *      `test/sdk.test.ts`'s "with LLM query expansion" suite. Local
 *      runs — including PR-author validation — exercise it fully.
 *
 * Use-cases that would tighten this further (mock the LLM at the
 * `store.internal.rerank` boundary) are deferred. The bench harness in
 * PR-8 is the rigorous quality gate; this test is a structural
 * smoke-check that the pieces wire up correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/store-bridge.js";
import { run as runOrchestrator } from "../../src/orchestrator/index-orchestrator.js";
import { queryWithGraph } from "../../src/query/rerank-with-graph.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";

const HAS_GRAPHQLITE =
  !!process.env.QKB_GRAPHQLITE_PATH || existsSync(DEFAULT_BREW_PATH);

const SHOULD_RUN = HAS_GRAPHQLITE && !process.env.CI;

describe.skipIf(!SHOULD_RUN)("queryWithGraph", () => {
  let tmpDir: string;
  let collectionDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "qkb-query-"));
    collectionDir = join(tmpDir, "vault");
    await mkdir(collectionDir, { recursive: true });
    dbPath = join(tmpDir, "index.sqlite");

    // Three notes. graph-queries.md links to edge-weighting.md via a
    // plain wikilink (becomes a `:LINKS_TO` edge). unrelated.md is a
    // distractor with no graph connection. The query targets
    // graph-queries.md directly; edge-weighting.md should rise via the
    // 1-hop graph expansion even though its own BM25/vector score for
    // "graph queries" is weaker than the seed's.
    await writeFile(
      join(collectionDir, "graph-queries.md"),
      "# Graph queries\nGraph queries traverse edges between notes. See [[edge-weighting]] for details.\n"
    );
    await writeFile(
      join(collectionDir, "edge-weighting.md"),
      "# Edge weighting\nEdge weight controls expansion priority. EMBEDS=0.9, LINKS_TO=0.4.\n"
    );
    await writeFile(
      join(collectionDir, "unrelated.md"),
      "# Recipe for sourdough\nMix flour and water; let it ferment overnight.\n"
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns reranked results that include graph-expanded candidates", async () => {
    const store = await openStore({
      dbPath,
      config: {
        collections: {
          vault: { path: collectionDir, pattern: "**/*.md" },
        },
      },
    });

    await runOrchestrator(store, { collections: ["vault"] });
    await store.embed();

    const results = await queryWithGraph(store, "graph queries", { limit: 2 });

    const files = results.map((r) => r.file);
    // Direct match — a BM25/vector winner. Must rank top-2.
    expect(files.some((f) => f.endsWith("graph-queries.md"))).toBe(true);
    // Graph-expanded — only reachable via the wikilink edge. The reranker
    // must place it above the distractor for the assertion to hold.
    expect(files.some((f) => f.endsWith("edge-weighting.md"))).toBe(true);
    // The distractor must not appear in the top-2.
    expect(files.some((f) => f.endsWith("unrelated.md"))).toBe(false);

    await store.close();
  }, 120_000);
});
