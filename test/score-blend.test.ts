import { describe, expect, test } from "vitest";

import { normalizeRerankLogit } from "../src/internals/onnx.js";

describe("normalizeRerankLogit", () => {
  test("maps 0 to exactly 0.5", () => {
    expect(normalizeRerankLogit(0)).toBe(0.5);
  });

  test("stays strictly inside (0,1) for extreme logits", () => {
    for (const logit of [-30, -10, -3.7, -1, -0.01, 0.01, 1, 3.7, 10, 30]) {
      const score = normalizeRerankLogit(logit);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1);
    }
  });

  test("never leaves [0,1] even when float64 saturates", () => {
    for (const logit of [-1000, -50, 50, 1000]) {
      const score = normalizeRerankLogit(logit);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  test("is monotonic: larger logits produce larger scores", () => {
    const logits = [-20, -5, -1, -0.5, 0, 0.5, 1, 5, 20];
    const scores = logits.map(normalizeRerankLogit);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
    }
  });
});

describe("rank/rerank blend invariant", () => {
  // Mirrors the CLI blend: w*(1/rank) + (1-w)*rerankScore with
  // w = 0.75 for rank<=3, 0.60 for rank<=10, 0.40 otherwise.
  function blendWeight(rank: number): number {
    if (rank <= 3) return 0.75;
    if (rank <= 10) return 0.60;
    return 0.40;
  }

  test("blended score never exceeds 1 for normalized rerank scores", () => {
    const ranks = [1, 2, 3, 4, 10, 11, 40];
    const rerankScores = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
    for (const rank of ranks) {
      const w = blendWeight(rank);
      for (const s of rerankScores) {
        const blended = w * (1 / rank) + (1 - w) * s;
        expect(blended).toBeLessThanOrEqual(1);
        expect(blended).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
