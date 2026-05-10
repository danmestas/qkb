/**
 * Graph layer configuration — RFC-0007.
 *
 * The `graph.*` section of `~/.config/qkb/index.yml`. Off by default; the
 * feature is opt-in for at least the v2.2.x → v2.3.x release window.
 */
import { z } from "zod";
import type { CollectionConfig } from "../internals/collections-yaml.js";

/**
 * Hard ceiling on `max_path_length`. Cypher variable-length patterns
 * grow exponentially with depth; capping at 12 prevents accidental
 * runaway queries. Users can override per-PR if they really need
 * deeper traversal, but the default ceiling is non-negotiable.
 */
const MAX_PATH_LENGTH_CEILING = 12;

/**
 * Identifier regex shared with the SDK — entity-extraction `types` are
 * used as Cypher labels at upsert time, so they must be valid
 * identifiers (alphanumeric + underscore, leading non-digit).
 */
const ENTITY_TYPE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const entityExtractionSchema = z.object({
  enabled: z.boolean().default(false),
  /** Optional override of the generate-model URI. When unset, falls
   *  back to whatever the user has configured under `models.generate`
   *  in the main config (or the built-in default). */
  model: z.string().min(1).optional(),
  /** Cypher labels to use for extracted entities. Default is a sensible
   *  three-way split that covers most knowledge-base use cases. */
  types: z
    .array(
      z
        .string()
        .regex(ENTITY_TYPE_RE, {
          message:
            "entity_extraction.types entries must be valid Cypher identifiers (alphanumeric + underscore, leading non-digit)",
        })
    )
    .min(1)
    .default(["Person", "Organization", "Concept"]),
});

const graphConfigSchema = z.object({
  // RFC-0007 Phase 3: default flipped from false → true. Users who
  // explicitly set `enabled: false` continue to opt out. Users with no
  // graph block in their config now get the layer enabled by default
  // (still gracefully degrades to disabled if the GraphQLite extension
  // can't be loaded).
  enabled: z.boolean({ message: "graph.enabled must be a boolean" }).default(true),
  bulk_insert_threshold: z.number().int().positive().default(64),
  query_timeout_ms: z.number().int().positive().default(5000),
  max_path_length: z
    .number()
    .int()
    .positive()
    .max(MAX_PATH_LENGTH_CEILING)
    .default(6),
  // .default(() => parse({})) is the zod 4.x idiom for "trigger the
  // inner schema's own defaults" — passing a literal `{}` bypasses
  // the inner schema's `.default()` chain.
  entity_extraction: entityExtractionSchema.default(() =>
    entityExtractionSchema.parse({})
  ),
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
