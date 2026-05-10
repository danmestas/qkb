/**
 * LLM-based entity extraction — RFC-0007 Phase 2D.
 *
 * Pure function: takes an LLM and a text chunk; returns an array of
 * `{ type, name }` entities. Types are constrained to a configured
 * whitelist (validated as Cypher labels by `resolveGraphConfig`).
 *
 * The prompt asks for a JSON array. On parse failure, returns an empty
 * array — extraction is opportunistic; we don't want LLM noise to
 * abort the surrounding indexing run.
 *
 * Wiring policy: extraction is invoked by `qkb graph extract`, NOT
 * inside the `qkb embed` loop. Users opt into the LLM cost explicitly
 * after embedding completes, which keeps embed perf characteristics
 * unchanged and makes the resource cost visible.
 */
import type { LLM } from "../internals/llm.js";

export interface Entity {
  type: string;
  name: string;
}

export interface ExtractEntitiesOptions {
  /** Override the default model. Falls back to the LLM's configured generate model. */
  model?: string;
  /** Soft cap on chunk text length (chars). Default 4000 — fits comfortably in
   *  most generate-context windows. */
  maxChars?: number;
  /** Maximum entities returned per chunk. Default 25. */
  maxEntities?: number;
}

const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_MAX_ENTITIES = 25;

const buildPrompt = (text: string, types: ReadonlyArray<string>): string =>
  `Extract named entities from the TEXT below. Return ONLY a JSON array,\n` +
  `no prose. Each item has shape {"type": "...", "name": "..."}.\n` +
  `\n` +
  `Allowed types: ${types.join(", ")}.\n` +
  `Only include EXPLICIT named mentions. Do not infer entities not\n` +
  `present in the text. Do not include common nouns. If the text\n` +
  `contains no extractable entities, return [].\n` +
  `\n` +
  `TEXT:\n${text}\n` +
  `\n` +
  `JSON:`;

/**
 * Parse the LLM's response. Tolerates leading/trailing prose, code
 * fences, and trailing whitespace. Returns an empty array on any
 * failure path — extraction is opportunistic.
 */
export function parseEntityResponse(
  response: string,
  allowedTypes: ReadonlyArray<string>,
  maxEntities = DEFAULT_MAX_ENTITIES
): Entity[] {
  if (!response) return [];

  // Strip optional ```json fences.
  let text = response.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1].trim();
  }

  // Try in order: JSON array, NDJSON (line-delimited objects), single
  // object. Different LLMs emit different shapes for "list of entities"
  // depending on prompt + model size. The 1.7B query-expansion model
  // currently default for `models.generate` emits NDJSON-style output
  // even when the prompt asks for an array — accept both.
  let parsed: unknown[] = [];

  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    try {
      const tryArr = JSON.parse(text.slice(arrayStart, arrayEnd + 1));
      if (Array.isArray(tryArr)) parsed = tryArr as unknown[];
    } catch {
      /* fall through to NDJSON */
    }
  }

  if (parsed.length === 0) {
    // NDJSON / line-by-line objects fallback.
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{") || !t.endsWith("}")) continue;
      try {
        parsed.push(JSON.parse(t));
      } catch {
        /* skip malformed line */
      }
    }
  }

  if (parsed.length === 0) return [];

  const allowedSet = new Set(allowedTypes);
  const seen = new Set<string>();
  const entities: Entity[] = [];

  for (const item of parsed) {
    if (entities.length >= maxEntities) break;
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : null;
    const name = typeof obj.name === "string" ? obj.name.trim() : null;
    if (!type || !name) continue;
    if (!allowedSet.has(type)) continue;
    // Dedup on (type, normalized name).
    const key = `${type}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push({ type, name });
  }

  return entities;
}

/**
 * Extract entities from a single chunk of text.
 *
 * Returns `[]` if the LLM is unavailable, returns null/empty, or
 * produces output we can't parse. Caller decides how to react.
 */
export async function extractEntities(
  llm: LLM,
  text: string,
  allowedTypes: ReadonlyArray<string>,
  options: ExtractEntitiesOptions = {}
): Promise<Entity[]> {
  if (allowedTypes.length === 0) return [];
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxEntities = options.maxEntities ?? DEFAULT_MAX_ENTITIES;
  const prompt = buildPrompt(trimmed.slice(0, maxChars), allowedTypes);

  let result;
  try {
    result = await llm.generate(prompt, {
      model: options.model,
      // Reasonable bounds: most lists fit easily in 512 tokens.
      maxTokens: 512,
      temperature: 0.1,
    });
  } catch {
    return [];
  }
  if (!result?.text) return [];

  return parseEntityResponse(result.text, allowedTypes, maxEntities);
}

/**
 * Normalize an entity name for use in a graph node id.
 * Lowercase, replace runs of non-identifier chars with a single
 * underscore, trim leading/trailing underscores.
 */
export function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Build the canonical node id for an entity per RFC §4.2.
 *   `entity:{type}:{normalized_name}`
 */
export function entityNodeId(type: string, name: string): string {
  return `entity:${type}:${normalizeEntityName(name)}`;
}
