# QKB - Query Knowledge Base

Use Bun instead of Node.js (`bun` not `node`, `bun install` not `npm install`).

## Commands

```sh
qkb collection add . --name <n>   # Create/index collection
qkb collection list               # List all collections with details
qkb collection remove <name>      # Remove a collection by name
qkb collection rename <old> <new> # Rename a collection
qkb ls [collection[/path]]        # List collections or files in a collection
qkb context add [path] "text"     # Add context for path (defaults to current dir)
qkb context list                  # List all contexts
qkb context check                 # Check for collections/paths missing context
qkb context rm <path>             # Remove context
qkb get <file>                    # Get document by path or docid (#abc123)
qkb multi-get <pattern>           # Get multiple docs by glob or comma-separated list
qkb status                        # Show index status and collections
qkb update [--pull]               # Re-index all collections (--pull: git pull first)
qkb embed                         # Generate vector embeddings (uses node-llama-cpp)
qkb query <query>                 # Search with query expansion + reranking (recommended)
qkb search <query>                # Full-text keyword search (BM25, no LLM)
qkb vsearch <query>               # Vector similarity search (no reranking)
qkb mcp                           # Start MCP server (stdio transport)
qkb mcp --http [--port N]         # Start MCP server (HTTP, default port 8181)
qkb mcp --http --daemon           # Start as background daemon
qkb mcp stop                      # Stop background MCP daemon
```

## Collection Management

```sh
# List all collections
qkb collection list

# Create a collection with explicit name
qkb collection add ~/Documents/notes --name mynotes --mask '**/*.md'

# Remove a collection
qkb collection remove mynotes

# Rename a collection
qkb collection rename mynotes my-notes

# List all files in a collection
qkb ls mynotes

# List files with a path prefix
qkb ls journals/2025
qkb ls qkb://journals/2025
```

## Context Management

```sh
# Add context to current directory (auto-detects collection)
qkb context add "Description of these files"

# Add context to a specific path
qkb context add /subfolder "Description for subfolder"

# Add global context to all collections (system message)
qkb context add / "Always include this context"

# Add context using virtual paths
qkb context add qkb://journals/ "Context for entire journals collection"
qkb context add qkb://journals/2024 "Journal entries from 2024"

# List all contexts
qkb context list

# Check for collections or paths without context
qkb context check

# Remove context
qkb context rm qkb://journals/2024
qkb context rm /  # Remove global context
```

## Document IDs (docid)

Each document has a unique short ID (docid) - the first 6 characters of its content hash.
Docids are shown in search results as `#abc123` and can be used with `get` and `multi-get`:

```sh
# Search returns docid in results
qkb search "query" --json
# Output: [{"docid": "#abc123", "score": 0.85, "file": "docs/readme.md", ...}]

# Get document by docid
qkb get "#abc123"
qkb get abc123              # Leading # is optional

# Docids also work in multi-get comma-separated lists
qkb multi-get "#abc123, #def456"
```

## Options

```sh
# Search & retrieval
-c, --collection <name>  # Restrict search to a collection (matches pwd suffix)
-n <num>                 # Number of results
--all                    # Return all matches
--min-score <num>        # Minimum score threshold
--full                   # Show full document content
--line-numbers           # Add line numbers to output

# Multi-get specific
-l <num>                 # Maximum lines per file
--max-bytes <num>        # Skip files larger than this (default 10KB)

# Output formats (search and multi-get)
--json, --csv, --md, --xml, --files
```

## Development

```sh
bun src/cli/qkb.ts <command>   # Run from source
bun link               # Install globally as 'qkb'
```

## Tests

All tests live in `test/`. Run everything:

```sh
npx vitest run --reporter=verbose test/
bun test --preload ./src/test-preload.ts test/
```

## Architecture

- SQLite FTS5 for full-text search (BM25)
- sqlite-vec for vector similarity search
- node-llama-cpp for embeddings (embeddinggemma), reranking (qwen3-reranker), and query expansion (Qwen3)
- Reciprocal Rank Fusion (RRF) for combining results
- Smart chunking: 900 tokens/chunk with 15% overlap, prefers markdown headings as boundaries
- AST-aware chunking: use `--chunk-strategy auto` to chunk code files (.ts/.js/.py/.go/.rs) at function/class/import boundaries via tree-sitter. Default is `regex` (existing behavior). Markdown and unknown file types always use regex chunking.

## Important: Do NOT run automatically

- Never run `qkb collection add`, `qkb embed`, or `qkb update` automatically
- Never modify the SQLite database directly
- Write out example commands for the user to run manually
- Index is stored at `~/.cache/qkb/index.sqlite`

## Do NOT compile

- Never run `bun build --compile` - it overwrites the shell wrapper and breaks sqlite-vec
- The `qkb` file is a shell script that runs compiled JS from `dist/` - do not replace it
- `npm run build` compiles TypeScript to `dist/` via `tsc -p tsconfig.build.json`

## Releasing

Use `/release <version>` to cut a release. Full changelog standards,
release workflow, and git hook setup are documented in the
[release skill](skills/release/SKILL.md).

Key points:
- Add changelog entries under `## [Unreleased]` **as you make changes**
- The release script renames `[Unreleased]` → `[X.Y.Z] - date` at release time
- Credit external PRs with `#NNN (thanks @username)`
- GitHub releases roll up the full minor series (e.g. 1.2.0 through 1.2.3)
