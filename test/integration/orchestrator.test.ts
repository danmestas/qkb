/**
 * Integration test for the indexing orchestrator — RFC-0009 PR-2.
 *
 * Asserts the single-entry-point invariant: `orchestrator.run()` calls
 * qmd's `store.update()` to populate `documents` + `content`, then runs
 * the graph pass on the same connection so `(:Note)-[:LINKS_TO]->(:Note)`
 * edges land in GraphQLite-managed tables. Both halves write to the same
 * SQLite file via `store.internal.db`.
 *
 * Skipped when GraphQLite isn't installed (Linux CI without the binary,
 * Windows). Mirrors `store-bridge.test.ts`'s skip predicate.
 *
 * Adaptation from PLAN.md: the plan assumed a relational `graph_edges`
 * table with `src_path`/`dst_path` columns. The actual graph layer is
 * GraphQLite-backed (Cypher `(:Note)-[:LINKS_TO]->(:Note)` patterns,
 * stored in GraphQLite-managed tables). Edge assertions use Cypher.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/store-bridge.js";
import { run as runOrchestrator } from "../../src/orchestrator/index-orchestrator.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";

const HAS_GRAPHQLITE =
  !!process.env.QKB_GRAPHQLITE_PATH || existsSync(DEFAULT_BREW_PATH);

describe.skipIf(!HAS_GRAPHQLITE)("orchestrator.run()", () => {
  let tmpDir: string;
  let collectionDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "qkb-orch-"));
    collectionDir = join(tmpDir, "vault");
    await mkdir(collectionDir, { recursive: true });
    dbPath = join(tmpDir, "index.sqlite");

    // Two notes; alpha links to beta via a wikilink. The link is plain
    // (not embed) so it lands as `:LINKS_TO` per the wikilink-extraction
    // contract.
    await writeFile(
      join(collectionDir, "alpha.md"),
      "# Alpha\nSee [[beta]] for details.\n"
    );
    await writeFile(
      join(collectionDir, "beta.md"),
      "# Beta\nA note about Beta.\n"
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("indexes both qmd tables and the graph layer", async () => {
    const store = await openStore({
      dbPath,
      config: {
        collections: {
          vault: { path: collectionDir, pattern: "**/*.md" },
        },
      },
    });

    const result = await runOrchestrator(store, { collections: ["vault"] });

    // qmd populated documents.
    const docs = store.internal.db
      .prepare(
        "SELECT path FROM documents WHERE active = 1 ORDER BY path"
      )
      .all() as Array<{ path: string }>;
    expect(docs.map((d) => d.path)).toEqual(["alpha.md", "beta.md"]);

    // qkb populated the graph: alpha.md → beta.md as a :LINKS_TO edge.
    const edgesRow = store.internal.db
      .prepare("SELECT cypher(?, ?) AS r")
      .get(
        "MATCH (a)-[r:LINKS_TO]->(b) RETURN a.path AS src, b.path AS dst",
        JSON.stringify({})
      ) as { r: string };
    const edges = JSON.parse(edgesRow.r) as Array<{
      src: string;
      dst: string;
    }>;
    expect(edges).toContainEqual({ src: "alpha.md", dst: "beta.md" });

    // qmd-side counters reflect the indexing run.
    expect(result.indexed).toBeGreaterThanOrEqual(2);
    // Graph upserted at least the one resolved wikilink.
    expect(result.graph.edgesUpserted).toBeGreaterThanOrEqual(1);

    await store.close();
  });

  it("prunes orphaned graph nodes when a doc is removed", async () => {
    const store = await openStore({
      dbPath,
      config: {
        collections: {
          vault: { path: collectionDir, pattern: "**/*.md" },
        },
      },
    });

    await runOrchestrator(store, { collections: ["vault"] });

    // Remove beta.md from disk and re-run. qmd's update() deactivates
    // the missing doc; the graph pass must prune the orphan node.
    await rm(join(collectionDir, "beta.md"));
    const second = await runOrchestrator(store, { collections: ["vault"] });

    // No active doc with path 'beta.md' anymore.
    const stillActive = store.internal.db
      .prepare("SELECT count(*) AS n FROM documents WHERE path = 'beta.md' AND active = 1")
      .get() as { n: number };
    expect(stillActive.n).toBe(0);

    // The :Note node for beta.md should be gone from the graph.
    const orphanRow = store.internal.db
      .prepare("SELECT cypher(?, ?) AS r")
      .get(
        "MATCH (n) WHERE n.path = $path RETURN count(n) AS c",
        JSON.stringify({ path: "beta.md" })
      ) as { r: string };
    const parsed = JSON.parse(orphanRow.r) as Array<{ c: number | string }>;
    const remaining = Number(parsed[0]?.c ?? 0);
    expect(remaining).toBe(0);

    expect(second.graph.nodesPruned).toBeGreaterThanOrEqual(1);

    await store.close();
  });
});
