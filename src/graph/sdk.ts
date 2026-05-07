/**
 * Graph SDK — RFC-0007 §4.6.1.
 *
 * Public surface attached to `store.graph.*`:
 *   - `upsertNode({ id, label, properties })` — typed write helper
 *   - `upsertEdge({ from, to, type, properties })` — typed write helper
 *   - `cypher<T>(query, params): T[]` — escape hatch for arbitrary Cypher
 *   - `cypher` tagged-template helper that produces a branded `CypherQuery`
 *
 * The branded type prevents accidental string interpolation: callers must
 * use the `cypher` template tag (which rejects values), and the SDK only
 * accepts that branded type. Direct concatenation with user input fails
 * at the type level *and* at runtime.
 */
import type { Database } from "../db.js";
import { validateMaxPathLength } from "./safety.js";

declare const __cypherBrand: unique symbol;

/**
 * Branded Cypher query string. Created only via the `cypher` template tag.
 * Direct casts are technically possible but the runtime guard in `cypher`
 * catches the common mistake (template literals with interpolation).
 */
export type CypherQuery = string & { readonly [__cypherBrand]: true };

/**
 * Tagged-template helper. Accepts only template literals with no
 * interpolations. The `never[]` value parameter is what makes
 * `cypher\`MATCH ${userInput}\`` fail at compile time.
 *
 * Runtime guard catches cases where TypeScript is bypassed (e.g.
 * `(cypher as any)` or JS callers).
 */
export function cypher(
  strings: TemplateStringsArray,
  ...values: never[]
): CypherQuery {
  if (values.length > 0) {
    throw new TypeError(
      "cypher`...`: interpolation is not allowed in value positions. " +
        "Use parameter binding via the second argument to store.graph.cypher() instead."
    );
  }
  // strings.raw is what the user typed verbatim — safe by construction
  // since we just rejected interpolations.
  return strings.raw[0] as CypherQuery;
}

export interface UpsertNodeArgs {
  id: string;
  label: string;
  properties?: Record<string, unknown>;
}

export interface UpsertEdgeArgs {
  from: string;
  to: string;
  type: string;
  properties?: Record<string, unknown>;
}

/**
 * Run a Cypher query against the graph and return rows as a typed array.
 *
 * GraphQLite's `cypher(query, params_json)` returns a JSON-array-of-objects
 * string; we parse it. For write queries with no `RETURN`, GraphQLite
 * returns a status string — if you don't need the result, ignore the
 * return value.
 */
export function runCypher<T = Record<string, unknown>>(
  db: Database,
  query: CypherQuery,
  params: Record<string, unknown> = {},
  maxPathLength?: number
): T[] {
  if (maxPathLength !== undefined) {
    validateMaxPathLength(query, maxPathLength);
  }
  const paramsJson = JSON.stringify(params);
  const row = db
    .prepare("SELECT cypher(?, ?) AS r")
    .get(query, paramsJson) as { r: string } | undefined;

  if (!row) return [];
  const parsed = JSON.parse(row.r) as unknown;

  if (Array.isArray(parsed)) return parsed as T[];

  // Non-array means status string from a write query — caller didn't
  // ask for typed rows, return empty.
  return [];
}

export interface PageRankArgs {
  /** Damping factor in (0, 1). Default 0.85. */
  damping?: number;
  /** Maximum iterations. Default 20. */
  iterations?: number;
}

export interface PageRankRow {
  node_id: string;
  user_id: string;
  score: number;
}

/**
 * Run GraphQLite's PageRank algorithm and return ranked nodes.
 *
 * Uses the `RETURN pageRank(d, i)` form rather than `CALL pageRank() YIELD ...`
 * because the result comes back as a JSON array we can parse uniformly.
 * `gql_load_graph()` is a no-op when already loaded.
 */
export function runPageRank(
  db: Database,
  args: PageRankArgs = {}
): PageRankRow[] {
  const damping = args.damping ?? 0.85;
  const iterations = args.iterations ?? 20;

  // Materialize adjacency cache (idempotent).
  try {
    db.prepare("SELECT cypher(?)").get("CALL gql_load_graph()");
  } catch {
    // Older versions or environments without gql_load_graph — non-fatal.
  }

  const row = db
    .prepare("SELECT cypher(?) AS r")
    .get(
      `RETURN pageRank(${damping.toFixed(4)}, ${Math.floor(iterations)})`
    ) as { r: string } | undefined;

  if (!row) return [];
  // pageRank returns a JSON array of {node_id, user_id, score} objects.
  const parsed = JSON.parse(row.r) as unknown;
  if (!Array.isArray(parsed)) return [];

  // The actual envelope is `[{ "pageRank(...)": [{...}, {...}] }]` in some
  // versions or just `[{...}, {...}]` in others. Handle both.
  if (parsed.length === 1 && typeof parsed[0] === "object" && parsed[0] !== null) {
    const obj = parsed[0] as Record<string, unknown>;
    const inner = Object.values(obj)[0];
    if (Array.isArray(inner)) return inner as PageRankRow[];
  }

  return parsed as PageRankRow[];
}

/**
 * Upsert a node by external `id`. If a node with the same id and label
 * exists, properties are merged via `SET n += $props`. Idempotent.
 *
 * **GraphQLite v0.4.4 quirks** (full evidence in `test/spikes/probe-merge-syntax.ts`):
 *  - `MERGE (n:Label {id: $id})` — `$id` silently null inside MERGE pattern.
 *  - `CREATE (n:Label {id: $id}) SET n += $props` — combining CREATE + SET
 *    in ONE cypher() call drops the SET (props don't land).
 *
 * Working pattern (used here):
 *  1. MATCH probe to detect existence.
 *  2a. Exists → `MATCH ... SET n += $props` (single call, props land).
 *  2b. Missing → `CREATE (n:Label {id: $p_id, key: $p_key, ...})` with all
 *      properties inlined (single call). Inline `$param` in CREATE works.
 *
 * Worst case is 2 cypher() calls per upsert — acceptable for now.
 * Re-evaluate when GraphQLite ships the MERGE-with-$param fix.
 */
export function runUpsertNode(db: Database, args: UpsertNodeArgs): void {
  const { id, label, properties = {} } = args;
  const labelStr = escapeLabel(label);

  const matchRow = db
    .prepare("SELECT cypher(?, ?) AS r")
    .get(
      `MATCH (n:${labelStr} {id: $id}) RETURN n.id AS id`,
      JSON.stringify({ id })
    ) as { r: string };

  const exists = (JSON.parse(matchRow.r) as unknown[]).length > 0;

  if (exists) {
    // SET on a MATCH-bound node carries props correctly.
    db.prepare("SELECT cypher(?, ?)").get(
      `MATCH (n:${labelStr} {id: $id}) SET n += $props RETURN 1`,
      JSON.stringify({ id, props: { ...properties, id } })
    );
  } else {
    // Inline ALL properties in CREATE (the SET-after-CREATE bug means we
    // can't separate them in a single call). Property keys are validated
    // by buildInlinePropMap.
    const { mapStr, params: propParams } = buildInlinePropMap({
      ...properties,
      id,
    });
    db.prepare("SELECT cypher(?, ?)").get(
      `CREATE (n:${labelStr}${mapStr}) RETURN 1`,
      JSON.stringify(propParams)
    );
  }
}

/**
 * Upsert a typed edge between two existing (or to-be-created) nodes.
 * Both endpoints are matched by their external `id`; if no matching
 * node exists, MERGE creates a placeholder node with just `{id}`.
 *
 * **Limitation**: in GraphQLite v0.4.4, `SET r += $props` on a relationship
 * variable bound by MERGE throws `Unbound variable in bulk SET: r` (an
 * upstream bug; see GraphQLite CHANGELOG re: MERGE+SET data-loss class).
 * To work around it we put properties INLINE in the MERGE pattern. The
 * net effect is that edge identity is `(from, to, type, properties)`
 * rather than `(from, to, type)` — re-upserting the same edge with
 * different properties creates a new edge instead of updating. Document
 * this in the SDK reference; revisit when GraphQLite ≥ v0.4.5 lands the
 * fix.
 */
export function runUpsertEdge(db: Database, args: UpsertEdgeArgs): void {
  const { from, to, type, properties = {} } = args;
  const { mapStr, params: propParams } = buildInlinePropMap(properties);

  // Chained MERGE doesn't propagate node variables across statements in
  // GraphQLite v0.4.4. We require both endpoints to exist (caller must
  // upsertNode them first) and use explicit MATCH for both — which works.
  // Inline props in a MERGE'd relationship pattern *do* honour $params
  // (only the node-MERGE-with-$param case is broken).
  const query =
    `MATCH (a {id: $from}), (b {id: $to}) ` +
    `MERGE (a)-[:${escapeRelType(type)}${mapStr}]->(b) ` +
    `RETURN 1`;

  db.prepare("SELECT cypher(?, ?)").get(
    query,
    JSON.stringify({ from, to, ...propParams })
  );
}

/**
 * Build a Cypher property map literal `{key1: $p_key1, key2: $p_key2}`
 * with values bound as named parameters. Keys are validated against
 * `IDENT_RE` to prevent any injection vector via key names.
 */
function buildInlinePropMap(
  properties: Record<string, unknown>
): { mapStr: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (!IDENT_RE.test(key)) {
      throw new TypeError(
        `Invalid property key: ${JSON.stringify(key)}. Must match ${IDENT_RE}.`
      );
    }
    const paramName = `p_${key}`;
    parts.push(`${key}: $${paramName}`);
    params[paramName] = value;
  }
  if (parts.length === 0) return { mapStr: "", params };
  return { mapStr: ` {${parts.join(", ")}}`, params };
}

/**
 * Cypher labels and relationship types must be valid identifiers
 * (alphanumeric + underscore). We reject anything else rather than
 * trying to escape. Caller bug if this fires.
 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function escapeLabel(label: string): string {
  if (!IDENT_RE.test(label)) {
    throw new TypeError(
      `Invalid graph node label: ${JSON.stringify(label)}. Must match ${IDENT_RE}.`
    );
  }
  return label;
}

function escapeRelType(type: string): string {
  if (!IDENT_RE.test(type)) {
    throw new TypeError(
      `Invalid graph edge type: ${JSON.stringify(type)}. Must match ${IDENT_RE}.`
    );
  }
  return type;
}
