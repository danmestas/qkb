/**
 * GraphQLite extension loader — RFC-0007 §4.5.
 *
 * Mirrors the pattern in `src/db.ts` for sqlite-vec. The dual-runtime
 * (bun:sqlite vs better-sqlite3) and Bun-on-macOS Apple-SQLite quirks
 * are already handled in db.ts at module init time; this module only
 * has to find the binary and call `db.loadExtension(path)`.
 *
 * Path resolution order (RFC §4.5 case L1/L3 vs L4):
 *   1. `QKB_GRAPHQLITE_PATH` env var — the C-mode escape hatch from the
 *      A+C vendoring decision (D7 in PLAN.md)
 *   2. Platform-default install location (Homebrew on macOS; standard
 *      Linux library paths)
 *
 * The lazy postinstall download (option A) is wired up in PR-4b; for
 * now, users either set the env var or `brew install graphqlite`.
 *
 * On L4 (binary missing), throws `GraphExtensionUnavailableError` with
 * the attempted path and platform-aware install hints.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Database } from "../internals/db.js";

const PLATFORM_DEFAULT_PATHS: Record<string, string[]> = {
  darwin: [
    // Homebrew on Apple Silicon
    "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib",
    // Homebrew on Intel
    "/usr/local/opt/graphqlite/lib/sqlite/graphqlite.dylib",
  ],
  linux: [
    "/usr/local/lib/graphqlite.so",
    "/usr/lib/graphqlite.so",
    "/usr/lib/x86_64-linux-gnu/graphqlite.so",
    "/usr/lib/aarch64-linux-gnu/graphqlite.so",
  ],
  // Windows is deferred per RFC §7 (D3 in PLAN.md).
};

/**
 * Thrown when the GraphQLite extension cannot be loaded — usually because
 * the binary is not installed (RFC §4.5 case L4). Contains the path that
 * was attempted, for debuggability.
 */
export class GraphExtensionUnavailableError extends Error {
  readonly attemptedPath: string;

  constructor(message: string, attemptedPath: string) {
    super(message);
    this.name = "GraphExtensionUnavailableError";
    this.attemptedPath = attemptedPath;
  }
}

/**
 * Resolve a candidate path for the GraphQLite extension. Returns the
 * first existing path; if none exist, returns the most-likely candidate
 * for the current platform so the caller can emit a useful error.
 *
 * This function does NOT load the extension — call `loadGraphqlite(db)`.
 */
export function resolveGraphqlitePath(): string {
  const envPath = process.env.QKB_GRAPHQLITE_PATH;
  if (envPath) {
    return envPath;
  }

  const candidates = PLATFORM_DEFAULT_PATHS[process.platform] ?? [];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // No existing path found — return the first platform default so the
  // error message points the user somewhere actionable.
  return candidates[0] ?? "(no platform default)";
}

function installHint(platform: string): string {
  if (platform === "darwin") {
    return (
      "Install with `brew install graphqlite` (Homebrew) or set " +
      "QKB_GRAPHQLITE_PATH to the absolute path of an existing " +
      "graphqlite.dylib"
    );
  }
  if (platform === "linux") {
    return (
      "Set QKB_GRAPHQLITE_PATH to the absolute path of graphqlite.so " +
      "(download from https://github.com/colliery-io/graphqlite/releases " +
      "or build from source)"
    );
  }
  return (
    "Set QKB_GRAPHQLITE_PATH to an absolute path. Windows is not yet " +
    "supported by QKB's graph layer (RFC-0007 §7)."
  );
}

/**
 * Load the GraphQLite extension into a Database. Throws
 * `GraphExtensionUnavailableError` if the binary is missing or fails
 * to load.
 *
 * After this returns, the SQL function `cypher(query[, params_json])`
 * is available on the connection.
 */
export function loadGraphqlite(db: Database): void {
  const path = resolveGraphqlitePath();

  if (!existsSync(path)) {
    throw new GraphExtensionUnavailableError(
      `GraphQLite extension not found at ${path}. ${installHint(process.platform)}.`,
      path
    );
  }

  try {
    db.loadExtension(path);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new GraphExtensionUnavailableError(
      `GraphQLite extension at ${path} failed to load: ${detail}. ${installHint(process.platform)}.`,
      path
    );
  }
}

/**
 * Read the hard-pinned GraphQLite version from
 * `scripts/graphqlite-versions.json`. The pin is the single source of
 * truth for the GraphQLite version qkb expects on a given DB. Mirrors
 * the version-pin readback in `src/store.ts` (which 3.x still owns and
 * RFC-0009 PR-7 will delete).
 */
export function readPinnedGraphqliteVersion(): string {
  try {
    const url = new URL(
      "../../scripts/graphqlite-versions.json",
      import.meta.url
    );
    const raw = readFileSync(url, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    /* fall through */
  }
  return "unknown";
}

/**
 * Ensure qkb's `graph_meta` schema exists on `db`. Idempotent — safe to
 * re-call on every store open. Single-row CHECK constraint (id='qkb')
 * keeps the table at one row across re-opens.
 *
 * Mirrors the schema produced by `initializeGraphLayer()` in
 * `src/store.ts` (3.x). Centralising here lets the new
 * `src/store-bridge.ts` (RFC-0009) ensure the schema after qmd's own
 * `createStore()` has migrated qmd-owned tables, without depending on
 * the legacy `store.ts` implementation that PR-7 deletes.
 */
export function ensureGraphSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_meta (
      id TEXT PRIMARY KEY DEFAULT 'qkb',
      graphqlite_version TEXT NOT NULL,
      initialized_at TEXT NOT NULL,
      CHECK (id = 'qkb')
    )
  `);

  const pinnedVersion = readPinnedGraphqliteVersion();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO graph_meta (id, graphqlite_version, initialized_at) VALUES ('qkb', ?, ?)`
  ).run(pinnedVersion, now);
}
