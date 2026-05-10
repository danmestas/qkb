/* qkb-owned utility — carved from qmd's vendored fork during the
 * RFC-0009 thin-wrapper migration. Not tracking upstream qmd.
 *
 * LLM-cache key derivation. qkb hashes a (url, body) pair into a stable
 * key for the embeddings/expand/rerank cache table. qmd's SDK doesn't
 * expose this; we own it here.
 */
import { createHash } from "crypto";

export function getCacheKey(url: string, body: object): string {
  const hash = createHash("sha256");
  hash.update(url);
  hash.update(JSON.stringify(body));
  return hash.digest("hex");
}
