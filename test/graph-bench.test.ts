/**
 * Tests for the graph performance harness — RFC-0007 §10.
 *
 * The harness functions are exposed as pure functions in
 * `src/graph/bench.ts` so they can be unit-tested without spinning up
 * an actual benchmark run. The thresholds enforced here are conservative
 * (small corpus + generous bounds) — the real perf gates run on CI
 * with the larger corpus and the §10 thresholds.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { setConfigSource } from "../src/collections.js";
import {
  generateSyntheticGraph,
  measureColdLoad,
  measureNeighborQuery,
  measurePageRank,
  measureFileSizeDelta,
  type BenchResult,
} from "../src/graph/bench.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";
const HAS_REAL_BINARY =
  !!process.env.QKB_GRAPHQLITE_PATH ||
  existsSync(DEFAULT_BREW_PATH);

describe("graph bench harness (always-on)", () => {
  it("BenchResult shape includes name + metric + threshold", () => {
    const r: BenchResult = {
      name: "test-metric",
      metric_value: 42,
      metric_unit: "ms",
      threshold: 100,
      threshold_kind: "lt",
      passed: true,
    };
    expect(r.passed).toBe(true);
    expect(r.threshold_kind).toBe("lt");
  });
});

describe.skipIf(!HAS_REAL_BINARY)("graph bench harness (real binary)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-bench-"));
    setConfigSource({
      config: { collections: {}, graph: { enabled: true } },
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    setConfigSource();
  });

  it("generateSyntheticGraph creates the expected counts", () => {
    const store = createStore(join(tmpDir, "synth.sqlite"));
    try {
      const counts = generateSyntheticGraph(store, {
        nodes: 50,
        avgEdgesPerNode: 3,
      });
      expect(counts.nodes).toBe(50);
      expect(counts.edges).toBeGreaterThan(0);
      expect(counts.edges).toBeLessThanOrEqual(50 * 3 * 2); // sanity
    } finally {
      store.close();
    }
  });

  it("measureColdLoad reports a positive duration_ms", () => {
    const result = measureColdLoad(join(tmpDir, "cold.sqlite"));
    expect(result.metric_value).toBeGreaterThan(0);
    expect(result.metric_unit).toBe("ms");
  });

  it("measureNeighborQuery on a small synthetic graph passes a generous threshold", () => {
    const store = createStore(join(tmpDir, "neigh.sqlite"));
    try {
      generateSyntheticGraph(store, { nodes: 100, avgEdgesPerNode: 3 });
      const result = measureNeighborQuery(store, 100); // 100ms ceiling for 100 nodes
      expect(result.metric_unit).toBe("ms");
      expect(result.passed).toBe(true);
    } finally {
      store.close();
    }
  });

  it("measurePageRank on a small graph completes well under threshold", () => {
    const store = createStore(join(tmpDir, "pr.sqlite"));
    try {
      generateSyntheticGraph(store, { nodes: 100, avgEdgesPerNode: 3 });
      const result = measurePageRank(store, 5000); // 5s ceiling for 100 nodes
      expect(result.passed).toBe(true);
    } finally {
      store.close();
    }
  });

  it("measureFileSizeDelta is below the 256 KB §10 threshold", () => {
    const result = measureFileSizeDelta(join(tmpDir, "size-base.sqlite"));
    expect(result.metric_unit).toBe("bytes");
    // §10 revised budget after Q2 spike: 256 KB
    expect(result.metric_value).toBeLessThan(256 * 1024);
    expect(result.passed).toBe(true);
  });
});
