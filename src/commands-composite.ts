/**
 * Commands with real composite logic — RFC-0009 §"File layout".
 *
 * Most subcommands are 1–3 line dispatches into qmd's SDK and live in
 * `src/commands.ts`. The handlers here do enough of their own
 * coordination (fan out across collections, diff two SDK calls, shell
 * out to git) that inlining them in the dispatch table would obscure
 * the dispatch shape.
 *
 * Plan-versus-reality deviations (intentional):
 *   - Plan's `contextCheck` only flagged "missing root context" — but
 *     `qkb context check` in 3.x lists every collection regardless of
 *     state and adds "(missing)" annotations on the path side. We
 *     return the same shape the dispatch test pins: per-collection
 *     `{collection, missing}` where `missing` is `["root"]` when no
 *     context rows exist for that collection, `[]` otherwise. Callers
 *     (CLI formatter in PR-6, MCP tool in PR-5) decide how to print it.
 *   - Plan's `updateWithPull` ran `git pull --ff-only` per collection
 *     unconditionally. 3.x has a per-collection `update_command` field
 *     (default `"git pull"`). We honour the simple default here and
 *     leave the customisable pre-update command for a follow-up PR;
 *     the CLI parser will advertise the simple `--pull` flag in PR-6.
 */
import type { QMDStore } from "@tobilu/qmd";
import { execSync } from "node:child_process";
import type { CommandContext } from "./commands.js";

export interface ContextCheckResult {
  /** Collection name the row applies to. */
  collection: string;
  /**
   * What context is missing. `["root"]` when no context rows exist for
   * the collection at all, `[]` when at least one context row exists.
   * Future: per-subdirectory missing markers.
   */
  missing: string[];
}

/**
 * Diff `listCollections()` against `listContexts()` to surface
 * collections that have zero context rows. Run as `qkb context check`.
 *
 * Returns one row per collection. Callers format the output (CLI
 * prints a table, MCP returns the JSON directly).
 */
export async function contextCheck(
  store: QMDStore
): Promise<ContextCheckResult[]> {
  const collections = await store.listCollections();
  const contexts = await store.listContexts();
  const byCollection = new Map<string, Set<string>>();
  for (const c of contexts) {
    if (!byCollection.has(c.collection)) {
      byCollection.set(c.collection, new Set());
    }
    byCollection.get(c.collection)!.add(c.path);
  }
  return collections.map((c) => ({
    collection: c.name,
    missing: byCollection.has(c.name) ? [] : ["root"],
  }));
}

/**
 * Fan out `git pull --ff-only` across every collection's working
 * directory, then run a full re-index via the orchestrator. Callers
 * reach this through `dispatchCommand("update", { pull: true })`.
 *
 * Per-collection failures (not a git repo, dirty tree, network blip)
 * are logged to stderr and do not abort the run. The orchestrator pass
 * still happens so collections without git get re-indexed too.
 */
export async function updateWithPull(
  ctx: CommandContext
): Promise<ReturnType<CommandContext["orchestrator"]["run"]>> {
  const collections = await ctx.store.listCollections();
  for (const c of collections) {
    try {
      execSync("git pull --ff-only", {
        cwd: c.pwd,
        stdio: "inherit",
      });
    } catch {
      // Collection isn't a git repo or pull failed — already surfaced
      // on stderr by the inherited `stdio`. Continue with the next.
    }
  }
  return ctx.orchestrator.run({});
}
