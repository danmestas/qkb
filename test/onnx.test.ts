import { describe, expect, test } from "vitest";

import { formatDocForEmbedding, formatQueryForEmbedding } from "../src/internals/llm.js";
import { DEFAULT_EMBED_MODEL, DEFAULT_RERANK_MODEL } from "../src/internals/store-engine.js";
import { isOnnxModelUri } from "../src/internals/onnx.js";

describe("ONNX model defaults", () => {
  test("uses ONNX models for embedding and reranking by default", () => {
    expect(DEFAULT_EMBED_MODEL).toBe("Xenova/all-MiniLM-L6-v2");
    expect(DEFAULT_RERANK_MODEL).toBe("Xenova/ms-marco-MiniLM-L-4-v2");
    expect(isOnnxModelUri(DEFAULT_EMBED_MODEL)).toBe(true);
    expect(isOnnxModelUri(DEFAULT_RERANK_MODEL)).toBe(true);
  });

  test("keeps legacy GGUF URIs opt-in", () => {
    expect(isOnnxModelUri("hf:ggml-org/model/repo/model.gguf")).toBe(false);
    expect(isOnnxModelUri("/tmp/model.gguf")).toBe(false);
  });

  test("formats ONNX embeddings without GGUF task prefixes", () => {
    expect(formatQueryForEmbedding("airport card", DEFAULT_EMBED_MODEL)).toBe("airport card");
    expect(formatDocForEmbedding("body", "Title", DEFAULT_EMBED_MODEL)).toBe("Title\nbody");
  });

  test("preserves Qwen GGUF query embedding prompt when explicitly configured", () => {
    const model = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
    expect(formatQueryForEmbedding("airport card", model)).toContain("Instruct:");
  });
});
