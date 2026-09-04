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
export {
  defaultSources,
  harnessMemoryDir,
  harnessProjectSlug,
  HARNESS_MEMORY_ROOT_ID,
} from './sources.js';
export {
  isValidRootId,
  locateAbsolute,
  parseSourcePath,
  primaryRoot,
  resolveInRoots,
  resolveRoots,
  rootForSet,
  toSourcePath,
  type ResolvedRoot,
  type SourceRoot,
} from './roots.js';
export { createMcpServer } from './mcp/server.js';
// The write gate. `screenMemoryText` runs before anything is persisted, not
// before anything is exported: a credential that reaches the committed replica
// is permanent in git history, so the only safe place for this is the write
// path itself.
export {
  screenMemoryText,
  redactSecrets,
  containsSecret,
  evaluateBlocklist,
} from './redaction/index.js';
export type {
  ScreenResult,
  ScreenOptions,
  RedactionFinding,
  BlocklistMatch,
  SecretKind,
} from './redaction/types.js';
// Prose-aware dedup. `supersede` is a distinct outcome from `discard` — a page
// that extends an existing one replaces it rather than being thrown away.
export { DedupIndex, compareProse, DEFAULT_DEDUP_POLICY } from './dedup/index.js';
export type {
  DedupVerdict,
  DedupAction,
  DedupDecision,
  DedupMatch,
  DedupPolicy,
} from './dedup/types.js';
export * from './memory/index.js';
export * from './types.js';
