/**
 * Index orchestrator — RFC-0009 §"Indexing path".
 *
 * Single entry point for all qkb indexing paths (CLI `qkb update`, CLI
 * `qkb collection add`, MCP `update` tool, and a future `qkb watch`).
 * The invariant: every indexing operation flows through `run()` so the
 * graph pass always follows qmd's `update()` on the same connection.
 *
 *     run(store, opts)
 *       → store.update({collections, onProgress})  // qmd: walk + hash + BM25/vec
 *       → runGraphPass(db, collections)            // qkb: extract + upsert + GC
 *
 * qmd's `update()` already does change detection (hash compare against
 * `documents.hash`) so we don't duplicate that. The graph pass is
 * idempotent (`INSERT OR REPLACE`-equivalent via `runUpsertNodesBulk`
 * / `runUpsertEdgesBulk`) so re-running is cheap.
 */
import type { QMDStore, UpdateProgress, UpdateResult } from "@tobilu/qmd";
import { runGraphPass, type GraphPassResult } from "../graph/index-pass.js";
import type { Database } from "../db.js";

export interface OrchestratorOptions {
  /** Restrict indexing to specific collection names. Omit to index all. */
  collections?: string[];
  /** Per-file progress callback forwarded to qmd's `update()`. */
  onProgress?: (info: UpdateProgress) => void;
}

export interface OrchestratorResult {
  /** New documents indexed by qmd. */
  indexed: number;
  /** Existing documents whose content changed. */
  updated: number;
  /** Documents whose content was unchanged. */
  unchanged: number;
  /** Documents that disappeared from disk (qmd marks active=0). */
  removed: number;
  /** Documents needing fresh embeddings (qmd reports). */
  needsEmbedding: number;
  /** Graph pass result — edges upserted + nodes pruned. */
  graph: GraphPassResult;
}

/**
 * Run a full indexing cycle: qmd update first, then the graph pass.
 *
 * Both halves write to the same SQLite file via `store.internal.db`;
 * qmd's per-file transactions plus the graph pass's idempotent upserts
 * mean a mid-run crash is recoverable on the next call.
 */
export async function run(
  store: QMDStore,
  opts: OrchestratorOptions = {}
): Promise<OrchestratorResult> {
  const qmdResult: UpdateResult = await store.update({
    collections: opts.collections,
    onProgress: opts.onProgress,
  });

  // qmd's `internal.db` matches qkb's structural Database shim across
  // both Bun and Node runtimes — see `src/db.ts`.
  const db = store.internal.db as unknown as Database;
  const graphResult = runGraphPass(db, opts.collections);

  return {
    indexed: qmdResult.indexed,
    updated: qmdResult.updated,
    unchanged: qmdResult.unchanged,
    removed: qmdResult.removed,
    needsEmbedding: qmdResult.needsEmbedding,
    graph: graphResult,
  };
}
