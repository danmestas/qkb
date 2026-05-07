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
import { runCypher, type CypherQuery } from "./sdk.js";

const DOLLAR_VAR_RE = /\$[A-Za-z_][A-Za-z0-9_]*/g;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  const { node_id, hops, edge_types } = args;

  if (!Number.isInteger(hops) || hops < 1 || hops > 3) {
    return {
      content: [
        {
          type: "text",
          text: `graph_neighbors: hops must be an integer in [1, 3] (got ${hops}).`,
        },
      ],
      isError: true,
    };
  }

  if (edge_types !== undefined) {
    for (const t of edge_types) {
      if (!IDENT_RE.test(t)) {
        return {
          content: [
            {
              type: "text",
              text: `graph_neighbors: invalid edge type ${JSON.stringify(t)}. Must match ${IDENT_RE}.`,
            },
          ],
          isError: true,
        };
      }
    }
  }

  if (!isGraphLayerAvailable()) return unavailable("graph_neighbors");

  // GraphQLite v0.4.4: `[r*1..N]` combined with `type(r)` in RETURN
  // throws "no such column: _gql_default_alias_*.id". So:
  //   - hops=1: use `[r:type|...]->` form, return both id and edge type.
  //   - hops>1: use `[*1..N:type|...]->` form, return id only (type is
  //     ambiguous along a multi-hop path anyway).
  const typeFilter =
    edge_types && edge_types.length > 0
      ? edge_types.join("|")
      : "";

  let cypher: string;
  let returnType: "id_only" | "id_and_type";

  if (hops === 1) {
    const relPattern = typeFilter ? `[r:${typeFilter}]` : "[r]";
    cypher = `MATCH (a {id: $id})-${relPattern}->(b) RETURN DISTINCT b.id AS id, type(r) AS type`;
    returnType = "id_and_type";
  } else {
    const varPattern = typeFilter
      ? `[:${typeFilter}*1..${hops}]`
      : `[*1..${hops}]`;
    cypher = `MATCH (a {id: $id})-${varPattern}->(b) RETURN DISTINCT b.id AS id`;
    returnType = "id_only";
  }

  try {
    const rows = runCypher<{ id: string; type?: string }>(
      store.db,
      cypher as CypherQuery,
      { id: node_id }
    );
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
