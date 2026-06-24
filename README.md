# qkb

[![CI](https://github.com/danmestas/qkb/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/danmestas/qkb/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@agent-ops/qkb)](https://www.npmjs.com/package/@agent-ops/qkb)

**Agent-friendly local knowledge-base retrieval for Markdown and Obsidian-style vaults.**

qkb combines deterministic BM25, title-weighted FTS, vector search, and optional ONNX reranking. It also maintains a typed wikilink/embed/reference graph, but the benchmark-backed default keeps graph neighbors out of the primary ranked list. Graph is best used as labeled supporting context after the best primary documents are selected.

Built for agent harnesses that can do their own query planning: the agent supplies expansion queries, qkb retrieves and reranks locally, and no cloud service is required.

![qkb architecture](assets/qkb-architecture.png)

## Install

```sh
npm install -g @agent-ops/qkb
qkb --help
```

qkb pulls runtime dependencies automatically on first use. ONNX embedding/rerank models are the preferred path. GGUF generation is now legacy/optional: qkb no longer needs to keep a local GGUF generator model for the default search strategy.

## Default retrieval strategy

The default `qkb query` strategy is tuned for agent use:

1. Search the original query with normal BM25.
2. Add a second title-weighted FTS stream to reward exact title/entity hits.
3. Search the original query with the configured embedding model.
4. Fuse the streams with RRF.
5. Rerank the fused primary pool unless `--no-rerank` is passed.
6. Let the harness read graph neighbors/backlinks as context when it needs explanation or navigation.

Graph-neighbor candidates no longer compete with exact lexical/vector matches by default. To run the old graph-as-candidate behavior explicitly:

```sh
qkb query "$QUESTION" --graph
```

## Harness-supplied query expansion

Agent harnesses should expand queries before calling qkb, then pass those expansions in directly:

```sh
qkb query "$QUESTION" \
  --expanded-query 'lex: FAA NMS' \
  --expanded-query 'vec: National Airspace System message service' \
  --expanded-query 'hyde: A document describing the FAA NMS API, contractor, and integration requirements' \
  -n 8 --files -c <your-collection>
```

Untyped `--expanded-query` values are searched as both `lex` and `vec`. Typed values support `lex:`, `vec:`, and `hyde:`.

Local GGUF-backed generative expansion is still available for standalone experimentation, but it is off by default:

```sh
qkb query "$QUESTION" --local-expand
```

## What it adds over qmd

1. **Agent-first retrieval.** qkb favors deterministic retrieval plus harness-supplied expansions instead of bundled local generative expansion. This keeps the agent in charge of query planning and avoids a mandatory GGUF generator model.

2. **Title-weighted lexical retrieval.** A cheap extra FTS stream emphasizes document titles and entity names. In the benchmark this was the best quality/latency standalone expansion strategy.

3. **A graph layer.** Every wikilink `[[Foo]]`, embed `![[Bar]]`, or reference becomes a typed edge in SQLite/GraphQLite. Use `qkb graph neighbors`, `qkb graph query`, or `qkb query --graph` when you explicitly want graph-neighbor candidates to enter the rerank pool.

4. **`qkb` CLI/MCP shape.** Same core surface as `qmd` (`search`, `vsearch`, `query`, `get`, `multi-get`, `mcp`, `status`, `update`, `embed`, `collection`, `context`), plus graph navigation and agent-oriented query controls.

## Use it from a Claude Code or Hermes skill

The preferred skill pattern is:

1. Expand the user question in the harness using domain context.
2. Call qkb with `--expanded-query` for the primary retrieval pass.
3. Read the top primary docs.
4. Optionally inspect graph neighbors/backlinks for supporting context.
5. Synthesize with citations.

Example retrieval step:

```sh
qkb --index <your-index> query "$QUESTION" \
  --expanded-query "$EXPANSION_1" \
  --expanded-query "lex: $ENTITY_NAME" \
  -n 8 --files -c <your-collection>
```

Keep a parallel graph-candidate mode only for AB testing:

```sh
qkb --index <your-index> query "$QUESTION" --graph -n 8 --files -c <your-collection>
```

## Benchmark interpretation

The earlier qkb-graph benchmark showed graph traversal can help multi-hop conceptual questions, but newer standalone retrieval testing showed that letting graph neighbors compete in the primary rerank pool can add noise for exact/entity lookups.

Current default conclusion:

- **Primary ranking:** BM25 + title-weighted FTS + vector + optional rerank.
- **Query expansion:** supplied by the harness with `--expanded-query`.
- **Graph:** post-retrieval context/navigation by default; primary candidate injection only with `--graph`.
- **GGUF generator:** optional legacy mode via `--local-expand`, not required for the default path.

## Where graph is still useful

- **Multi-hop conceptual questions.** "What are the international NOTAM coverage requirements?" may need traversal from NOTAM Reform to ICAO.
- **Entity-relation queries.** A contractor page may link to an API page even when the API page lacks the contractor name.
- **Context expansion.** Once primary docs are known, graph neighbors are useful labeled context for synthesis.

## Where graph should not dominate

- **Exact-name lookups.** BM25/title-weighted FTS usually wins.
- **Sparse corpora.** Few links means little graph signal.
- **Out-of-scope questions.** More hops do not create missing coverage.

## Architecture decisions

For the longer story:

- [RFC-0007: Graph layer](docs/rfcs/0007-graphqlite-graph-layer.md) — schema, GraphQLite integration, typed edges
- [RFC-0008: Hybrid graph queries](docs/rfcs/0008-hybrid-graph-query.md) — graph-candidate strategies and their trade-offs
- [RFC-0009: Thin-wrapper architecture](docs/rfcs/0009-thin-wrapper-architecture.md) — how qkb consumes qmd via SDK without forking

## License

MIT. Same as qmd. Built on qmd's shoulders — credit there.
