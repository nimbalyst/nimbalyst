/**
 * Markdown indexer: walk source globs → chunk → hash → embed (only dirty
 * chunks) → upsert into the shadow store. Incremental by content hash; unchanged
 * chunks reuse their stored embedding so a one-line edit re-embeds one chunk,
 * not the whole file.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import picomatch from 'picomatch';
import type { Embedder, EngineConfig, SourceSet, StoredChunk, VirtualRecord } from '../types.js';
import { chunkMarkdown } from '../chunker.js';
import { termFrequencies } from '../retrieval/bm25.js';
import type { SqliteStore } from '../store/sqliteStore.js';

export interface IndexProgress {
  phase: 'enumerate' | 'index' | 'prune' | 'done';
  file?: string;
  done: number;
  total: number;
}

interface FileRef {
  /** POSIX path relative to root. */
  sourcePath: string;
  sourceClass: string;
}

/** A source chunked + dirty-checked but not yet embedded (see `prepareContent`). */
interface PreparedSource {
  sourcePath: string;
  /** All chunks for the source; reusable ones already carry their dense vector. */
  stored: StoredChunk[];
  /** Chunks needing a (re)embed, as indices into `stored` plus the embed input. */
  pending: { idx: number; input: string }[];
}

/** Embed input includes the heading breadcrumb for extra context. */
function embedInput(headingPath: string[], text: string): string {
  const crumb = headingPath.join(' > ');
  return crumb ? `${crumb}\n${text}` : text;
}

const BASE_IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.vite/**'];

export class Indexer {
  private matchers: { sourceClass: string; isMatch: (p: string) => boolean }[];
  private isExcluded: (p: string) => boolean;
  private ignoreGlobs: string[];

  constructor(
    private config: EngineConfig,
    private store: SqliteStore,
    private embedder: Embedder
  ) {
    this.matchers = config.sources.map((set) => ({
      sourceClass: set.sourceClass,
      isMatch: picomatch(set.include, { dot: true }),
    }));
    const exclude = config.exclude ?? [];
    this.isExcluded = exclude.length ? picomatch(exclude, { dot: true }) : () => false;
    this.ignoreGlobs = [...BASE_IGNORE, ...exclude];
  }

  /**
   * POSIX-relative paths of the files in a given source class, honoring the
   * configured excludes. Host-agnostic: a source class is just a label on a glob
   * set, so this is "the docs that belong to this class" with no app knowledge.
   */
  async filesForClass(sourceClass: string): Promise<string[]> {
    const out = new Set<string>();
    for (const set of this.config.sources) {
      if (set.sourceClass !== sourceClass) continue;
      for (const rel of await this.globSet(set)) out.add(rel);
    }
    return Array.from(out);
  }

  /** Resolve all source files (first matching source set wins). */
  async enumerate(): Promise<FileRef[]> {
    const seen = new Map<string, string>();
    for (const set of this.config.sources) {
      const matches = await this.globSet(set);
      for (const rel of matches) if (!seen.has(rel)) seen.set(rel, set.sourceClass);
    }
    return Array.from(seen.entries()).map(([sourcePath, sourceClass]) => ({
      sourcePath,
      sourceClass,
    }));
  }

  private async globSet(set: SourceSet): Promise<string[]> {
    return fg(set.include, {
      cwd: this.config.root,
      absolute: false,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: this.ignoreGlobs,
    });
  }

  /** Full (incremental) index pass. */
  async indexAll(onProgress?: (p: IndexProgress) => void): Promise<{ indexed: number; files: number }> {
    onProgress?.({ phase: 'enumerate', done: 0, total: 0 });
    const files = await this.enumerate();
    const live = new Set(files.map((f) => f.sourcePath));

    let indexed = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      onProgress?.({ phase: 'index', file: f.sourcePath, done: i, total: files.length });
      indexed += await this.indexFile(f.sourcePath, f.sourceClass);
    }

    // Drop files that no longer exist on disk. Only file-backed sources are
    // considered — virtual records (trackers, sessions) are never pruned here,
    // so a markdown re-index can't wipe the catalog.
    onProgress?.({ phase: 'prune', done: 0, total: 0 });
    for (const sourcePath of this.store.fileSourcePaths()) {
      if (!live.has(sourcePath)) this.store.deleteSource(sourcePath);
    }

    onProgress?.({ phase: 'done', done: files.length, total: files.length });
    return { indexed, files: files.length };
  }

  /** Index a single file. Returns the number of chunks (re)embedded. */
  async indexFile(sourcePath: string, sourceClass: string): Promise<number> {
    const abs = path.join(this.config.root, sourcePath);
    let raw: string;
    try {
      raw = await readFile(abs, 'utf8');
    } catch {
      // File vanished mid-pass; treat as deletion.
      this.store.deleteSource(sourcePath);
      return 0;
    }
    return this.indexContent(sourcePath, sourceClass, raw);
  }

  /**
   * Index a virtual record set (trackers, sessions — anything that does NOT live
   * on disk). Dirty-checks per record exactly like a file, but batches the embed
   * call across ALL records so a large backfill is one (internally-paginated)
   * embedder round-trip, not one per record. Returns the number of chunks
   * (re)embedded.
   */
  async indexRecords(records: VirtualRecord[]): Promise<number> {
    if (records.length === 0) return 0;

    const prepared: PreparedSource[] = [];
    const inputs: string[] = [];
    const backref: { p: number; idx: number }[] = [];
    for (const rec of records) {
      const raw = rec.title ? `# ${rec.title}\n\n${rec.text}` : rec.text;
      const p = this.prepareContent(rec.id, rec.sourceClass, raw, {
        refType: rec.refType,
        refId: rec.refId,
      });
      const pi = prepared.push(p) - 1;
      for (const pend of p.pending) {
        backref.push({ p: pi, idx: pend.idx });
        inputs.push(pend.input);
      }
    }

    if (inputs.length) {
      const vectors = await this.embedder.embed(inputs);
      backref.forEach((b, i) => {
        prepared[b.p].stored[b.idx].denseEmbedding = vectors[i] ?? null;
      });
    }

    let embedded = 0;
    for (const p of prepared) {
      this.store.upsertChunks(p.stored);
      this.store.pruneSource(p.sourcePath, p.stored.map((c) => c.id));
      embedded += p.pending.length;
    }
    return embedded;
  }

  /**
   * Index raw markdown for one source path (file or virtual). Chunk → dirty-check
   * → embed only changed chunks → upsert → prune the stale tail. Returns the
   * number of chunks (re)embedded.
   */
  async indexContent(
    sourcePath: string,
    sourceClass: string,
    raw: string,
    ref?: { refType?: string; refId?: string }
  ): Promise<number> {
    const p = this.prepareContent(sourcePath, sourceClass, raw, ref);
    if (p.pending.length) {
      const vectors = await this.embedder.embed(p.pending.map((t) => t.input));
      p.pending.forEach((t, i) => {
        p.stored[t.idx].denseEmbedding = vectors[i] ?? null;
      });
    }
    this.store.upsertChunks(p.stored);
    this.store.pruneSource(sourcePath, p.stored.map((c) => c.id));
    return p.pending.length;
  }

  /**
   * Chunk + dirty-check one source without embedding. Reusable chunks keep their
   * stored vector; changed/new ones are collected in `pending` for a batched
   * embed by the caller.
   */
  private prepareContent(
    sourcePath: string,
    sourceClass: string,
    raw: string,
    ref?: { refType?: string; refId?: string }
  ): PreparedSource {
    const chunks = chunkMarkdown(sourcePath, sourceClass, raw, this.config.chunk, ref);
    const existing = new Map(this.store.chunksForSource(sourcePath).map((c) => [c.id, c]));
    const info = this.embedder.info;

    const pending: { idx: number; input: string }[] = [];
    const stored: StoredChunk[] = chunks.map((c, idx) => {
      const prev = existing.get(c.id);
      const reusable =
        prev &&
        prev.contentHash === c.contentHash &&
        prev.embedderId === info.id &&
        prev.model === info.model &&
        prev.dims === info.dims &&
        (info.dims === 0 || prev.denseEmbedding);
      if (!reusable) pending.push({ idx, input: embedInput(c.headingPath, c.text) });
      return {
        ...c,
        denseEmbedding: reusable ? prev!.denseEmbedding : null,
        sparseTerms: termFrequencies(embedInput(c.headingPath, c.text)),
        embedderId: info.id,
        model: info.model,
        dims: info.dims,
        updatedAt: Date.now(),
      };
    });
    return { sourcePath, stored, pending };
  }

  /** Drop a source file from the index. */
  removeFile(sourcePath: string): void {
    this.store.deleteSource(sourcePath);
  }

  /** Map an absolute or relative path to its source class, or null if unmanaged. */
  classify(relOrAbs: string): string | null {
    const rel = path.isAbsolute(relOrAbs)
      ? path.relative(this.config.root, relOrAbs)
      : relOrAbs;
    const posix = rel.split(path.sep).join('/');
    if (this.isExcluded(posix)) return null;
    for (const m of this.matchers) if (m.isMatch(posix)) return m.sourceClass;
    return null;
  }
}
