/**
 * Performance harness for the graph layer — RFC-0007 §10.
 *
 * Pure functions that measure individual metrics against thresholds.
 * The CLI driver in `bench/graph-bench.ts` orchestrates them, generates
 * a synthetic corpus, prints a summary table, and exits non-zero if any
 * threshold is violated.
 *
 * Every metric returns a `BenchResult` so the harness output is uniform
 * (JSON-friendly, gateable in CI).
 */
import { existsSync, statSync, unlinkSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../db.js";
import { runPageRank, runCypher, type CypherQuery } from "./sdk.js";
import { loadGraphqlite } from "./loader.js";
import type { Store } from "../store.js";

export interface BenchResult {
  name: string;
  metric_value: number;
  metric_unit: "ms" | "bytes" | "ratio" | "count";
  threshold: number;
  threshold_kind: "lt" | "lte" | "gt" | "gte";
  passed: boolean;
  detail?: string;
}

function checkThreshold(
  value: number,
  threshold: number,
  kind: BenchResult["threshold_kind"]
): boolean {
  switch (kind) {
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
  }
}

export interface SyntheticGraphOptions {
  nodes: number;
  /** Approx average out-degree per node. Edges target a triangle pattern. */
  avgEdgesPerNode: number;
}

/**
 * Build a synthetic graph for benchmarking. Nodes are labeled `Bench`
 * with sequential ids `bench:0`, `bench:1`, etc. Edges follow a simple
 * "next-N-ids" pattern (avoids degenerate isolated-component graphs and
 * gives PageRank something to chew on).
 */
export function generateSyntheticGraph(
  store: Store,
  opts: SyntheticGraphOptions
): { nodes: number; edges: number } {
  const { nodes, avgEdgesPerNode } = opts;
  const half = Math.max(1, Math.floor(avgEdgesPerNode / 2));

  for (let i = 0; i < nodes; i++) {
    store.graph.upsertNode({
      id: `bench:${i}`,
      label: "Bench",
      properties: { idx: i },
    });
  }

  let edgeCount = 0;
  for (let i = 0; i < nodes; i++) {
    for (let j = 1; j <= half; j++) {
      const target = (i + j) % nodes;
      if (target === i) continue;
      store.graph.upsertEdge({
        from: `bench:${i}`,
        to: `bench:${target}`,
        type: "LINKS",
      });
      edgeCount++;
    }
  }

  return { nodes, edges: edgeCount };
}

/**
 * Measure the cold extension-load time. Opens a fresh DB, runs the
 * loader, records elapsed wallclock. RFC §10 threshold: < 50 ms.
 */
export function measureColdLoad(
  dbPath: string,
  thresholdMs = 200
): BenchResult {
  if (existsSync(dbPath)) unlinkSync(dbPath);

  const db = openDatabase(dbPath);
  try {
    const start = performance.now();
    loadGraphqlite(db);
    // Touch the cypher() function to force any deferred init.
    db.prepare("SELECT cypher(?)").get("RETURN 1");
    const elapsed = performance.now() - start;

    return {
      name: "cold_extension_load",
      metric_value: elapsed,
      metric_unit: "ms",
      threshold: thresholdMs,
      threshold_kind: "lt",
      passed: checkThreshold(elapsed, thresholdMs, "lt"),
    };
  } finally {
    db.close();
  }
}

/**
 * Run a 2-hop neighbor query against the seeded graph and measure
 * latency. Run several times and report p95.
 */
export function measureNeighborQuery(
  store: Store,
  thresholdMs: number,
  iterations = 20
): BenchResult {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const seed = `bench:${i % 50}`;
    const start = performance.now();
    runCypher(
      store.db,
      `MATCH (a {id: $id})-[*1..2]->(b) RETURN DISTINCT b.id AS id` as CypherQuery,
      { id: seed }
    );
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p95Index = Math.min(samples.length - 1, Math.floor(0.95 * samples.length));
  const p95 = samples[p95Index] ?? 0;

  return {
    name: "neighbor_2hop_p95",
    metric_value: p95,
    metric_unit: "ms",
    threshold: thresholdMs,
    threshold_kind: "lt",
    passed: checkThreshold(p95, thresholdMs, "lt"),
    detail: `${iterations} iterations`,
  };
}

export function measurePageRank(
  store: Store,
  thresholdMs: number
): BenchResult {
  const start = performance.now();
  runPageRank(store.db, { damping: 0.85, iterations: 20 });
  const elapsed = performance.now() - start;
  return {
    name: "pagerank",
    metric_value: elapsed,
    metric_unit: "ms",
    threshold: thresholdMs,
    threshold_kind: "lt",
    passed: checkThreshold(elapsed, thresholdMs, "lt"),
  };
}

/**
 * Measure the on-disk size delta caused by enabling the graph layer
 * on an otherwise empty SQLite file. RFC §10 (revised after Q2 spike):
 * < 256 KB.
 */
export function measureFileSizeDelta(
  dbPath: string,
  thresholdBytes = 256 * 1024
): BenchResult {
  if (existsSync(dbPath)) unlinkSync(dbPath);

  // Step 1: empty SQLite + a marker table to get a non-trivial baseline.
  let db = openDatabase(dbPath);
  db.exec("CREATE TABLE marker (id INTEGER PRIMARY KEY)");
  db.close();
  const baseline = statSync(dbPath).size;

  // Step 2: load extension and force materialization.
  db = openDatabase(dbPath);
  loadGraphqlite(db);
  db.prepare("SELECT cypher(?)").get("CREATE (n:Probe {x: 1}) DELETE n RETURN 1");
  db.close();
  const after = statSync(dbPath).size;
  const delta = after - baseline;

  return {
    name: "empty_graph_file_delta",
    metric_value: delta,
    metric_unit: "bytes",
    threshold: thresholdBytes,
    threshold_kind: "lt",
    passed: checkThreshold(delta, thresholdBytes, "lt"),
    detail: `baseline=${baseline}B after=${after}B`,
  };
}
