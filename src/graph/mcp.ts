/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MCP tools for the graph layer — RFC-0007 §4.6.3.
 *
 * Two tools, registered separately from the rest of the QKB MCP surface:
 *
 *   - graph_query(cypher, params): mirrors the SDK rules. Same parameter
 *     enforcement as the CLI (§4.6.2) — refuses queries with $-prefixed
 *     identifiers when params is empty/missing.
 *
 *   - graph_neighbors(node_id, hops, edge_types?): constrained traversal
 *     for agents that don't speak Cypher. hops capped at 3.
 *
 * Deliberately NOT exposed via MCP per RFC §4.6.3:
 *   - PageRank (and any O(N) global algorithm): too easy for an agent to
 *     trigger resource exhaustion.
 *   - gc: mutating, not appropriate for opportunistic tool callers.
 *
 * Handlers are pure functions returning the MCP-shaped result object so
 * they can be unit-tested without spinning up an actual MCP server.
 */
import { z } from "zod";
import {
  isGraphLayerAvailable,
  getGraphLayerUnavailableReason,
  type Store,
} from "../store.js";
import {
  runCypher,
  type CypherQuery,
  findNeighbors,
  validateFindNeighborsArgs,
} from "./sdk.js";

const DOLLAR_VAR_RE = /\$[A-Za-z_][A-Za-z0-9_]*/g;

export interface GraphMcpResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface GraphQueryArgs {
  cypher: string;
  params?: Record<string, unknown>;
}

export interface GraphNeighborsArgs {
  node_id: string;
  hops: number;
  edge_types?: string[];
}

function unavailable(toolName: string): GraphMcpResult {
  const reason = getGraphLayerUnavailableReason() ?? "unknown";
  return {
    content: [
      {
        type: "text",
        text:
          `${toolName}: graph layer is unavailable (${reason}). ` +
          `Set graph.enabled=true in ~/.config/qkb/index.yml and ` +
          `ensure GraphQLite is installed.`,
      },
    ],
    isError: true,
  };
}

export function runGraphQuery(
  store: Store,
  args: GraphQueryArgs
): GraphMcpResult {
  const { cypher, params = {} } = args;
  const dollarVars = cypher.match(DOLLAR_VAR_RE);
  const hasParams = Object.keys(params).length > 0;
  if (dollarVars && dollarVars.length > 0 && !hasParams) {
    return {
      content: [
        {
          type: "text",
          text:
            `graph_query: cypher contains parameter references ` +
            `(${[...new Set(dollarVars)].join(", ")}) but params is empty. ` +
            `Pass parameters as an object: { ${[...new Set(dollarVars)]
              .map((v) => `"${v.slice(1)}": ...`)
              .join(", ")} }.`,
        },
      ],
      isError: true,
    };
  }

  if (!isGraphLayerAvailable()) return unavailable("graph_query");

  try {
    const rows = runCypher(store.db, cypher as CypherQuery, params);
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      structuredContent: { rows },
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `graph_query: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}

export function runGraphNeighbors(
  store: Store,
  args: GraphNeighborsArgs
): GraphMcpResult {
  // Validate args *before* checking layer availability so callers see
  // shape errors regardless of whether GraphQLite is loaded — the
  // tests in `graph-mcp.test.ts > graph_neighbors hop limit (always-on)`
  // run on platforms without the binary and rely on this ordering.
  try {
    validateFindNeighborsArgs({
      nodeId: args.node_id,
      hops: args.hops,
      edgeTypes: args.edge_types,
    });
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `graph_neighbors: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }

  if (!isGraphLayerAvailable()) return unavailable("graph_neighbors");

  try {
    const { rows, returnType } = findNeighbors(store.db, {
      nodeId: args.node_id,
      hops: args.hops,
      edgeTypes: args.edge_types,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      structuredContent: { neighbors: rows, return_type: returnType },
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `graph_neighbors: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}


/**
 * Register the graph MCP tools on a server. Called from
 * `src/mcp/server.ts`'s `createMcpServer(store)` after the existing
 * tool registrations.
 *
 * The tools are registered unconditionally — when the graph layer is
 * unavailable, calls return `isError: true` with a clear reason. This
 * lets agents discover the surface and learn how to enable it.
 */
export function registerGraphMcpTools(server: any, store: Store): void {
  server.registerTool(
    "graph_query",
    {
      title: "Graph Query (Cypher)",
      description:
        "Run a parameterized Cypher query against the QKB graph layer. " +
        "PARAMS RULES: any \$-prefixed identifier in the cypher text MUST " +
        "be supplied via the params object — the tool refuses unparameterized " +
        "queries that contain references. Returns rows as a JSON array.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        cypher: z.string().describe("Cypher query text. Use \$paramName for parameters."),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .default({})
          .describe("Object mapping parameter names (without the leading \$) to values."),
      },
    },
    async (args: GraphQueryArgs) => runGraphQuery(store, args),
  );

  server.registerTool(
    "graph_neighbors",
    {
      title: "Graph Neighbors (Constrained Traversal)",
      description:
        "Find nodes reachable from a given node id within N hops, optionally " +
        "filtered by edge type(s). For hops=1 returns id+type per edge; for " +
        "hops>1 returns reachable node ids only (paths may span multiple " +
        "edge types). Maximum hops is 3 — for deeper traversal use graph_query.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        node_id: z.string().describe("Starting node id (e.g. 'entity:person:alice')."),
        hops: z.number().int().min(1).max(3).describe("Hop limit (1-3 inclusive)."),
        edge_types: z
          .array(z.string())
          .optional()
          .describe("Optional whitelist of edge type names. Identifiers only (alphanumeric+underscore)."),
      },
    },
    async (args: GraphNeighborsArgs) => runGraphNeighbors(store, args),
  );
}
