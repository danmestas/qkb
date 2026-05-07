/**
 * Tests for `qkb graph <subcommand>` CLI logic — RFC-0007 §4.6.2.
 *
 * Tests at the logic-function level (fast); a small e2e smoke test exists
 * in test/cli.test.ts to confirm wiring through process boundary.
 *
 * Subcommands:
 *   - status: prints layer state, version, node/edge counts
 *   - query --params '{...}' "..."  — refuses without --params if $-vars present
 *   - pagerank --top N
 *   - gc --dry-run                  — sweep orphan chunk nodes
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { setConfigSource } from "../src/collections.js";
import {
  graphStatus,
  graphQuery,
  graphPageRank,
  graphGc,
} from "../src/graph/cli.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";

const HAS_REAL_BINARY =
  !!process.env.QKB_GRAPHQLITE_PATH ||
  existsSync(DEFAULT_BREW_PATH);

describe("graph CLI logic", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-cli-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    setConfigSource();
  });

  function dbPath(name = "test"): string {
    return join(tmpDir, `${name}.sqlite`);
  }

  describe("graph status (always-on)", () => {
    it("reports 'disabled' when graph.enabled=false", () => {
      setConfigSource({ config: { collections: {} } });
      const store = createStore(dbPath("status-disabled"));
      try {
        const r = graphStatus(store);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toMatch(/disabled|not enabled/i);
      } finally {
        store.close();
      }
    });

    it("reports 'unavailable' with reason when binary is missing", () => {
      const originalEnv = process.env.QKB_GRAPHQLITE_PATH;
      process.env.QKB_GRAPHQLITE_PATH = join(tmpDir, "nope.dylib");
      try {
        setConfigSource({
          config: { collections: {}, graph: { enabled: true } },
        });
        const store = createStore(dbPath("status-missing"));
        try {
          const r = graphStatus(store);
          expect(r.exitCode).toBe(0);
          expect(r.stdout).toMatch(/(unavailable|not found)/i);
        } finally {
          store.close();
        }
      } finally {
        if (originalEnv === undefined)
          delete process.env.QKB_GRAPHQLITE_PATH;
        else process.env.QKB_GRAPHQLITE_PATH = originalEnv;
      }
    });
  });

  describe("graph query (always-on guard)", () => {
    it("refuses queries with $-vars when --params not supplied", () => {
      setConfigSource({ config: { collections: {} } }); // doesn't matter — guard runs first
      const store = createStore(dbPath("query-no-params"));
      try {
        const r = graphQuery(
          store,
          "MATCH (n {id: $id}) RETURN n",
          undefined
        );
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toMatch(/--params/i);
        expect(r.stderr).toMatch(/\$id/);
      } finally {
        store.close();
      }
    });

    it("rejects malformed --params JSON", () => {
      const store = createStore(dbPath("query-bad-json"));
      try {
        const r = graphQuery(store, "RETURN 1", "{not-json}");
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toMatch(/json|parse/i);
      } finally {
        store.close();
      }
    });
  });

  describe.skipIf(!HAS_REAL_BINARY)(
    "graph subcommands with real binary",
    () => {
      function enabledStore(name: string) {
        setConfigSource({
          config: { collections: {}, graph: { enabled: true } },
        });
        return createStore(dbPath(name));
      }

      it("graph status reports node + edge counts when enabled", () => {
        const store = enabledStore("status-real");
        try {
          store.graph.upsertNode({
            id: "alice",
            label: "Person",
            properties: { name: "Alice" },
          });
          store.graph.upsertNode({
            id: "bob",
            label: "Person",
            properties: { name: "Bob" },
          });
          store.graph.upsertEdge({ from: "alice", to: "bob", type: "KNOWS" });

          const r = graphStatus(store);
          expect(r.exitCode).toBe(0);
          expect(r.stdout).toMatch(/nodes:\s*2/i);
          expect(r.stdout).toMatch(/edges:\s*1/i);
          expect(r.stdout).toMatch(/v?0\.4\.4|version/i);
        } finally {
          store.close();
        }
      });

      it("graph query runs a parameterized Cypher and prints rows as JSON", () => {
        const store = enabledStore("query-real");
        try {
          store.graph.upsertNode({
            id: "p:1",
            label: "Person",
            properties: { name: "alice" },
          });
          const r = graphQuery(
            store,
            "MATCH (p:Person {id: $id}) RETURN p.name AS name",
            JSON.stringify({ id: "p:1" })
          );
          expect(r.exitCode).toBe(0);
          const rows = JSON.parse(r.stdout) as Array<{ name: string }>;
          expect(rows[0]?.name).toBe("alice");
        } finally {
          store.close();
        }
      });

      it("graph pagerank prints top-N results", () => {
        const store = enabledStore("pr-real");
        try {
          for (const id of ["a", "b", "c"]) {
            store.graph.upsertNode({ id, label: "P", properties: {} });
          }
          store.graph.upsertEdge({ from: "a", to: "b", type: "L" });
          store.graph.upsertEdge({ from: "b", to: "c", type: "L" });
          store.graph.upsertEdge({ from: "c", to: "a", type: "L" });

          const r = graphPageRank(store, 5);
          expect(r.exitCode).toBe(0);
          // Pretty-printed table or JSON
          expect(r.stdout.length).toBeGreaterThan(0);
        } finally {
          store.close();
        }
      });

      it("graph gc --dry-run reports orphans without deleting", () => {
        const store = enabledStore("gc-dry");
        try {
          // Create chunk node with no matching content row
          store.graph.upsertNode({
            id: "chunk:dead:0",
            label: "Chunk",
            properties: { hash: "dead", seq: 0 },
          });

          const r = graphGc(store, true);
          expect(r.exitCode).toBe(0);
          expect(r.stdout).toMatch(/dry-run/i);
          expect(r.stdout).toMatch(/1 orphan|orphans:\s*1/i);

          // Verify NOT deleted
          const stillThere = store.graph.cypher<{ id: string }>(
            // eslint-disable-next-line no-template-curly-in-string
            ((s: TemplateStringsArray, ..._v: unknown[]) =>
              s.raw[0])`MATCH (c:Chunk {id: $id}) RETURN c.id AS id` as never,
            { id: "chunk:dead:0" }
          );
          expect(stillThere.length).toBe(1);
        } finally {
          store.close();
        }
      });

      it("graph gc actually deletes orphans without --dry-run", () => {
        const store = enabledStore("gc-real");
        try {
          store.graph.upsertNode({
            id: "chunk:dead2:0",
            label: "Chunk",
            properties: { hash: "dead2", seq: 0 },
          });

          const r = graphGc(store, false);
          expect(r.exitCode).toBe(0);
          expect(r.stdout).toMatch(/removed|deleted/i);
        } finally {
          store.close();
        }
      });
    }
  );
});
