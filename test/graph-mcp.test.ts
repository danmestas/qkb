/**
 * Tests for the graph MCP tools — RFC-0007 §4.6.3.
 *
 * Tests the pure handler functions (Store + args -> MCP-shaped result).
 * Wiring into the actual MCP server is exercised by existing mcp.test.ts
 * smoke tests once these tools are registered.
 *
 * Tools:
 *   - graph_query(cypher, params) — same param rules as SDK CLI
 *   - graph_neighbors(node_id, hops, edge_types?) — constrained traversal
 *
 * NOT exposed via MCP per RFC §4.6.3:
 *   - pageRank (resource exhaustion risk for agents)
 *   - gc (mutating, not appropriate for tool callers)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/internals/store-engine.js";
import { setConfigSource } from "../src/internals/collections-yaml.js";
import { runGraphQuery, runGraphNeighbors } from "../src/graph/mcp.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";
const HAS_REAL_BINARY =
  !!process.env.QKB_GRAPHQLITE_PATH ||
  existsSync(DEFAULT_BREW_PATH);

describe("graph MCP handlers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-mcp-graph-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    setConfigSource();
  });

  function dbPath(name: string): string {
    return join(tmpDir, `${name}.sqlite`);
  }

  describe("disabled state (always-on)", () => {
    it("graph_query returns isError + helpful text when layer disabled", () => {
      setConfigSource({ config: { collections: {}, graph: { enabled: false } } });
      const store = createStore(dbPath("disabled-q"));
      try {
        const res = runGraphQuery(store, { cypher: "RETURN 1", params: {} });
        expect(res.isError).toBe(true);
        const text = (res.content[0] as { text: string }).text;
        expect(text).toMatch(/disabled|unavailable/i);
      } finally {
        store.close();
      }
    });

    it("graph_neighbors returns isError when layer disabled", () => {
      setConfigSource({ config: { collections: {}, graph: { enabled: false } } });
      const store = createStore(dbPath("disabled-n"));
      try {
        const res = runGraphNeighbors(store, { node_id: "a", hops: 1 });
        expect(res.isError).toBe(true);
      } finally {
        store.close();
      }
    });
  });

  describe("graph_query parameter rules (always-on)", () => {
    it("rejects $-prefixed identifiers without params", () => {
      setConfigSource({ config: { collections: {}, graph: { enabled: false } } });
      const store = createStore(dbPath("noparams"));
      try {
        const res = runGraphQuery(store, {
          cypher: "MATCH (n {id: $id}) RETURN n",
          params: {},
        });
        expect(res.isError).toBe(true);
        const text = (res.content[0] as { text: string }).text;
        expect(text).toMatch(/params|parameter/i);
        expect(text).toMatch(/\$id/);
      } finally {
        store.close();
      }
    });
  });

  describe("graph_neighbors hop limit (always-on)", () => {
    it("rejects hops > 3", () => {
      const store = createStore(dbPath("hops"));
      try {
        const res = runGraphNeighbors(store, { node_id: "a", hops: 4 });
        expect(res.isError).toBe(true);
        const text = (res.content[0] as { text: string }).text;
        expect(text).toMatch(/hops|limit/i);
      } finally {
        store.close();
      }
    });

    it("rejects hops < 1", () => {
      const store = createStore(dbPath("hops-lo"));
      try {
        const res = runGraphNeighbors(store, { node_id: "a", hops: 0 });
        expect(res.isError).toBe(true);
      } finally {
        store.close();
      }
    });
  });

  describe.skipIf(!HAS_REAL_BINARY)("with real binary", () => {
    function enabled(name: string) {
      setConfigSource({
        config: { collections: {}, graph: { enabled: true } },
      });
      return createStore(dbPath(name));
    }

    it("graph_query returns rows for a parameterized Cypher", () => {
      const store = enabled("q-real");
      try {
        store.graph.upsertNode({
          id: "alice",
          label: "Person",
          properties: { name: "Alice" },
        });
        const res = runGraphQuery(store, {
          cypher: "MATCH (p:Person {id: $id}) RETURN p.name AS name",
          params: { id: "alice" },
        });
        expect(res.isError).toBeFalsy();
        const sc = res.structuredContent as { rows: Array<{ name: string }> };
        expect(sc.rows[0]?.name).toBe("Alice");
      } finally {
        store.close();
      }
    });

    it("graph_neighbors returns 1-hop neighbors", () => {
      const store = enabled("n-real");
      try {
        for (const id of ["a", "b", "c"]) {
          store.graph.upsertNode({ id, label: "P", properties: {} });
        }
        store.graph.upsertEdge({ from: "a", to: "b", type: "KNOWS" });
        store.graph.upsertEdge({ from: "a", to: "c", type: "FOLLOWS" });

        const res = runGraphNeighbors(store, { node_id: "a", hops: 1 });
        expect(res.isError).toBeFalsy();
        const sc = res.structuredContent as { neighbors: Array<{ id: string; type: string }> };
        const ids = sc.neighbors.map((n) => n.id).sort();
        expect(ids).toEqual(["b", "c"]);
      } finally {
        store.close();
      }
    });

    it("graph_neighbors filters by edge_types", () => {
      const store = enabled("n-filter");
      try {
        for (const id of ["a", "b", "c"]) {
          store.graph.upsertNode({ id, label: "P", properties: {} });
        }
        store.graph.upsertEdge({ from: "a", to: "b", type: "KNOWS" });
        store.graph.upsertEdge({ from: "a", to: "c", type: "FOLLOWS" });

        const res = runGraphNeighbors(store, {
          node_id: "a",
          hops: 1,
          edge_types: ["KNOWS"],
        });
        expect(res.isError).toBeFalsy();
        const sc = res.structuredContent as { neighbors: Array<{ id: string }> };
        const ids = sc.neighbors.map((n) => n.id).sort();
        expect(ids).toEqual(["b"]);
      } finally {
        store.close();
      }
    });
  });
});
