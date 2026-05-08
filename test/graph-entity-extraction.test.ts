/**
 * Tests for entity extraction — RFC-0007 Phase 2D.
 *
 * The parser is unit-testable without a real LLM (just feed canned
 * response strings). Full LLM extraction is exercised manually via
 * `qkb graph extract --collection foo` once a generate model is loaded.
 */
import { describe, it, expect } from "vitest";
import {
  parseEntityResponse,
  normalizeEntityName,
  entityNodeId,
  extractEntities,
  type Entity,
} from "../src/graph/entity-extraction.js";
import type { LLM } from "../src/llm.js";

const ALLOWED = ["Person", "Organization", "Concept"];

describe("parseEntityResponse", () => {
  it("parses a clean JSON array", () => {
    const text = `[
      {"type": "Person", "name": "Alice"},
      {"type": "Organization", "name": "Acme"}
    ]`;
    const result = parseEntityResponse(text, ALLOWED);
    expect(result).toEqual([
      { type: "Person", name: "Alice" },
      { type: "Organization", name: "Acme" },
    ]);
  });

  it("strips a ```json fence", () => {
    const text = '```json\n[{"type":"Person","name":"Bob"}]\n```';
    const result = parseEntityResponse(text, ALLOWED);
    expect(result).toEqual([{ type: "Person", name: "Bob" }]);
  });

  it("strips an unfenced ``` block", () => {
    const text = '```\n[{"type":"Person","name":"Carol"}]\n```';
    const result = parseEntityResponse(text, ALLOWED);
    expect(result).toEqual([{ type: "Person", name: "Carol" }]);
  });

  it("tolerates leading prose before the JSON array", () => {
    const text = `Here are the entities:\n[{"type":"Person","name":"Dave"}]`;
    const result = parseEntityResponse(text, ALLOWED);
    expect(result).toEqual([{ type: "Person", name: "Dave" }]);
  });

  it("returns [] on malformed JSON", () => {
    const result = parseEntityResponse("[not-json", ALLOWED);
    expect(result).toEqual([]);
  });

  it("returns [] when there's no JSON array at all", () => {
    const result = parseEntityResponse("no entities found", ALLOWED);
    expect(result).toEqual([]);
  });

  it("accepts NDJSON — small LLMs emit one-object-per-line", () => {
    // Real shape observed from default 1.7B generate model:
    const text = `\n\n{"type": "Concept", "name": "Cessna 172"}\n{"type": "Person", "name": "Alice"}\n{"type": "Organization", "name": "NASA"}`;
    const result = parseEntityResponse(text, ALLOWED);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.name).sort()).toEqual([
      "Alice",
      "Cessna 172",
      "NASA",
    ]);
  });

  it("NDJSON tolerates surrounding prose and blank lines", () => {
    const text = `Here are the entities:\n\n{"type":"Person","name":"Bob"}\n  \n{"type":"Concept","name":"physics"}\n\nThat's all.`;
    const result = parseEntityResponse(text, ALLOWED);
    expect(result.map((r) => r.name).sort()).toEqual(["Bob", "physics"]);
  });

  it("returns [] on empty input", () => {
    expect(parseEntityResponse("", ALLOWED)).toEqual([]);
  });

  it("filters out entries with disallowed types", () => {
    const text = `[
      {"type": "Person", "name": "Alice"},
      {"type": "Animal", "name": "Mittens"},
      {"type": "Organization", "name": "Acme"}
    ]`;
    const result = parseEntityResponse(text, ALLOWED);
    expect(result.map((e) => e.type)).toEqual(["Person", "Organization"]);
  });

  it("filters out entries missing type or name", () => {
    const text = `[
      {"type": "Person", "name": "Alice"},
      {"type": "Person"},
      {"name": "Orphan"},
      {"type": null, "name": "Bad"}
    ]`;
    const result = parseEntityResponse(text, ALLOWED);
    expect(result).toEqual([{ type: "Person", name: "Alice" }]);
  });

  it("dedupes (type, normalized name)", () => {
    const text = `[
      {"type": "Person", "name": "Alice"},
      {"type": "Person", "name": "ALICE"},
      {"type": "Person", "name": "alice"}
    ]`;
    const result = parseEntityResponse(text, ALLOWED);
    expect(result).toEqual([{ type: "Person", name: "Alice" }]);
  });

  it("respects maxEntities cap", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      type: "Person",
      name: `P${i}`,
    }));
    const result = parseEntityResponse(JSON.stringify(items), ALLOWED, 5);
    expect(result).toHaveLength(5);
  });

  it("accepts a single JSON object as a degenerate NDJSON case", () => {
    // A bare top-level object like `{"type":"...","name":"..."}` is the
    // degenerate one-line NDJSON shape. Permissive parser accepts it.
    expect(parseEntityResponse('{"type":"Person","name":"X"}', ALLOWED)).toEqual([
      { type: "Person", name: "X" },
    ]);
  });
});

describe("normalizeEntityName", () => {
  it("lowercases", () => {
    expect(normalizeEntityName("Alice Wonderland")).toBe("alice_wonderland");
  });

  it("collapses non-identifier runs to single underscore", () => {
    expect(normalizeEntityName("O'Brien & Sons, Inc.")).toBe("o_brien_sons_inc");
  });

  it("trims leading/trailing underscores", () => {
    expect(normalizeEntityName("!!Topic!!")).toBe("topic");
  });

  it("preserves digits", () => {
    expect(normalizeEntityName("Acme 2.0")).toBe("acme_2_0");
  });
});

describe("entityNodeId", () => {
  it("composes type + normalized name", () => {
    expect(entityNodeId("Person", "Alice Wonderland")).toBe(
      "entity:Person:alice_wonderland"
    );
    expect(entityNodeId("Organization", "Acme Corp.")).toBe(
      "entity:Organization:acme_corp"
    );
  });
});

describe("extractEntities (mocked LLM)", () => {
  function mockLLM(response: string): LLM {
    // Minimal LLM stub — only `generate` is used.
    return {
      embed: async () => null,
      generate: async () => ({ text: response, model: "mock" }),
      modelExists: async () => ({ available: true, path: null, source: "test" }),
      expandQuery: async () => [],
      rerank: async () => ({ documents: [] }),
      dispose: async () => {},
    } as unknown as LLM;
  }

  it("returns entities from a successful LLM response", async () => {
    const llm = mockLLM(
      '[{"type":"Person","name":"Alice"},{"type":"Concept","name":"graphs"}]'
    );
    const result = await extractEntities(llm, "Alice studies graphs", ALLOWED);
    expect(result.length).toBe(2);
    expect(result.find((r: Entity) => r.name === "Alice")).toBeDefined();
  });

  it("returns [] when LLM throws", async () => {
    const llm: LLM = {
      embed: async () => null,
      generate: async () => {
        throw new Error("model not loaded");
      },
      modelExists: async () => ({ available: false, path: null, source: "test" }),
      expandQuery: async () => [],
      rerank: async () => ({ documents: [] }),
      dispose: async () => {},
    } as unknown as LLM;
    const result = await extractEntities(llm, "text", ALLOWED);
    expect(result).toEqual([]);
  });

  it("returns [] for empty allowed types", async () => {
    const llm = mockLLM("[]");
    const result = await extractEntities(llm, "text", []);
    expect(result).toEqual([]);
  });

  it("returns [] for empty text", async () => {
    const llm = mockLLM("[]");
    const result = await extractEntities(llm, "   ", ALLOWED);
    expect(result).toEqual([]);
  });

  it("truncates long text to maxChars", async () => {
    let lastPrompt = "";
    const llm: LLM = {
      embed: async () => null,
      generate: async (p: string) => {
        lastPrompt = p;
        return { text: "[]", model: "mock" };
      },
      modelExists: async () => ({ available: true, path: null, source: "test" }),
      expandQuery: async () => [],
      rerank: async () => ({ documents: [] }),
      dispose: async () => {},
    } as unknown as LLM;
    const longText = "A".repeat(8000);
    await extractEntities(llm, longText, ALLOWED, { maxChars: 100 });
    // Prompt should contain at most ~100 chars of the input text plus
    // the wrapper prose. Cap at 4 for a generous bound.
    const aCount = (lastPrompt.match(/A/g) ?? []).length;
    expect(aCount).toBeLessThanOrEqual(150);
    expect(aCount).toBeGreaterThanOrEqual(100);
  });
});
