/**
 * Cypher safety helpers — RFC-0007 §4.7.
 *
 * Currently:
 *   - `validateMaxPathLength(query, max)` — rejects variable-length
 *     patterns whose upper bound exceeds the configured ceiling.
 *
 * Deferred:
 *   - `query_timeout_ms` enforcement: requires SQLite's
 *     `progress_handler` callback, which neither better-sqlite3 nor
 *     bun:sqlite expose in a portable way today. Tracked in PLAN.md.
 */

/**
 * Cypher variable-length relationship pattern. Matches:
 *   - `*` (unbounded)
 *   - `*N` (exactly N)
 *   - `*N..M` (between N and M)
 *   - `*..M` (up to M)
 *   - `*N..` (at least N — also unbounded, treated as ceiling violation)
 *
 * The grouping captures the lower and upper bounds when present.
 */
const VAR_LENGTH_RE = /\*(\d+)?(?:\.\.(\d+)?)?/g;

export class CypherPathLengthError extends Error {
  readonly requestedLength: number;
  readonly maxAllowed: number;

  constructor(requestedLength: number, maxAllowed: number, detail: string) {
    super(detail);
    this.name = "CypherPathLengthError";
    this.requestedLength = requestedLength;
    this.maxAllowed = maxAllowed;
  }
}

/**
 * Validate a Cypher query string against a path-length ceiling.
 * Throws `CypherPathLengthError` if any variable-length relationship
 * pattern can match a path longer than `max`.
 *
 * Conservative by design: when an upper bound is missing (`*`, `*N..`),
 * we treat that as exceeding the cap.
 */
export function validateMaxPathLength(query: string, max: number): void {
  for (const match of query.matchAll(VAR_LENGTH_RE)) {
    const lower = match[1] !== undefined ? Number(match[1]) : undefined;
    const upper = match[2] !== undefined ? Number(match[2]) : undefined;

    // Detect the form to give a useful error.
    const raw = match[0];

    // Bare `*` or `*N..` — unbounded upper.
    const hasNoUpper = upper === undefined;
    const hasRangeSyntax = raw.includes("..");

    // `*` alone, or `*N..` — unbounded.
    if (hasNoUpper && (raw === "*" || hasRangeSyntax)) {
      throw new CypherPathLengthError(
        Number.POSITIVE_INFINITY,
        max,
        `Variable-length pattern '${raw}' is unbounded; max_path_length=${max} requires an explicit upper bound.`
      );
    }

    // `*N` (no `..`): exactly N. Use lower (which == upper here).
    // `*N..M`: use M (upper).
    // `*..M`: use M (upper).
    const requested = upper ?? lower ?? 0;
    if (requested > max) {
      throw new CypherPathLengthError(
        requested,
        max,
        `Variable-length pattern '${raw}' exceeds max_path_length=${max} (requested ${requested}).`
      );
    }
  }
}
