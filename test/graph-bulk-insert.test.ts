/**
 * Tests for the SDK bulk-insert path — RFC-0007 §4.4 (Phase 2A).
 *
 * `store.graph.upsertNodesBulk` / `upsertEdgesBulk` wrap the per-call
 * upsertNode/upsertEdge inside a single SQLite transaction. This
 * amortizes per-statement fsync cost across the batch and is the path
 * the indexing pipeline (PR-17) uses for entity extraction at ingest
 * time.
 *
 * Note: GraphQLite v0.4.4 has a documented "bulk insert API" that
 * bypasses Cypher parsing entirely. We don't use it directly because
 * (a) it requires the binary's specific C-API which isn't exposed via
 * the SQL extension surface, and (b) wrapping the existing upsert in
 * a transaction already eliminates the dominant overhead. Revisit if
 * Phase 2 perf shows the per-node Cypher parse to be the bottleneck.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { setConfigSource } from "../src/collections.js";
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
});
