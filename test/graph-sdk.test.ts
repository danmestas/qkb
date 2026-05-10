/**
 * Tests for the graph SDK — RFC-0007 §4.6.1.
 *
 * Public surface (under `store.graph.*`):
 *   - upsertNode({ id, label, properties })
 *   - upsertEdge({ from, to, type, properties })
 *   - cypher<T>(query: CypherQuery, params: object): T[]
 *   - cypher tagged-template helper (rejects interpolation at value positions)
 *
 * When `graph.enabled=false`, every method throws GraphDisabledError.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/internals/store-engine.js";
import { setConfigSource } from "../src/internals/collections-yaml.js";
import { cypher } from "../src/graph/sdk.js";
import { GraphDisabledError } from "../src/graph/config.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";

const HAS_REAL_BINARY =
  !!process.env.QKB_GRAPHQLITE_PATH ||
  existsSync(DEFAULT_BREW_PATH);

describe("graph SDK", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-sdk-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    setConfigSource();
  });

  function dbPath(name = "test"): string {
    return join(tmpDir, `${name}.sqlite`);
  }

  describe("disabled state (graph.enabled=false)", () => {
    it("upsertNode throws GraphDisabledError", () => {
      setConfigSource({ config: { collections: {}, graph: { enabled: false } } });
      const store = createStore(dbPath("disabled-1"));
      try {
        expect(() =>
          store.graph.upsertNode({
            id: "n1",
            label: "Node",
            properties: {},
          })
        ).toThrow(GraphDisabledError);
      } finally {
        store.close();
      }
    });

    it("upsertEdge throws GraphDisabledError", () => {
      setConfigSource({ config: { collections: {}, graph: { enabled: false } } });
      const store = createStore(dbPath("disabled-2"));
      try {
        expect(() =>
          store.graph.upsertEdge({
            from: "n1",
            to: "n2",
            type: "REL",
          })
        ).toThrow(GraphDisabledError);
      } finally {
        store.close();
      }
    });

    it("cypher throws GraphDisabledError", () => {
      setConfigSource({ config: { collections: {}, graph: { enabled: false } } });
      const store = createStore(dbPath("disabled-3"));
      try {
        expect(() =>
          store.graph.cypher(cypher`RETURN 1 AS x`, {})
        ).toThrow(GraphDisabledError);
      } finally {
        store.close();
      }
    });
  });

  describe("cypher template tag", () => {
    it("accepts a plain template literal with no interpolations", () => {
      const q = cypher`MATCH (n) RETURN n`;
      expect(typeof q).toBe("string");
      expect(String(q)).toBe("MATCH (n) RETURN n");
    });

    it("rejects template literals with interpolations at runtime", () => {
      const userInput = "evil";
      // @ts-expect-error — TypeScript should already reject this at compile time;
      // the runtime guard exists for cases where types are bypassed.
      expect(() => cypher`MATCH (n) WHERE n.id = ${userInput} RETURN n`).toThrow(
        /interpolation/i
      );
    });
  });

  describe.skipIf(!HAS_REAL_BINARY)("with real GraphQLite binary", () => {
    function enabledStore(name: string) {
      setConfigSource({
        config: { collections: {}, graph: { enabled: true } },
      });
      return createStore(dbPath(name));
    }

    it("upsertNode creates a node and is queryable via cypher", () => {
      const store = enabledStore("upsert-node");
      try {
        store.graph.upsertNode({
          id: "person:alice",
          label: "Person",
          properties: { name: "Alice", age: 30 },
        });

        const rows = store.graph.cypher<{ name: string; age: number }>(
          cypher`MATCH (p:Person {id: $id}) RETURN p.name AS name, p.age AS age`,
          { id: "person:alice" }
        );

        expect(rows.length).toBe(1);
        expect(rows[0]?.name).toBe("Alice");
        expect(rows[0]?.age).toBe(30);
      } finally {
        store.close();
      }
    });

    it("upsertNode is idempotent — re-upsert updates properties", () => {
      const store = enabledStore("upsert-idempotent");
      try {
        store.graph.upsertNode({
          id: "person:bob",
          label: "Person",
          properties: { name: "Bob", age: 25 },
        });

        store.graph.upsertNode({
          id: "person:bob",
          label: "Person",
          properties: { name: "Bob", age: 26 }, // bumped age
        });

        const rows = store.graph.cypher<{ age: number }>(
          cypher`MATCH (p:Person {id: $id}) RETURN p.age AS age`,
          { id: "person:bob" }
        );

        expect(rows.length).toBe(1);
        expect(rows[0]?.age).toBe(26);
      } finally {
        store.close();
      }
    });

    it("upsertEdge creates a typed relationship", () => {
      const store = enabledStore("upsert-edge");
      try {
        store.graph.upsertNode({
          id: "person:alice",
          label: "Person",
          properties: { name: "Alice" },
        });
        store.graph.upsertNode({
          id: "person:bob",
          label: "Person",
          properties: { name: "Bob" },
        });
        store.graph.upsertEdge({
          from: "person:alice",
          to: "person:bob",
          type: "KNOWS",
          properties: { since: 2020 },
        });

        const rows = store.graph.cypher<{ name: string; since: number }>(
          cypher`MATCH (a:Person {id: $a})-[r:KNOWS]->(b:Person)
                 RETURN b.name AS name, r.since AS since`,
          { a: "person:alice" }
        );

        expect(rows.length).toBe(1);
        expect(rows[0]?.name).toBe("Bob");
        expect(rows[0]?.since).toBe(2020);
      } finally {
        store.close();
      }
    });

    it("cypher returns empty array when no rows match", () => {
      const store = enabledStore("empty-result");
      try {
        const rows = store.graph.cypher(
          cypher`MATCH (n:NoSuchLabel) RETURN n`,
          {}
        );
        expect(rows).toEqual([]);
      } finally {
        store.close();
      }
    });

    it("cypher write queries (no RETURN) don't throw on status-string output", () => {
      // GraphQLite returns "Query executed successfully - nodes
      // created: N, ..." for write queries with no RETURN. JSON.parse
      // throws on that; runCypher must swallow + return [].
      const store = enabledStore("write-status");
      try {
        expect(() =>
          store.graph.cypher(cypher`CREATE (:Mark {id: 'w1'})`, {})
        ).not.toThrow();
        const rows = store.graph.cypher<{ c: number }>(
          cypher`MATCH (n:Mark) RETURN count(n) AS c`,
          {}
        );
        expect(Number(rows[0]?.c)).toBe(1);
      } finally {
        store.close();
      }
    });

    it("cypher passes parameters by name", () => {
      const store = enabledStore("params");
      try {
        store.graph.upsertNode({
          id: "p:1",
          label: "Item",
          properties: { value: 42 },
        });

        const rows = store.graph.cypher<{ value: number }>(
          cypher`MATCH (i:Item {id: $id}) RETURN i.value AS value`,
          { id: "p:1" }
        );

        expect(rows[0]?.value).toBe(42);
      } finally {
        store.close();
      }
    });
  });
});
