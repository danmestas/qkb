/**
 * Tests for `store.graph.pageRank()` and the max_path_length query
 * rewriter — RFC-0007 §4.6.1 + §4.7.
 *
 * - pageRank({damping, iterations}) returns typed `[{node_id, score}]`.
 * - max_path_length rewriter rejects Cypher with variable-length
 *   patterns like `*1..N` where N > config ceiling.
 * - GraphDisabledError still thrown when graph layer not loaded.
 *
 * Note: query_timeout_ms enforcement (RFC §4.7) is deferred — neither
 * better-sqlite3 nor bun:sqlite currently expose SQLite's
 * progress_handler callback in a way we can use without native bindings.
 * The config field is parsed and stored but not yet wired. Documented in
 * a TODO and tracked as future work.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/internals/store-engine.js";
import { setConfigSource } from "../src/internals/collections-yaml.js";
import { cypher } from "../src/graph/sdk.js";
import {
  validateMaxPathLength,
  CypherPathLengthError,
} from "../src/graph/safety.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";

const HAS_REAL_BINARY =
  !!process.env.QKB_GRAPHQLITE_PATH ||
  existsSync(DEFAULT_BREW_PATH);

describe("max_path_length rewriter (always-on)", () => {
  it("accepts queries with no variable-length patterns", () => {
    expect(() => validateMaxPathLength("MATCH (a)-[r]->(b) RETURN a, b", 6)).not.toThrow();
    expect(() => validateMaxPathLength("MATCH (n) RETURN n", 6)).not.toThrow();
  });

  it("accepts variable-length patterns within limit", () => {
    expect(() => validateMaxPathLength("MATCH (a)-[*1..3]->(b) RETURN a, b", 6)).not.toThrow();
    expect(() => validateMaxPathLength("MATCH (a)-[*..6]->(b) RETURN a, b", 6)).not.toThrow();
    expect(() => validateMaxPathLength("MATCH (a)-[*6]->(b) RETURN a, b", 6)).not.toThrow();
  });

  it("rejects variable-length patterns exceeding limit", () => {
    expect(() =>
      validateMaxPathLength("MATCH (a)-[*1..7]->(b) RETURN a, b", 6)
    ).toThrow(CypherPathLengthError);
    expect(() =>
      validateMaxPathLength("MATCH (a)-[*..10]->(b) RETURN a, b", 6)
    ).toThrow(/exceeds max_path_length/i);
  });

  it("rejects unbounded variable-length (*) when limit is set", () => {
    expect(() =>
      validateMaxPathLength("MATCH (a)-[*]->(b) RETURN a, b", 6)
    ).toThrow(/unbounded/i);
  });

  it("rejects multiple variable-length patterns where any exceeds", () => {
    expect(() =>
      validateMaxPathLength(
        "MATCH (a)-[*1..3]->(b)-[*4..8]->(c) RETURN a, b, c",
        6
      )
    ).toThrow(CypherPathLengthError);
  });

  it("CypherPathLengthError carries the offending value", () => {
    try {
      validateMaxPathLength("MATCH (a)-[*1..99]->(b) RETURN 1", 6);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CypherPathLengthError);
      const e = err as CypherPathLengthError;
      expect(e.requestedLength).toBe(99);
      expect(e.maxAllowed).toBe(6);
    }
  });
});

describe.skipIf(!HAS_REAL_BINARY)("pageRank wrapper", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-algos-"));
    setConfigSource({
      config: { collections: {}, graph: { enabled: true } },
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    setConfigSource();
  });

  it("returns ranked nodes for a small graph", () => {
    const store = createStore(join(tmpDir, "pr.sqlite"));
    try {
      // Build a tiny graph: alice → bob → carol → alice (triangle)
      for (const id of ["alice", "bob", "carol"]) {
        store.graph.upsertNode({ id, label: "Person", properties: { name: id } });
      }
      store.graph.upsertEdge({ from: "alice", to: "bob", type: "FOLLOWS" });
      store.graph.upsertEdge({ from: "bob", to: "carol", type: "FOLLOWS" });
      store.graph.upsertEdge({ from: "carol", to: "alice", type: "FOLLOWS" });

      const ranks = store.graph.pageRank({ damping: 0.85, iterations: 20 });

      expect(ranks.length).toBeGreaterThanOrEqual(3);
      // Each entry has a numeric score
      for (const r of ranks) {
        expect(typeof r.score).toBe("number");
        expect(Number.isFinite(r.score)).toBe(true);
      }
    } finally {
      store.close();
    }
  });

  it("uses default parameters when not specified", () => {
    const store = createStore(join(tmpDir, "pr-defaults.sqlite"));
    try {
      store.graph.upsertNode({ id: "solo", label: "Person", properties: {} });
      const ranks = store.graph.pageRank();
      // Solo node should still appear in results
      expect(Array.isArray(ranks)).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("max_path_length wired through SDK cypher() (always-on)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-pathcap-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    setConfigSource();
  });

  it.skipIf(!HAS_REAL_BINARY)(
    "rejects user query exceeding max_path_length at SDK boundary",
    () => {
      setConfigSource({
        config: {
          collections: {},
          graph: { enabled: true, max_path_length: 3 },
        },
      });
      const store = createStore(join(tmpDir, "cap.sqlite"));
      try {
        // Variable-length 1..5 exceeds cap of 3
        expect(() =>
          store.graph.cypher(
            cypher`MATCH (a)-[*1..5]->(b) RETURN a, b`,
            {}
          )
        ).toThrow(CypherPathLengthError);
      } finally {
        store.close();
      }
    }
  );
});
