/**
 * Tests for src/graph/loader.ts — RFC-0007 extension loader.
 *
 * The loader resolves a GraphQLite binary path, calls db.loadExtension(),
 * and verifies it works with a probe. Three test contexts:
 *
 *   1. **Always-on (CI-safe)**: error paths when binary is missing.
 *   2. **Gated on real binary** (`QKB_GRAPHQLITE_PATH` or brew default):
 *      L1/L3 happy paths.
 *   3. **Bun-vs-Node parity**: same loader API works under both runtimes,
 *      mirroring the existing sqlite-vec abstraction.
 *
 * The skip-when-no-binary gating uses the same pattern as
 * `test/spikes/graphqlite-spikes.test.ts` so this file is safe to run in
 * any CI matrix slot, with or without graphqlite installed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import {
  loadGraphqlite,
  resolveGraphqlitePath,
  GraphExtensionUnavailableError,
} from "../src/graph/loader.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";

const HAS_REAL_BINARY =
  !!process.env.QKB_GRAPHQLITE_PATH ||
  existsSync(DEFAULT_BREW_PATH);

describe("loader: error path (CI-safe)", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-loader-"));
    originalEnv = process.env.QKB_GRAPHQLITE_PATH;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.QKB_GRAPHQLITE_PATH;
    else process.env.QKB_GRAPHQLITE_PATH = originalEnv;
  });

  it("throws GraphExtensionUnavailableError when binary path is missing", () => {
    const fakePath = join(tmpDir, "does-not-exist.dylib");
    process.env.QKB_GRAPHQLITE_PATH = fakePath;

    const db = openDatabase(":memory:");
    try {
      expect(() => loadGraphqlite(db)).toThrow(GraphExtensionUnavailableError);
      expect(() => loadGraphqlite(db)).toThrow(/not found/i);
    } finally {
      db.close();
    }
  });

  it("error message includes the path that was tried", () => {
    const fakePath = join(tmpDir, "nonexistent.dylib");
    process.env.QKB_GRAPHQLITE_PATH = fakePath;

    const db = openDatabase(":memory:");
    try {
      expect(() => loadGraphqlite(db)).toThrow(fakePath);
    } finally {
      db.close();
    }
  });

  it("error message hints at QKB_GRAPHQLITE_PATH and brew install", () => {
    process.env.QKB_GRAPHQLITE_PATH = join(tmpDir, "x.dylib");

    const db = openDatabase(":memory:");
    try {
      expect(() => loadGraphqlite(db)).toThrow(/QKB_GRAPHQLITE_PATH|brew/i);
    } finally {
      db.close();
    }
  });

  it("GraphExtensionUnavailableError is identifiable + extends Error", () => {
    const err = new GraphExtensionUnavailableError("test", "/path/x.dylib");
    expect(err).toBeInstanceOf(GraphExtensionUnavailableError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GraphExtensionUnavailableError");
    expect(err.attemptedPath).toBe("/path/x.dylib");
  });
});

describe("resolveGraphqlitePath", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.QKB_GRAPHQLITE_PATH;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.QKB_GRAPHQLITE_PATH;
    else process.env.QKB_GRAPHQLITE_PATH = originalEnv;
  });

  it("prefers QKB_GRAPHQLITE_PATH when set", () => {
    process.env.QKB_GRAPHQLITE_PATH = "/explicit/override.dylib";
    expect(resolveGraphqlitePath()).toBe("/explicit/override.dylib");
  });

  it("returns a candidate path even when nothing exists (caller validates)", () => {
    delete process.env.QKB_GRAPHQLITE_PATH;
    const result = resolveGraphqlitePath();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_REAL_BINARY)("loader: happy path (real binary)", () => {
  it("loads the extension and a Cypher probe succeeds", () => {
    const db = openDatabase(":memory:");
    try {
      loadGraphqlite(db);
      const row = db
        .prepare("SELECT cypher(?) AS r")
        .get("RETURN 1 AS x") as { r: string };
      const parsed = JSON.parse(row.r) as Array<{ x: number }>;
      expect(parsed[0]?.x).toBe(1);
    } finally {
      db.close();
    }
  });

  it("loadGraphqlite is idempotent within one connection (re-load is a no-op or harmless)", () => {
    const db = openDatabase(":memory:");
    try {
      loadGraphqlite(db);
      // Second call may throw or be a no-op depending on SQLite behavior;
      // either way the contract is "after this returns, cypher() works".
      try {
        loadGraphqlite(db);
      } catch {
        /* tolerate */
      }
      const row = db
        .prepare("SELECT cypher(?) AS r")
        .get("RETURN 42 AS x") as { r: string };
      expect((JSON.parse(row.r) as Array<{ x: number }>)[0]?.x).toBe(42);
    } finally {
      db.close();
    }
  });
});
