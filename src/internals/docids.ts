/* qkb-owned utility — carved from qmd's vendored fork during the
 * RFC-0009 thin-wrapper migration. Not tracking upstream qmd.
 *
 * Docid handling — the short 6-character prefix qkb uses to address
 * documents in CLI flows. qmd has no docid concept on its public SDK
 * surface; the column lives in `documents.hash` but the addressing
 * idiom is qkb's.
 */

/**
 * Extract short docid from a full hash (first 6 characters).
 */
export function getDocid(hash: string): string {
  return hash.slice(0, 6);
}

/**
 * Normalize various docid input formats to a clean hex string.
 * Handles: "#abc123", 'abc123', "abc123", #abc123, abc123
 * Returns the bare hex string.
 */
export function normalizeDocid(docid: string): string {
  let normalized = docid.trim();

  if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1);
  }

  if (normalized.startsWith('#')) {
    normalized = normalized.slice(1);
  }

  return normalized;
}

/**
 * Check if a string looks like a docid reference.
 * Accepts: #abc123, abc123, "#abc123", "abc123", '#abc123', 'abc123'
 * Returns true if the normalized form is a valid hex string of 6+ chars.
 */
export function isDocid(input: string): boolean {
  const normalized = normalizeDocid(input);
  return normalized.length >= 6 && /^[a-f0-9]+$/i.test(normalized);
}
