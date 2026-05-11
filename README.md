# qkb

[![CI](https://github.com/danmestas/qkb/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/danmestas/qkb/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@agent-ops/qkb)](https://www.npmjs.com/package/@agent-ops/qkb)

**A thin wrapper around [qmd](https://github.com/tobi/qmd) that adds a graph-aware search layer for Obsidian-style wiki vaults.**

qmd handles the heavy lifting — BM25 + vector + LLM reranking, all on-device, no cloud. qkb keeps that engine intact and stacks one extra trick on top: a typed wikilink/embed/reference graph that boosts retrieval when the right answer is one or two hops away from a strong lexical match.

Built for vaults where pages link to each other heavily — the [karpathy LLM wiki](https://github.com/karpathy/llm-wiki), Andy Matuschak / Maggie Appleton-style note collections, a flight-planning kb, anything in that shape. If your corpus is flat (no wikilinks), qkb degrades cleanly to plain qmd.

![qkb architecture](assets/qkb-architecture.png)

## Install

```sh
npm install -g @agent-ops/qkb
qkb --help
```

That's it. qmd, sqlite-vec, GraphQLite, and the GGUF models all get pulled or downloaded automatically on first use.

## What it adds over qmd

Two things, both opt-out:

1. **A graph layer.** Every wikilink `[[Foo]]`, embed `![[Bar]]`, or reference becomes a typed edge in a SQLite graph table. At query time, the top-K post-RRF candidates seed a 1-hop graph expansion, and the expanded set is merged back into the rerank pool. RFC-0007 + RFC-0008 in `docs/rfcs/` for the details.

2. **`qkb` CLI shape.** Same surface as `qmd` (`search`, `vsearch`, `query`, `get`, `multi-get`, `mcp`, `status`, `update`, `embed`, `collection`, `context`), plus `graph neighbors` / `graph query` for direct graph navigation. The default `qkb query` includes graph expansion; pass `--no-graph` to match `qmd query` exactly.

## Use it from a Claude Code skill

The headline use case is calling qkb from a vault-query skill, the same way skills call qmd today. Two patterns:

### Modify your existing `vault-query` skill

Swap the retrieval step. Wherever the skill reads the hot cache + index + curated pages, replace it with a single qkb call:

```sh
qkb --index <your-index> query "$QUESTION" --graph -n 8 --files -c <your-collection>
```

That returns the top 8 vault-relative file paths. Read those, synthesize, cite. You get ICAO-on-NOTAM-style transitive hits the curated-reading path misses.

### Or add a parallel `vault-query-graph` skill

Keep the original `vault-query` for AB testing. Mirror its structure but route through qkb. There's a working example in `flight-planner-kb/.claude/skills/vault-query-graph/` if you want a template.

The skill body stays small — qkb does retrieval, the skill does synthesis + citation discipline.

## Benchmarks vs raw vault-query

Tested against a 4-question subset of `flight-planner-kb`, with subagents running each skill end-to-end:

| Metric | vault-query (curated reading) | vault-query-graph (qkb-backed) |
|---|---:|---:|
| Mean wall-clock | 67.6s | **59.8s** (12% faster) |
| Recall vs expected docs | 32% | **65%** (2× better) |
| Synthesis depth wins | 1 / 4 | 3 / 4 |

Full results in `bench/results/skill-bench-vault-query-vs-graph.md`. Underlying retrieval-only comparison across 7 modes (qkb-bm25 / qkb-vector / qkb-hybrid / qkb-graph / qmd-bm25 / qmd-vector / qmd-hybrid) in `bench/results/full-bench-baseline.md`.

### Where qkb-graph is strong

- **Multi-hop conceptual questions.** "What are the international NOTAM coverage requirements?" — ICAO is the canonical answer but the ICAO page doesn't say "NOTAM." Graph traversal from NOTAM-Reform → ICAO lands it. Raw BM25 misses.
- **Entity-relation queries.** "Who built the FAA NMS API?" — the contractor page (CGI Federal) links to FAA NMS via wikilink. qkb finds both; vault-query has to know to look.
- **Speed when your hot/index pages are large.** qkb retrieves directly; vault-query has to chunk through a 30k-token `index.md` first.

### Where qkb-graph is weak (or no-op)

- **Exact-name lookups.** "What is FAA NMS?" — BM25 alone wins; graph expansion is noise. qkb still returns the right answer, just doesn't add value here.
- **Sparsely-linked corpora.** If your vault has 50 wikilinks total, the graph signal is too thin to reshape rankings. The pipeline falls back to plain hybrid retrieval gracefully.
- **Out-of-scope questions.** "Engine-out emergency procedures" against a flight-*planning* vault — no amount of graph hops surfaces an answer. Both approaches correctly admit the gap; qkb-graph just explores more dead-end neighbors before giving up.

## What's under the hood

qkb is ~2k LoC of glue over `@tobilu/qmd` (the upstream qmd package on npm). qmd owns the state engine, schemas, and search; qkb owns the graph layer, CLI dispatch, and a handful of Obsidian-flavored utilities (`qkb://` URL parsing, wikilink extraction, docid hashing) carved into `src/internals/`.

If you want the heavy documentation on indexing, embedding models, RRF tuning, MCP usage, score interpretation, output formats, AI-agent workflows, or anything else qmd already documents — [read qmd's README](https://github.com/tobi/qmd#readme). All of it applies here, byte-identically. qkb just adds `--graph`.

## Architecture decisions

For the longer story:

- [RFC-0007: Graph layer](docs/rfcs/0007-graphqlite-graph-layer.md) — schema, GraphQLite integration, typed edges
- [RFC-0008: Hybrid graph queries](docs/rfcs/0008-hybrid-graph-query.md) — the four blending strategies, why we shipped edge-weighted 1-hop
- [RFC-0009: Thin-wrapper architecture](docs/rfcs/0009-thin-wrapper-architecture.md) — how qkb consumes qmd via SDK without forking

## License

MIT. Same as qmd. Built on qmd's shoulders — credit there.
