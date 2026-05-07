/**
 * Graph dump/restore — RFC-0007 §7 (exit-plan tool).
 *
 * Format: QKB-defined NDJSON (decoupled from GraphQLite per D10 in
 * PLAN.md). One JSON object per line:
 *
 *   {"kind":"header","format_version":1,"qkb_version":"...","exported_at":"..."}
 *   {"kind":"node","id":"...","label":"...","properties":{...}}
 *   {"kind":"edge","from":"...","to":"...","type":"...","properties":{...}}
 *
 * Header is required and pinned to format_version=1. Bumps to the
 * version go through a deliberate migration story.
 */
import { runCypher, type CypherQuery } from "./sdk.js";
import type { Store } from "../store.js";
import { readFileSync } from "node:fs";

const FORMAT_VERSION = 1;

export interface DumpHeader {
  kind: "header";
  format_version: number;
  qkb_version: string;
  exported_at: string;
}

export interface DumpNode {
  kind: "node";
  id: string;
  label: string;
  properties: Record<string, unknown>;
}

export interface DumpEdge {
  kind: "edge";
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface ParsedDump {
  header: DumpHeader;
  nodes: DumpNode[];
  edges: DumpEdge[];
}

function getQkbVersion(): string {
  // Read from package.json; fall back gracefully when not available.
  try {
    const pkgUrl = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Walk all nodes and edges in the graph, emit as NDJSON. Returns the
 * full document as a string. Caller writes to stdout / file as
 * appropriate.
 */
export function dumpGraph(store: Store): string {
  const lines: string[] = [];

  const header: DumpHeader = {
    kind: "header",
    format_version: FORMAT_VERSION,
    qkb_version: getQkbVersion(),
    exported_at: new Date().toISOString(),
  };
  lines.push(JSON.stringify(header));

  // GraphQLite v0.4.4 returns properties() as a JSON STRING, not an
  // object. Parse it back. (Confirmed via test/spikes/probe-props.ts.)
  const parseProps = (raw: unknown): Record<string, unknown> => {
    if (raw == null) return {};
    if (typeof raw === "object") return raw as Record<string, unknown>;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        /* fall through */
      }
    }
    return {};
  };

  // Nodes
  const nodeRows = runCypher<{ id: string; label: string; props: unknown }>(
    store.db,
    `MATCH (n) RETURN n.id AS id, labels(n)[0] AS label, properties(n) AS props` as CypherQuery,
    {}
  );
  for (const row of nodeRows) {
    const props = parseProps(row.props);
    delete props.id;

    const node: DumpNode = {
      kind: "node",
      id: row.id,
      label: row.label,
      properties: props,
    };
    lines.push(JSON.stringify(node));
  }

  // Edges. Aliases avoid Cypher reserved keywords (`from`, `to`, `type`).
  const edgeRows = runCypher<{
    src: string;
    dst: string;
    rel_type: string;
    props: unknown;
  }>(
    store.db,
    `MATCH (a)-[r]->(b) RETURN a.id AS src, b.id AS dst, type(r) AS rel_type, properties(r) AS props` as CypherQuery,
    {}
  );
  for (const row of edgeRows) {
    const edge: DumpEdge = {
      kind: "edge",
      from: row.src,
      to: row.dst,
      type: row.rel_type,
      properties: parseProps(row.props),
    };
    lines.push(JSON.stringify(edge));
  }

  return lines.join("\n") + "\n";
}

export function parseDump(text: string): ParsedDump {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new SyntaxError("graph dump: empty input.");
  }

  let header: DumpHeader | undefined;
  const nodes: DumpNode[] = [];
  const edges: DumpEdge[] = [];

  for (const [idx, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new SyntaxError(
        `graph dump: failed to parse JSON on line ${idx + 1}: ${(err as Error).message}`
      );
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SyntaxError(
        `graph dump: line ${idx + 1} is not a JSON object.`
      );
    }
    const obj = parsed as Record<string, unknown>;
    const kind = obj.kind;

    if (kind === "header") {
      header = obj as unknown as DumpHeader;
      if (header.format_version !== FORMAT_VERSION) {
        throw new SyntaxError(
          `graph dump: unsupported format_version=${header.format_version} (expected ${FORMAT_VERSION}).`
        );
      }
    } else if (kind === "node") {
      nodes.push(obj as unknown as DumpNode);
    } else if (kind === "edge") {
      edges.push(obj as unknown as DumpEdge);
    } else {
      throw new SyntaxError(
        `graph dump: line ${idx + 1} has unknown kind: ${JSON.stringify(kind)}.`
      );
    }
  }

  if (!header) {
    throw new SyntaxError(
      "graph dump: missing required header line (must be the first non-blank line)."
    );
  }

  return { header, nodes, edges };
}

/**
 * Restore a parsed dump (or NDJSON text) into the store via SDK upsert
 * calls. Returns counts.
 */
export function restoreGraph(
  store: Store,
  textOrParsed: string | ParsedDump
): { nodes: number; edges: number } {
  const parsed =
    typeof textOrParsed === "string" ? parseDump(textOrParsed) : textOrParsed;

  for (const n of parsed.nodes) {
    store.graph.upsertNode({
      id: n.id,
      label: n.label,
      properties: n.properties ?? {},
    });
  }
  for (const e of parsed.edges) {
    store.graph.upsertEdge({
      from: e.from,
      to: e.to,
      type: e.type,
      properties: e.properties ?? {},
    });
  }

  return { nodes: parsed.nodes.length, edges: parsed.edges.length };
}
