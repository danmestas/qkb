/**
 * Vault-aware structural graph extraction for Obsidian-style wikis.
 *
 * Inspired by the `vault-ingest` and `vault-query` skills in
 * flight-planner-kb. The vault is a typed knowledge graph already —
 * each markdown file declares its `type:` in frontmatter, links to
 * other notes via `[[Wikilink]]`, embeds via `![[Embed]]`, and uses
 * `aliases:` for additional reference keys. We parse all of that into
 * the GraphQLite layer with no LLM in the loop.
 *
 * Extracted relationships:
 *   - LINKS_TO    `(:Note)-[:LINKS_TO]->(:Note)`         (resolved wikilink)
 *   - LINKS_TO    `(:Note)-[:LINKS_TO]->(:WikiTarget)`   (unresolved)
 *   - EMBEDS      `(:Note)-[:EMBEDS]->(:Note)`           (resolved `![[X]]`)
 *   - REFERENCES  `(:Note)-[:REFERENCES]->(:Note)`       (resolved `](rel.md)`)
 *
 * Node labels (priority order):
 *   1. Frontmatter `type:` field (entity → Entity, concept → Concept, etc.)
 *   2. Path-based: `wiki/entities/*.md` → Entity, `wiki/concepts/*.md`
 *      → Concept, etc. (covers untyped pages in known dirs)
 *   3. Generic `Note`
 *
 * The Obsidian wikilink resolution rule (we mirror it):
 *   - `[[Foo]]` resolves to the doc whose filename is `Foo.md` first
 *   - falling back to `Foo/index.md`
 *   - frontmatter `aliases:` provides additional resolver keys
 *   - case-insensitive
 */
import { parse as parseYaml } from "yaml";

// Wikilinks must NOT be preceded by `!` (that would be an embed,
// matched separately by EMBED_RE).
const WIKILINK_RE = /(?<!!)\[\[([^\]\n|]+?)(?:\|[^\]\n]*)?\]\]/g;
const EMBED_RE = /!\[\[([^\]\n|]+?)(?:\|[^\]\n]*)?\]\]/g;
const MD_LINK_RE = /\]\(([A-Za-z0-9_./-]+\.md)(?:#[^)]*)?\)/g;
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

export interface ExtractedLinks {
  /** Plain `[[Wikilink]]` targets, deduped, first-seen order. */
  wikilinks: string[];
  /** `![[Embed]]` targets — distinct from wikilinks; intent is inclusion. */
  embeds: string[];
  /** Relative `.md` link targets like `concepts/foo.md`. */
  mdLinks: string[];
}

export function extractLinks(text: string): ExtractedLinks {
  const embeds = new Set<string>();
  for (const m of text.matchAll(EMBED_RE)) {
    if (m[1]) embeds.add(m[1].trim());
  }
  const wikilinks = new Set<string>();
  for (const m of text.matchAll(WIKILINK_RE)) {
    if (m[1]) wikilinks.add(m[1].trim());
  }
  const mdLinks = new Set<string>();
  for (const m of text.matchAll(MD_LINK_RE)) {
    if (m[1]) mdLinks.add(m[1].trim());
  }
  return {
    wikilinks: [...wikilinks],
    embeds: [...embeds],
    mdLinks: [...mdLinks],
  };
}

export interface Frontmatter {
  /** Raw `type:` field if present. */
  type?: string;
  /** `aliases:` array (or single string), all stringified. */
  aliases?: string[];
  /** `title:` if present. */
  title?: string;
}

export function parseFrontmatter(text: string): Frontmatter {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(m[1] ?? "");
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const obj = parsed as Record<string, unknown>;
  const out: Frontmatter = {};
  if (typeof obj.type === "string") out.type = obj.type.trim();
  if (typeof obj.title === "string") out.title = obj.title.trim();
  if (typeof obj.aliases === "string") out.aliases = [obj.aliases];
  else if (Array.isArray(obj.aliases)) {
    out.aliases = obj.aliases.filter((a): a is string => typeof a === "string");
  }
  return out;
}

/**
 * Classify a doc by path when frontmatter `type:` is absent. Mirrors
 * the wiki-ingest naming conventions documented in the vault-ingest
 * skill: `wiki/{entities,concepts,sources,questions,comparisons,
 * domains,meta}/<slug>.md`.
 */
export function classifyByPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.includes("wiki/entities/")) return "Entity";
  if (lower.includes("wiki/concepts/")) return "Concept";
  if (lower.includes("wiki/sources/")) return "Source";
  if (lower.includes("wiki/questions/")) return "Question";
  if (lower.includes("wiki/comparisons/")) return "Comparison";
  if (lower.includes("wiki/domains/")) return "Domain";
  if (lower.includes("wiki/meta/")) return "Meta";
  // Top-level wiki meta pages
  const filename = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (
    filename === "index.md" ||
    filename === "log.md" ||
    filename === "hot.md" ||
    filename === "overview.md"
  ) {
    return "Meta";
  }
  return "Note";
}

/**
 * Capitalize first letter and discard non-alpha so a frontmatter
 * `type: entity` becomes `Entity` (a valid Cypher label).
 */
export function frontmatterTypeToLabel(type: string): string {
  const t = type.trim().replace(/[^A-Za-z0-9]/g, "");
  if (t.length === 0) return "Note";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Pick the best label for a doc: frontmatter type wins, then path
 * classification, then generic Note.
 */
export function chooseLabel(fm: Frontmatter, path: string): string {
  if (fm.type) return frontmatterTypeToLabel(fm.type);
  return classifyByPath(path);
}

export interface DocIndexEntry {
  id: number;
  title: string;
  path: string;
  /** Raw doc body (used to parse frontmatter aliases). */
  doc: string;
}

/**
 * Normalize a wikilink target for matching. Lowercase + strip
 * non-alphanumerics. Mirrors how Obsidian collapses `[[Foo Bar]]`
 * vs `[[foo-bar]]` for matching purposes.
 */
export function normalizeWikilinkTarget(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

/**
 * Build a lookup from normalized wikilink targets → doc id.
 * Each doc registers multiple keys: filename stem, frontmatter title,
 * frontmatter aliases, parent dir name (for `Foo/index.md`).
 */
export function buildResolver(
  docs: ReadonlyArray<DocIndexEntry>
): Map<string, number> {
  const m = new Map<string, number>();
  const set = (key: string | undefined, id: number): void => {
    if (!key) return;
    const k = normalizeWikilinkTarget(key);
    if (k && !m.has(k)) m.set(k, id);
  };

  for (const d of docs) {
    const fm = parseFrontmatter(d.doc);

    // Filename stem (Obsidian's primary resolution key)
    const lastSlash = d.path.lastIndexOf("/");
    const filename = lastSlash >= 0 ? d.path.slice(lastSlash + 1) : d.path;
    const stem = filename.replace(/\.md$/i, "");
    set(stem, d.id);

    // Frontmatter title
    set(fm.title, d.id);

    // documents.title (already populated by qkb update)
    set(d.title, d.id);

    // Aliases
    if (fm.aliases) {
      for (const a of fm.aliases) set(a, d.id);
    }

    // Foo/index.md → parent dir name
    if (/\/index\.md$/i.test(d.path)) {
      const parent = d.path.slice(0, lastSlash);
      const parentLast = parent.lastIndexOf("/");
      const parentName =
        parentLast >= 0 ? parent.slice(parentLast + 1) : parent;
      set(parentName, d.id);
    }
  }
  return m;
}

export interface ResolvedLink {
  target: string;
  docId: number | null;
}

export function resolveLinks(
  rawTargets: ReadonlyArray<string>,
  resolver: Map<string, number>
): ResolvedLink[] {
  return rawTargets.map((t) => {
    // Strip `#section` suffix for matching purposes.
    const baseTarget = t.split("#")[0]?.trim() ?? "";
    const key = normalizeWikilinkTarget(baseTarget);
    const docId = key ? resolver.get(key) ?? null : null;
    return { target: t, docId };
  });
}
