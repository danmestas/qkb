/**
 * Regression: databases written by a pre-#118 qkb wrapped every documents_fts
 * column in a custom normalize_cjk_for_fts() SQL function that later builds no
 * longer register. Because the FTS objects are created with
 * CREATE ... IF NOT EXISTS, opening such a database with the current code left
 * the stale triggers in place, so every write threw
 * "no such function: normalize_cjk_for_fts" (reads were unaffected).
 * initializeDatabase() now detects the stale objects, rebuilds them with the
 * current DDL, and backfills the FTS index. See CHANGELOG [Unreleased].
 */
import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/internals/db.js";
import type { Database } from "../src/internals/db.js";
import { initializeDatabase } from "../src/internals/store-engine.js";

// The stale FTS objects a pre-#118 qkb wrote: documents_fts plus triggers whose
// columns are wrapped in the (now unregistered) normalize_cjk_for_fts().
const DOWNGRADE_TO_STALE = `
  DROP TRIGGER IF EXISTS documents_ai;
  DROP TRIGGER IF EXISTS documents_ad;
  DROP TRIGGER IF EXISTS documents_au;
  DROP TABLE IF EXISTS documents_fts;
  CREATE VIRTUAL TABLE documents_fts USING fts5(filepath, title, body, tokenize='porter unicode61');
  CREATE TRIGGER documents_ai AFTER INSERT ON documents WHEN new.active = 1 BEGIN
    INSERT INTO documents_fts(rowid, filepath, title, body)
    SELECT new.id,
           normalize_cjk_for_fts(new.collection || '/' || new.path),
           normalize_cjk_for_fts(new.title),
           normalize_cjk_for_fts((SELECT doc FROM content WHERE hash = new.hash));
  END;
`;

function seedOneDoc(db: Database): void {
  db.prepare(
    `INSERT INTO content(hash, doc, created_at) VALUES ('h1', 'hello merge world', datetime())`,
  ).run();
  db.prepare(
    `INSERT INTO documents(collection, path, title, hash, created_at, modified_at)
     VALUES ('c', 'p.md', 'Title', 'h1', datetime(), datetime())`,
  ).run();
}

let tmp: string | null = null;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

describe("documents_fts normalize_cjk_for_fts migration", () => {
  test("rebuilds stale CJK triggers so writes succeed again", () => {
    tmp = mkdtempSync(join(tmpdir(), "qkb-fts-mig-"));
    const db = openDatabase(join(tmp, "index.sqlite"));

    // Build a current-good schema, then downgrade it to the pre-#118 state.
    initializeDatabase(db);
    db.exec(DOWNGRADE_TO_STALE);

    // Precondition: with the stale trigger and no registered function, writing a
    // document throws — this is the reported breakage.
    expect(() => seedOneDoc(db)).toThrow(/normalize_cjk_for_fts/);
    // The content row landed before the failing documents insert; clear it so
    // the post-migration retry starts clean.
    db.exec(`DELETE FROM content`);

    // Reopen with the fixed path: the migration rebuilds the FTS objects.
    initializeDatabase(db);

    // Nothing references the dead function any more.
    const stale = db
      .prepare(
        `SELECT count(*) AS c FROM sqlite_master WHERE sql LIKE '%normalize_cjk_for_fts%'`,
      )
      .get() as { c: number };
    expect(stale.c).toBe(0);

    // Writes now succeed and the row is searchable via FTS.
    expect(() => seedOneDoc(db)).not.toThrow();
    const hits = db
      .prepare(`SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'merge'`)
      .all();
    expect(hits.length).toBe(1);

    db.close();
  });

  test("backfills the FTS index for rows that predate the rebuild", () => {
    tmp = mkdtempSync(join(tmpdir(), "qkb-fts-mig2-"));
    const db = openDatabase(join(tmp, "index.sqlite"));

    // Good schema with one already-indexed document.
    initializeDatabase(db);
    seedOneDoc(db);
    expect(
      (db.prepare(`SELECT count(*) AS c FROM documents_fts`).get() as { c: number }).c,
    ).toBe(1);

    // Downgrade the triggers to the stale form; documents/content survive but
    // documents_fts is dropped and recreated empty (as an old DB would appear).
    db.exec(DOWNGRADE_TO_STALE);
    expect(
      (db.prepare(`SELECT count(*) AS c FROM documents_fts`).get() as { c: number }).c,
    ).toBe(0);

    // The migration rebuilds and backfills from the surviving rows.
    initializeDatabase(db);
    const hits = db
      .prepare(`SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'hello'`)
      .all();
    expect(hits.length).toBe(1);

    db.close();
  });
});
