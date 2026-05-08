/**
 * Tests for vault-aware structural graph extraction.
 *
 * Mirrors the resolution rules from the flight-planner-kb vault-ingest
 * skill: filename-stem first, then frontmatter title/aliases, with
 * normalized matching that collapses Obsidian's case + punctuation
 * variants.
 */
import { describe, it, expect } from "vitest";
import {
  extractLinks,
  parseFrontmatter,
  classifyByPath,
  chooseLabel,
  normalizeWikilinkTarget,
  buildResolver,
  resolveLinks,
} from "../src/graph/wikilink-extraction.js";

describe("extractLinks", () => {
  it("extracts plain wikilinks", () => {
    const r = extractLinks("See [[Partnership Opportunities]] and [[FAA NMS]].");
    expect(r.wikilinks.sort()).toEqual(["FAA NMS", "Partnership Opportunities"]);
  });

  it("extracts piped wikilinks (uses target before |)", () => {
    const r = extractLinks("See [[Partnership Opportunities|partnerships]].");
    expect(r.wikilinks).toEqual(["Partnership Opportunities"]);
  });

  it("extracts embeds separately from wikilinks", () => {
    const r = extractLinks("Body text. ![[diagram.png]] [[Concept]]");
    expect(r.embeds).toEqual(["diagram.png"]);
    expect(r.wikilinks).toEqual(["Concept"]);
  });

  it("extracts markdown .md links (relative paths only)", () => {
    const r = extractLinks(
      "See [the spec](other-doc.md) or [section](deep/nested.md#section)."
    );
    expect(r.mdLinks.sort()).toEqual(["deep/nested.md", "other-doc.md"]);
  });

  it("does not match http(s) markdown URLs", () => {
    const r = extractLinks("[link](https://example.com/page.md)");
    // The MD_LINK_RE only allows alphanumeric + ./-/_ in path → URLs
    // with `:` or `//` are excluded.
    expect(r.mdLinks).toEqual([]);
  });

  it("dedupes wikilinks", () => {
    const r = extractLinks("[[A]] [[A]] [[A]] [[B]]");
    expect(r.wikilinks.sort()).toEqual(["A", "B"]);
  });

  it("does not match wikilinks containing newlines", () => {
    const r = extractLinks("[[multi\nline]]");
    expect(r.wikilinks).toEqual([]);
  });

  it("returns empty arrays on empty input", () => {
    const r = extractLinks("");
    expect(r.wikilinks).toEqual([]);
    expect(r.embeds).toEqual([]);
    expect(r.mdLinks).toEqual([]);
  });
});

describe("parseFrontmatter", () => {
  it("returns empty object when no frontmatter is present", () => {
    expect(parseFrontmatter("# Just a heading\n\nbody")).toEqual({});
  });

  it("extracts type field", () => {
    const text = "---\ntype: entity\ntitle: Foo\n---\nbody";
    expect(parseFrontmatter(text)).toEqual({ type: "entity", title: "Foo" });
  });

  it("extracts aliases as array", () => {
    const text = '---\ntype: concept\naliases:\n  - "AIXM"\n  - "AIXM 5.1.1"\n---\nbody';
    const fm = parseFrontmatter(text);
    expect(fm.type).toBe("concept");
    expect(fm.aliases).toEqual(["AIXM", "AIXM 5.1.1"]);
  });

  it("extracts a single string alias", () => {
    const text = '---\naliases: "Just one"\n---\nbody';
    expect(parseFrontmatter(text).aliases).toEqual(["Just one"]);
  });

  it("returns empty on malformed YAML", () => {
    const text = "---\nthis is { not valid yaml\n---\nbody";
    expect(parseFrontmatter(text)).toEqual({});
  });
});

describe("classifyByPath", () => {
  it.each([
    ["wiki/entities/Acme Corp.md", "Entity"],
    ["wiki/concepts/Missing Middle.md", "Concept"],
    ["wiki/sources/article-2026.md", "Source"],
    ["wiki/questions/why-x.md", "Question"],
    ["wiki/comparisons/A vs B.md", "Comparison"],
    ["wiki/domains/Aviation.md", "Domain"],
    ["wiki/meta/policies.md", "Meta"],
    ["wiki/index.md", "Meta"],
    ["wiki/log.md", "Meta"],
    ["wiki/hot.md", "Meta"],
    ["wiki/overview.md", "Meta"],
    ["misc/random.md", "Note"],
  ])("classifies %s -> %s", (path, expected) => {
    expect(classifyByPath(path)).toBe(expected);
  });
});

describe("chooseLabel", () => {
  it("frontmatter type wins over path", () => {
    expect(chooseLabel({ type: "entity" }, "misc/foo.md")).toBe("Entity");
  });

  it("normalizes frontmatter type case", () => {
    expect(chooseLabel({ type: "entity" }, "x")).toBe("Entity");
    expect(chooseLabel({ type: "Concept" }, "x")).toBe("Concept");
  });

  it("falls back to path classification when no frontmatter type", () => {
    expect(chooseLabel({}, "wiki/concepts/Foo.md")).toBe("Concept");
  });

  it("falls back to Note when nothing matches", () => {
    expect(chooseLabel({}, "random/file.md")).toBe("Note");
  });
});

describe("normalizeWikilinkTarget", () => {
  it("collapses non-alphanumeric runs to nothing for matching", () => {
    expect(normalizeWikilinkTarget("Partnership Opportunities")).toBe(
      "partnershipopportunities"
    );
    expect(normalizeWikilinkTarget("partnership-opportunities")).toBe(
      "partnershipopportunities"
    );
    expect(normalizeWikilinkTarget("AIXM 5.1")).toBe("aixm51");
  });
});

describe("buildResolver + resolveLinks", () => {
  const docs = [
    {
      id: 1,
      title: "Partnership Opportunities",
      path: "wiki/Partnership Opportunities.md",
      doc: "---\ntype: domain\ntitle: Partnership Opportunities\n---\nbody",
    },
    {
      id: 2,
      title: "FAA NMS",
      path: "wiki/concepts/FAA NMS.md",
      doc: "body — no frontmatter",
    },
    {
      id: 3,
      title: "AIXM 5.1",
      path: "wiki/concepts/AIXM 5.1.md",
      doc: '---\naliases:\n  - "AIXM"\n  - "AIXM 5.1.1"\n---\nbody',
    },
    {
      id: 4,
      title: "Foo Bar Domain",
      path: "wiki/domains/foo-bar/index.md",
      doc: "body",
    },
  ];

  it("resolves by filename stem", () => {
    const r = buildResolver(docs);
    expect(resolveLinks(["FAA NMS"], r)[0]?.docId).toBe(2);
  });

  it("resolves by frontmatter alias", () => {
    const r = buildResolver(docs);
    expect(resolveLinks(["AIXM"], r)[0]?.docId).toBe(3);
    expect(resolveLinks(["AIXM 5.1.1"], r)[0]?.docId).toBe(3);
  });

  it("resolves slug ↔ Title-with-spaces (Obsidian-style normalization)", () => {
    const r = buildResolver(docs);
    expect(resolveLinks(["partnership-opportunities"], r)[0]?.docId).toBe(1);
    expect(resolveLinks(["Partnership Opportunities"], r)[0]?.docId).toBe(1);
  });

  it("resolves Foo/index.md by parent dir name", () => {
    const r = buildResolver(docs);
    expect(resolveLinks(["foo-bar"], r)[0]?.docId).toBe(4);
  });

  it("strips #section suffix from wikilinks before matching", () => {
    const r = buildResolver(docs);
    expect(resolveLinks(["FAA NMS#header"], r)[0]?.docId).toBe(2);
  });

  it("returns null docId for unresolved targets", () => {
    const r = buildResolver(docs);
    const resolved = resolveLinks(["Nonexistent"], r);
    expect(resolved[0]?.docId).toBeNull();
    expect(resolved[0]?.target).toBe("Nonexistent");
  });
});
