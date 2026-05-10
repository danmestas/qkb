/* qkb-owned utility — carved from qmd's vendored fork during the
 * RFC-0009 thin-wrapper migration. Not tracking upstream qmd.
 *
 * Title extraction from document content. qkb's CLI uses this to
 * surface a friendly display name in `ls`, search results, and the
 * MCP server's neighbor responses. qmd's SDK doesn't expose this;
 * extending it would require an upstream PR we've chosen not to file.
 */

const titleExtractors: Record<string, (content: string) => string | null> = {
  '.md': (content) => {
    const match = content.match(/^##?\s+(.+)$/m);
    if (match) {
      const title = (match[1] ?? "").trim();
      if (title === "📝 Notes" || title === "Notes") {
        const nextMatch = content.match(/^##\s+(.+)$/m);
        if (nextMatch?.[1]) return nextMatch[1].trim();
      }
      return title;
    }
    return null;
  },
  '.org': (content) => {
    const titleProp = content.match(/^#\+TITLE:\s*(.+)$/im);
    if (titleProp?.[1]) return titleProp[1].trim();
    const heading = content.match(/^\*+\s+(.+)$/m);
    if (heading?.[1]) return heading[1].trim();
    return null;
  },
};

export function extractTitle(content: string, filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  const extractor = titleExtractors[ext];
  if (extractor) {
    const title = extractor(content);
    if (title) return title;
  }
  return filename.replace(/\.[^.]+$/, "").split("/").pop() || filename;
}
