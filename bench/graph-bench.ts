#!/usr/bin/env node
/**
 * RFC-0007 §10 performance harness driver.
 *
 *   npx tsx bench/graph-bench.ts            # CI mode: small corpus, fast
 *   npx tsx bench/graph-bench.ts --full     # local: full 10k-node corpus
 *   npx tsx bench/graph-bench.ts --json     # machine-readable output
 *
 * Exits non-zero if any threshold is violated. CI integration in
 * `.github/workflows/` lands with PR-4b (which installs graphqlite on
 * runners); this script can be invoked manually any time.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigSource } from "../src/collections.js";
import { createStore } from "../src/store.js";
import {
  generateSyntheticGraph,
  measureColdLoad,
  measureNeighborQuery,
  measurePageRank,
  measureFileSizeDelta,
  type BenchResult,
} from "../src/graph/bench.js";

const FULL = process.argv.includes("--full");
const JSON_OUT = process.argv.includes("--json");

const NODE_COUNT = FULL ? 10_000 : 500;
const AVG_OUT_DEGREE = 4;

// Thresholds — RFC §10. CI mode loosens to keep tests deterministic on
// shared runners; --full mode enforces the actual production gates.
const THRESHOLDS = FULL
  ? {
      coldLoadMs: 50,
      neighborP95Ms: 25,
      pageRankMs: 2000,
      fileDeltaBytes: 256 * 1024,
    }
  : {
      coldLoadMs: 500, // generous for cold cache
      neighborP95Ms: 100,
      pageRankMs: 5000,
      fileDeltaBytes: 256 * 1024,
    };

function formatRow(r: BenchResult): string {
  const status = r.passed ? "✓" : "✗";
  const cmp = r.threshold_kind;
  return `${status}  ${r.name.padEnd(28)} ${r.metric_value.toFixed(2).padStart(10)} ${r.metric_unit.padEnd(6)} ${cmp} ${r.threshold} ${r.detail ? `(${r.detail})` : ""}`;
}

async function main(): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "qkb-bench-"));
  try {
    setConfigSource({
      config: { collections: {}, graph: { enabled: true } },
    });

    const results: BenchResult[] = [];

    // 1. Cold extension-load on a fresh DB.
    results.push(measureColdLoad(join(tmpDir, "cold.sqlite"), THRESHOLDS.coldLoadMs));

    // 2. Empty-graph file-size delta.
    results.push(measureFileSizeDelta(join(tmpDir, "size.sqlite"), THRESHOLDS.fileDeltaBytes));

    // 3. Build the synthetic corpus once for query/pagerank measurements.
    const corpusPath = join(tmpDir, "corpus.sqlite");
    const store = createStore(corpusPath);
    try {
      const start = performance.now();
      const counts = generateSyntheticGraph(store, {
        nodes: NODE_COUNT,
        avgEdgesPerNode: AVG_OUT_DEGREE,
      });
      const buildMs = performance.now() - start;
      if (!JSON_OUT) {
        console.error(
          `[bench] built synthetic graph: ${counts.nodes} nodes, ${counts.edges} edges in ${buildMs.toFixed(0)} ms`
        );
      }

      // 4. 2-hop neighbor p95.
      results.push(measureNeighborQuery(store, THRESHOLDS.neighborP95Ms));

      // 5. PageRank.
      results.push(measurePageRank(store, THRESHOLDS.pageRankMs));
    } finally {
      store.close();
    }

    if (JSON_OUT) {
      console.log(JSON.stringify({ mode: FULL ? "full" : "ci", results }, null, 2));
    } else {
      console.log(`\nRFC-0007 §10 perf harness — mode=${FULL ? "full" : "ci"}\n`);
      console.log(
        `  status  ${"name".padEnd(28)} ${"value".padStart(10)} ${"unit".padEnd(6)} cmp threshold`
      );
      console.log(`  ${"-".repeat(70)}`);
      for (const r of results) console.log(`  ${formatRow(r)}`);
      const failures = results.filter((r) => !r.passed);
      console.log(
        `\n${failures.length === 0 ? "✓ all thresholds passed" : `✗ ${failures.length} threshold(s) failed`}`
      );
    }

    const anyFailed = results.some((r) => !r.passed);
    process.exit(anyFailed ? 1 : 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
