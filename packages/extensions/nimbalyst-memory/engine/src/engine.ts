/**
 * MemoryEngine — the host-agnostic orchestrator. Owns the store, indexer,
 * retriever snapshot, facts store, and embedder. Enforces the embedder-identity
 * invariant: if the configured embedder differs from what the store was built
 * with, the store is reset (vectors are non-comparable) and a full re-index is
 * required.
 *
 * ZERO host-app imports. The MCP server (mcp/server.ts) is a thin adapter over
 * these methods.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  Embedder,
  EngineConfig,
  Fact,
  RetrievalCapabilities,
  SearchHit,
  VirtualRecord,
} from './types.js';
import { SqliteStore } from './store/sqliteStore.js';
import { Indexer, type IndexProgress } from './indexer/indexer.js';
import { IndexWatcher } from './indexer/watcher.js';
import { Retriever } from './retrieval/retriever.js';
import { FactsStore, type RecallQuery, type RememberInput } from './facts/facts.js';

export interface EngineStatus {
  chunks: number;
  /** Chunks that carry a dense vector (the dense retrieval arm). */
  denseChunks: number;
  /** Chunk count keyed by source class (e.g. design/docs/plans/facts). */
  bySourceClass: Record<string, number>;
  /** Distinct source files currently represented in the index. */
  sourceFiles: number;
  /** Epoch millis of the most recent chunk write, or null when empty. */
  lastIndexedAt: number | null;
  embedder: { id: string; model: string; dims: number };
  embedderChanged: boolean;
  indexing: boolean;
  /**
   * Last query-embedding failure, if any. When set, search has been running
   * sparse-only (BM25) — a strong signal something is wrong with the embedder
   * (bad key, network, or fd starvation) rather than with retrieval logic.
   */
  lastEmbedError: string | null;
  retrieval: RetrievalCapabilities;
  root: string;
}

/** Refresh the retrieval snapshot every N files during a full index pass so
 *  partial results are searchable within seconds rather than after the whole
 *  (potentially many-minute) corpus pass completes. */
const SNAPSHOT_REFRESH_EVERY_FILES = 25;

export class MemoryEngine {
  private store: SqliteStore;
  private indexer: Indexer;
  private facts: FactsStore;
  private retriever: Retriever;
  private watcher: IndexWatcher | null = null;
  private indexing = false;
  /** True when the stored embedder differed and a re-index is needed. */
  private embedderChanged = false;
  /** Last query-embedding error message, or null if the last embed succeeded. */
  private lastEmbedError: string | null = null;

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.config.onLog?.(level, message);
  }

  private constructor(
    private config: EngineConfig,
    private embedder: Embedder,
    store: SqliteStore
  ) {
    this.store = store;
    this.indexer = new Indexer(config, store, embedder);
    this.facts = new FactsStore(config.root, config.factsDir);
    this.retriever = new Retriever(store.loadAll());
  }

  static create(config: EngineConfig, embedder: Embedder): MemoryEngine {
    const store = new SqliteStore(config.dbPath, config.nativeBinding);
    const prior = store.getEmbedderInfo();
    const info = embedder.info;
    let changed = false;
    if (!prior) {
      store.setEmbedderInfo(info);
    } else if (prior.id !== info.id || prior.model !== info.model || prior.dims !== info.dims) {
      // Non-comparable vectors — wipe and re-key. Caller must re-index.
      store.reset();
      store.setEmbedderInfo(info);
      changed = true;
    }
    const engine = new MemoryEngine(config, embedder, store);
    engine.embedderChanged = changed;
    return engine;
  }

  /** Rebuild the in-memory retrieval snapshot from the store. */
  private refreshSnapshot(): void {
    this.retriever = new Retriever(this.store.loadAll());
  }

  async indexAll(onProgress?: (p: IndexProgress) => void): Promise<{ indexed: number; files: number }> {
    this.indexing = true;
    try {
      // Refresh the retrieval snapshot periodically during the pass so partial
      // results are searchable within seconds on a large corpus (the full pass
      // can take minutes), not only once indexAll() returns.
      const result = await this.indexer.indexAll((p) => {
        if (p.phase === 'index' && p.done > 0 && p.done % SNAPSHOT_REFRESH_EVERY_FILES === 0) {
          this.refreshSnapshot();
        }
        onProgress?.(p);
      });
      this.embedderChanged = false;
      this.refreshSnapshot();
      return result;
    } finally {
      this.indexing = false;
    }
  }

  startWatching(): void {
    if (this.watcher) return;
    this.watcher = new IndexWatcher(this.config, this.indexer, () => this.refreshSnapshot());
    this.watcher.start();
  }

  // --- Virtual records (DB-resident content: trackers, sessions, …) ---------

  /**
   * Ingest records that don't live on disk. Chunks, embeds (only changed
   * records, by content hash), and upserts them into the same hybrid index as
   * files — so one `search()` spans markdown + trackers + sessions. Refreshes
   * the retrieval snapshot so the new records are immediately searchable.
   *
   * Each record's `id` must be globally unique (the host namespaces it); it is
   * the synthetic source path and the `removeRecords` key.
   */
  async ingestRecords(records: VirtualRecord[]): Promise<{ ingested: number }> {
    const ingested = await this.indexer.indexRecords(records);
    this.refreshSnapshot();
    return { ingested };
  }

  /**
   * Remove virtual records by their `id` (the same value passed as
   * `VirtualRecord.id`). Idempotent — unknown ids are no-ops. Refreshes the
   * retrieval snapshot.
   */
  removeRecords(ids: string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) this.store.deleteSource(id);
    this.refreshSnapshot();
  }

  // --- Retrieval -----------------------------------------------------------

  async search(
    query: string,
    k = 5,
    opts?: { sourceClasses?: string[] },
  ): Promise<SearchHit[]> {
    let vec: number[] | null = null;
    try {
      const [embedded] = await this.embedder.embed([query]);
      vec = embedded ?? null;
      if (this.lastEmbedError) {
        this.log('info', '[engine] query embedding recovered; dense retrieval re-enabled');
        this.lastEmbedError = null;
      }
    } catch (err) {
      // Fall back to sparse-only, but DO NOT swallow silently — a persistent
      // failure here is the difference between hybrid and BM25-only retrieval.
      vec = null;
      const msg = (err as Error)?.message ?? String(err);
      if (this.lastEmbedError !== msg) {
        this.log('warn', `[engine] query embedding failed; falling back to sparse-only: ${msg}`);
      }
      this.lastEmbedError = msg;
    }
    return this.retriever.search(query, vec, k, opts);
  }

  expand(sourcePath: string, headingPath: string[]): { sourcePath: string; headingPath: string[]; text: string } | null {
    return this.retriever.expandSection(sourcePath, headingPath);
  }

  /**
   * The most-recently-modified document in a source class (by file mtime), with
   * its content. Host-agnostic: "latest plan" is just latestDoc('plans') to the
   * caller. Returns null when the class has no files on disk.
   */
  async latestDoc(
    sourceClass: string
  ): Promise<{ path: string; content: string; mtimeMs: number } | null> {
    const [latest] = await this.recentDocs(sourceClass, 1);
    return latest ?? null;
  }

  /**
   * The N most-recently-modified documents in a source class (newest first),
   * each with its content. Host-agnostic; honors `config.exclude`. Used by
   * auto-distillation to harvest candidate facts from recent decisions/plans.
   * Returns `[]` when the class has no files.
   */
  async recentDocs(
    sourceClass: string,
    limit: number
  ): Promise<Array<{ path: string; content: string; mtimeMs: number }>> {
    const files = await this.indexer.filesForClass(sourceClass);
    const stamped: Array<{ path: string; mtimeMs: number }> = [];
    for (const rel of files) {
      try {
        const st = await stat(path.join(this.config.root, rel));
        stamped.push({ path: rel, mtimeMs: st.mtimeMs });
      } catch {
        // File vanished between glob and stat — skip it.
      }
    }
    stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const top = stamped.slice(0, Math.max(0, limit));
    const out: Array<{ path: string; content: string; mtimeMs: number }> = [];
    for (const s of top) {
      const { content } = await this.readDoc(s.path);
      out.push({ path: s.path, content, mtimeMs: s.mtimeMs });
    }
    return out;
  }

  /** Read a managed doc by relative path (guarded against escaping the root). */
  async readDoc(relPath: string): Promise<{ path: string; content: string }> {
    const abs = path.resolve(this.config.root, relPath);
    const rootResolved = path.resolve(this.config.root);
    if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
      throw new Error(`read_doc: path escapes engine root: ${relPath}`);
    }
    const content = await readFile(abs, 'utf8');
    return { path: path.relative(rootResolved, abs).split(path.sep).join('/'), content };
  }

  // --- Facts ---------------------------------------------------------------

  remember(input: RememberInput): Promise<string> {
    return this.facts.remember(input);
  }

  recall(q: RecallQuery): Promise<Fact[]> {
    return this.facts.recall(q);
  }

  topFacts(limit = 8): Promise<Fact[]> {
    return this.facts.top(limit);
  }

  /** Delete a fact by its relative sourcePath. Returns true if removed. The
   *  fact's chunks are pruned from the shadow index on the next index pass. */
  deleteFact(sourcePath: string): Promise<boolean> {
    return this.facts.delete(sourcePath);
  }

  // --- Lifecycle -----------------------------------------------------------

  status(): EngineStatus {
    const bySourceClass = this.store.countsBySourceClass();
    const semanticAvailable = this.embedder.info.dims > 0 && !this.lastEmbedError;
    const retrieval: RetrievalCapabilities = {
      mode: semanticAvailable ? 'hybrid' : 'keyword-only',
      semantic: semanticAvailable
        ? { available: true }
        : {
            available: false,
            reason: 'optional-embedding-provider-unavailable',
          },
      keyword: { available: true, source: 'local-project-index' },
    };
    return {
      chunks: this.store.count(),
      denseChunks: this.store.countDense(),
      bySourceClass,
      sourceFiles: this.store.sourcePaths().length,
      lastIndexedAt: this.store.lastUpdatedAt(),
      embedder: this.embedder.info,
      embedderChanged: this.embedderChanged,
      indexing: this.indexing,
      lastEmbedError: this.lastEmbedError,
      retrieval,
      root: this.config.root,
    };
  }

  /**
   * Total on-disk size of the shadow index (the SQLite db plus its WAL/SHM
   * sidecars), in bytes. Best-effort: missing sidecars count as zero. Async
   * because it stats the filesystem; kept separate from the sync `status()`.
   */
  async indexSizeBytes(): Promise<number> {
    const paths = [this.config.dbPath, `${this.config.dbPath}-wal`, `${this.config.dbPath}-shm`];
    let total = 0;
    for (const p of paths) {
      try {
        total += (await stat(p)).size;
      } catch {
        // Sidecar (or db) not present — contributes nothing.
      }
    }
    return total;
  }

  async close(): Promise<void> {
    await this.watcher?.stop();
    this.store.close();
  }
}
