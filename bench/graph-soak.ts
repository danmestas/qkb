#!/usr/bin/env node
/**
 * Long-running soak harness for the graph layer — RFC-0007 §11.
 *
 * Continuously indexes synthetic content, runs random queries, and
 * samples RSS / on-disk size / query p95 every sample interval. Reports
 * leak indicators: linear RSS growth, p95 drift, file-size runaway.
 *
 * Modes:
 *   npx tsx bench/graph-soak.ts                     # default 30 min (CI nightly)
 *   npx tsx bench/graph-soak.ts --duration-min 60   # custom
 *   npx tsx bench/graph-soak.ts --full              # 24 hours (local validation)
 *   npx tsx bench/graph-soak.ts --json              # machine-readable samples
 *
 * Exits non-zero on any of:
 *   - Cypher / SDK error during the loop
 *   - RSS growth > 50 MB / hour (sustained)
 *   - p95 query latency more than 3x the first-hour baseline
 *
 * GitHub Actions caps job runtime at 6 hours, so the nightly workflow
 * uses the default 30-minute mode. Full 24-hour soak runs on demand.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setConfigSource } from "../src/internals/collections-yaml.js";
import { createStore } from "../src/internals/store-engine.js";
import { generateSyntheticGraph } from "../src/graph/bench.js";
import { runCypher, runPageRank, type CypherQuery } from "../src/graph/sdk.js";

interface Args {
  durationSec: number;
  sampleIntervalSec: number;
  jsonOut: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const has = (flag: string) => argv.includes(flag);
  const valueOf = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };

  const full = has("--full");
  const customMin = valueOf("--duration-min");
  const durationMin = full ? 24 * 60 : customMin ? Number(customMin) : 30;
  const sampleIntervalSec = full ? 60 : 30; // less spam in long runs

  return {
    durationSec: Math.max(60, durationMin * 60),
    sampleIntervalSec,
    jsonOut: has("--json"),
  };
}

interface Sample {
  t_sec: number;
  rss_mb: number;
  file_kb: number;
  query_p95_ms: number;
  total_nodes: number;
  total_edges: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const tmpDir = mkdtempSync(join(tmpdir(), "qkb-soak-"));
  const dbPath = join(tmpDir, "soak.sqlite");

  setConfigSource({
    config: { collections: {}, graph: { enabled: true } },
  });
  const store = createStore(dbPath);

  if (!args.jsonOut) {
    console.error(
      `[soak] dbPath=${dbPath} duration=${args.durationSec}s sample=${args.sampleIntervalSec}s`
    );
  }

  // Seed: 1000 nodes to start. The loop adds more.
  generateSyntheticGraph(store, { nodes: 1000, avgEdgesPerNode: 4 });

  const samples: Sample[] = [];
  const start = Date.now();
  let totalNodes = 1000;
  let totalEdges = 0;
  let nextSeed = 10_000;
  const queryLatencies: number[] = []; // rolling buffer for p95

  let lastSampleAt = 0;

  function sample(): void {
    const elapsed_sec = Math.floor((Date.now() - start) / 1000);
    const rss_mb = process.memoryUsage().rss / 1024 / 1024;
    const file_kb = statSync(dbPath).size / 1024;
    queryLatencies.sort((a, b) => a - b);
    const p95 = queryLatencies.length
      ? queryLatencies[Math.floor(0.95 * (queryLatencies.length - 1))] ?? 0
      : 0;
    queryLatencies.length = 0;
    samples.push({
      t_sec: elapsed_sec,
      rss_mb,
      file_kb,
      query_p95_ms: p95,
      total_nodes: totalNodes,
      total_edges: totalEdges,
    });
    if (!args.jsonOut) {
      console.error(
        `[soak t=${elapsed_sec}s] rss=${rss_mb.toFixed(0)}MB ` +
          `file=${(file_kb / 1024).toFixed(1)}MB ` +
          `p95=${p95.toFixed(1)}ms ` +
          `nodes=${totalNodes} edges=${totalEdges}`
      );
    }
  }

  const failures: string[] = [];

  try {
    while ((Date.now() - start) / 1000 < args.durationSec) {
      // Insert a batch of new nodes/edges
      const batchSize = 50;
      const nodes = Array.from({ length: batchSize }, (_, i) => ({
        id: `bench:${nextSeed + i}`,
        label: "Bench",
        properties: { idx: nextSeed + i },
      }));
      const edges = Array.from({ length: batchSize - 1 }, (_, i) => ({
        from: `bench:${nextSeed + i}`,
        to: `bench:${nextSeed + i + 1}`,
        type: "LINKS",
      }));
      try {
        store.graph.upsertNodesBulk(nodes);
        store.graph.upsertEdgesBulk(edges);
        totalNodes += batchSize;
        totalEdges += edges.length;
        nextSeed += batchSize;
      } catch (err) {
        failures.push(`insert error at t=${(Date.now() - start) / 1000}s: ${(err as Error).message}`);
        break;
      }

      // Mix of queries: 1 pageRank every ~100 iterations, neighbors otherwise
      try {
        if (Math.random() < 0.01) {
          const qStart = performance.now();
          runPageRank(store.db, { damping: 0.85, iterations: 10 });
          queryLatencies.push(performance.now() - qStart);
        } else {
          const seedId = `bench:${Math.floor(Math.random() * totalNodes)}`;
          const qStart = performance.now();
          runCypher(
            store.db,
            `MATCH (a {id: $id})-[*1..2]->(b) RETURN DISTINCT b.id AS id` as CypherQuery,
            { id: seedId }
          );
          queryLatencies.push(performance.now() - qStart);
        }
      } catch (err) {
        failures.push(`query error at t=${(Date.now() - start) / 1000}s: ${(err as Error).message}`);
        break;
      }

      const elapsed_sec = (Date.now() - start) / 1000;
      if (elapsed_sec - lastSampleAt >= args.sampleIntervalSec) {
        sample();
        lastSampleAt = elapsed_sec;
      }
    }

    sample(); // final sample
  } finally {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // Leak analysis
  const rssGrowthMbPerHr =
    samples.length >= 2
      ? ((samples[samples.length - 1]!.rss_mb - samples[0]!.rss_mb) /
          (args.durationSec / 3600))
      : 0;

  const firstHalfP95 =
    samples.slice(0, Math.floor(samples.length / 2)).reduce((a, s) => a + s.query_p95_ms, 0) /
      Math.max(1, Math.floor(samples.length / 2)) || 0;
  const secondHalfP95 =
    samples.slice(Math.floor(samples.length / 2)).reduce((a, s) => a + s.query_p95_ms, 0) /
      Math.max(1, samples.length - Math.floor(samples.length / 2)) || 0;
  const p95DriftRatio = firstHalfP95 > 0 ? secondHalfP95 / firstHalfP95 : 1;

  if (args.jsonOut) {
    console.log(
      JSON.stringify(
        { args, samples, failures, rssGrowthMbPerHr, p95DriftRatio },
        null,
        2
      )
    );
  } else {
    console.log("\nLEAK ANALYSIS");
    console.log(`  RSS growth:        ${rssGrowthMbPerHr.toFixed(1)} MB/hr`);
    console.log(
      `  Query p95 drift:   ${p95DriftRatio.toFixed(2)}x (1st half → 2nd half)`
    );
    console.log(`  Failures:          ${failures.length}`);
    for (const f of failures) console.log(`    - ${f}`);
  }

  // Pass criteria
  const failed =
    failures.length > 0 ||
    rssGrowthMbPerHr > 50 ||
    p95DriftRatio > 3;

  if (!args.jsonOut) {
    console.log(failed ? "\n✗ soak FAILED" : "\n✓ soak passed");
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
