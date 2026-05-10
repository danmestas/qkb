/**
 * Unit tests for `dispatchCommand` — RFC-0009 PR-4.
 *
 * The dispatch table replaces 17 hypothetical command-file modules with a
 * single map from subcommand name to handler. Each handler is a 1–3 line
 * call into qmd's SDK or qkb's orchestrator. These tests pin the
 * argument-shape contract between the CLI parser (PR-6) / MCP server
 * (PR-5) and the dispatch layer.
 *
 * Mocks `QMDStore` and `orchestrator` — no real DB, no real LLM. Real
 * round-trip is covered in the integration suite for orchestrator and
 * query-with-graph.
 */
import { describe, it, expect, vi } from "vitest";
import { dispatchCommand, type CommandContext } from "../../src/commands.js";

function makeCtx(overrides: Record<string, unknown> = {}): CommandContext {
  return {
    store: {
      search: vi.fn().mockResolvedValue([]),
      searchLex: vi
        .fn()
        .mockResolvedValue([{ file: "a.md", score: 1 }]),
      searchVector: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ file: "a.md", body: "hi" }),
      multiGet: vi.fn().mockResolvedValue({ docs: [], errors: [] }),
      listCollections: vi.fn().mockResolvedValue([]),
      getStatus: vi.fn().mockResolvedValue({ docs: 0 }),
      addCollection: vi.fn().mockResolvedValue(undefined),
      removeCollection: vi.fn().mockResolvedValue(true),
      renameCollection: vi.fn().mockResolvedValue(true),
      addContext: vi.fn().mockResolvedValue(true),
      listContexts: vi.fn().mockResolvedValue([]),
      removeContext: vi.fn().mockResolvedValue(true),
      embed: vi.fn().mockResolvedValue({ embedded: 0 }),
      internal: { db: {} },
      ...overrides,
    },
    orchestrator: {
      run: vi
        .fn()
        .mockResolvedValue({
          indexed: 0,
          updated: 0,
          unchanged: 0,
          removed: 0,
          needsEmbedding: 0,
          graph: { edgesUpserted: 0, nodesPruned: 0, wikiTargetsPruned: 0 },
        }),
    },
    pruneGraphOrphans: vi
      .fn()
      .mockReturnValue({
        edgesUpserted: 0,
        nodesPruned: 0,
        wikiTargetsPruned: 0,
      }),
  } as unknown as CommandContext;
}

describe("dispatchCommand", () => {
  it("search → store.searchLex with limit + collection", async () => {
    const ctx = makeCtx();
    await dispatchCommand(
      "search",
      { query: "hello", limit: 5, collection: "docs" },
      ctx
    );
    expect(ctx.store.searchLex).toHaveBeenCalledWith("hello", {
      limit: 5,
      collection: "docs",
    });
  });

  it("vsearch → store.searchVector", async () => {
    const ctx = makeCtx();
    await dispatchCommand("vsearch", { query: "hi", limit: 3 }, ctx);
    expect(ctx.store.searchVector).toHaveBeenCalledWith("hi", {
      limit: 3,
      collection: undefined,
    });
  });

  it("update → orchestrator.run({collections})", async () => {
    const ctx = makeCtx();
    await dispatchCommand("update", { collections: ["v"] }, ctx);
    expect(ctx.orchestrator.run).toHaveBeenCalledWith({
      collections: ["v"],
    });
  });

  it("update with no collections → orchestrator.run({})", async () => {
    const ctx = makeCtx();
    await dispatchCommand("update", {}, ctx);
    expect(ctx.orchestrator.run).toHaveBeenCalledWith({
      collections: undefined,
    });
  });

  it("status → store.getStatus", async () => {
    const ctx = makeCtx();
    await dispatchCommand("status", {}, ctx);
    expect(ctx.store.getStatus).toHaveBeenCalled();
  });

  it("collection.add → store.addCollection then orchestrator.run scoped to it", async () => {
    const ctx = makeCtx();
    await dispatchCommand(
      "collection.add",
      { name: "v", path: "/tmp/v", pattern: "**/*.md" },
      ctx
    );
    expect(ctx.store.addCollection).toHaveBeenCalledWith("v", {
      path: "/tmp/v",
      pattern: "**/*.md",
      ignore: undefined,
    });
    expect(ctx.orchestrator.run).toHaveBeenCalledWith({ collections: ["v"] });
  });

  it("collection.remove → store.removeCollection then pruneGraphOrphans", async () => {
    const ctx = makeCtx();
    const result = await dispatchCommand(
      "collection.remove",
      { name: "v" },
      ctx
    );
    expect(ctx.store.removeCollection).toHaveBeenCalledWith("v");
    // Pruning runs against the same db as the store. Cheaper than a
    // full orchestrator.run({}) which would re-walk every collection.
    expect(ctx.pruneGraphOrphans).toHaveBeenCalled();
    expect(ctx.orchestrator.run).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("collection.rename → store.renameCollection", async () => {
    const ctx = makeCtx();
    await dispatchCommand(
      "collection.rename",
      { old: "a", new: "b" },
      ctx
    );
    expect(ctx.store.renameCollection).toHaveBeenCalledWith("a", "b");
  });

  it("collection.list → store.listCollections", async () => {
    const ctx = makeCtx();
    await dispatchCommand("collection.list", {}, ctx);
    expect(ctx.store.listCollections).toHaveBeenCalled();
  });

  it("context.add → store.addContext(name, path, text)", async () => {
    const ctx = makeCtx();
    await dispatchCommand(
      "context.add",
      { collection: "v", path: "sub/", text: "hello" },
      ctx
    );
    expect(ctx.store.addContext).toHaveBeenCalledWith("v", "sub/", "hello");
  });

  it("context.list → store.listContexts", async () => {
    const ctx = makeCtx();
    await dispatchCommand("context.list", {}, ctx);
    expect(ctx.store.listContexts).toHaveBeenCalled();
  });

  it("context.rm → store.removeContext", async () => {
    const ctx = makeCtx();
    await dispatchCommand(
      "context.rm",
      { collection: "v", path: "sub/" },
      ctx
    );
    expect(ctx.store.removeContext).toHaveBeenCalledWith("v", "sub/");
  });

  it("context.check → composite contextCheck", async () => {
    const ctx = makeCtx({
      listCollections: vi.fn().mockResolvedValue([
        { name: "v", pwd: "/v", glob_pattern: "**/*.md", doc_count: 1, active_count: 1, last_modified: null, includeByDefault: true },
      ]),
      listContexts: vi.fn().mockResolvedValue([]),
    });
    const result = (await dispatchCommand("context.check", {}, ctx)) as Array<{
      collection: string;
      missing: string[];
    }>;
    expect(result).toEqual([{ collection: "v", missing: ["root"] }]);
  });

  it("get → store.get with includeBody flag", async () => {
    const ctx = makeCtx();
    await dispatchCommand("get", { path: "a.md", includeBody: true }, ctx);
    expect(ctx.store.get).toHaveBeenCalledWith("a.md", { includeBody: true });
  });

  it("multi-get → store.multiGet with pattern + maxBytes", async () => {
    const ctx = makeCtx();
    await dispatchCommand(
      "multi-get",
      { pattern: "**/*.md", maxBytes: 1024, includeBody: true },
      ctx
    );
    expect(ctx.store.multiGet).toHaveBeenCalledWith("**/*.md", {
      includeBody: true,
      maxBytes: 1024,
    });
  });

  it("embed → store.embed forwards options", async () => {
    const ctx = makeCtx();
    await dispatchCommand(
      "embed",
      { force: true, model: "hf:foo/bar" },
      ctx
    );
    expect(ctx.store.embed).toHaveBeenCalledWith({
      force: true,
      model: "hf:foo/bar",
    });
  });

  it("query → queryWithGraph (via store.search + rerank)", async () => {
    // queryWithGraph internally calls store.search with rerank:false. We
    // verify dispatch reaches it by spying on store.search.
    const search = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({ search });
    await dispatchCommand("query", { query: "hi", limit: 5 }, ctx);
    expect(search).toHaveBeenCalled();
    const callArgs = search.mock.calls[0]?.[0] as { rerank: boolean };
    expect(callArgs.rerank).toBe(false);
  });

  it("unknown subcommand throws", async () => {
    const ctx = makeCtx();
    await expect(
      dispatchCommand("nonsense", {}, ctx)
    ).rejects.toThrow(/unknown command/i);
  });
});
