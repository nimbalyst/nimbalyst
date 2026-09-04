/// <reference path="../picomatch.d.ts" />

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
import type {
  Chunk,
  Embedder,
  EngineConfig,
  SourceSet,
  StoredChunk,
  VirtualRecord,
} from '../types.js';
import { PAGE_VECTOR_BYTES } from '../types.js';
import { chunkMarkdown } from '../chunker.js';
import { sha256 } from '../hash.js';
import { termFrequencies } from '../retrieval/bm25.js';
import type { SqliteStore } from '../store/sqliteStore.js';
import {
  locateAbsolute,
  parseSourcePath,
  resolveInRoots,
  resolveRoots,
  rootForSet,
  toSourcePath,
  type ResolvedRoot,
} from '../roots.js';

export interface IndexProgress {
  phase: 'enumerate' | 'index' | 'prune' | 'done';
  file?: string;
  done: number;
  total: number;
}

interface FileRef {
  /** `sourcePath` (root-prefixed for non-primary roots). */
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

/**
 * Build the page-level row for one source: amendment A2's whole-document
 * vector, stored beside that source's chunks.
 *
 * It carries no `sparseTerms`, so it cannot leak into BM25 statistics, and an
 * empty `headingPath`, because a page row is a document-level SIGNAL rather
 * than a citable answer — the retriever resolves a page hit to the best chunk
 * inside that document before returning it.
 *
 * Returns null for a source short enough that the page vector would just be a
 * copy of its only chunk, which would cost an embedding to say nothing.
 */
function pageRowFor(
  sourcePath: string,
  sourceClass: string,
  raw: string,
  chunkCount: number,
  ref?: { refType?: string; refId?: string }
): Chunk | null {
  if (chunkCount <= 1) return null;
  const text = raw.slice(0, PAGE_VECTOR_BYTES);
  if (!text.trim()) return null;
  return {
    id: `${sourcePath}#page`,
    sourcePath,
    sourceClass,
    headingPath: [],
    // Sorts ahead of every real chunk and can never collide with one.
    ordinal: -1,
    text,
    contentHash: sha256(text),
    refType: ref?.refType ?? 'doc-file',
    refId: ref?.refId ?? sourcePath,
    granularity: 'page',
  };
}

const BASE_IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.vite/**'];

export class Indexer {
  private roots: ResolvedRoot[];
  private matchers: { sourceClass: string; root: ResolvedRoot; isMatch: (p: string) => boolean }[];
  private isExcluded: (p: string) => boolean;
  private ignoreGlobs: string[];

  constructor(
    private config: EngineConfig,
    private store: SqliteStore,
    private embedder: Embedder
  ) {
    this.roots = resolveRoots(config.root, config.sources);
    // A matcher is bound to its set's root: `docs/**/*.md` declared against the
    // primary root must not claim a `docs/x.md` that lives under another root.
    this.matchers = config.sources.map((set) => ({
      sourceClass: set.sourceClass,
      root: rootForSet(this.roots, set),
      isMatch: picomatch(set.include, { dot: true }),
    }));
    const exclude = config.exclude ?? [];
    this.isExcluded = exclude.length ? picomatch(exclude, { dot: true }) : () => false;
    this.ignoreGlobs = [...BASE_IGNORE, ...exclude];
  }

  /** The configured roots, primary first. */
  sourceRoots(): ResolvedRoot[] {
    return this.roots;
  }

  /**
   * `sourcePath`s of the files in a given source class, honoring the configured
   * excludes. Host-agnostic: a source class is just a label on a glob set, so
   * this is "the docs that belong to this class" with no app knowledge.
   */
  async filesForClass(sourceClass: string): Promise<string[]> {
    const out = new Set<string>();
    for (const set of this.config.sources) {
      if (set.sourceClass !== sourceClass) continue;
      for (const sp of await this.globSet(set)) out.add(sp);
    }
    return Array.from(out);
  }

  /** Resolve all source files (first matching source set wins). */
  async enumerate(): Promise<FileRef[]> {
    const seen = new Map<string, string>();
    for (const set of this.config.sources) {
      const matches = await this.globSet(set);
      for (const sp of matches) if (!seen.has(sp)) seen.set(sp, set.sourceClass);
    }
    return Array.from(seen.entries()).map(([sourcePath, sourceClass]) => ({
      sourcePath,
      sourceClass,
    }));
  }

  /**
   * Walk one source set against ITS root and return `sourcePath`s — prefixed for
   * a non-primary root, so a `README.md` under two roots yields two distinct
   * keys instead of colliding on the chunk primary key.
   */
  private async globSet(set: SourceSet): Promise<string[]> {
    const root = rootForSet(this.roots, set);
    const rels = await fg(set.include, {
      cwd: root.dir,
      absolute: false,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: this.ignoreGlobs,
    });
    return rels.map((rel) => toSourcePath(root, rel));
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

  /** Index a single file by `sourcePath`. Returns the number of chunks (re)embedded. */
  async indexFile(sourcePath: string, sourceClass: string): Promise<number> {
    let abs: string;
    let root: ResolvedRoot;
    try {
      ({ abs, root } = resolveInRoots(this.roots, sourcePath));
    } catch (err) {
      // Outside every configured root. Never seen for a path we derived, so this
      // is a bug rather than a deletion — log it and touch nothing, so a bad
      // path can't prune real index rows.
      this.config.onLog?.('warn', `[indexer] refusing to index ${sourcePath}: ${(err as Error).message}`);
      return 0;
    }
    let raw: string;
    try {
      raw = await readFile(abs, 'utf8');
    } catch {
      // File vanished mid-pass; treat as deletion.
      this.store.deleteSource(sourcePath);
      return 0;
    }
    // `sourcePath` is the index key; `refId` is what a caller opens. They are
    // the same string for the primary root, but a file under another root is
    // not reachable from the workspace path, so it carries its absolute path
    // instead — otherwise a hit from that root can be found and not opened.
    return this.indexContent(
      sourcePath,
      sourceClass,
      raw,
      root.id === null ? undefined : { refId: abs }
    );
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
    // A2: the page-level vector rides the same dirty-check and prune path as
    // the chunks, so it stays consistent with them for free.
    const page = pageRowFor(sourcePath, sourceClass, raw, chunks.length, ref);
    const rows = page ? [...chunks, page] : chunks;
    const existing = new Map(this.store.chunksForSource(sourcePath).map((c) => [c.id, c]));
    const info = this.embedder.info;

    const pending: { idx: number; input: string }[] = [];
    const stored: StoredChunk[] = rows.map((c, idx) => {
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
        // Page rows stay out of BM25 entirely: giving one terms would both
        // double-count the document's vocabulary in the IDF statistics and let
        // the same source surface twice in the keyword arm.
        sparseTerms: c.granularity === 'page' ? {} : termFrequencies(embedInput(c.headingPath, c.text)),
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

  /**
   * Map an absolute path, a `sourcePath`, or a bare primary-relative path to the
   * source class that claims it plus its canonical `sourcePath`. Null when no
   * source set covers it, when it is excluded, or when an absolute path lies
   * outside every configured root.
   *
   * Returns the `sourcePath` as well as the class because with more than one
   * root the caller can no longer derive it from `config.root` alone — the
   * watcher used to do exactly that.
   */
  classify(relOrAbs: string): { sourceClass: string; sourcePath: string } | null {
    const located = path.isAbsolute(relOrAbs)
      ? locateAbsolute(this.roots, relOrAbs)
      : parseSourcePath(this.roots, relOrAbs);
    if (!located) return null;
    const { root, rel } = located;
    const posix = rel.split(path.sep).join('/');
    if (this.isExcluded(posix)) return null;
    for (const m of this.matchers) {
      if (m.root.dir === root.dir && m.isMatch(posix)) {
        return { sourceClass: m.sourceClass, sourcePath: toSourcePath(root, posix) };
      }
    }
    return null;
  }
}
