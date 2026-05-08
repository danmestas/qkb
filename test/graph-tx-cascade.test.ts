/**
 * Tests for cross-extension transactions + cascade-on-delete — RFC-0007 §4.4.
 *
 * Validates that:
 *   1. A transaction spanning content + content_vectors + graph all rolls
 *      back atomically on error.
 *   2. A transaction spanning all three commits atomically on success.
 *   3. The `cleanupOrphanedChunkNodes` helper removes `chunk:*` nodes
 *      whose hash no longer exists in `content`.
 *
 * All tests gated on a real GraphQLite binary (skipIf no env var and no
 * brew default).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, cleanupOrphanedChunkNodes } from "../src/store.js";
import { setConfigSource } from "../src/collections.js";
import { cypher } from "../src/graph/sdk.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";

const HAS_REAL_BINARY =
  !!process.env.QKB_GRAPHQLITE_PATH ||
  existsSync(DEFAULT_BREW_PATH);

describe.skipIf(!HAS_REAL_BINARY)("cross-extension tx + cascade", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-tx-"));
    setConfigSource({
      config: { collections: {}, graph: { enabled: true } },
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    setConfigSource();
  });

  function dbPath(name = "test"): string {
    return join(tmpDir, `${name}.sqlite`);
  }

  it("commits content + content_vectors + graph node atomically", () => {
    const store = createStore(dbPath("commit"));
    try {
      store.ensureVecTable(3);

      const hash = "abc123";
      const seq = 0;

      store.db.exec("BEGIN");
      store.db
        .prepare(
          "INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)"
        )
        .run(hash, "hello world", new Date().toISOString());
      store.db
        .prepare(
          "INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, 0, 'test', ?)"
        )
        .run(hash, seq, new Date().toISOString());
      store.graph.upsertNode({
        id: `chunk:${hash}:${seq}`,
        label: "Chunk",
        properties: { hash, seq },
      });
      store.db.exec("COMMIT");

      const contentRow = store.db
        .prepare("SELECT hash FROM content WHERE hash = ?")
        .get(hash);
      expect(contentRow).toBeDefined();

      const cvRow = store.db
        .prepare(
          "SELECT hash FROM content_vectors WHERE hash = ? AND seq = ?"
        )
        .get(hash, seq);
      expect(cvRow).toBeDefined();

      const graphRows = store.graph.cypher<{ id: string }>(
        cypher`MATCH (c:Chunk {id: $id}) RETURN c.id AS id`,
        { id: `chunk:${hash}:${seq}` }
      );
      expect(graphRows.length).toBe(1);
    } finally {
      store.close();
    }
  });

  it("rolls back content + content_vectors + graph node atomically", () => {
    const store = createStore(dbPath("rollback"));
    try {
      store.ensureVecTable(3);

      const hash = "rollback-hash";
      const seq = 0;

      try {
        store.db.exec("BEGIN");
        store.db
          .prepare(
            "INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)"
          )
          .run(hash, "doomed", new Date().toISOString());
        store.db
          .prepare(
            "INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, 0, 'test', ?)"
          )
          .run(hash, seq, new Date().toISOString());
        store.graph.upsertNode({
          id: `chunk:${hash}:${seq}`,
          label: "Chunk",
          properties: { hash, seq },
        });
        throw new Error("simulated mid-transaction failure");
      } catch {
        store.db.exec("ROLLBACK");
      }

      // None of the three writes survived. SQLite drivers differ on the
      // sentinel they return for "no row": better-sqlite3 returns
      // `undefined`, bun:sqlite returns `null`. `toBeFalsy()` accepts both.
      const contentRow = store.db
        .prepare("SELECT hash FROM content WHERE hash = ?")
        .get(hash);
      expect(contentRow).toBeFalsy();

      const cvRow = store.db
        .prepare(
          "SELECT hash FROM content_vectors WHERE hash = ? AND seq = ?"
        )
        .get(hash, seq);
      expect(cvRow).toBeFalsy();

      const graphRows = store.graph.cypher<{ id: string }>(
        cypher`MATCH (c:Chunk {id: $id}) RETURN c.id AS id`,
        { id: `chunk:${hash}:${seq}` }
      );
      expect(graphRows.length).toBe(0);
    } finally {
      store.close();
    }
  });

  it("cleanupOrphanedChunkNodes removes chunks whose hash is gone from content", () => {
    const store = createStore(dbPath("cleanup"));
    try {
      // Two chunk nodes; only one has corresponding content
      store.db
        .prepare(
          "INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)"
        )
        .run("alive-hash", "hello", new Date().toISOString());

      store.graph.upsertNode({
        id: "chunk:alive-hash:0",
        label: "Chunk",
        properties: { hash: "alive-hash", seq: 0 },
      });
      store.graph.upsertNode({
        id: "chunk:dead-hash:0",
        label: "Chunk",
        properties: { hash: "dead-hash", seq: 0 },
      });
      // Sanity: also a non-chunk node, must NOT be touched
      store.graph.upsertNode({
        id: "entity:person:alice",
        label: "Person",
        properties: { name: "Alice" },
      });

      const removed = cleanupOrphanedChunkNodes(store.db);
      expect(removed).toBe(1);

      // alive-hash chunk still there
      const alive = store.graph.cypher<{ id: string }>(
        cypher`MATCH (c:Chunk {id: $id}) RETURN c.id AS id`,
        { id: "chunk:alive-hash:0" }
      );
      expect(alive.length).toBe(1);

      // dead-hash chunk gone
      const dead = store.graph.cypher<{ id: string }>(
        cypher`MATCH (c:Chunk {id: $id}) RETURN c.id AS id`,
        { id: "chunk:dead-hash:0" }
      );
      expect(dead.length).toBe(0);

      // Entity untouched
      const entity = store.graph.cypher<{ id: string }>(
        cypher`MATCH (e:Person {id: $id}) RETURN e.id AS id`,
        { id: "entity:person:alice" }
      );
      expect(entity.length).toBe(1);
    } finally {
      store.close();
    }
  });

  it("cleanupOrphanedChunkNodes returns 0 when nothing to clean", () => {
    const store = createStore(dbPath("nothing"));
    try {
      const removed = cleanupOrphanedChunkNodes(store.db);
      expect(removed).toBe(0);
    } finally {
      store.close();
    }
  });
});
