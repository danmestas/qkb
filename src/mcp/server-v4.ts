/**
 * qkb MCP server (4.0) — RFC-0009 PR-5 + PR-7c.
 *
 * Tool handlers are one-line wrappers around `dispatchCommand` (the
 * PR-4 dispatch table) plus `findNeighbors` (which dispatch also
 * routes via `"neighbors"`). MCP's JSON Schema validates input shape;
 * the dispatcher coerces with `str`/`numOpt`/`boolOpt`.
 *
 * Tool-name parity with qmd's MCP (`query`, `get`, `multi_get`,
 * `status`) keeps qkb interchangeable with qmd in MCP client configs
 * — RFC §"MCP server". The remaining tools are qkb-only:
 * `search`/`vsearch`/`update`/`embed`/`neighbors`.
 *
 * Plan-versus-reality deviations (intentional):
 *   - Plan imported `runFindNeighbors` from `src/graph/sdk.js`. The
 *     actual export is `findNeighbors` (no `run` prefix). We add
 *     `"neighbors"` to the PR-4 dispatch table so the MCP handler
 *     stays a one-liner — option A from the PR-5 brief.
 *   - Plan registered 5 tools (`search`/`get`/`status`/`update`/
 *     `query`) plus `neighbors`. Spec says register every tool name
 *     qmd's MCP exposes for client interchangeability; qmd registers
 *     `query`/`get`/`multi_get`/`status`. We add `multi_get` here so
 *     the parity claim holds. We also keep qkb-only tools that the
 *     CLI surface already exposes (`search`/`vsearch`/`update`/`embed`).
 *   - Plan's `query` schema took a single string. qmd's MCP takes a
 *     `searches: [{type, query}, ...]` array. We keep the single-
 *     string shape because `queryWithGraph` is single-string today
 *     and reimplementing qmd's typed-sub-query shell is out of PR-5
 *     scope. A future follow-up widens it if needed.
 *   - Plan's `McpHandle.listTools` returned `[{name}]` only and used a
 *     hand-rolled `concat`. We expose a real in-process MCP client
 *     instead via `InMemoryTransport.createLinkedPair()` so tests
 *     exercise the actual MCP wire format — same path a stdio client
 *     takes — without a separate process.
 *
 * Transports (all live in this module after PR-7c):
 *   - stdio:                `startMcpStdio({dbPath})`
 *   - HTTP foreground:      `startMcpHttpServer(port, opts?)`
 *   - HTTP daemon:          CLI handles spawn/PID; this module is the body
 *   - In-process (tests):   `startMcpInProcess({dbPath})`
 *
 * The HTTP transport additionally exposes two non-MCP REST endpoints
 * carried over from the 3.x server for clients that don't speak the
 * MCP protocol: `POST /query` (alias `POST /search`) for structured
 * search and `GET /health` for liveness probes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport }
  from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  extractSnippet,
  addLineNumbers,
  getDefaultDbPath,
  type ExpandedQuery,
  type QMDStore,
} from "@tobilu/qmd";
import { openStore } from "../store-bridge.js";
import {
  dispatchCommand,
  type CommandContext,
} from "../commands.js";
import { run as orchestratorRun } from "../orchestrator/index-orchestrator.js";
import * as schemas from "./schemas.js";

/** Set of (toolName, dispatchName) pairs that share a one-liner handler. */
interface ToolBinding {
  /** MCP tool name as it appears to clients. */
  name: string;
  /** Dispatch table key — see `src/commands.ts`. */
  dispatch: string;
  /**
   * Schema spec passed to `McpServer.registerTool`. Contains
   * `description` + `inputSchema` — keep the rest of `RegisteredTool`
   * (e.g. `annotations`) defaultable so this stays terse.
   */
  schema: { description: string; inputSchema: Record<string, unknown> };
}

const TOOLS: ReadonlyArray<ToolBinding> = [
  // qmd MCP parity — same names, same intent. Schemas may differ in
  // detail (qkb's `query` is single-string, qmd's takes a typed array)
  // but the tool-name set is interchangeable.
  { name: "query",     dispatch: "query",     schema: schemas.schemaQuery     },
  { name: "get",       dispatch: "get",       schema: schemas.schemaGet       },
  { name: "multi_get", dispatch: "multi-get", schema: schemas.schemaMultiGet  },
  { name: "status",    dispatch: "status",    schema: schemas.schemaStatus    },
  // qkb-only — CLI surface that doesn't exist in qmd's MCP today.
  { name: "search",    dispatch: "search",    schema: schemas.schemaSearch    },
  { name: "vsearch",   dispatch: "vsearch",   schema: schemas.schemaVSearch   },
  { name: "update",    dispatch: "update",    schema: schemas.schemaUpdate    },
  { name: "embed",     dispatch: "embed",     schema: schemas.schemaEmbed     },
  { name: "neighbors", dispatch: "neighbors", schema: schemas.schemaNeighbors },
];

/** Build the per-server `CommandContext` shared by all tool handlers. */
function buildContext(store: QMDStore): CommandContext {
  return {
    store,
    orchestrator: { run: (opts) => orchestratorRun(store, opts) },
    // `pruneGraphOrphans` is not needed by MCP tools (no `collection.remove`
    // here), but the CommandContext interface allows defaulting via the
    // dispatch table's `c.pruneGraphOrphans ?? pruneGraphOrphans` fallback.
  };
}

/**
 * Wire every tool in `TOOLS` onto `server`. Handler body is one
 * `dispatchCommand` call per tool — the dispatcher does the strict
 * arg coercion that qmd's MCP server does inline in each handler.
 */
function registerTools(server: McpServer, ctx: CommandContext): void {
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      t.schema as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: Record<string, unknown>): Promise<any> => {
        const out = await dispatchCommand(t.dispatch, args ?? {}, ctx);
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        };
      },
    );
  }
}

/** Build an `McpServer` configured with all qkb tools, no transport attached yet. */
async function buildServer(opts: {
  dbPath: string;
}): Promise<{ server: McpServer; store: QMDStore }> {
  const store = await openStore({ dbPath: opts.dbPath });
  const server = new McpServer({ name: "qkb", version: "4.0.0" });
  registerTools(server, buildContext(store));
  return { server, store };
}

// ─── In-process handle (used by integration tests) ────────────────

/**
 * Test-only MCP handle. Wires a `Client` and the `McpServer` together
 * via `InMemoryTransport` so tests exercise the real MCP request/response
 * cycle without a child process. The returned `client` is a fully-
 * featured MCP client — call `client.listTools()` / `client.callTool()`.
 *
 * `tools` is a convenience snapshot of the registered tool names so
 * the simplest assertions don't need a `listTools()` round-trip.
 */
export interface InProcessMcpHandle {
  client: Client;
  /** Snapshot of registered tool names — no MCP round-trip needed. */
  toolNames: string[];
  close(): Promise<void>;
}

/**
 * Start the qkb MCP server in-process and return a connected MCP
 * client paired with it via `InMemoryTransport`. Tests use this to
 * exercise tools end-to-end through MCP's JSON-RPC layer.
 */
export async function startMcpInProcess(opts: {
  dbPath: string;
}): Promise<InProcessMcpHandle> {
  const { server, store } = await buildServer(opts);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: "qkb-test-client", version: "0.0.0" },
    { capabilities: {} },
  );

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    toolNames: TOOLS.map((t) => t.name),
    async close() {
      await client.close();
      await server.close();
      await store.close();
    },
  };
}

// ─── stdio transport (production path) ────────────────────────────

/**
 * Start the qkb MCP server over stdio. This is what `qkb mcp` (no
 * flags) wires up — same shape as today's qkb 3.x MCP entry point.
 *
 * The CLI cutover (PR-6) is what swaps `qkb mcp`'s default-stdio
 * branch from importing `./server.js`'s `startMcpServer` to importing
 * this `startMcpStdio`.
 */
export async function startMcpStdio(opts: {
  dbPath: string;
}): Promise<void> {
  const { server } = await buildServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ─── HTTP transport ───────────────────────────────────────────────

/** Handle returned by `startMcpHttpServer` — exposes the bound port and a stop hook. */
export type HttpServerHandle = {
  httpServer: import("http").Server;
  port: number;
  stop: () => Promise<void>;
};

/**
 * Start the qkb MCP server over Streamable HTTP (JSON responses, no SSE).
 *
 * Binds to localhost only. Per MCP spec each client gets its own
 * `McpServer` + `Transport` pair; the underlying `QMDStore` is shared
 * (SQLite handles concurrent reads).
 *
 * In addition to the MCP-protocol `/mcp` endpoint, this exposes two
 * convenience HTTP endpoints carried over from qkb's 3.x server:
 *
 *   - `GET  /health`             — JSON `{status, uptime}` liveness
 *   - `POST /query` (or `/search`) — structured search without MCP
 *
 * `dbPath` defaults to qmd's `getDefaultDbPath()` (which honors the
 * `INDEX_PATH` env var used by tests).
 */
export async function startMcpHttpServer(
  port: number,
  options?: { quiet?: boolean; dbPath?: string },
): Promise<HttpServerHandle> {
  const dbPath = options?.dbPath ?? getDefaultDbPath();
  const store = await openStore({ dbPath });

  // Pre-fetch default collection names for the REST endpoint.
  const defaultCollectionNames = await store.getDefaultCollectionNames();

  // Per MCP spec, each session owns its own server+transport pair.
  // The `store` is shared because SQLite + bun:sqlite/better-sqlite3
  // are safe for concurrent reads.
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const ctx = buildContext(store);

  async function createSession(): Promise<WebStandardStreamableHTTPServerTransport> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, transport);
        log(`${ts()} New session ${sessionId} (${sessions.size} active)`);
      },
    });
    const server = new McpServer({ name: "qkb", version: "4.0.0" });
    registerTools(server, ctx);
    await server.connect(transport);

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    return transport;
  }

  const startTime = Date.now();
  const quiet = options?.quiet ?? false;

  /** Format timestamp for request logging. */
  function ts(): string {
    return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  }

  /** Extract a human-readable label from a JSON-RPC body. */
  function describeRequest(body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }): string {
    const method = body?.method ?? "unknown";
    if (method === "tools/call") {
      const tool = body.params?.name ?? "?";
      const args = body.params?.arguments;
      if (args && typeof args.query === "string") {
        const q = args.query.slice(0, 80);
        return `tools/call ${tool} "${q}"`;
      }
      if (args && typeof args.path === "string") return `tools/call ${tool} ${args.path}`;
      if (args && typeof args.pattern === "string") return `tools/call ${tool} ${args.pattern}`;
      return `tools/call ${tool}`;
    }
    return method;
  }

  function log(msg: string): void {
    if (!quiet) console.error(msg);
  }

  async function collectBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString();
  }

  const httpServer = createServer(async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
    const reqStart = Date.now();
    const pathname = nodeReq.url || "/";

    try {
      if (pathname === "/health" && nodeReq.method === "GET") {
        const body = JSON.stringify({ status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000) });
        nodeRes.writeHead(200, { "Content-Type": "application/json" });
        nodeRes.end(body);
        log(`${ts()} GET /health (${Date.now() - reqStart}ms)`);
        return;
      }

      // REST endpoint: POST /query (alias: /search) — structured search without MCP protocol
      if ((pathname === "/query" || pathname === "/search") && nodeReq.method === "POST") {
        const rawBody = await collectBody(nodeReq);
        const params = JSON.parse(rawBody) as {
          searches?: Array<{ type: string; query: string }>;
          collections?: string[];
          limit?: number;
          minScore?: number;
          intent?: string;
        };

        if (!params.searches || !Array.isArray(params.searches)) {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({ error: "Missing required field: searches (array)" }));
          return;
        }

        const queries: ExpandedQuery[] = params.searches.map((s) => ({
          type: s.type as "lex" | "vec" | "hyde",
          query: String(s.query || ""),
        }));

        const effectiveCollections = params.collections ?? defaultCollectionNames;

        const results = await store.search({
          queries,
          collections: effectiveCollections.length > 0 ? effectiveCollections : undefined,
          limit: params.limit ?? 10,
          minScore: params.minScore ?? 0,
          intent: params.intent,
        });

        // Use first lex/vec query for snippet extraction.
        const primaryQuery =
          params.searches.find((s) => s.type === "lex")?.query
          || params.searches.find((s) => s.type === "vec")?.query
          || params.searches[0]?.query
          || "";

        const formatted = results.map((r) => {
          const { line, snippet } = extractSnippet(r.bestChunk, primaryQuery, 300);
          return {
            docid: `#${r.docid}`,
            file: r.displayPath,
            title: r.title,
            score: Math.round(r.score * 100) / 100,
            context: r.context,
            snippet: addLineNumbers(snippet, line),
          };
        });

        nodeRes.writeHead(200, { "Content-Type": "application/json" });
        nodeRes.end(JSON.stringify({ results: formatted }));
        log(`${ts()} POST /query ${params.searches.length} queries (${Date.now() - reqStart}ms)`);
        return;
      }

      if (pathname === "/mcp" && nodeReq.method === "POST") {
        const rawBody = await collectBody(nodeReq);
        const body = JSON.parse(rawBody);
        const label = describeRequest(body);
        const url = `http://localhost:${port}${pathname}`;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (typeof v === "string") headers[k] = v;
        }

        const sessionId = headers["mcp-session-id"];
        let transport: WebStandardStreamableHTTPServerTransport;

        if (sessionId) {
          const existing = sessions.get(sessionId);
          if (!existing) {
            nodeRes.writeHead(404, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found" },
              id: body?.id ?? null,
            }));
            return;
          }
          transport = existing;
        } else if (isInitializeRequest(body)) {
          transport = await createSession();
        } else {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Missing session ID" },
            id: body?.id ?? null,
          }));
          return;
        }

        const request = new Request(url, { method: "POST", headers, body: rawBody });
        const response = await transport.handleRequest(request, { parsedBody: body });

        nodeRes.writeHead(response.status, Object.fromEntries(response.headers));
        nodeRes.end(Buffer.from(await response.arrayBuffer()));
        log(`${ts()} POST /mcp ${label} (${Date.now() - reqStart}ms)`);
        return;
      }

      if (pathname === "/mcp") {
        // GET / DELETE on /mcp — must have a valid session.
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (typeof v === "string") headers[k] = v;
        }

        const sessionId = headers["mcp-session-id"];
        if (!sessionId) {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Missing session ID" },
            id: null,
          }));
          return;
        }
        const transport = sessions.get(sessionId);
        if (!transport) {
          nodeRes.writeHead(404, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          }));
          return;
        }

        const url = `http://localhost:${port}${pathname}`;
        const rawBody = nodeReq.method !== "GET" && nodeReq.method !== "HEAD" ? await collectBody(nodeReq) : undefined;
        const request = new Request(url, { method: nodeReq.method || "GET", headers, ...(rawBody ? { body: rawBody } : {}) });
        const response = await transport.handleRequest(request);
        nodeRes.writeHead(response.status, Object.fromEntries(response.headers));
        nodeRes.end(Buffer.from(await response.arrayBuffer()));
        return;
      }

      nodeRes.writeHead(404);
      nodeRes.end("Not Found");
    } catch (err) {
      console.error("HTTP handler error:", err);
      nodeRes.writeHead(500);
      nodeRes.end("Internal Server Error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(port, "localhost", () => resolve());
  });

  const actualPort = (httpServer.address() as import("net").AddressInfo).port;

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    for (const transport of sessions.values()) {
      await transport.close();
    }
    sessions.clear();
    httpServer.close();
    await store.close();
  };

  process.on("SIGTERM", async () => {
    console.error("Shutting down (SIGTERM)...");
    await stop();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    console.error("Shutting down (SIGINT)...");
    await stop();
    process.exit(0);
  });

  log(`QKB MCP server listening on http://localhost:${actualPort}/mcp`);
  return { httpServer, port: actualPort, stop };
}

// Exported for inspection / future tooling. `_meta` only.
export const REGISTERED_TOOLS: ReadonlyArray<string> = TOOLS.map(
  (t) => t.name,
);
