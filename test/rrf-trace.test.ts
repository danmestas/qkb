import { describe, expect, test } from "vitest";
import { buildRrfTrace, reciprocalRankFusion, type RankedResult } from "../src/store";

describe("buildRrfTrace", () => {
  test("matches reciprocalRankFusion totals and records per-list contributions", () => {
    const list1: RankedResult[] = [
      { file: "qkb://docs/a.md", displayPath: "docs/a.md", title: "A", body: "", score: 0.92 },
      { file: "qkb://docs/b.md", displayPath: "docs/b.md", title: "B", body: "", score: 0.81 },
    ];
    const list2: RankedResult[] = [
      { file: "qkb://docs/b.md", displayPath: "docs/b.md", title: "B", body: "", score: 0.77 },
      { file: "qkb://docs/a.md", displayPath: "docs/a.md", title: "A", body: "", score: 0.65 },
    ];

    const weights = [2.0, 1.0];
    const traces = buildRrfTrace(
      [list1, list2],
      weights,
      [
        { source: "fts", queryType: "lex", query: "lex query" },
        { source: "vec", queryType: "vec", query: "vec query" },
      ]
    );
    const fused = reciprocalRankFusion([list1, list2], weights);

    for (const result of fused) {
      const trace = traces.get(result.file);
      expect(trace).toBeDefined();
      expect(trace!.totalScore).toBeCloseTo(result.score, 10);
    }

    const aTrace = traces.get("qkb://docs/a.md")!;
    expect(aTrace.contributions).toHaveLength(2);
    expect(aTrace.contributions[0]?.source).toBe("fts");
    expect(aTrace.contributions[1]?.source).toBe("vec");
    expect(aTrace.topRank).toBe(1);
    expect(aTrace.topRankBonus).toBeCloseTo(0.05, 10);
  });

  test("applies top-rank bonus thresholds correctly", () => {
    const list: RankedResult[] = [
      { file: "qkb://docs/r1.md", displayPath: "docs/r1.md", title: "R1", body: "", score: 0.9 },
      { file: "qkb://docs/r2.md", displayPath: "docs/r2.md", title: "R2", body: "", score: 0.8 },
      { file: "qkb://docs/r3.md", displayPath: "docs/r3.md", title: "R3", body: "", score: 0.7 },
      { file: "qkb://docs/r4.md", displayPath: "docs/r4.md", title: "R4", body: "", score: 0.6 },
    ];

    const traces = buildRrfTrace([list], [1.0], [{ source: "fts", queryType: "lex", query: "rank" }]);

    expect(traces.get("qkb://docs/r1.md")?.topRankBonus).toBeCloseTo(0.05, 10);
    expect(traces.get("qkb://docs/r2.md")?.topRankBonus).toBeCloseTo(0.02, 10);
    expect(traces.get("qkb://docs/r3.md")?.topRankBonus).toBeCloseTo(0.02, 10);
    expect(traces.get("qkb://docs/r4.md")?.topRankBonus).toBeCloseTo(0.0, 10);
  });
});
