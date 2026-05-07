/**
 * Graph layer configuration — RFC-0007.
 *
 * The `graph.*` section of `~/.config/qkb/index.yml`. Off by default; the
 * feature is opt-in for at least the v2.2.x → v2.3.x release window.
 */
import { z } from "zod";
import type { CollectionConfig } from "../collections.js";

/**
 * Hard ceiling on `max_path_length`. Cypher variable-length patterns
 * grow exponentially with depth; capping at 12 prevents accidental
 * runaway queries. Users can override per-PR if they really need
 * deeper traversal, but the default ceiling is non-negotiable.
 */
const MAX_PATH_LENGTH_CEILING = 12;

const graphConfigSchema = z.object({
  enabled: z.boolean({ message: "graph.enabled must be a boolean" }).default(false),
  bulk_insert_threshold: z.number().int().positive().default(64),
  query_timeout_ms: z.number().int().positive().default(5000),
  max_path_length: z
    .number()
    .int()
    .positive()
    .max(MAX_PATH_LENGTH_CEILING)
    .default(6),
});

/**
 * User-facing graph config (all fields optional in YAML).
 */
export type GraphConfig = z.input<typeof graphConfigSchema>;

/**
 * Fully-resolved graph config, all defaults applied. This is what
 * runtime code reads.
 */
export type ResolvedGraphConfig = z.output<typeof graphConfigSchema>;

/**
 * Apply defaults and validate the `graph` section of a CollectionConfig.
 *
 * Throws `ZodError` (with field-name in the message) on invalid input.
 */
export function resolveGraphConfig(
  config: CollectionConfig
): ResolvedGraphConfig {
  return graphConfigSchema.parse(config.graph ?? {});
}

/**
 * Thrown when a graph SDK / CLI operation is attempted while
 * `graph.enabled` is false. Identifiable via `instanceof`.
 */
export class GraphDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphDisabledError";
  }
}
