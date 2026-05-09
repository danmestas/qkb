/**
 * Integration test for `openStore()` — RFC-0009 PR-1.
 *
 * Proves the thin-wrapper architecture's foundation: qkb can open a
 * `@tobilu/qmd` store, load the GraphQLite extension into the same
 * better-sqlite3 connection, and create the qkb-owned `graph_meta`
 * schema — all without conflicting with qmd's own table set.
 *
 * Tests skip if the GraphQLite extension binary isn't available
 * (Linux CI without the binary, Windows). On macOS the binary is
 * installed via `brew install graphqlite` (CI does this).
 *
 * Internal-surface coverage from RFC §"Internal surface dependencies":
 *   - `QMDStore.internal.db` — extension load + ad-hoc SQL exec
 *   - Graph extension load coexists with sqlite-vec on one connection
 *   - Schema migration ordering: qmd first, qkb after
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/store-bridge.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";

const HAS_GRAPHQLITE =
  !!process.env.QKB_GRAPHQLITE_PATH || existsSync(DEFAULT_BREW_PATH);

describe.skipIf(!HAS_GRAPHQLITE)("openStore", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "qkb-store-bridge-"));
    dbPath = join(tmpDir, "index.sqlite");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("opens a qmd store, loads GraphQLite, creates graph_meta", async () => {
    const store = await openStore({
      dbPath,
      config: {
        collections: {
          test: { path: tmpDir, pattern: "**/*.md" },
        },
      },
    });

    // qmd's own tables present (created by createStore migrations).
    // qmd 2.1 uses `documents` for the canonical doc table; `store_*`
    // tables exist for collection/context state.
    const docsCount = store.internal.db
      .prepare("SELECT count(*) AS n FROM documents")
      .get() as { n: number };
    expect(docsCount.n).toBe(0);

    const collectionsTable = store.internal.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='store_collections'"
      )
      .get() as { name: string } | undefined;
    expect(collectionsTable?.name).toBe("store_collections");

    // qkb's own table present — proves ensureGraphSchema ran AFTER qmd
    // migrated. graph_meta is a singleton row keyed by id='qkb' with the
    // graphqlite_version pin.
    const metaRows = store.internal.db
      .prepare("SELECT id, graphqlite_version FROM graph_meta")
      .all() as Array<{ id: string; graphqlite_version: string }>;
    expect(metaRows).toHaveLength(1);
    expect(metaRows[0]?.id).toBe("qkb");
    expect(metaRows[0]?.graphqlite_version).toBeTruthy();

    // GraphQLite extension actually loaded — the `cypher()` SQL function
    // is only available when the extension is loaded. A trivial Cypher
    // query exercises it without depending on graph data.
    expect(() =>
      store.internal.db
        .prepare("SELECT cypher('RETURN 1 AS n', NULL) AS result")
        .get()
    ).not.toThrow();

    await store.close();
  });

  it("is idempotent across re-opens", async () => {
    const first = await openStore({
      dbPath,
      config: {
        collections: { test: { path: tmpDir, pattern: "**/*.md" } },
      },
    });
    await first.close();

    // Re-opening must not error and must not duplicate graph_meta rows.
    const second = await openStore({
      dbPath,
      config: {
        collections: { test: { path: tmpDir, pattern: "**/*.md" } },
      },
    });
    const count = second.internal.db
      .prepare("SELECT count(*) AS n FROM graph_meta")
      .get() as { n: number };
    expect(count.n).toBe(1);
    await second.close();
  });
});
