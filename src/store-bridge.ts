/**
 * store-bridge — single store entry point for qkb 4.0 (RFC-0009 PR-1).
 *
 * Wraps `@tobilu/qmd`'s `createStore()` so that every qkb subcommand,
 * MCP handler, and SDK consumer opens the SQLite file through one path:
 *
 *   1. qmd creates / migrates its tables (`docs`, `chunks`, `vec_chunks`,
 *      `store_*`, etc.) and loads the sqlite-vec extension.
 *   2. qkb loads the GraphQLite extension into the *same* connection.
 *   3. qkb creates / migrates its own tables (`graph_meta`, plus
 *      GraphQLite-managed tables that materialise on first cypher()
 *      write).
 *
 * Migration ordering is automatic: qmd inside `createStore`, qkb after.
 * The two layers own disjoint table sets (RFC §"Table ownership").
 *
 * On a system without GraphQLite installed, `loadGraphqlite()` throws
 * `GraphExtensionUnavailableError` — graph queries fail loudly per
 * RFC §"Error handling" rather than silently degrading.
 */
import {
  createStore,
  type StoreOptions,
  type QMDStore,
} from "@tobilu/qmd";
import { loadGraphqlite, ensureGraphSchema } from "./graph/loader.js";
import type { Database } from "./db.js";

/**
 * Open a qmd store and overlay qkb's graph layer on its connection.
 *
 * Returns the qmd store unchanged — callers use the standard `QMDStore`
 * surface (`store.search`, `store.update`, ...) plus the graph helpers
 * exposed elsewhere in qkb that read/write through `store.internal.db`.
 */
export async function openStore(opts: StoreOptions): Promise<QMDStore> {
  const store = await createStore(opts);
  // qmd's `internal.db` is a `better-sqlite3` Database (or `bun:sqlite`
  // under Bun). qkb's structural `Database` shim from `db.ts` matches
  // both shapes — the cast satisfies TypeScript without changing
  // behaviour.
  const db = store.internal.db as unknown as Database;
  loadGraphqlite(db);
  ensureGraphSchema(db);
  return store;
}
