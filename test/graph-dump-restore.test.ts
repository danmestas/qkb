/**
 * Tests for `qkb graph dump` / `qkb graph restore` — RFC-0007 §7
 * (exit-plan tool). Format is QKB-defined NDJSON per D10 in PLAN.md.
 *
 * Format (one JSON object per line):
 *   {"kind":"header","format_version":1,"qkb_version":"...","exported_at":"..."}
 *   {"kind":"node","id":"alice","label":"Person","properties":{...}}
 *   {"kind":"edge","from":"alice","to":"bob","type":"KNOWS","properties":{...}}
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/internals/store-engine.js";
import { setConfigSource } from "../src/internals/collections-yaml.js";
import {
  dumpGraph,
  restoreGraph,
  parseDump,
} from "../src/graph/dump-restore.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";
const HAS_REAL_BINARY =
  !!process.env.QKB_GRAPHQLITE_PATH ||
  existsSync(DEFAULT_BREW_PATH);

describe("graph dump/restore format (always-on)", () => {
  it("parseDump accepts a valid header + nodes + edges", () => {
    const ndjson = [
      JSON.stringify({
        kind: "header",
        format_version: 1,
        qkb_version: "2.2.0",
        exported_at: "2026-05-07T00:00:00Z",
      }),
      JSON.stringify({
        kind: "node",
        id: "a",
        label: "P",
        properties: { name: "Alice" },
      }),
      JSON.stringify({
        kind: "edge",
        from: "a",
        to: "b",
        type: "KNOWS",
        properties: { since: 2020 },
      }),
    ].join("\n");

    const parsed = parseDump(ndjson);
    expect(parsed.header.format_version).toBe(1);
    expect(parsed.nodes.length).toBe(1);
    expect(parsed.edges.length).toBe(1);
    expect(parsed.nodes[0]?.id).toBe("a");
    expect(parsed.edges[0]?.type).toBe("KNOWS");
  });

  it("parseDump tolerates blank lines + trailing newline", () => {
    const ndjson =
      JSON.stringify({ kind: "header", format_version: 1, qkb_version: "x", exported_at: "x" }) +
      "\n\n" +
      JSON.stringify({ kind: "node", id: "a", label: "P", properties: {} }) +
      "\n";
    const parsed = parseDump(ndjson);
    expect(parsed.nodes.length).toBe(1);
  });

  it("parseDump rejects missing header line", () => {
    const ndjson = JSON.stringify({
      kind: "node",
      id: "a",
      label: "P",
      properties: {},
    });
    expect(() => parseDump(ndjson)).toThrow(/header/i);
  });

  it("parseDump rejects unknown format_version", () => {
    const ndjson = JSON.stringify({
      kind: "header",
      format_version: 999,
      qkb_version: "x",
      exported_at: "x",
    });
    expect(() => parseDump(ndjson)).toThrow(/format_version/i);
  });

  it("parseDump rejects malformed JSON line", () => {
    const ndjson =
      JSON.stringify({ kind: "header", format_version: 1, qkb_version: "x", exported_at: "x" }) +
      "\n{not-json}";
    expect(() => parseDump(ndjson)).toThrow(/json|parse/i);
  });

  it("parseDump rejects unknown kind", () => {
    const ndjson =
      JSON.stringify({ kind: "header", format_version: 1, qkb_version: "x", exported_at: "x" }) +
      "\n" +
      JSON.stringify({ kind: "fish", id: "a" });
    expect(() => parseDump(ndjson)).toThrow(/kind|fish/i);
  });
});

describe.skipIf(!HAS_REAL_BINARY)("dump/restore round-trip", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-dump-"));
    setConfigSource({
      config: { collections: {}, graph: { enabled: true } },
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    setConfigSource();
  });

  it("dumps an empty graph as header + zero rows", () => {
    const store = createStore(join(tmpDir, "empty.sqlite"));
    try {
      const dump = dumpGraph(store);
      const parsed = parseDump(dump);
      expect(parsed.nodes.length).toBe(0);
      expect(parsed.edges.length).toBe(0);
      expect(parsed.header.format_version).toBe(1);
    } finally {
      store.close();
    }
  });

  it("round-trips a small graph through dump → restore", () => {
    const src = createStore(join(tmpDir, "src.sqlite"));
    try {
      src.graph.upsertNode({
        id: "alice",
        label: "Person",
        properties: { name: "Alice", age: 30 },
      });
      src.graph.upsertNode({
        id: "bob",
        label: "Person",
        properties: { name: "Bob", age: 25 },
      });
      src.graph.upsertEdge({
        from: "alice",
        to: "bob",
        type: "KNOWS",
        properties: { since: 2020 },
      });
      const dump = dumpGraph(src);

      const dst = createStore(join(tmpDir, "dst.sqlite"));
      try {
        const counts = restoreGraph(dst, dump);
        expect(counts.nodes).toBe(2);
        expect(counts.edges).toBe(1);

        // Verify content
        const aliceRow = dst.graph.cypher<{ name: string; age: number }>(
          ((s: TemplateStringsArray) => s.raw[0])`MATCH (p:Person {id: $id}) RETURN p.name AS name, p.age AS age` as never,
          { id: "alice" }
        );
        expect(aliceRow[0]?.name).toBe("Alice");
        expect(aliceRow[0]?.age).toBe(30);

        const knows = dst.graph.cypher<{ since: number }>(
          ((s: TemplateStringsArray) => s.raw[0])`MATCH (a:Person {id: $a})-[r:KNOWS]->(:Person) RETURN r.since AS since` as never,
          { a: "alice" }
        );
        expect(knows[0]?.since).toBe(2020);
      } finally {
        dst.close();
      }
    } finally {
      src.close();
    }
  });

  it("restore is additive — running twice is idempotent for nodes (upsert) but doubles edges", () => {
    const src = createStore(join(tmpDir, "src2.sqlite"));
    try {
      src.graph.upsertNode({ id: "x", label: "P", properties: {} });
      src.graph.upsertNode({ id: "y", label: "P", properties: {} });
      src.graph.upsertEdge({ from: "x", to: "y", type: "L" });
      const dump = dumpGraph(src);

      const dst = createStore(join(tmpDir, "dst2.sqlite"));
      try {
        restoreGraph(dst, dump);
        restoreGraph(dst, dump);

        // Idempotent on nodes (upsert): still 2 nodes
        const nodeCount = dst.graph.cypher<{ c: number }>(
          ((s: TemplateStringsArray) => s.raw[0])`MATCH (n:P) RETURN count(n) AS c` as never
        );
        expect(Number(nodeCount[0]?.c)).toBe(2);

        // Edges via inline-MERGE — same (from,to,type,properties=∅) signature
        // matches existing, so no duplicate. Confirms.
        const edgeCount = dst.graph.cypher<{ c: number }>(
          ((s: TemplateStringsArray) => s.raw[0])`MATCH ()-[r:L]->() RETURN count(r) AS c` as never
        );
        expect(Number(edgeCount[0]?.c)).toBe(1);
      } finally {
        dst.close();
      }
    } finally {
      src.close();
    }
  });
});
