/**
 * MCP tool schemas — RFC-0009 PR-5.
 *
 * One spot for every Zod input schema the qkb MCP server registers.
 * Pulled out of `server.ts` so the server file stays a 1-line dispatch
 * per tool: schema here, handler there, dispatch elsewhere.
 *
 * Tool-name parity with qmd's MCP (`query`, `get`, `multi_get`,
 * `status`) keeps configs interchangeable per RFC §"MCP server"; the
 * remaining tools are qkb-only (`search`, `vsearch`, `update`, `embed`,
 * `neighbors`) and are surfaced because qkb users already rely on them
 * via the CLI dispatch table.
 *
 * Schemas use `z.object({...})` (not raw shapes) so the server can use
 * `inputSchema` as a Zod schema — `McpServer.registerTool` accepts both
 * the raw-shape and full-schema forms in this SDK version.
 */
import { z } from "zod";

/** Full-text BM25 search (no LLM rerank). qkb-only — qmd's MCP doesn't expose this directly. */
export const schemaSearch = {
  description:
    "Full-text BM25 search (no LLM rerank). Faster than `query`; use when " +
    "you know exact keywords. Use `query` for graph-aware semantic search.",
  inputSchema: {
    query: z.string().describe("Search keywords."),
    limit: z.number().int().positive().optional().describe("Max results."),
    collection: z.string().optional().describe("Filter to a single collection."),
  },
};

/** Vector similarity search (no rerank). qkb-only — exposes the standalone vector path. */
export const schemaVSearch = {
  description:
    "Vector similarity search (no LLM rerank). Embeds the query and pulls " +
    "the nearest chunks. Use when you want semantic recall without rerank cost.",
  inputSchema: {
    query: z.string().describe("Natural-language query."),
    limit: z.number().int().positive().optional().describe("Max results."),
    collection: z.string().optional().describe("Filter to a single collection."),
  },
};

/** Single-doc retrieval — qmd MCP parity. */
export const schemaGet = {
  description: "Retrieve a single document by file path or docid (e.g. `#abc123`).",
  inputSchema: {
    path: z.string().describe("File path or docid (`#abc123`) from search results."),
    includeBody: z
      .boolean()
      .optional()
      .describe("If true, include the full document body in the response."),
  },
};

/** Glob/csv multi-doc retrieval — qmd MCP parity. */
export const schemaMultiGet = {
  description:
    "Retrieve multiple documents by glob pattern (e.g. `journals/2025-05*.md`) " +
    "or comma-separated list. Skips files larger than `maxBytes`.",
  inputSchema: {
    pattern: z.string().describe("Glob pattern or comma-separated list of paths."),
    includeBody: z
      .boolean()
      .optional()
      .describe("If true, include full bodies (default true via SDK)."),
    maxBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Skip files larger than this. Default 10240 (10 KB)."),
  },
};

/** Index status — qmd MCP parity. */
export const schemaStatus = {
  description: "Index status: doc count, collections, embedding state.",
  inputSchema: {} as Record<string, never>,
};

/**
 * Re-index collections via the orchestrator (qmd update + graph pass).
 * qkb-only because qmd's MCP doesn't expose update; we surface it
 * because the daemon-mode MCP server is the practical place for an
 * agent to refresh the index without dropping into the CLI.
 */
export const schemaUpdate = {
  description:
    "Re-index collections (BM25 + vector + graph). Omit `collections` to " +
    "update everything; pass names to scope the run.",
  inputSchema: {
    collections: z
      .array(z.string())
      .optional()
      .describe("Collection names to re-index. Omit for all."),
    pull: z
      .boolean()
      .optional()
      .describe("Run `git pull --ff-only` per collection before indexing."),
  },
};

/** Embedding generation — qkb-only. */
export const schemaEmbed = {
  description:
    "Generate vector embeddings for documents that don't have them yet. " +
    "Idempotent — safe to re-run.",
  inputSchema: {
    force: z.boolean().optional().describe("Re-embed even when up to date."),
    model: z.string().optional().describe("Override the default embedding model."),
  },
};

/**
 * Graph-aware hybrid query — qkb's headline differentiator.
 *
 * Note on shape drift from qmd's MCP: qmd's `query` tool takes a
 * `searches` array of typed sub-queries (lex/vec/hyde). qkb's
 * `queryWithGraph` is single-string today; we keep the simpler
 * shape rather than reimplement qmd's expansion shell. PR-7 (or a
 * follow-up) can widen this to mirror qmd if MCP clients need it.
 */
export const schemaQuery = {
  description:
    "Hybrid search: BM25 + vector + title-weighted lexical retrieval with optional " +
    "harness-supplied expansions and optional rerank. Graph neighbors are better " +
    "used as labeled context; set graphCandidates only when you want legacy graph " +
    "neighbors to compete in the rerank pool.",
  inputSchema: {
    query: z.string().describe("Natural-language query."),
    expandedQueries: z
      .array(z.union([
        z.string(),
        z.object({
          type: z.enum(["lex", "vec", "hyde"]).optional(),
          query: z.string(),
        }),
      ]))
      .optional()
      .describe("Agent/harness-supplied expansion queries. Untyped strings are searched as both lex and vec; typed objects can use lex, vec, or hyde."),
    limit: z.number().int().positive().optional().describe("Max results (default 10)."),
    collection: z.string().optional().describe("Filter to a single collection."),
    intent: z
      .string()
      .optional()
      .describe("Optional disambiguating context — does not search on its own."),
    graphCandidates: z
      .boolean()
      .optional()
      .describe("Opt into legacy graph-neighbor candidate injection. Defaults false; prefer graph neighbors as post-retrieval context."),
  },
};

/** Constrained 1-hop graph traversal — qkb-only. */
export const schemaNeighbors = {
  description:
    "Graph neighbours: nodes reachable from `nodeId` within `hops` steps. " +
    "For hops=1 returns id + edge type; for hops>1 returns ids only.",
  inputSchema: {
    nodeId: z.string().describe("Source node id (e.g. `doc:42`)."),
    hops: z
      .number()
      .int()
      .min(1)
      .max(3)
      .optional()
      .describe("Hop count, 1-3 inclusive. Default 1."),
    edgeTypes: z
      .array(z.string())
      .optional()
      .describe("Optional whitelist of edge types (identifiers only)."),
  },
};
