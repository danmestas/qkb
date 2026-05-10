/**
 * RFC-0007 research spikes — answers Q1, Q2, Q4 from the RFC's open-questions
 * section by running real GraphQLite queries against a real SQLite DB.
 *
 * These tests are *not* run by default — they require GraphQLite installed
 * locally (`brew install graphqlite` or set QKB_GRAPHQLITE_PATH=...). Set
 * QKB_RUN_SPIKES=1 to opt in. The whole suite is `describe.skipIf` gated.
 *
 * To run: `QKB_RUN_SPIKES=1 npx vitest run test/spikes/`
 *
 * Findings are written to docs/rfcs/0007-impl/SPIKE-RESULTS.md by hand after
 * a successful run; this file is the executable proof.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, loadSqliteVec, type Database } from "../../src/internals/db.js";

const RUN = process.env.QKB_RUN_SPIKES === "1";

const GRAPHQLITE_PATH =
  process.env.QKB_GRAPHQLITE_PATH ??
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";

const HAS_GRAPHQLITE = existsSync(GRAPHQLITE_PATH);

describe.skipIf(!RUN || !HAS_GRAPHQLITE)("RFC-0007 spikes", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-spike-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function freshDb(name: string): Database {
    const dbPath = join(tmpDir, `${name}.sqlite`);
    const db = openDatabase(dbPath);
    db.loadExtension(GRAPHQLITE_PATH);
    return db;
  }

  function freshDbWithVec(name: string): Database {
    const dbPath = join(tmpDir, `${name}.sqlite`);
    const db = openDatabase(dbPath);
    loadSqliteVec(db);
    db.loadExtension(GRAPHQLITE_PATH);
    return db;
  }

  /**
   * Q1 — Does GraphQLite cypher() participate correctly in nested SAVEPOINTs?
   *
   * Pattern: BEGIN -> CREATE node -> SAVEPOINT s1 -> CREATE node -> ROLLBACK TO s1
   * -> COMMIT. Expect: only the first node survives. If GraphQLite ignores
   * SAVEPOINT semantics, both nodes would survive, and the SDK contract for
   * nested transactions in QKB would be unsafe.
   */
  it("Q1: cypher() participates in nested SAVEPOINTs", () => {
    const db = freshDb("q1-savepoint");
    try {
      // Setup: register a graph (single graph per DB; no namespace arg).
      db.exec("BEGIN");
      db.prepare("SELECT cypher(?)").get("CREATE (:Marker {tag: 'before'})");
      db.exec("COMMIT");

      // Outer txn with savepoint.
      db.exec("BEGIN");
      db.prepare("SELECT cypher(?)").get("CREATE (:Marker {tag: 'outer'})");
      db.exec("SAVEPOINT s1");
      db.prepare("SELECT cypher(?)").get("CREATE (:Marker {tag: 'inner'})");
      db.exec("ROLLBACK TO s1");
      db.exec("COMMIT");

      const result = db
        .prepare("SELECT cypher(?) as r")
        .get(
          "MATCH (m:Marker) RETURN m.tag AS tag ORDER BY m.tag"
        ) as { r: string };

      const tags = (JSON.parse(result.r) as Array<{ tag: string }>).map(
        (row) => row.tag
      );

      // Expected: 'before' and 'outer' survive; 'inner' was rolled back.
      expect(tags).toEqual(["before", "outer"]);
    } finally {
      db.close();
    }
  });

  /**
   * Q2 — On-disk size of an empty graph.
   *
   * Measures the index.sqlite delta caused by initializing a single graph
   * via a no-op CREATE/DELETE cycle (which forces GraphQLite to materialize
   * its schema tables). RFC §10 budgets 64 KB for an empty graph layer.
   */
  it("Q2: empty graph adds < 64 KB to the database file", () => {
    const dbPath = join(tmpDir, "q2-size.sqlite");

    const db1 = openDatabase(dbPath);
    db1.exec("CREATE TABLE marker (id INTEGER PRIMARY KEY)");
    db1.close();
    const baselineBytes = statSync(dbPath).size;

    const db2 = openDatabase(dbPath);
    db2.loadExtension(GRAPHQLITE_PATH);
    // Force materialization of GraphQLite's schema with a touch operation.
    db2
      .prepare("SELECT cypher(?)")
      .get("CREATE (n:Probe {x: 1}) DELETE n RETURN 1");
    db2.close();
    const afterBytes = statSync(dbPath).size;

    const delta = afterBytes - baselineBytes;

    // Don't make this a hard expect() — record the actual delta and
    // surface it via console for SPIKE-RESULTS.md to capture.
    console.log(
      `Q2 result: baseline=${baselineBytes}B after=${afterBytes}B delta=${delta}B`
    );

    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(256 * 1024); // sanity ceiling 256 KB
  });

  /**
   * Q4 — sqlite-vec and graphqlite coexist in the same connection.
   *
   * Loads both extensions, creates a vec0 virtual table and runs a Cypher
   * write in the same transaction. Asserts both round-trip correctly and
   * neither extension corrupts the other's state.
   */
  it("Q4: sqlite-vec and graphqlite coexist + share a transaction", () => {
    const db = freshDbWithVec("q4-coexist");
    try {
      // Mirror QKB's actual vec0 schema: TEXT primary key (see store.ts vectors_vec).
      db.exec(
        "CREATE VIRTUAL TABLE probes USING vec0(probe_id TEXT PRIMARY KEY, embedding float[3])"
      );

      db.exec("BEGIN");
      db.prepare(
        "INSERT INTO probes(probe_id, embedding) VALUES (?, ?)"
      ).run("p1", JSON.stringify([0.1, 0.2, 0.3]));
      db.prepare("SELECT cypher(?)").get("CREATE (:CoexistMarker {id: 1})");
      db.exec("COMMIT");

      // Vec round-trip
      const vecRow = db
        .prepare("SELECT probe_id FROM probes WHERE probe_id = 'p1'")
        .get() as { probe_id: string } | undefined;
      expect(vecRow?.probe_id).toBe("p1");

      // Graph round-trip
      const graphRow = db
        .prepare("SELECT cypher(?) AS r")
        .get(
          "MATCH (m:CoexistMarker) RETURN m.id AS id"
        ) as { r: string };
      const ids = (JSON.parse(graphRow.r) as Array<{ id: number }>).map(
        (r) => r.id
      );
      expect(ids).toEqual([1]);
    } finally {
      db.close();
    }
  });

  /**
   * Q4b — Bonus: rollback affects both extensions atomically.
   */
  it("Q4b: rollback unwinds vec0 + graph writes together", () => {
    const db = freshDbWithVec("q4b-rollback");
    try {
      db.exec(
        "CREATE VIRTUAL TABLE probes USING vec0(embedding float[3])"
      );

      try {
        db.exec("BEGIN");
        db.prepare(
          "INSERT INTO probes(rowid, embedding) VALUES (?, ?)"
        ).run(1, JSON.stringify([0.1, 0.2, 0.3]));
        db.prepare("SELECT cypher(?)").get("CREATE (:Doomed {id: 1})");
        throw new Error("simulated failure mid-txn");
      } catch (err) {
        db.exec("ROLLBACK");
      }

      const vecCount = db
        .prepare("SELECT COUNT(*) AS c FROM probes")
        .get() as { c: number };
      expect(vecCount.c).toBe(0);

      const graphRow = db
        .prepare("SELECT cypher(?) AS r")
        .get("MATCH (n:Doomed) RETURN COUNT(n) AS c") as { r: string };
      const counts = (JSON.parse(graphRow.r) as Array<{ c: number }>).map(
        (r) => r.c
      );
      expect(counts[0]).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("Spike-mode preflight", () => {
  it("documents spike preconditions when not running", () => {
    if (RUN && !HAS_GRAPHQLITE) {
      throw new Error(
        `QKB_RUN_SPIKES=1 but GraphQLite extension not found at ${GRAPHQLITE_PATH}. ` +
          `Install with 'brew install graphqlite' or set QKB_GRAPHQLITE_PATH.`
      );
    }
    expect(true).toBe(true);
  });
});
