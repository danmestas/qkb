/**
 * Command dispatch table — RFC-0009 §"File layout".
 *
 * Single map from subcommand name (`"search"`, `"collection.add"`, ...)
 * to a handler that delegates to qmd's SDK or qkb's orchestrator. Both
 * the CLI parser (PR-6) and the MCP server (PR-5) call into this layer
 * via `dispatchCommand(name, args, ctx)`.
 *
 * Why a single dispatch table instead of one file per subcommand: most
 * subcommands are 1–3 line dispatches into qmd's SDK. A 17-file
 * `commands/` directory would be 17 shallow modules with high change
 * amplification (a global `--quiet` flag would mean 17 edits). A single
 * dispatch table keeps related handlers co-located; only commands with
 * genuine composite logic earn their own file (`commands-composite.ts`).
 *
 * Plan-versus-reality deviations (intentional):
 *   - Plan ran `c.orchestrator.run({})` after `removeCollection`. That
 *     re-walks every collection's filesystem and re-extracts wikilinks
 *     for every active doc — expensive overkill when all we need is
 *     orphan GC for the `doc:*` nodes whose backing rows qmd just
 *     hard-deleted from `documents`. We instead expose
 *     `pruneGraphOrphans(db)` (extracted from `runGraphPass`'s tail)
 *     and call that. Same correctness, no fs walk, no LLM models loaded.
 *   - Plan typed `c.store` as a partial `QMDStore` matching only the
 *     methods used. We type the full `QMDStore` so consumers (CLI,
 *     MCP) can pass the value they already have without casting.
 */
import type { QMDStore } from "@tobilu/qmd";
import {
  run as orchestratorRun,
  type OrchestratorOptions,
  type OrchestratorResult,
} from "./orchestrator/index-orchestrator.js";
import { pruneGraphOrphans } from "./graph/index-pass.js";
import {
  queryWithGraph,
  type QueryWithGraphOpts,
} from "./query/rerank-with-graph.js";
import { contextCheck, updateWithPull } from "./commands-composite.js";
import { findNeighbors } from "./graph/sdk.js";
import type { Database } from "./internals/db.js";

/**
 * Per-call context shared across all handlers. The CLI parser builds
 * one of these per invocation; the MCP server reuses one for the life
 * of the server.
 *
 * `pruneGraphOrphans` is injected (rather than imported directly inside
 * the handler) so unit tests can mock it without spinning up GraphQLite.
 */
export interface CommandContext {
  store: QMDStore;
  orchestrator: {
    run: (opts: OrchestratorOptions) => Promise<OrchestratorResult>;
  };
  /**
   * Prune orphaned graph nodes + WikiTarget placeholders against the
   * shared connection. Defaults to the real implementation; tests
   * inject a mock.
   */
  pruneGraphOrphans?: (db: Database) => {
    nodesPruned: number;
    wikiTargetsPruned: number;
  };
}

type Handler = (
  args: Record<string, unknown>,
  ctx: CommandContext
) => Promise<unknown>;

/** Coerce `args.X` to a string when the dispatch contract requires one. */
function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") {
    throw new TypeError(`expected string arg "${key}", got ${typeof v}`);
  }
  return v;
}

/** Coerce `args.X` to an optional string. */
function strOpt(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new TypeError(`expected string arg "${key}", got ${typeof v}`);
  }
  return v;
}

/** Coerce `args.X` to an optional number. */
function numOpt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number") {
    throw new TypeError(`expected number arg "${key}", got ${typeof v}`);
  }
  return v;
}

/** Coerce `args.X` to an optional boolean. */
function boolOpt(
  args: Record<string, unknown>,
  key: string
): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  return !!v;
}

function expandedQueriesOpt(args: Record<string, unknown>): QueryWithGraphOpts["expandedQueries"] {
  const v = args.expandedQueries;
  if (!Array.isArray(v)) return undefined;
  const out: NonNullable<QueryWithGraphOpts["expandedQueries"]> = [];
  for (const item of v) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) out.push({ type: "lex", query: text }, { type: "vec", query: text });
      continue;
    }
    if (item && typeof item === "object") {
      const row = item as { type?: unknown; query?: unknown };
      const type = row.type === "lex" || row.type === "vec" || row.type === "hyde" ? row.type : "lex";
      if (typeof row.query === "string" && row.query.trim()) out.push({ type, query: row.query.trim() });
    }
  }
  return out.length ? out : undefined;
}

const handlers: Record<string, Handler> = {
  // ── Collections ────────────────────────────────────────────────
  "collection.add": async (a, c) => {
    const name = str(a, "name");
    await c.store.addCollection(name, {
      path: str(a, "path"),
      pattern: strOpt(a, "pattern"),
      ignore: Array.isArray(a.ignore) ? (a.ignore as string[]) : undefined,
    });
    // Index the new collection immediately so the user sees results on
    // the very next `qkb search`. Scoped to the new collection so we
    // don't re-walk every other collection.
    return c.orchestrator.run({ collections: [name] });
  },

  "collection.list": async (_a, c) => c.store.listCollections(),

  "collection.remove": async (a, c) => {
    const name = str(a, "name");
    const ok = await c.store.removeCollection(name);
    // qmd's `removeCollection` hard-deletes from `documents` + cascades
    // chunks/vectors but leaves graph rows pointing at vanished doc
    // ids. Prune those orphans here. Cheaper than `orchestrator.run({})`
    // (which would re-walk every other collection's filesystem) and
    // exactly correct: the only graph rows that need cleaning are the
    // ones whose `doc:N` no longer joins to `documents`.
    const prune = c.pruneGraphOrphans ?? pruneGraphOrphans;
    prune(c.store.internal.db as unknown as Database);
    return ok;
  },

  "collection.rename": async (a, c) =>
    c.store.renameCollection(str(a, "old"), str(a, "new")),

  // ── Context ────────────────────────────────────────────────────
  "context.add": async (a, c) =>
    c.store.addContext(str(a, "collection"), str(a, "path"), str(a, "text")),

  "context.list": async (_a, c) => c.store.listContexts(),

  "context.rm": async (a, c) =>
    c.store.removeContext(str(a, "collection"), str(a, "path")),

  "context.check": async (_a, c) => contextCheck(c.store),

  // ── Documents ──────────────────────────────────────────────────
  get: async (a, c) =>
    c.store.get(str(a, "path"), { includeBody: boolOpt(a, "includeBody") }),

  "multi-get": async (a, c) =>
    c.store.multiGet(str(a, "pattern"), {
      includeBody: boolOpt(a, "includeBody"),
      maxBytes: numOpt(a, "maxBytes"),
    }),

  // ── Index lifecycle ────────────────────────────────────────────
  status: async (_a, c) => c.store.getStatus(),

  update: async (a, c) => {
    if (a.pull) return updateWithPull(c);
    const collections = Array.isArray(a.collections)
      ? (a.collections as string[])
      : undefined;
    return c.orchestrator.run({ collections });
  },

  embed: async (a, c) =>
    c.store.embed({
      force: boolOpt(a, "force"),
      model: strOpt(a, "model"),
      maxDocsPerBatch: numOpt(a, "maxDocsPerBatch"),
      maxBatchBytes: numOpt(a, "maxBatchBytes"),
    }),

  // ── Search ─────────────────────────────────────────────────────
  search: async (a, c) =>
    c.store.searchLex(str(a, "query"), {
      limit: numOpt(a, "limit"),
      collection: strOpt(a, "collection"),
    }),

  vsearch: async (a, c) =>
    c.store.searchVector(str(a, "query"), {
      limit: numOpt(a, "limit"),
      collection: strOpt(a, "collection"),
    }),

  query: async (a, c) =>
    queryWithGraph(c.store, str(a, "query"), {
      limit: numOpt(a, "limit"),
      collection: strOpt(a, "collection"),
      intent: strOpt(a, "intent"),
      expandedQueries: expandedQueriesOpt(a),
      useGraph: boolOpt(a, "graphCandidates"),
    } as QueryWithGraphOpts),

  // ── Graph ──────────────────────────────────────────────────────
  // 1-hop neighbour traversal. Same `nodeId` / `hops` / `edgeTypes`
  // shape as `findNeighbors` in `src/graph/sdk.ts` — args names match
  // the Cypher parameter convention there. Hop count is validated to
  // [1, 3] inside `findNeighbors`; surface anything over as a
  // `RangeError` so MCP/CLI callers don't have to revalidate.
  neighbors: async (a, c) =>
    findNeighbors(c.store.internal.db as unknown as Database, {
      nodeId: str(a, "nodeId"),
      hops: numOpt(a, "hops") ?? 1,
      edgeTypes: Array.isArray(a.edgeTypes)
        ? (a.edgeTypes as string[])
        : undefined,
    }),
};

/**
 * Look up `name` in the dispatch table and call its handler with
 * `args` + `ctx`. Throws on unknown command names so the CLI surfaces
 * "did you mean..." hints rather than silently dropping the request.
 *
 * `args` is intentionally `Record<string, unknown>` rather than a
 * tagged union — the CLI parser hands us a bag of CLI flags that only
 * the per-command handler knows how to interpret. Each handler validates
 * the keys it cares about via the `str`/`strOpt`/`numOpt` helpers above.
 */
export async function dispatchCommand(
  name: string,
  args: Record<string, unknown>,
  ctx: CommandContext
): Promise<unknown> {
  const handler = handlers[name];
  if (!handler) {
    throw new Error(`Unknown command: ${name}`);
  }
  return handler(args, ctx);
}

// Re-export for downstream consumers (tests, the CLI parser, MCP).
export type { OrchestratorOptions, OrchestratorResult } from "./orchestrator/index-orchestrator.js";
export { orchestratorRun };
