/**
 * vsearch-expansion.test.ts — Regression tests for issue #128.
 *
 * `qkb vsearch` (vectorSearchQuery) must NOT trigger GGUF-backed local query
 * expansion unless explicitly opted in via `useLocalExpansion` (--local-expand).
 *
 * CI-safe: no model download — expandQuery is stubbed to throw and searchVec
 * is stubbed to return no results.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  createStore,
  vectorSearchQuery,
  type Store,
} from "../src/internals/store-engine.js";
import type { CollectionConfig } from "../src/internals/collections-yaml.js";

let testDir: string;
let store: Store;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qkb-vsearch-expansion-"));

  // Point config at an empty test config dir
  process.env.QKB_CONFIG_DIR = testDir;
  const emptyConfig: CollectionConfig = { collections: {} };
  await writeFile(join(testDir, "index.yml"), YAML.stringify(emptyConfig));

  store = createStore(join(testDir, "test.sqlite"));

  // Ensure the vector-table guard passes — the guard only checks sqlite_master
  // for a table named 'vectors_vec'.
  store.db
    .prepare(`CREATE TABLE IF NOT EXISTS vectors_vec (id INTEGER)`)
    .run();

  // Stub out anything that would load a model:
  // expandQuery throws so any expansion attempt is detectable;
  // searchVec returns no results so no embedding is needed.
  store.expandQuery = () => {
    throw new Error("must not expand");
  };
  store.searchVec = async () => [];
});

afterEach(async () => {
  store.close();
  delete process.env.QKB_CONFIG_DIR;
  await rm(testDir, { recursive: true, force: true });
});

describe("vectorSearchQuery expansion gating (#128)", () => {
  test("does not call expandQuery by default", async () => {
    const results = await vectorSearchQuery(store, "q", {});
    expect(results).toEqual([]);
  });

  test("does not call expandQuery when options are omitted", async () => {
    const results = await vectorSearchQuery(store, "q");
    expect(results).toEqual([]);
  });

  test("calls expandQuery when useLocalExpansion is true", async () => {
    await expect(
      vectorSearchQuery(store, "q", { useLocalExpansion: true })
    ).rejects.toThrow("must not expand");
  });

  test("prefers harness-supplied expandedQueries over local expansion", async () => {
    // expandedQueries short-circuits local expansion even when opted in
    const results = await vectorSearchQuery(store, "q", {
      useLocalExpansion: true,
      expandedQueries: [{ type: "vec", query: "variant" }],
    });
    expect(results).toEqual([]);
  });
});
