#!/usr/bin/env -S npx tsx
/**
 * Full retrieval benchmark — qkb vs qmd, all retrieval modes.
 *
 * Compares 7 retrieval modes against the same SQLite index (qkb-built;
 * qmd reads it transparently because qmd-owned tables share schema):
 *
 *   qkb-bm25     — `qkb search`            (FTS5 lexical)
 *   qkb-vector   — `qkb vsearch`           (sqlite-vec, no rerank)
 *   qkb-hybrid   — `qkb query --no-graph`  (BM25 + vec + RRF + rerank)
 *   qkb-graph    — `qkb query --graph`     (hybrid + edge-weighted 1-hop graph expansion)
 *   qmd-bm25     — `qmd search`            (qmd's FTS5 lexical)
 *   qmd-vector   — `qmd vsearch`           (qmd's vector)
 *   qmd-hybrid   — `qmd query`             (qmd's full hybrid; no graph in qmd)
 *
 * The vault-query skill (manual file-reading via Claude judgment) is NOT
 * benchmarked — it's procedural, not CLI-runnable, and represents a
 * different paradigm. The 7 modes above ARE the retrieval backends that
 * skills like vault-query-qmd and vault-query-graph use under the hood.
 *
 * Usage:
 *   npx tsx bench/full-bench-eval.ts \
 *     --fixture bench/fixtures/flight-planner-questions.json \
 *     --vault /Users/dmestas/projects/flight-planner-kb \
 *     --index ~/.cache/qkb/flight-graph.sqlite
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

const ALL_MODES = [
  "qkb-bm25",
  "qkb-vector",
  "qkb-hybrid",
  "qkb-graph",
  "qmd-bm25",
  "qmd-vector",
  "qmd-hybrid",
] as const;
type Mode = typeof ALL_MODES[number];

interface ModeResult {
  mode: Mode;
  ok: boolean;
  command: string;
  elapsedMs: number;
  hits: string[];
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
    out: { type: "string" },
    qkb: { type: "string" },
    qmd: { type: "string" },
    index: { type: "string" },
  },
  strict: false,
}).values;

const fixturePath = (args.fixture as string) ??
  "bench/fixtures/flight-planner-questions.json";
const outDir = (args.out as string) ?? "bench/results";
const qkbBin = (args.qkb as string) ?? "bin/qkb";
const qmdBin = (args.qmd as string) ?? "node_modules/@tobilu/qmd/bin/qmd";
const sharedIndex = (args.index as string) ??
  `${process.env.HOME}/.cache/qkb/flight-graph.sqlite`;

const enabledModes: Mode[] = (
  (args.modes as string)
    ?? ALL_MODES.join(",")
).split(",")
  .map((s) => s.trim())
  .filter((s): s is Mode => (ALL_MODES as readonly string[]).includes(s));

const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

console.error(`Full retrieval bench: ${fixture.corpus}`);
console.error(`  questions: ${fixture.questions.length}`);
console.error(`  modes:     ${enabledModes.join(", ")}`);
console.error(`  index:     ${sharedIndex}`);
console.error("");

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Both qkb (qkb://) and qmd (qmd://) emit collection-virtual URLs. Strip
// the prefix and any ?index= query suffix, return the vault-relative path.
function normalizeUrlToVaultPath(url: string): string {
  const stripped = (url.split("?")[0] ?? "").trim();
  const m = /^(?:qkb|qmd):\/\/[^/]+\/(.+)$/.exec(stripped);
  if (!m) return "";
  return m[1] ?? "";
}

function parseJsonHits(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as Array<{ file?: string }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) => r.file ?? "")
      .map(normalizeUrlToVaultPath)
      .filter((p) => p.length > 0);
  } catch {
    return [];
  }
}

// Both `qkb query --files` and `qmd query --files` emit "#docid,score,url"
// per line. Take the URL column and normalize.
function parseFilesOutput(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const parts = line.split(",");
      const url = parts[2] ?? parts[parts.length - 1] ?? "";
      return normalizeUrlToVaultPath(url);
    })
    .filter((p) => p.length > 0);
}

function buildCmd(mode: Mode, q: string): { cmd: string; env?: NodeJS.ProcessEnv } {
  const Q = shellEscape(q);
  const env = { ...process.env, INDEX_PATH: sharedIndex };
  switch (mode) {
    case "qkb-bm25":
      return {
        cmd: `${qkbBin} --index flight-graph search ${Q} --json -n 10 -c ${fixture.qkbCollection}`,
      };
    case "qkb-vector":
      return {
        cmd: `${qkbBin} --index flight-graph vsearch ${Q} --json -n 10 -c ${fixture.qkbCollection}`,
      };
    case "qkb-hybrid":
      return {
        cmd: `${qkbBin} --index flight-graph query ${Q} -n 10 --files --no-graph -c ${fixture.qkbCollection}`,
      };
    case "qkb-graph":
      return {
        cmd: `${qkbBin} --index flight-graph query ${Q} -n 10 --files --graph -c ${fixture.qkbCollection}`,
      };
    case "qmd-bm25":
      return {
        cmd: `sh ${qmdBin} search ${Q} --json -n 10`,
        env,
      };
    case "qmd-vector":
      return {
        cmd: `sh ${qmdBin} vsearch ${Q} --json -n 10`,
        env,
      };
    case "qmd-hybrid":
      return {
        cmd: `sh ${qmdBin} query ${Q} -n 10 --files`,
        env,
      };
  }
}

function runMode(mode: Mode, question: Question): ModeResult {
  const { cmd, env } = buildCmd(mode, question.question);
  const start = Date.now();
  try {
    const stdout = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
      env,
    });
    const elapsedMs = Date.now() - start;
    const isJson =
      mode === "qkb-bm25" || mode === "qkb-vector" ||
      mode === "qmd-bm25" || mode === "qmd-vector";
    const hits = isJson ? parseJsonHits(stdout) : parseFilesOutput(stdout);
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
      error: (e.stderr && e.stderr.toString()) ?? e.message ?? "unknown",
    };
  }
}

function scoreRecall(hits: string[], expected: string[]): RecallScores {
  const expectedSet = new Set(expected);
  const denom = Math.max(1, expected.length);
  const matched5 = hits.slice(0, 5).filter((h) => expectedSet.has(h)).length;
  const matched10 = hits.slice(0, 10).filter((h) => expectedSet.has(h)).length;
  const firstHitIndex = hits.findIndex((h) => expectedSet.has(h));
  return {
    recall5: matched5 / denom,
    recall10: matched10 / denom,
    top1Hit: !!hits[0] && expectedSet.has(hits[0]),
    firstHitRank: firstHitIndex >= 0 ? firstHitIndex + 1 : null,
  };
}

const results: QuestionResult[] = [];

for (let i = 0; i < fixture.questions.length; i++) {
  const q = fixture.questions[i]!;
  console.error(`[${i + 1}/${fixture.questions.length}] ${q.id}: ${q.question}`);
  const modeResults: ModeResult[] = [];
  for (const mode of enabledModes) {
    process.stderr.write(`  ${mode.padEnd(12)}... `);
    const r = runMode(mode, q);
    process.stderr.write(
      `${r.ok ? "ok" : "FAIL"} ${(r.elapsedMs / 1000).toFixed(1)}s, ${r.hits.length} hits\n`
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
function fmtPct(r: number): string {
  return `${(r * 100).toFixed(0)}%`;
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(outDir, `full-bench-${timestamp}.md`);
mkdirSync(dirname(outPath), { recursive: true });

const lines: string[] = [];
lines.push(`# Full retrieval benchmark — ${fixture.corpus}`);
lines.push("");
lines.push(`**Run**: ${new Date().toISOString()}`);
lines.push(`**Index**: \`${sharedIndex}\``);
lines.push(`**Questions**: ${fixture.questions.length}`);
lines.push(`**Modes**: ${enabledModes.join(", ")}`);
lines.push("");
lines.push("Both qkb and qmd run against the same SQLite file (qmd reads qkb's index transparently — schema for qmd-owned tables is shared). This isolates pipeline differences from corpus differences.");
lines.push("");
lines.push("## Summary");
lines.push("");

interface Agg {
  count: number;
  failed: number;
  totalMs: number;
  recall5Sum: number;
  recall10Sum: number;
  top1Hits: number;
  firstHitRanksKnown: number;
  firstHitRankSum: number;
}

const agg = new Map<Mode, Agg>();
for (const m of enabledModes) {
  agg.set(m, {
    count: 0, failed: 0, totalMs: 0,
    recall5Sum: 0, recall10Sum: 0, top1Hits: 0,
    firstHitRanksKnown: 0, firstHitRankSum: 0,
  });
}

for (const r of results) {
  for (const m of r.modes) {
    const a = agg.get(m.mode);
    if (!a) continue;
    a.count++;
    a.totalMs += m.elapsedMs;
    if (!m.ok) { a.failed++; continue; }
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
  "| Mode | recall@5 | recall@10 | top-1 | first-hit | latency | failures |"
);
lines.push(
  "|------|---------:|----------:|------:|----------:|--------:|---------:|"
);
for (const m of enabledModes) {
  const a = agg.get(m)!;
  const ok = a.count - a.failed;
  const r5 = ok > 0 ? a.recall5Sum / ok : 0;
  const r10 = ok > 0 ? a.recall10Sum / ok : 0;
  const t1 = ok > 0 ? a.top1Hits / ok : 0;
  const fhr = a.firstHitRanksKnown > 0
    ? (a.firstHitRankSum / a.firstHitRanksKnown).toFixed(1)
    : "—";
  const meanMs = a.count > 0 ? a.totalMs / a.count : 0;
  lines.push(
    `| ${m} | ${fmtPct(r5)} | ${fmtPct(r10)} | ${fmtPct(t1)} | ${fhr} | ${fmtMs(meanMs)} | ${a.failed}/${a.count} |`
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
  lines.push("| Mode | recall@5 | recall@10 | top-1 | first-hit | latency |");
  lines.push("|------|---------:|----------:|------:|----------:|--------:|");
  for (const m of r.modes) {
    if (!m.ok) {
      lines.push(`| ${m.mode} | — | — | — | — | ${fmtMs(m.elapsedMs)} (failed) |`);
      continue;
    }
    const s = scoreRecall(m.hits, r.question.expected_docs);
    lines.push(
      `| ${m.mode} | ${fmtPct(s.recall5)} | ${fmtPct(s.recall10)} | ${s.top1Hit ? "✓" : "✗"} | ${s.firstHitRank ?? "—"} | ${fmtMs(m.elapsedMs)} |`
    );
  }
  lines.push("");
}

lines.push("## Methodology");
lines.push("");
lines.push("- **recall@K**: fraction of `expected_docs` appearing in top-K results (deterministic, no LLM judge).");
lines.push("- **top-1 hit**: did the top result match an expected doc?");
lines.push("- **first-hit rank**: 1-indexed rank of the first expected doc.");
lines.push("- **expected_docs**: hand-curated per-question — see `bench/fixtures/flight-planner-questions.json`.");
lines.push("- Both engines query the same SQLite file; differences isolate pipeline contributions.");
lines.push("");
lines.push("## Caveats");
lines.push("");
lines.push("- The `vault-query` Claude skill (curated index.md + hot.md + 3-5 selected pages) is NOT benchmarked here. It's not a retrieval engine — it's a procedural reading pattern that depends on Claude judgment. Comparing it to ranked-list retrieval would be apples-to-oranges.");
lines.push("- `qmd` doesn't have a graph mode; the `qkb-graph` row's edge over `qmd-hybrid` quantifies the value of the graph layer in qkb's pipeline.");
lines.push("- Vector-only modes (`qkb-vector`, `qmd-vector`) skip the cross-encoder reranker by design — they show what raw embedding similarity buys before the reranker steps in.");

const report = lines.join("\n") + "\n";
writeFileSync(outPath, report);
console.error(`Wrote ${outPath}`);
console.log(report);

let anySuccess = false;
for (const a of agg.values()) {
  if (a.count - a.failed > 0) { anySuccess = true; break; }
}
process.exit(anySuccess ? 0 : 1);
