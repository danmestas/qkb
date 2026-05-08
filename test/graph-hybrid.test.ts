/**
 * Tests for hybrid query strategies — RFC-0007 §5 (Phase 2B).
 *
 * `filterThenRank`: Cypher → (hash, seq) candidates → caller scores.
 * `rankThenRerank`: existing seeds + graph-neighbor expansion → RRF.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { setConfigSource } from "../src/collections.js";
import { cypher } from "../src/graph/sdk.js";
import {
  runFilterThenRank,
  runRankThenRerank,
} from "../src/graph/hybrid.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";
const HAS_REAL_BINARY =
  !!process.env.QKB_GRAPHQLITE_PATH ||
  existsSync(DEFAULT_BREW_PATH);

describe.skipIf(!HAS_REAL_BINARY)("hybrid query strategies", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-hybrid-"));
    setConfigSource({
      config: { collections: {}, graph: { enabled: true } },
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    setConfigSource();
  });

  function setupCorpus(store: ReturnType<typeof createStore>) {
    // Three "chunks" tied to three content hashes
    const chunks = [
      { hash: "ha", seq: 0 },
      { hash: "hb", seq: 0 },
      { hash: "hc", seq: 0 },
    ];
    for (const { hash, seq } of chunks) {
      store.graph.upsertNode({
        id: `chunk:${hash}:${seq}`,
        label: "Chunk",
        properties: { hash, seq },
      });
    }
    // One entity, mentioned by chunks A and C (not B)
    store.graph.upsertNode({
      id: "entity:topic:graphs",
      label: "Topic",
      properties: { name: "graphs" },
    });
    store.graph.upsertEdge({
      from: "chunk:ha:0",
      to: "entity:topic:graphs",
      type: "MENTIONS",
    });
    store.graph.upsertEdge({
      from: "chunk:hc:0",
      to: "entity:topic:graphs",
      type: "MENTIONS",
    });
  }

  describe("filterThenRank", () => {
    it("returns chunk (hash, seq) candidates from Cypher", () => {
      const store = createStore(join(tmpDir, "ftr.sqlite"));
      try {
        setupCorpus(store);

        // Use MATCH+WHERE rather than inline $param in the pattern —
        // $params inside inline property maps are broken in
        // GraphQLite v0.4.4 (see test/spikes/probe-merge-syntax.ts).
        const result = runFilterThenRank(store, {
          cypher: cypher`MATCH (c:Chunk)-[:MENTIONS]->(t:Topic)
                         WHERE t.name = $topic
                         RETURN c.hash AS hash, c.seq AS seq`,
          params: { topic: "graphs" },
        });

        expect(result.candidates).toHaveLength(2);
        const hashes = result.candidates.map((c) => c.hash).sort();
        expect(hashes).toEqual(["ha", "hc"]);
      } finally {
        store.close();
      }
    });

    it("returns empty when Cypher matches nothing", () => {
      const store = createStore(join(tmpDir, "ftr-empty.sqlite"));
      try {
        const result = runFilterThenRank(store, {
          cypher: cypher`MATCH (c:NoSuchLabel) RETURN c.hash AS hash, c.seq AS seq`,
        });
        expect(result.candidates).toEqual([]);
      } finally {
        store.close();
      }
    });

    it("applies candidateLimit", () => {
      const store = createStore(join(tmpDir, "ftr-limit.sqlite"));
      try {
        // Ten chunks, all matched by query
        for (let i = 0; i < 10; i++) {
          store.graph.upsertNode({
            id: `chunk:h${i}:0`,
            label: "Chunk",
            properties: { hash: `h${i}`, seq: 0 },
          });
        }
        const result = runFilterThenRank(store, {
          cypher: cypher`MATCH (c:Chunk) RETURN c.hash AS hash, c.seq AS seq`,
          candidateLimit: 3,
        });
        expect(result.candidates).toHaveLength(3);
      } finally {
        store.close();
      }
    });
  });

  describe("rankThenRerank", () => {
    it("blends seed ranks with graph-neighbor frequency via RRF", () => {
      const store = createStore(join(tmpDir, "rr.sqlite"));
      try {
        setupCorpus(store);
        // Add chunk hd connected to ha by SIMILAR_TO so the expansion
        // will surface hd from seed=ha.
        store.graph.upsertNode({
          id: "chunk:hd:0",
          label: "Chunk",
          properties: { hash: "hd", seq: 0 },
        });
        store.graph.upsertEdge({
          from: "chunk:ha:0",
          to: "chunk:hd:0",
          type: "SIMILAR_TO",
        });

        const result = runRankThenRerank(store, {
          seeds: [
            { hash: "ha", seq: 0, score: 0.9 },
            { hash: "hb", seq: 0, score: 0.7 },
          ],
          hops: 1,
        });

        // ha + hb are seeds (in list A); hd shows up in list B (from ha
        // expansion). All 3 should appear in the fused list.
        const keys = result.ranked.map((r) => `${r.hash}:${r.seq}`).sort();
        expect(keys).toContain("ha:0");
        expect(keys).toContain("hb:0");
        expect(keys).toContain("hd:0");
      } finally {
        store.close();
      }
    });

    it("handles seeds with no corresponding graph node gracefully", () => {
      const store = createStore(join(tmpDir, "rr-orphan.sqlite"));
      try {
        const result = runRankThenRerank(store, {
          seeds: [
            { hash: "orphan", seq: 0, score: 1.0 },
          ],
          hops: 1,
        });
        // Orphan still appears in list A → fused list contains it.
        expect(result.ranked).toHaveLength(1);
        expect(result.ranked[0]?.hash).toBe("orphan");
      } finally {
        store.close();
      }
    });

    it("rejects invalid edge_types at the validator boundary", () => {
      const store = createStore(join(tmpDir, "rr-bad-edges.sqlite"));
      try {
        expect(() =>
          runRankThenRerank(store, {
            seeds: [{ hash: "x", seq: 0, score: 1 }],
            hops: 1,
            edgeTypes: ["bad-type!"],
          })
        ).toThrow(/invalid edge type/i);
      } finally {
        store.close();
      }
    });

    it("clamps hops to [1, 3]", () => {
      const store = createStore(join(tmpDir, "rr-clamp.sqlite"));
      try {
        setupCorpus(store);
        // hops=99 should be clamped to 3 (no error, no infinite traversal).
        const result = runRankThenRerank(store, {
          seeds: [{ hash: "ha", seq: 0, score: 0.5 }],
          hops: 99,
        });
        expect(Array.isArray(result.ranked)).toBe(true);
      } finally {
        store.close();
      }
    });
  });
});
