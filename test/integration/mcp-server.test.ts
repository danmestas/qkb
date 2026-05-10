/**
 * Integration test for the qkb 4.0 MCP server — RFC-0009 PR-5.
 *
 * Asserts the in-process MCP server registers the expected tool set
 * (qmd-parity + qkb-only) and that two non-LLM tools round-trip
 * through MCP's JSON-RPC layer end-to-end:
 *
 *   - `status` — reads the index status (no LLM, no graph)
 *   - `neighbors` — exercises the GraphQLite extension via dispatch
 *
 * LLM-bound tools (`query`, `vsearch`, `embed`) are deliberately NOT
 * exercised here — they require model downloads and are covered by
 * PR-3's `query-with-graph.test.ts`. We trust that if `dispatchCommand`
 * works (covered in PR-4 unit tests) and the MCP wiring works (covered
 * here for `status` and `neighbors`), the LLM-bound tools work too.
 *
 * GraphQLite gating mirrors `store-bridge.test.ts` and
 * `orchestrator.test.ts` — if the binary isn't installed, the suite
 * is a no-op rather than a fail. CI on Linux without the binary skips
 * cleanly; macOS dev installs via `brew install graphqlite`.
 *
 * We use a real MCP `Client` linked via `InMemoryTransport` to the
 * `McpServer`, so the assertions exercise the actual JSON-RPC
 * `tools/list` / `tools/call` shapes — same path a stdio client takes
 * — without spawning a child process.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startMcpInProcess,
  REGISTERED_TOOLS,
} from "../../src/mcp/server.js";

const DEFAULT_BREW_PATH =
  "/opt/homebrew/opt/graphqlite/lib/sqlite/graphqlite.dylib";

const HAS_GRAPHQLITE =
  !!process.env.QKB_GRAPHQLITE_PATH || existsSync(DEFAULT_BREW_PATH);

describe.skipIf(!HAS_GRAPHQLITE)("qkb MCP server (in-process)", () => {
  let tmpDir: string;
  let collectionDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "qkb-mcp-"));
    collectionDir = join(tmpDir, "vault");
    await mkdir(collectionDir, { recursive: true });
    // Empty fixture is enough for `status` / `neighbors` shape checks;
    // we don't need a populated index for the wiring assertions.
    await writeFile(join(collectionDir, "alpha.md"), "# Alpha\n");
    dbPath = join(tmpDir, "index.sqlite");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers the expected qmd-parity + qkb-only tool set", async () => {
    const handle = await startMcpInProcess({ dbPath });
    try {
      // Sanity: the static manifest matches what the server module exposes.
      expect(handle.toolNames).toEqual(Array.from(REGISTERED_TOOLS));

      const { tools } = await handle.client.listTools();
      const names = tools.map((t) => t.name).sort();

      // qmd-parity set (RFC §"MCP server" — interchangeable with qmd).
      for (const expected of ["query", "get", "multi_get", "status"]) {
        expect(names).toContain(expected);
      }

      // qkb-only graph + lifecycle tools.
      for (const expected of [
        "search",
        "vsearch",
        "update",
        "embed",
        "neighbors",
      ]) {
        expect(names).toContain(expected);
      }
    } finally {
      await handle.close();
    }
  });

  it("`status` round-trips through MCP and returns the index status", async () => {
    const handle = await startMcpInProcess({ dbPath });
    try {
      const result = await handle.client.callTool({
        name: "status",
        arguments: {},
      });

      // dispatchCommand serialises the result as JSON in a `text` block.
      // Parse it back so we can assert structural shape rather than text.
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content?.[0]?.type).toBe("text");
      const parsed = JSON.parse(content[0]!.text) as {
        totalDocuments?: number;
      };
      expect(typeof parsed.totalDocuments).toBe("number");
    } finally {
      await handle.close();
    }
  });

  it("`neighbors` round-trips through MCP and returns rows + return type", async () => {
    const handle = await startMcpInProcess({ dbPath });
    try {
      // Empty graph — querying a non-existent node should still return a
      // well-formed payload (`rows: []`, `returnType: "id_and_type"` for
      // the default 1-hop case). Exercises the dispatch path through
      // GraphQLite without needing an indexed corpus.
      const result = await handle.client.callTool({
        name: "neighbors",
        arguments: { nodeId: "doc:does-not-exist", hops: 1 },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as {
        rows: unknown[];
        returnType: string;
      };
      expect(Array.isArray(parsed.rows)).toBe(true);
      expect(parsed.returnType).toBe("id_and_type");
    } finally {
      await handle.close();
    }
  });

  it("returns an MCP-level error result for unknown tool names", async () => {
    const handle = await startMcpInProcess({ dbPath });
    try {
      // MCP SDK 1.29 surfaces unknown-tool errors as a normal result with
      // `isError: true` rather than rejecting the call. Either is
      // protocol-conformant; this test just locks the contract.
      const result = await handle.client.callTool({
        name: "not-a-tool",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text ?? "").toMatch(/not[- ]?found|Unknown/i);
    } finally {
      await handle.close();
    }
  });
});
