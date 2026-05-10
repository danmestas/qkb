/* qkb-owned utility — carved from qmd's vendored fork during the
 * RFC-0009 thin-wrapper migration. Not tracking upstream qmd.
 *
 * `qkb://` virtual-path parsing. qmd has no notion of qkb's virtual-path
 * scheme — it's purely a qkb CLI/MCP convenience for addressing files
 * across collections without worrying about their absolute filesystem
 * location.
 */

export type VirtualPath = {
  collectionName: string;
  path: string; // relative path within collection
  indexName?: string;
};

/**
 * Normalize explicit virtual path formats to standard qkb:// format.
 * Only handles paths that are already explicitly virtual:
 * - qkb://collection/path.md (already normalized)
 * - qkb:////collection/path.md (extra slashes - normalize)
 * - //collection/path.md (missing qkb: prefix - add it)
 *
 * Does NOT handle:
 * - collection/path.md (bare paths - could be filesystem relative)
 * - :linenum suffix (should be parsed separately before calling this)
 */
export function normalizeVirtualPath(input: string): string {
  let path = input.trim();

  if (path.startsWith('qkb:')) {
    path = path.slice(4);
    path = path.replace(/^\/+/, '');
    return `qkb://${path}`;
  }

  if (path.startsWith('//')) {
    path = path.replace(/^\/+/, '');
    return `qkb://${path}`;
  }

  return path;
}

/**
 * Parse a virtual path like "qkb://collection-name/path/to/file.md"
 * into its components.
 * Also supports collection root: "qkb://collection-name/" or "qkb://collection-name"
 */
export function parseVirtualPath(virtualPath: string): VirtualPath | null {
  const normalized = normalizeVirtualPath(virtualPath);
  const [pathPart = normalized, queryString = ""] = normalized.split("?");

  const match = pathPart.match(/^qkb:\/\/([^\/]+)\/?(.*)$/);
  if (!match?.[1]) return null;
  const indexName = new URLSearchParams(queryString).get("index")?.trim() || undefined;
  return {
    collectionName: match[1],
    path: match[2] ?? '',
    ...(indexName ? { indexName } : {}),
  };
}

/**
 * Build a virtual path from collection name and relative path.
 */
export function buildVirtualPath(collectionName: string, path: string, indexName?: string): string {
  const base = `qkb://${collectionName}/${path}`;
  return indexName ? `${base}?index=${encodeURIComponent(indexName)}` : base;
}

/**
 * Check if a path is explicitly a virtual path.
 * Only recognizes explicit virtual path formats:
 * - qkb://collection/path.md
 * - //collection/path.md
 *
 * Does NOT consider bare collection/path.md as virtual - that should be
 * handled separately by checking if the first component is a collection name.
 */
export function isVirtualPath(path: string): boolean {
  const trimmed = path.trim();
  if (trimmed.startsWith('qkb:')) return true;
  if (trimmed.startsWith('//')) return true;
  return false;
}
