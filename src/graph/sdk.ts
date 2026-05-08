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

  // GraphQLite returns one of:
  //   - a JSON array of result objects (read queries with RETURN)
  //   - a status string like "Query executed successfully - nodes
  //     created: N, relationships created: M" (write queries with no
  //     RETURN, or when the executor wants to report status)
  //   - garbled output if a quirk fires
  //
  // JSON.parse throws on the status-string case. Treat any non-parseable
  // or non-array result as "no rows" — the caller of cypher() asked for
  // typed rows, so a write-status return is information they didn't
  // request. Surfacing it would just complicate the typed-array contract.
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.r);
  } catch {
    return [];
  }

  if (Array.isArray(parsed)) return parsed as T[];
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

/**
 * Per-batch caps for the multi-pattern Cypher path. Different shapes
 * have different planner costs:
 *
 * - **CREATE** (`CREATE (m0:L {...}), (m1:L {...}), ...`): no MATCH,
 *   no join planning, scales freely. 100 is plenty.
 * - **MATCH + SET** (`MATCH (n0:L {...}), ... SET n0 += $p0, ...`): each
 *   labeled MATCH consumes ~2 tables in SQLite's join planner, which
 *   caps at 64 tables (`SQLITE_MAX_FROM_TABLES`). 25 leaves headroom.
 * - **MATCH + MERGE for edges** (`MATCH (a0 {...}), (b0 {...}), ...
 *   MERGE (a0)-[:T]->(b0), ...`): two endpoint MATCHes per edge plus
 *   the relationship table. 25 stays well under 64.
 *
 * Bounds were probed empirically against v0.4.4 — see
 * `test/spikes/probe-limit.ts`.
 */
const BULK_CREATE_BATCH = 100;
const BULK_MERGE_BATCH = 25;

/**
 * Bulk upsert nodes. Same semantics as calling `runUpsertNode` for each
 * element (idempotent; existing nodes get `SET n += $props`), but
 * orders of magnitude faster: one Cypher call per chunk of
 * {@link BULK_BATCH_SIZE} instead of two per node.
 *
 * Why this is deep:
 *   - Caller passes a flat array. Internals group by label, probe
 *     existence in one batched MATCH-IN-$ids per label, split into
 *     new vs. existing, then issue:
 *       * one comma-separated `CREATE (m0:L {...}), (m1:L {...}), ...`
 *         for the new bucket, and
 *       * one comma-separated `MATCH (n0 {id:$id0}), ... SET n0 += $p0, ...`
 *         for the existing bucket.
 *
 * **GraphQLite v0.4.4 quirks honored** (see
 * `test/spikes/probe-multi-merge.ts`):
 *   - Comma-separated CREATE works; space-chained CREATE silently runs
 *     only the first statement.
 *   - Single MATCH with comma-separated patterns + single SET with
 *     comma-separated assignments works.
 *   - All chunked inside a SQLite transaction so a mid-batch failure
 *     rolls back the whole bulk.
 */
export function runUpsertNodesBulk(
  db: Database,
  nodes: ReadonlyArray<UpsertNodeArgs>
): void {
  if (nodes.length === 0) return;

  const byLabel = new Map<string, UpsertNodeArgs[]>();
  for (const n of nodes) {
    const list = byLabel.get(n.label) ?? [];
    list.push(n);
    byLabel.set(n.label, list);
  }

  const tx = db.transaction(() => {
    for (const [label, group] of byLabel) {
      // Validate label once per group (cheaper + clearer error if wrong).
      const labelStr = escapeLabel(label);

      // Existence probe in one Cypher call: which of these ids already exist?
      const ids = group.map((n) => n.id);
      const probed = runCypher<{ id: string }>(
        db,
        `MATCH (n:${labelStr}) WHERE n.id IN $ids RETURN n.id AS id` as CypherQuery,
        { ids }
      );
      const existingIds = new Set(probed.map((r) => r.id));

      const newNodes = group.filter((n) => !existingIds.has(n.id));
      const existingNodes = group.filter((n) => existingIds.has(n.id));

      for (let i = 0; i < newNodes.length; i += BULK_CREATE_BATCH) {
        runCreateBatch(db, labelStr, newNodes.slice(i, i + BULK_CREATE_BATCH));
      }
      for (let i = 0; i < existingNodes.length; i += BULK_MERGE_BATCH) {
        runMergeSetBatch(
          db,
          labelStr,
          existingNodes.slice(i, i + BULK_MERGE_BATCH)
        );
      }
    }
  });
  tx();
}

/**
 * Bulk upsert edges. One Cypher call per chunk of {@link BULK_BATCH_SIZE}
 * (instead of one per edge), using a single MATCH clause with
 * comma-separated endpoint patterns and a single MERGE clause with
 * comma-separated edge patterns.
 *
 * On a 5000-edge batch this is roughly 10× faster in-memory and
 * substantially more on disk (each Cypher call fsyncs the WAL; 50
 * fsyncs vs. 5000).
 *
 * **Limitation** (inherited from `runUpsertEdge`): edge properties are
 * inlined into the MERGE pattern, so identity is `(from, to, type,
 * properties)`. Re-upserting the same logical edge with different
 * properties creates a new edge rather than updating. Document this in
 * the public docs.
 */
export function runUpsertEdgesBulk(
  db: Database,
  edges: ReadonlyArray<UpsertEdgeArgs>
): void {
  if (edges.length === 0) return;

  const tx = db.transaction(() => {
    for (let i = 0; i < edges.length; i += BULK_MERGE_BATCH) {
      runEdgeBatch(db, edges.slice(i, i + BULK_MERGE_BATCH));
    }
  });
  tx();
}

function runCreateBatch(
  db: Database,
  labelStr: string,
  nodes: ReadonlyArray<UpsertNodeArgs>
): void {
  const params: Record<string, unknown> = {};
  const parts: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const allProps = { ...(n.properties ?? {}), id: n.id };
    const propParts: string[] = [];
    for (const [key, value] of Object.entries(allProps)) {
      if (!IDENT_RE.test(key)) {
        throw new TypeError(
          `Invalid property key: ${JSON.stringify(key)}. Must match ${IDENT_RE}.`
        );
      }
      const paramName = `p_${key}_${i}`;
      propParts.push(`${key}: $${paramName}`);
      params[paramName] = value;
    }
    parts.push(`(m${i}:${labelStr} {${propParts.join(", ")}})`);
  }
  db.prepare("SELECT cypher(?, ?)").get(
    `CREATE ${parts.join(", ")}`,
    JSON.stringify(params)
  );
}

function runMergeSetBatch(
  db: Database,
  labelStr: string,
  nodes: ReadonlyArray<UpsertNodeArgs>
): void {
  const params: Record<string, unknown> = {};
  const matchParts: string[] = [];
  const setParts: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const idKey = `id_${i}`;
    const propsKey = `props_${i}`;
    params[idKey] = n.id;
    // Validate keys to match per-node validation; props go through
    // bulk SET += so individual key validation happens lazily here.
    for (const key of Object.keys(n.properties ?? {})) {
      if (!IDENT_RE.test(key)) {
        throw new TypeError(
          `Invalid property key: ${JSON.stringify(key)}. Must match ${IDENT_RE}.`
        );
      }
    }
    params[propsKey] = { ...(n.properties ?? {}), id: n.id };
    matchParts.push(`(n${i}:${labelStr} {id: $${idKey}})`);
    setParts.push(`n${i} += $${propsKey}`);
  }
  db.prepare("SELECT cypher(?, ?)").get(
    `MATCH ${matchParts.join(", ")} SET ${setParts.join(", ")}`,
    JSON.stringify(params)
  );
}

function runEdgeBatch(
  db: Database,
  edges: ReadonlyArray<UpsertEdgeArgs>
): void {
  const params: Record<string, unknown> = {};
  const matchParts: string[] = [];
  const mergeParts: string[] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    const fk = `f${i}`;
    const tk = `t${i}`;
    params[fk] = e.from;
    params[tk] = e.to;
    matchParts.push(`(a${i} {id: $${fk}})`, `(b${i} {id: $${tk}})`);

    let propMap = "";
    if (e.properties && Object.keys(e.properties).length > 0) {
      const propParts: string[] = [];
      for (const [key, value] of Object.entries(e.properties)) {
        if (!IDENT_RE.test(key)) {
          throw new TypeError(
            `Invalid property key: ${JSON.stringify(key)}. Must match ${IDENT_RE}.`
          );
        }
        const paramName = `p_${key}_${i}`;
        propParts.push(`${key}: $${paramName}`);
        params[paramName] = value;
      }
      propMap = ` {${propParts.join(", ")}}`;
    }
    mergeParts.push(
      `(a${i})-[:${escapeRelType(e.type)}${propMap}]->(b${i})`
    );
  }
  db.prepare("SELECT cypher(?, ?)").get(
    `MATCH ${matchParts.join(", ")} MERGE ${mergeParts.join(", ")}`,
    JSON.stringify(params)
  );
}
