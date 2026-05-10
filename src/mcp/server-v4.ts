/**
 * qkb MCP server (4.0) — RFC-0009 PR-5.
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
 * Why a new file (`server-v4.ts`) rather than overwriting the 3.x
 * `server.ts` in this PR: the 3.x file is still imported by
 * `src/cli/qkb.ts` and `test/mcp.test.ts`. PR-7 ("DELETE vendored
 * code") will rip the old file out wholesale; until then the two
 * coexist. The new file owns the single name `qkb-mcp-v4` that the
 * cutover (PR-6) wires the CLI's `mcp` subcommand to.
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
 *     scope. PR-7 (or a future follow-up) widens if needed.
 *   - Plan's `McpHandle.listTools` returned `[{name}]` only and used a
 *     hand-rolled `concat`. We expose a real in-process MCP client
 *     instead via `InMemoryTransport.createLinkedPair()` so tests
 *     exercise the actual MCP wire format — same path a stdio client
 *     takes — without a separate process.
 *
 * Transports preserved from today's qkb (per RFC §"MCP server" /
 * "follow today's qkb patterns"):
 *   - stdio:           `startMcpStdio({dbPath})`
 *   - HTTP foreground: `startMcpHttpServer(port)` — TODO in PR-6
 *   - HTTP daemon:     CLI handles spawn/PID; this module is the body
 *
 * For HTTP/daemon parity in this PR we re-export the existing 3.x
 * `startMcpHttpServer` from `./server.js`. The 4.0 stdio surface uses
 * the new in-process server. The HTTP and daemon paths get fully
 * cut over in PR-6 alongside the CLI.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openStore } from "../store-bridge.js";
import {
  dispatchCommand,
  type CommandContext,
} from "../commands.js";
import { run as orchestratorRun } from "../orchestrator/index-orchestrator.js";
import * as schemas from "./schemas.js";
import type { QMDStore } from "@tobilu/qmd";

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

// ─── HTTP transports (deferred to PR-6) ───────────────────────────

/**
 * HTTP transport for the 4.0 MCP server.
 *
 * For PR-5 we re-export the 3.x HTTP server. PR-6 (CLI cutover) will
 * port the HTTP/daemon implementations onto this 4.0 server. Keeping
 * the re-export here means today's `qkb mcp --http` keeps working
 * across the whole 4.0 branch — see RFC §"MCP server" "HTTP/stdio/
 * daemon modes follow today's qkb patterns".
 */
export { startMcpHttpServer, type HttpServerHandle } from "./server.js";

// Exported for inspection / future tooling. `_meta` only.
export const REGISTERED_TOOLS: ReadonlyArray<string> = TOOLS.map(
  (t) => t.name,
);
