#!/usr/bin/env -S npx tsx
/**
 * RFC-0008 graph-query benchmark.
 *
 * Runs a fixed question set through three retrieval modes and produces
 * a Markdown report with per-question results, timings, and recall@K
 * scores against a hand-curated `expected_docs` list per question.
 *
 *   1. bm25      — `qkb search` (lexical-only baseline; same FTS5 engine
 *                  as the upstream `qmd` tool that vault-query-qmd uses).
 *   2. hybrid    — `qkb query` without --graph (full hybrid pipeline:
 *                  BM25 + vector + RRF + cross-encoder rerank).
 *   3. hybrid-graph — `qkb query --graph` (hybrid + edge-weighted 1-hop
 *                  graph expansion, RFC-0008 #2).
 *
 * All three share the same retrieval engine, so differences in scores
 * isolate the contribution of each pipeline layer (vs. cross-tool
 * engine quirks).
 *
 * Each mode returns a ranked list of file paths (top-10). Quality
 * scoring is deterministic (no LLM judge):
 *
 *   - recall@K (K=5, 10): how many of the question's expected_docs
 *     appear in the top-K results.
 *   - top-1 hit: is the top result in expected_docs?
 *   - first-hit-rank: where does the first expected doc appear?
 *
 * Iteration knobs:
 *   - Edit `bench/fixtures/flight-planner-questions.json` to refine
 *     questions / expected_docs.
 *   - --modes to subset which modes run (e.g. --modes hybrid,hybrid-graph).
 *   - --skip-rerank to halve qkb runtime when iterating fast.
 *
 * Usage:
 *   npx tsx bench/graph-bench-eval.ts \
 *     --fixture bench/fixtures/flight-planner-questions.json \
 *     --vault /Users/dmestas/projects/flight-planner-kb \
 *     [--modes bm25,hybrid,hybrid-graph] \
 *     [--skip-rerank] \
 *     [--out bench/results/]
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

interface Question {
  id: string;
  question: string;
  expected_docs: string[];
  category: string;
  notes?: string;
}

interface Fixture {
  corpus: string;
  qmdIndex: string;
  qmdCollection: string;
  qkbIndex: string;
  qkbCollection: string;
  questions: Question[];
}

type Mode = "bm25" | "hybrid" | "hybrid-graph";

interface ModeResult {
  mode: Mode;
  ok: boolean;
  command: string;
  elapsedMs: number;
  /** Vault-relative paths in rank order. Empty on failure. */
  hits: string[];
  /** Free-form notes (e.g. "Graph expansion: 46 novel"). */
  signal?: string;
  error?: string;
}

interface QuestionResult {
  question: Question;
  modes: ModeResult[];
}

interface RecallScores {
  recall5: number;
  recall10: number;
  top1Hit: boolean;
  firstHitRank: number | null;
}

const args = parseArgs({
  options: {
    fixture: { type: "string" },
    vault: { type: "string" },
    modes: { type: "string" },
    "skip-rerank": { type: "boolean" },
    out: { type: "string" },
    qkb: { type: "string" },
  },
  strict: false,
}).values;

const fixturePath = (args.fixture as string) ??
  "bench/fixtures/flight-planner-questions.json";
const vaultRoot = (args.vault as string) ??
  "/Users/dmestas/projects/flight-planner-kb";
const outDir = (args.out as string) ?? "bench/results";
const skipRerank = !!args["skip-rerank"];
const qkbBin = (args.qkb as string) ?? "bin/qkb";

const enabledModes: Set<Mode> = new Set(
  ((args.modes as string) ?? "bm25,hybrid,hybrid-graph")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Mode =>
      s === "bm25" || s === "hybrid" || s === "hybrid-graph"
    )
);

const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

console.error(`Bench: ${fixture.corpus}`);
console.error(`  questions: ${fixture.questions.length}`);
console.error(`  modes:     ${[...enabledModes].join(", ")}`);
console.error(`  skipRerank: ${skipRerank}`);
console.error(`  vault:     ${vaultRoot}`);
console.error("");

function parseQkbSearchHits(stdout: string): string[] {
  // qkb search --json returns a JSON array of { file, ... } objects.
  // file is shaped like "qkb://flight-planner/wiki/entities/foo.md".
  try {
    const parsed = JSON.parse(stdout) as Array<{ file?: string }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) => r.file ?? "")
      .map((url) => normalizeQkbToVaultPath(url))
      .filter((p) => p.length > 0);
  } catch {
    return [];
  }
}

function parseQkbFilesOutput(stdout: string): string[] {
  // qkb query --files emits "#docid,score,qkb://collection/path?index=..."
  // one per line. Some lines may be progress/log lines on stderr — we
  // already stream stderr separately, so stdout is just the file output.
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  return lines
    .map((line) => {
      const parts = line.split(",");
      const url = parts[2] ?? parts[parts.length - 1] ?? "";
      return normalizeQkbToVaultPath(url);
    })
    .filter((p) => p.length > 0);
}

function normalizeQkbToVaultPath(url: string): string {
  // qkb://flight-planner/wiki/entities/foo.md?index=flight-graph
  //                                          -> wiki/entities/foo.md
  const stripped = url.split("?")[0] ?? "";
  const m = /^qkb:\/\/[^/]+\/(.+)$/.exec(stripped);
  if (!m) return "";
  return m[1] ?? "";
}

function runMode(
  mode: Mode,
  question: Question,
  fixture: Fixture
): ModeResult {
  let cmd: string;
  switch (mode) {
    case "bm25":
      // Same FTS5 BM25 engine as upstream qmd. Lexical-only, no LLM.
      cmd = `${qkbBin} --index ${fixture.qkbIndex} search ${shellEscape(
        question.question
      )} --json -n 10 -c ${fixture.qkbCollection}`;
      break;
    case "hybrid": {
      const norerank = skipRerank ? "--no-rerank" : "";
      cmd = `${qkbBin} --index ${fixture.qkbIndex} query ${shellEscape(
        question.question
      )} -n 10 --files ${norerank}`.trim();
      break;
    }
    case "hybrid-graph": {
      const norerank = skipRerank ? "--no-rerank" : "";
      cmd = `${qkbBin} --index ${fixture.qkbIndex} query ${shellEscape(
        question.question
      )} -n 10 --files --graph ${norerank}`.trim();
      break;
    }
  }

  const start = Date.now();
  try {
    // Capture stderr separately so progress/log noise doesn't pollute
    // the file-output parsing. The qkb pipeline writes "Graph expansion:
    // N novel candidate(s)" to stderr — capture for the report.
    const stdout = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    const elapsedMs = Date.now() - start;
    const hits =
      mode === "bm25"
        ? parseQkbSearchHits(stdout)
        : parseQkbFilesOutput(stdout);
    return { mode, ok: true, command: cmd, elapsedMs, hits };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    const e = err as { stderr?: Buffer; message?: string };
    return {
      mode,
      ok: false,
      command: cmd,
      elapsedMs,
      hits: [],
      error:
        (e.stderr && e.stderr.toString()) ?? e.message ?? "unknown failure",
    };
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function scoreRecall(hits: string[], expected: string[]): RecallScores {
  const expectedSet = new Set(expected);
  const top5 = hits.slice(0, 5);
  const top10 = hits.slice(0, 10);
  const matched5 = top5.filter((h) => expectedSet.has(h)).length;
  const matched10 = top10.filter((h) => expectedSet.has(h)).length;
  const denom = Math.max(1, expected.length);
  const top1Hit = !!hits[0] && expectedSet.has(hits[0]);
  const firstHitIndex = hits.findIndex((h) => expectedSet.has(h));
  return {
    recall5: matched5 / denom,
    recall10: matched10 / denom,
    top1Hit,
    firstHitRank: firstHitIndex >= 0 ? firstHitIndex + 1 : null,
  };
}

const results: QuestionResult[] = [];

for (let i = 0; i < fixture.questions.length; i++) {
  const q = fixture.questions[i]!;
  console.error(
    `[${i + 1}/${fixture.questions.length}] ${q.id}: ${q.question}`
  );
  const modeResults: ModeResult[] = [];
  for (const mode of enabledModes) {
    process.stderr.write(`  ${mode}... `);
    const r = runMode(mode, q, fixture);
    process.stderr.write(
      `${r.ok ? "ok" : "FAIL"} ${r.elapsedMs}ms, ${r.hits.length} hits\n`
    );
    modeResults.push(r);
  }
  results.push({ question: q, modes: modeResults });
}

console.error("");

// === Report ===

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtRecall(r: number): string {
  return `${(r * 100).toFixed(0)}%`;
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(outDir, `graph-bench-${timestamp}.md`);
mkdirSync(dirname(outPath), { recursive: true });

const lines: string[] = [];
lines.push(`# Graph-query benchmark — ${fixture.corpus}`);
lines.push("");
lines.push(`**Run**: ${new Date().toISOString()}`);
lines.push(`**Modes**: ${[...enabledModes].join(", ")}`);
lines.push(`**Skip rerank**: ${skipRerank}`);
lines.push(`**Questions**: ${fixture.questions.length}`);
lines.push("");
lines.push("## Summary");
lines.push("");

// Aggregate per-mode stats.
type ModeAgg = {
  count: number;
  failed: number;
  totalMs: number;
  recall5Sum: number;
  recall10Sum: number;
  top1Hits: number;
  firstHitRanksKnown: number;
  firstHitRankSum: number;
};

const agg = new Map<Mode, ModeAgg>();
for (const m of enabledModes) {
  agg.set(m, {
    count: 0,
    failed: 0,
    totalMs: 0,
    recall5Sum: 0,
    recall10Sum: 0,
    top1Hits: 0,
    firstHitRanksKnown: 0,
    firstHitRankSum: 0,
  });
}

for (const r of results) {
  for (const m of r.modes) {
    const a = agg.get(m.mode)!;
    a.count++;
    a.totalMs += m.elapsedMs;
    if (!m.ok) {
      a.failed++;
      continue;
    }
    const s = scoreRecall(m.hits, r.question.expected_docs);
    a.recall5Sum += s.recall5;
    a.recall10Sum += s.recall10;
    if (s.top1Hit) a.top1Hits++;
    if (s.firstHitRank !== null) {
      a.firstHitRanksKnown++;
      a.firstHitRankSum += s.firstHitRank;
    }
  }
}

lines.push(
  "| Mode | Mean recall@5 | Mean recall@10 | Top-1 hit rate | Mean first-hit rank | Mean latency | Failed |"
);
lines.push(
  "|------|--------------:|---------------:|---------------:|--------------------:|-------------:|-------:|"
);
for (const m of enabledModes) {
  const a = agg.get(m)!;
  const successCount = a.count - a.failed;
  const meanR5 = successCount > 0 ? a.recall5Sum / successCount : 0;
  const meanR10 = successCount > 0 ? a.recall10Sum / successCount : 0;
  const top1 = successCount > 0 ? a.top1Hits / successCount : 0;
  const meanFirstHit =
    a.firstHitRanksKnown > 0
      ? (a.firstHitRankSum / a.firstHitRanksKnown).toFixed(1)
      : "—";
  const meanMs = a.count > 0 ? a.totalMs / a.count : 0;
  lines.push(
    `| ${m} | ${fmtRecall(meanR5)} | ${fmtRecall(meanR10)} | ${fmtRecall(top1)} | ${meanFirstHit} | ${fmtMs(meanMs)} | ${a.failed}/${a.count} |`
  );
}

lines.push("");
lines.push("## Per-question");
lines.push("");

for (const r of results) {
  lines.push(`### ${r.question.id} — ${r.question.category}`);
  lines.push("");
  lines.push(`**Q**: ${r.question.question}`);
  lines.push("");
  lines.push(`**Expected**: ${r.question.expected_docs.map((d) => `\`${d}\``).join(", ")}`);
  if (r.question.notes) {
    lines.push("");
    lines.push(`> ${r.question.notes}`);
  }
  lines.push("");
  lines.push(
    "| Mode | recall@5 | recall@10 | top-1 hit | first-hit rank | latency | top-5 hits |"
  );
  lines.push(
    "|------|---------:|----------:|----------:|---------------:|--------:|------------|"
  );
  for (const m of r.modes) {
    if (!m.ok) {
      lines.push(`| ${m.mode} | — | — | — | — | ${fmtMs(m.elapsedMs)} | (failed: ${m.error?.slice(0, 60)}) |`);
      continue;
    }
    const s = scoreRecall(m.hits, r.question.expected_docs);
    const expectedSet = new Set(r.question.expected_docs);
    const top5 = m.hits
      .slice(0, 5)
      .map((h) => (expectedSet.has(h) ? `**${h}**` : h))
      .join("<br/>");
    lines.push(
      `| ${m.mode} | ${fmtRecall(s.recall5)} | ${fmtRecall(s.recall10)} | ${s.top1Hit ? "✓" : "✗"} | ${s.firstHitRank ?? "—"} | ${fmtMs(m.elapsedMs)} | ${top5 || "(no hits)"} |`
    );
  }
  lines.push("");
}

lines.push("## Methodology");
lines.push("");
lines.push("- **recall@K**: fraction of the question's `expected_docs` that appear in the top-K results.");
lines.push("- **top-1 hit**: did the top result match an expected doc?");
lines.push("- **first-hit rank**: 1-indexed rank of the first expected doc in the result list (lower is better).");
lines.push("- **expected_docs**: hand-curated per-question, see `bench/fixtures/flight-planner-questions.json`.");
lines.push("- Quality scoring is deterministic — no LLM judge — so iterating on the question fixture changes scores.");
lines.push("");
lines.push("## Limits / known caveats");
lines.push("");
lines.push("- Only tests retrieval quality, not synthesis quality. The actual `vault-query-graph` skill includes LLM synthesis on top of these retrieved hits.");
lines.push("- `expected_docs` are best-guess curations; missing entries can make a mode look worse than it is. Iterate.");
lines.push("- `vault-query` (manual file-reading skill) is not benchmarked — it's procedural and not directly CLI-runnable.");

const report = lines.join("\n") + "\n";
writeFileSync(outPath, report);

console.error(`Wrote ${outPath}`);
console.log(report);

// Exit 0 unless every mode failed every question (catastrophic).
let anySuccess = false;
for (const a of agg.values()) {
  if (a.count - a.failed > 0) {
    anySuccess = true;
    break;
  }
}
process.exit(anySuccess ? 0 : 1);
