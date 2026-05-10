/**
 * Tests for the SDK bulk-insert path — RFC-0007 §4.4 (Phase 2A,
 * extended for the multi-MERGE batched fast path).
 *
 * `store.graph.upsertNodesBulk` / `upsertEdgesBulk` issue ~one Cypher
 * call per chunk of 100 elements (instead of one per element), using
 * comma-separated CREATE / MATCH+SET / MATCH+MERGE patterns. v0.4.4
 * quirks documented in `test/spikes/probe-multi-merge.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/internals/store-engine.js";
import { setConfigSource } from "../src/internals/collections-yaml.js";
import { cypher } from "../src/graph/sdk.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";
const HAS_REAL_BINARY =
  !!process.env.QKB_GRAPHQLITE_PATH ||
  existsSync(DEFAULT_BREW_PATH);

describe("graph bulk SDK (disabled state)", () => {
  it("upsertNodesBulk throws GraphDisabledError when layer is unavailable", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qkb-bulk-disabled-"));
    try {
      setConfigSource({ config: { collections: {}, graph: { enabled: false } } });
      const store = createStore(join(tmp, "x.sqlite"));
      try {
        expect(() =>
          store.graph.upsertNodesBulk([
            { id: "a", label: "X", properties: {} },
          ])
        ).toThrow(/graph layer/i);
      } finally {
        store.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      setConfigSource();
    }
  });
});

describe.skipIf(!HAS_REAL_BINARY)("graph bulk SDK (real binary)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-bulk-"));
    setConfigSource({
      config: { collections: {}, graph: { enabled: true } },
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    setConfigSource();
  });

  it("upsertNodesBulk inserts all nodes and they're queryable", () => {
    const store = createStore(join(tmpDir, "bulk-nodes.sqlite"));
    try {
      const nodes = Array.from({ length: 50 }, (_, i) => ({
        id: `e:${i}`,
        label: "E",
        properties: { idx: i, name: `entity-${i}` },
      }));

      store.graph.upsertNodesBulk(nodes);

      const rows = store.graph.cypher<{ c: number }>(
        cypher`MATCH (n:E) RETURN count(n) AS c`
      );
      expect(Number(rows[0]?.c)).toBe(50);
    } finally {
      store.close();
    }
  });

  it("upsertNodesBulk is idempotent (re-inserting same ids does not duplicate)", () => {
    const store = createStore(join(tmpDir, "bulk-idempotent.sqlite"));
    try {
      const nodes = Array.from({ length: 20 }, (_, i) => ({
        id: `e:${i}`,
        label: "E",
        properties: { idx: i },
      }));

      store.graph.upsertNodesBulk(nodes);
      store.graph.upsertNodesBulk(nodes);

      const rows = store.graph.cypher<{ c: number }>(
        cypher`MATCH (n:E) RETURN count(n) AS c`
      );
      expect(Number(rows[0]?.c)).toBe(20);
    } finally {
      store.close();
    }
  });

  it("upsertEdgesBulk requires endpoints to exist (or upsertNodes them first)", () => {
    const store = createStore(join(tmpDir, "bulk-edges.sqlite"));
    try {
      // Pre-create nodes
      const nodes = Array.from({ length: 10 }, (_, i) => ({
        id: `n:${i}`,
        label: "N",
        properties: {},
      }));
      store.graph.upsertNodesBulk(nodes);

      // Bulk create edges 0→1, 1→2, ..., 8→9
      const edges = Array.from({ length: 9 }, (_, i) => ({
        from: `n:${i}`,
        to: `n:${i + 1}`,
        type: "NEXT",
      }));
      store.graph.upsertEdgesBulk(edges);

      const rows = store.graph.cypher<{ c: number }>(
        cypher`MATCH ()-[r:NEXT]->() RETURN count(r) AS c`
      );
      expect(Number(rows[0]?.c)).toBe(9);
    } finally {
      store.close();
    }
  });

  it("bulk inserts roll back atomically on mid-batch error", () => {
    const store = createStore(join(tmpDir, "bulk-rollback.sqlite"));
    try {
      // Mix of valid + invalid (label fails the IDENT_RE check). The
      // SDK should reject the WHOLE batch — no partial commit.
      const nodes = [
        { id: "ok:1", label: "Good", properties: {} },
        { id: "ok:2", label: "Good", properties: {} },
        { id: "bad:1", label: "BAD-LABEL!", properties: {} }, // hyphen rejected
      ];

      expect(() => store.graph.upsertNodesBulk(nodes)).toThrow();

      const rows = store.graph.cypher<{ c: number }>(
        cypher`MATCH (n:Good) RETURN count(n) AS c`
      );
      // Atomicity: either all 3 land or none. Bad input → none.
      expect(Number(rows[0]?.c)).toBe(0);
    } finally {
      store.close();
    }
  });

  it("empty batches are no-ops", () => {
    const store = createStore(join(tmpDir, "bulk-empty.sqlite"));
    try {
      store.graph.upsertNodesBulk([]);
      store.graph.upsertEdgesBulk([]);
      const rows = store.graph.cypher<{ c: number }>(
        cypher`MATCH (n) RETURN count(n) AS c`
      );
      expect(Number(rows[0]?.c)).toBe(0);
    } finally {
      store.close();
    }
  });

  it("splits across multiple internal batches (BULK_*_BATCH boundary)", () => {
    const store = createStore(join(tmpDir, "bulk-split.sqlite"));
    try {
      // 250 nodes → 3 CREATE batches (100 + 100 + 50).
      const nodes = Array.from({ length: 250 }, (_, i) => ({
        id: `s:${i}`,
        label: "S",
        properties: { idx: i },
      }));
      store.graph.upsertNodesBulk(nodes);

      // 250 edges → 10 MERGE batches (BULK_MERGE_BATCH = 25).
      const edges = Array.from({ length: 250 }, (_, i) => ({
        from: `s:${i}`,
        to: `s:${(i + 1) % 250}`,
        type: "RING",
      }));
      store.graph.upsertEdgesBulk(edges);

      const nodeRows = store.graph.cypher<{ c: number }>(
        cypher`MATCH (n:S) RETURN count(n) AS c`
      );
      const edgeRows = store.graph.cypher<{ c: number }>(
        cypher`MATCH ()-[r:RING]->() RETURN count(r) AS c`
      );
      expect(Number(nodeRows[0]?.c)).toBe(250);
      expect(Number(edgeRows[0]?.c)).toBe(250);
    } finally {
      store.close();
    }
  });

  it("mixed new+existing nodes in one batch — existing get SET, new get CREATE", () => {
    const store = createStore(join(tmpDir, "bulk-mixed.sqlite"));
    try {
      // First batch: 5 nodes with title "v1"
      const first = Array.from({ length: 5 }, (_, i) => ({
        id: `m:${i}`,
        label: "M",
        properties: { title: "v1" },
      }));
      store.graph.upsertNodesBulk(first);

      // Second batch: same 5 ids with title "v2" + 5 new ids with title "v1"
      const second = [
        ...Array.from({ length: 5 }, (_, i) => ({
          id: `m:${i}`,
          label: "M",
          properties: { title: "v2" },
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          id: `m:${i + 5}`,
          label: "M",
          properties: { title: "v1" },
        })),
      ];
      store.graph.upsertNodesBulk(second);

      const rows = store.graph.cypher<{ id: string; title: string }>(
        cypher`MATCH (n:M) RETURN n.id AS id, n.title AS title`
      );
      expect(rows).toHaveLength(10);
      const byId = new Map(rows.map((r) => [r.id, r.title]));
      // Existing get the new value (SET +=).
      for (let i = 0; i < 5; i++) expect(byId.get(`m:${i}`)).toBe("v2");
      // New keep their first value.
      for (let i = 5; i < 10; i++) expect(byId.get(`m:${i}`)).toBe("v1");
    } finally {
      store.close();
    }
  });

  it("edges with mixed types in one batch", () => {
    const store = createStore(join(tmpDir, "bulk-mixed-types.sqlite"));
    try {
      const nodes = Array.from({ length: 6 }, (_, i) => ({
        id: `t:${i}`,
        label: "T",
        properties: {},
      }));
      store.graph.upsertNodesBulk(nodes);

      const edges = [
        { from: "t:0", to: "t:1", type: "LINKS_TO" },
        { from: "t:1", to: "t:2", type: "EMBEDS" },
        { from: "t:2", to: "t:3", type: "REFERENCES" },
        { from: "t:3", to: "t:4", type: "LINKS_TO" },
        { from: "t:4", to: "t:5", type: "EMBEDS" },
      ];
      store.graph.upsertEdgesBulk(edges);

      for (const t of ["LINKS_TO", "EMBEDS", "REFERENCES"]) {
        const expected = edges.filter((e) => e.type === t).length;
        const rows = store.graph.cypher<{ c: number }>(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          `MATCH ()-[r:${t}]->() RETURN count(r) AS c` as any
        );
        expect(Number(rows[0]?.c)).toBe(expected);
      }
    } finally {
      store.close();
    }
  });

  it("edges with inline properties", () => {
    const store = createStore(join(tmpDir, "bulk-edge-props.sqlite"));
    try {
      const nodes = Array.from({ length: 3 }, (_, i) => ({
        id: `p:${i}`,
        label: "P",
        properties: {},
      }));
      store.graph.upsertNodesBulk(nodes);

      const edges = [
        { from: "p:0", to: "p:1", type: "LINKED", properties: { weight: 1 } },
        { from: "p:1", to: "p:2", type: "LINKED", properties: { weight: 5 } },
      ];
      store.graph.upsertEdgesBulk(edges);

      const rows = store.graph.cypher<{ w: number }>(
        cypher`MATCH ()-[r:LINKED]->() RETURN r.weight AS w`
      );
      expect(rows.map((r) => Number(r.w)).sort((a, b) => a - b)).toEqual([1, 5]);
    } finally {
      store.close();
    }
  });
});
