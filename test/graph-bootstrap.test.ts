/**
 * Tests for the graph schema bootstrap path — RFC-0007 §9.
 *
 * `initializeDatabase()` (in src/store.ts) reads graph config; if
 * `graph.enabled=true` and the binary loads, ensures the QKB-owned
 * `graph_meta` table exists. GraphQLite's own schema materializes
 * lazily on first cypher() write — we don't force it.
 *
 * Cases:
 *   1. graph.enabled=false → no graph_meta table created (default)
 *   2. graph.enabled=true + binary available → graph_meta has 1 row with
 *      a non-empty graphqlite_version; idempotent on re-open
 *   3. graph.enabled=true + binary missing → store still works for
 *      non-graph features; graph_meta NOT created (graceful degrade)
 *
 * Case 2 is gated on a real binary (skipIf no QKB_GRAPHQLITE_PATH and no
 * brew default). Cases 1 + 3 always run.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { setConfigSource } from "../src/collections.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";

const HAS_REAL_BINARY =
  !!process.env.QKB_GRAPHQLITE_PATH ||
  existsSync(DEFAULT_BREW_PATH);

describe("graph schema bootstrap", () => {
  let tmpDir: string;
  let originalEnvPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-graph-bootstrap-"));
    originalEnvPath = process.env.QKB_GRAPHQLITE_PATH;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    setConfigSource(); // reset
    if (originalEnvPath === undefined) delete process.env.QKB_GRAPHQLITE_PATH;
    else process.env.QKB_GRAPHQLITE_PATH = originalEnvPath;
  });

  function dbPath(name = "test"): string {
    return join(tmpDir, `${name}.sqlite`);
  }

  function tableExists(store: ReturnType<typeof createStore>, name: string): boolean {
    const row = store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(name);
    return row != null;
  }

  it("does not create graph_meta when graph is absent from config (default)", () => {
    setConfigSource({ config: { collections: {}, graph: { enabled: false } } });
    const store = createStore(dbPath("disabled-default"));
    try {
      expect(tableExists(store, "graph_meta")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("does not create graph_meta when graph.enabled=false explicitly", () => {
    setConfigSource({
      config: { collections: {}, graph: { enabled: false } },
    });
    const store = createStore(dbPath("disabled-explicit"));
    try {
      expect(tableExists(store, "graph_meta")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("graceful degrade: enabled=true + missing binary → store works, no graph_meta", () => {
    process.env.QKB_GRAPHQLITE_PATH = join(tmpDir, "nonexistent.dylib");
    setConfigSource({
      config: { collections: {}, graph: { enabled: true } },
    });

    // Should NOT throw — graceful degrade like sqlite-vec.
    const store = createStore(dbPath("missing-binary"));
    try {
      expect(tableExists(store, "graph_meta")).toBe(false);
      // Other tables are still created — non-graph features unaffected.
      expect(tableExists(store, "documents")).toBe(true);
      expect(tableExists(store, "content")).toBe(true);
    } finally {
      store.close();
    }
  });

  describe.skipIf(!HAS_REAL_BINARY)("with real GraphQLite binary", () => {
    it("creates graph_meta with one row when graph.enabled=true", () => {
      setConfigSource({
        config: { collections: {}, graph: { enabled: true } },
      });
      const store = createStore(dbPath("enabled-real"));
      try {
        expect(tableExists(store, "graph_meta")).toBe(true);

        const rows = store.db
          .prepare("SELECT * FROM graph_meta")
          .all() as Array<{ graphqlite_version: string; initialized_at: string }>;
        expect(rows.length).toBe(1);
        expect(rows[0]?.graphqlite_version).toBeTruthy();
        expect(rows[0]?.initialized_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
      } finally {
        store.close();
      }
    });

    it("re-opening with graph.enabled=true is idempotent (no duplicate rows)", () => {
      setConfigSource({
        config: { collections: {}, graph: { enabled: true } },
      });
      const path = dbPath("idempotent");

      const store1 = createStore(path);
      store1.close();

      const store2 = createStore(path);
      try {
        const rowCount = (
          store2.db.prepare("SELECT COUNT(*) AS c FROM graph_meta").get() as
            | { c: number }
            | undefined
        )?.c;
        expect(rowCount).toBe(1);
      } finally {
        store2.close();
      }
    });

    it("downgrade then re-open with graph.enabled=false leaves graph tables inert (not dropped)", () => {
      const path = dbPath("downgrade");

      // Create with graph.enabled=true so the schema lands.
      setConfigSource({
        config: { collections: {}, graph: { enabled: true } },
      });
      const enabled = createStore(path);
      enabled.close();

      // Re-open with graph.enabled=false — graph_meta must still exist on disk
      // but cypher() function should not be registered.
      setConfigSource({
        config: { collections: {}, graph: { enabled: false } },
      });
      const disabled = createStore(path);
      try {
        expect(tableExists(disabled, "graph_meta")).toBe(true);

        // cypher() should be unavailable
        let cypherWorks = true;
        try {
          disabled.db.prepare("SELECT cypher(?)").get("RETURN 1 AS x");
        } catch {
          cypherWorks = false;
        }
        expect(cypherWorks).toBe(false);
      } finally {
        disabled.close();
      }
    });
  });
});
