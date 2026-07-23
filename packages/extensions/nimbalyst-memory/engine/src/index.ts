/**
 * @nimbalyst/memory-engine — public API.
 *
 * Host-agnostic project-knowledge + facts engine. No host-app imports anywhere
 * in this package: it is the extraction seam and is publishable standalone.
 */
export { MemoryEngine, type EngineStatus } from './engine.js';
export { createEmbedder, type EmbedderConfig } from './embedders/factory.js';
export { OpenAIEmbedder, type OpenAIEmbedderConfig } from './embedders/openaiEmbedder.js';
export { LocalEmbedder, type LocalEmbedderConfig } from './embedders/localEmbedder.js';
export { SparseEmbedder } from './embedders/sparseEmbedder.js';
export { buildProjectSearchResponse, buildPublicEngineStatus } from './searchResponse.js';
export { Indexer, type IndexProgress } from './indexer/indexer.js';
export { Retriever } from './retrieval/retriever.js';
export { SqliteStore } from './store/sqliteStore.js';
export { FactsStore, type RememberInput, type RecallQuery } from './facts/facts.js';
export { chunkMarkdown, estimateTokens, stripFrontmatter } from './chunker.js';
export { createMcpServer } from './mcp/server.js';
export * from './types.js';
