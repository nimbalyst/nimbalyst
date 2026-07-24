# @nimbalyst/memory-engine

A host-agnostic **project-knowledge + facts engine** exposed as an **MCP server**. It indexes markdown sources into a rebuildable shadow index and serves fast hybrid retrieval and durable facts to any MCP agent.

> **Extraction seam.** This package has **zero host-app imports**. It is designed to be lifted out of the Nimbalyst monorepo and published standalone without a rewrite. Anything that knows about voice, trackers, or app settings lives in the parent extension, never here.

## What it does

- **Indexes markdown** (`design/`, `docs/`, plans, `CLAUDE.md`, a facts tree — any globs you configure) into heading-aware chunks (~200–500 tokens) that carry their `sourcePath` and full `headingPath`.
- **Incremental & rebuildable.** Each chunk is SHA-256 hashed; a re-index only re-embeds chunks whose content changed. The SQLite store is disposable — delete it and it rebuilds from the markdown.
- **Hybrid retrieval.** Dense cosine (in-memory over the loaded vectors) **+** BM25 sparse keyword scoring, fused with **Reciprocal Rank Fusion**, then **expand-to-section** via the heading breadcrumb. Pure cosine is weak on symbol/path queries; the sparse leg covers that.
- **Pluggable embedders** behind one interface:
  - `OpenAIEmbedder` — `text-embedding-3-small`, 1536-dim (REST, no SDK dep).
  - `LocalEmbedder` — `Xenova/bge-m3` ONNX via transformers.js (optional dep, lazy-loaded, offline).
  - The store records `embedder_id`/`model`/`dims`. Switching the embedder produces non-comparable vectors, so the engine **wipes and forces a full re-index**.
- **Markdown-first facts.** `remember` is ADD-only — it appends a new `.md` file with YAML frontmatter (`category`/`scope`/`priority`) and never mutates existing facts. `recall` is scoped and ranks by keyword relevance (or priority×recency with no query). Contradictions resolve at read time by recency.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `search_project_knowledge(query, k=5)` | Hybrid search → top chunks with `sourcePath#heading` citations |
| `expand(sourcePath, headingPath[])` | Expand a hit to its full heading section |
| `read_doc(path)` | Read a managed document by relative path (root-guarded) |
| `remember(text, category?, scope?, priority?)` | Append a durable fact (ADD-only) |
| `recall(query?, category?, scope?, limit?)` | Recall facts, newest-wins on conflict |
| `index()` | Run an incremental index pass |
| `status()` | Index size, active embedder, re-index-needed flag |

## Running

```sh
npm run build            # tsc → dist/
node dist/serve.js       # stdio MCP server
```

Configuration is supplied **explicitly at launch** — the engine never reads an API key from the ambient environment as an implicit app credential.

| Env var | Default | Notes |
| --- | --- | --- |
| `NIMBALYST_MEMORY_ROOT` | `cwd` | Index/resolve root |
| `NIMBALYST_MEMORY_DB` | `<root>/.nimbalyst-memory/index.db` | Shadow index (rebuildable) |
| `NIMBALYST_MEMORY_FACTS_DIR` | `nimbalyst-local/voice-memory` | Facts tree (relative) |
| `NIMBALYST_MEMORY_CONFIG` | — | JSON file overriding `sources`/`chunk` |
| `NIMBALYST_MEMORY_EMBEDDER` | `openai` | `openai` \| `local` |
| `NIMBALYST_MEMORY_OPENAI_KEY` | — | Required for the OpenAI embedder |
| `NIMBALYST_MEMORY_OPENAI_MODEL` / `_DIMS` / `_BASEURL` | `text-embedding-3-small` / `1536` / — | |
| `NIMBALYST_MEMORY_LOCAL_MODEL` | `Xenova/bge-m3` | LocalEmbedder model |
| `NIMBALYST_BETTER_SQLITE3_NATIVE` | — | Explicit native binding path (ABI portability) |

The server connects immediately and serves partial/empty results while the initial index runs in the background; the file watcher then keeps it fresh.

## Programmatic use

```ts
import { MemoryEngine, createEmbedder } from '@nimbalyst/memory-engine';

const embedder = await createEmbedder({ kind: 'openai', apiKey });
const engine = MemoryEngine.create(
  { root, dbPath, factsDir, sources: [{ sourceClass: 'docs', include: ['docs/**/*.md'] }] },
  embedder
);
await engine.indexAll();
const hits = await engine.search('how does voice grounding work?', 5);
```

## Layout

```
src/
  chunker.ts            heading-aware markdown chunking
  hash.ts               SHA-256 dirty check
  frontmatter.ts        YAML frontmatter parsing
  types.ts              Chunk, Embedder interface, config
  embedders/            OpenAIEmbedder, LocalEmbedder, factory
  store/sqliteStore.ts  rebuildable SQLite shadow index
  retrieval/            cosine, bm25, rrf, hybrid Retriever
  indexer/              walk→chunk→hash→embed→upsert + watcher
  facts/facts.ts        markdown-first ADD-only facts
  engine.ts             MemoryEngine orchestrator
  mcp/server.ts         MCP adapter over the engine
  serve.ts              thin stdio launcher
```
