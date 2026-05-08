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
import { createStore, reciprocalRankFusion } from "../src/store.js";
import { setConfigSource } from "../src/collections.js";
import { cypher } from "../src/graph/sdk.js";
import {
  runFilterThenRank,
  runRankThenRerank,
  runEdgeWeightedRank,
  mergeFusedWithGraphExpansion,
  DEFAULT_EDGE_WEIGHTS,
  type RankedDoc,
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

  describe("runEdgeWeightedRank (RFC-0008 #2)", () => {
    /**
     * Build a tiny vault-style corpus: 4 docs, with LINKS_TO + EMBEDS +
     * REFERENCES edges. Documents table seeded so SQL resolution works.
     */
    function setupVaultCorpus(store: ReturnType<typeof createStore>) {
      // Insert content + documents rows so the SQL resolution path
      // (file URL → docId, docId → file URL + body) succeeds.
      const now = new Date().toISOString();
      const insertContent = store.db.prepare(
        "INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)"
      );
      const insertDoc = store.db.prepare(
        "INSERT INTO documents (id, collection, path, title, hash, active, created_at, modified_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
      );
      const docs = [
        { id: 1, hash: "h1", title: "Alpha", body: "alpha body" },
        { id: 2, hash: "h2", title: "Beta", body: "beta body" },
        { id: 3, hash: "h3", title: "Gamma", body: "gamma body" },
        { id: 4, hash: "h4", title: "Delta", body: "delta body" },
      ];
      for (const d of docs) {
        insertContent.run(d.hash, d.body, now);
        insertDoc.run(
          d.id,
          "test",
          `${d.title.toLowerCase()}.md`,
          d.title,
          d.hash,
          now,
          now
        );
        store.graph.upsertNode({
          id: `doc:${d.id}`,
          label: "Note",
          properties: { title: d.title },
        });
      }
      // Edges: 1 →(EMBEDS) 2, 1 →(LINKS_TO) 3, 1 →(REFERENCES) 4, 2 →(LINKS_TO) 4
      store.graph.upsertEdge({ from: "doc:1", to: "doc:2", type: "EMBEDS" });
      store.graph.upsertEdge({ from: "doc:1", to: "doc:3", type: "LINKS_TO" });
      store.graph.upsertEdge({ from: "doc:1", to: "doc:4", type: "REFERENCES" });
      store.graph.upsertEdge({ from: "doc:2", to: "doc:4", type: "LINKS_TO" });
    }

    it("expands seeds via 1-hop edges with default weights", () => {
      const store = createStore(join(tmpDir, "ewr-default.sqlite"));
      try {
        setupVaultCorpus(store);
        const r = runEdgeWeightedRank(store, {
          seeds: [{ file: "qkb://test/alpha.md", score: 1.0 }],
        });
        // Doc 1 is the seed; expansion should reach docs 2, 3, 4.
        const files = r.expanded.map((e) => e.file).sort();
        expect(files).toEqual([
          "qkb://test/beta.md",
          "qkb://test/delta.md",
          "qkb://test/gamma.md",
        ]);
        // EMBEDS (0.9) → Beta should outrank LINKS_TO (0.4) → Gamma which
        // outranks REFERENCES (0.2) → Delta.
        const byTitle = new Map(r.expanded.map((e) => [e.title, e.score]));
        expect(byTitle.get("Beta")!).toBeGreaterThan(byTitle.get("Gamma")!);
        expect(byTitle.get("Gamma")!).toBeGreaterThan(byTitle.get("Delta")!);
      } finally {
        store.close();
      }
    });

    it("filters out edge types not in weight map", () => {
      const store = createStore(join(tmpDir, "ewr-filter.sqlite"));
      try {
        setupVaultCorpus(store);
        // Only LINKS_TO; EMBEDS and REFERENCES are dropped.
        const r = runEdgeWeightedRank(store, {
          seeds: [{ file: "qkb://test/alpha.md", score: 1.0 }],
          weights: { LINKS_TO: 1.0 },
        });
        const files = r.expanded.map((e) => e.file).sort();
        // Only doc 3 (LINKS_TO from doc 1).
        expect(files).toEqual(["qkb://test/gamma.md"]);
      } finally {
        store.close();
      }
    });

    it("treats weight=0 same as omitted (filters out)", () => {
      const store = createStore(join(tmpDir, "ewr-zero.sqlite"));
      try {
        setupVaultCorpus(store);
        const r = runEdgeWeightedRank(store, {
          seeds: [{ file: "qkb://test/alpha.md", score: 1.0 }],
          weights: { EMBEDS: 0.9, LINKS_TO: 0, REFERENCES: 0 },
        });
        // Only EMBEDS edge survives → only Beta.
        const files = r.expanded.map((e) => e.file);
        expect(files).toEqual(["qkb://test/beta.md"]);
      } finally {
        store.close();
      }
    });

    it("excludes seeds from the expansion (no self-loops)", () => {
      const store = createStore(join(tmpDir, "ewr-self.sqlite"));
      try {
        setupVaultCorpus(store);
        // Use docs 1 AND 2 as seeds. Doc 2 is reachable from doc 1 via
        // EMBEDS but should NOT appear in expansion (already a seed).
        const r = runEdgeWeightedRank(store, {
          seeds: [
            { file: "qkb://test/alpha.md", score: 1.0 },
            { file: "qkb://test/beta.md", score: 0.9 },
          ],
        });
        const files = r.expanded.map((e) => e.file);
        expect(files).not.toContain("qkb://test/alpha.md");
        expect(files).not.toContain("qkb://test/beta.md");
      } finally {
        store.close();
      }
    });

    it("respects expansionLimit", () => {
      const store = createStore(join(tmpDir, "ewr-limit.sqlite"));
      try {
        setupVaultCorpus(store);
        const r = runEdgeWeightedRank(store, {
          seeds: [{ file: "qkb://test/alpha.md", score: 1.0 }],
          expansionLimit: 2,
        });
        expect(r.expanded.length).toBe(2);
        // Top 2 by weight should be EMBEDS:Beta and LINKS_TO:Gamma.
        const titles = r.expanded.map((e) => e.title);
        expect(titles).toEqual(["Beta", "Gamma"]);
      } finally {
        store.close();
      }
    });

    it("returns empty expansion on empty seeds", () => {
      const store = createStore(join(tmpDir, "ewr-empty.sqlite"));
      try {
        setupVaultCorpus(store);
        const r = runEdgeWeightedRank(store, { seeds: [] });
        expect(r.expanded).toEqual([]);
      } finally {
        store.close();
      }
    });

    it("returns empty expansion when seeds resolve to no doc rows", () => {
      const store = createStore(join(tmpDir, "ewr-noresolve.sqlite"));
      try {
        setupVaultCorpus(store);
        const r = runEdgeWeightedRank(store, {
          seeds: [{ file: "qkb://test/nonexistent.md", score: 1.0 }],
        });
        expect(r.expanded).toEqual([]);
      } finally {
        store.close();
      }
    });

    it("strips ?index= suffix from seed URLs", () => {
      const store = createStore(join(tmpDir, "ewr-suffix.sqlite"));
      try {
        setupVaultCorpus(store);
        const r = runEdgeWeightedRank(store, {
          seeds: [
            { file: "qkb://test/alpha.md?index=foo", score: 1.0 },
          ],
        });
        // Should still resolve and expand normally.
        expect(r.expanded.length).toBeGreaterThan(0);
      } finally {
        store.close();
      }
    });

    it("rejects malformed edge type names", () => {
      const store = createStore(join(tmpDir, "ewr-badtype.sqlite"));
      try {
        setupVaultCorpus(store);
        expect(() =>
          runEdgeWeightedRank(store, {
            seeds: [{ file: "qkb://test/alpha.md", score: 1.0 }],
            weights: { "BAD-TYPE": 0.5 },
          })
        ).toThrow(/invalid edge type/i);
      } finally {
        store.close();
      }
    });

    it("DEFAULT_EDGE_WEIGHTS is frozen and has expected keys", () => {
      expect(DEFAULT_EDGE_WEIGHTS.EMBEDS).toBeGreaterThan(
        DEFAULT_EDGE_WEIGHTS.LINKS_TO!
      );
      expect(DEFAULT_EDGE_WEIGHTS.LINKS_TO).toBeGreaterThan(
        DEFAULT_EDGE_WEIGHTS.REFERENCES!
      );
      expect(Object.isFrozen(DEFAULT_EDGE_WEIGHTS)).toBe(true);
    });
  });
});

/**
 * Tests for `mergeFusedWithGraphExpansion` — the fix for the
 * "graph candidates appended then sliced out" bug. These tests don't
 * need the GraphQLite binary (pure RRF logic over synthetic lists),
 * so they run on every CI matrix entry, not just macOS.
 */
describe("mergeFusedWithGraphExpansion", () => {
  function mkDoc(file: string, score = 0): RankedDoc {
    return { file, displayPath: file, title: file, body: "", score };
  }

  it("returns sliced fused list unchanged when expansion is empty", () => {
    const fused = Array.from({ length: 50 }, (_, i) => mkDoc(`/f${i}`));
    const result = mergeFusedWithGraphExpansion(
      fused,
      [],
      40,
      reciprocalRankFusion
    );
    expect(result).toHaveLength(40);
    expect(result[0]?.file).toBe("/f0");
    expect(result[39]?.file).toBe("/f39");
  });

  it("PROMOTES novel graph candidates above tail of saturated fused list (bug fix)", () => {
    // Reproduce the exact bug: fused has 50 items (saturating the
    // candidateLimit=40 pool), graph adds 5 novel docs. Pre-fix: novel
    // docs got appended after fused and sliced out at index 40+. Now:
    // they should appear in the result via RRF blend.
    const fused = Array.from({ length: 50 }, (_, i) => mkDoc(`/f${i}`));
    const expansion = Array.from({ length: 5 }, (_, i) => mkDoc(`/g${i}`));

    const result = mergeFusedWithGraphExpansion(
      fused,
      expansion,
      40,
      reciprocalRankFusion
    );
    expect(result).toHaveLength(40);

    const files = result.map((r) => r.file);
    // At least the top graph result MUST appear in the rerank pool now.
    expect(files).toContain("/g0");
    // It should outrank a tail-of-fused item — `/f49` (would be sliced
    // at index 40 anyway in the pre-fix code, but post-fix `/g0` should
    // appear ahead of e.g. `/f30`).
    const g0Idx = files.indexOf("/g0");
    const tailFusedIdx = files.indexOf("/f30");
    expect(g0Idx).toBeGreaterThanOrEqual(0);
    if (tailFusedIdx >= 0) {
      // Both present; graph rank-1 should beat or tie fused rank-30.
      expect(g0Idx).toBeLessThanOrEqual(tailFusedIdx);
    }
  });

  it("preserves the head of fused (graph doesn't displace strong lexical hits)", () => {
    // Fused #1-3 are strong matches; graph has 3 novel candidates.
    // Top 3 of fused should still win.
    const fused = Array.from({ length: 50 }, (_, i) => mkDoc(`/f${i}`));
    const expansion = [
      mkDoc("/gA"),
      mkDoc("/gB"),
      mkDoc("/gC"),
    ];

    const result = mergeFusedWithGraphExpansion(
      fused,
      expansion,
      40,
      reciprocalRankFusion
    );
    // Top 3 by RRF should be docs that are #1 in fused or #1 in graph.
    // /f0 has fused-rank-1 + topRank bonus. /gA has graph-rank-1 + topRank
    // bonus. They tie or fused wins; either way, /f0 must be in top 3
    // and reasonable lexical heads must dominate.
    const top3 = result.slice(0, 3).map((r) => r.file);
    expect(top3).toContain("/f0");
  });

  it("graph candidate present in BOTH lists scores highest (additive RRF)", () => {
    // /shared is at rank 5 in fused AND rank 0 in graph. Its RRF score
    // should beat /f0 (rank 0 in fused only) on weighted contribution
    // because the bonus + graph contribution stack.
    const fused = [
      mkDoc("/f0"),
      mkDoc("/f1"),
      mkDoc("/f2"),
      mkDoc("/f3"),
      mkDoc("/f4"),
      mkDoc("/shared"),
      ...Array.from({ length: 44 }, (_, i) => mkDoc(`/f${i + 6}`)),
    ];
    const expansion = [
      mkDoc("/shared"),
      mkDoc("/gA"),
      mkDoc("/gB"),
    ];

    const result = mergeFusedWithGraphExpansion(
      fused,
      expansion,
      10,
      reciprocalRankFusion
    );
    const sharedIdx = result.findIndex((r) => r.file === "/shared");
    const f4Idx = result.findIndex((r) => r.file === "/f4");
    expect(sharedIdx).toBeGreaterThanOrEqual(0);
    // /shared has fused-rank-5 + graph-rank-0 contributions; should
    // outrank /f4 (only fused-rank-4).
    expect(sharedIdx).toBeLessThan(f4Idx);
  });

  it("respects candidateLimit", () => {
    const fused = Array.from({ length: 100 }, (_, i) => mkDoc(`/f${i}`));
    const expansion = Array.from({ length: 30 }, (_, i) => mkDoc(`/g${i}`));
    const result = mergeFusedWithGraphExpansion(
      fused,
      expansion,
      25,
      reciprocalRankFusion
    );
    expect(result).toHaveLength(25);
  });

  it("returns empty when both inputs are empty", () => {
    const result = mergeFusedWithGraphExpansion([], [], 40, reciprocalRankFusion);
    expect(result).toEqual([]);
  });

  it("handles fused-only (no expansion) without invoking RRF", () => {
    const fused = [mkDoc("/a"), mkDoc("/b")];
    const result = mergeFusedWithGraphExpansion(
      fused,
      [],
      40,
      // RRF function should NOT be invoked when expansion is empty.
      // Throw if called, and the test passes only if the early-return
      // branch handles it.
      () => {
        throw new Error("RRF should not be called for empty expansion");
      }
    );
    expect(result.map((r) => r.file)).toEqual(["/a", "/b"]);
  });
});
