/**
 * Incremental file watcher. Watches ONLY the configured source directories —
 * NOT the engine root. Watching a large monorepo root recursively opens an fd
 * per directory/file when chokidar falls back to `fs.watch` (the fsevents
 * native binding is not available in the Electron utility-process), which on a
 * repo with node_modules + multiple packages blows past the process fd limit
 * (EMFILE). That fd exhaustion also starves outbound sockets, so the OpenAI
 * query-embedding `fetch` fails and search silently degrades to sparse-only.
 * Scoping to the source bases keeps the watch set to a few small trees.
 *
 * Debounces per-file and re-indexes (or drops) markdown files that belong to a
 * configured source set. After a batch settles it invokes `onSettled` so the
 * engine can rebuild its in-memory retrieval snapshot.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import fg from 'fast-glob';
import type { EngineConfig, SourceSet } from '../types.js';
import type { Indexer } from './indexer.js';

const DEBOUNCE_MS = 400;
const IGNORED = /(^|[/\\])(node_modules|\.git|dist|\.vite|\.cache)([/\\]|$)/;
const FG_IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.vite/**'];

/** Static directory prefix of a glob (the part before the first magic char). */
export function globBaseDir(glob: string): string {
  const magic = glob.search(/[*?{}[\]!()]/);
  const prefix = magic === -1 ? glob : glob.slice(0, magic);
  const slash = prefix.lastIndexOf('/');
  return slash === -1 ? '' : prefix.slice(0, slash);
}

/**
 * Resolve the minimal watch scope for a set of source globs.
 * - `dirs`: distinct, non-overlapping base directories (relative, POSIX) to
 *   watch recursively (descendants of another listed dir are dropped).
 * - `rootAnchoredGlobs`: globs whose base is the root (e.g. `CLAUDE.md`,
 *   `**​/CLAUDE.md`). These are watched by enumerating their current matches as
 *   individual file watches rather than watching the entire root tree.
 */
export function computeWatchScope(sources: SourceSet[]): {
  dirs: string[];
  rootAnchoredGlobs: string[];
} {
  const dirSet = new Set<string>();
  const rootAnchoredGlobs: string[] = [];
  for (const set of sources) {
    for (const g of set.include) {
      const base = globBaseDir(g);
      if (base === '') rootAnchoredGlobs.push(g);
      else dirSet.add(base);
    }
  }
  const sorted = Array.from(dirSet).sort();
  const dirs: string[] = [];
  for (const d of sorted) {
    if (!dirs.some((m) => d === m || d.startsWith(m + '/'))) dirs.push(d);
  }
  return { dirs, rootAnchoredGlobs };
}

export class IndexWatcher {
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, 'upsert' | 'remove'>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private config: EngineConfig,
    private indexer: Indexer,
    private onSettled: () => void
  ) {}

  start(): void {
    if (this.watcher) return;
    const targets = this.resolveWatchTargets();
    if (targets.length === 0) return;
    this.watcher = chokidar.watch(targets, {
      ignored: (p: string) => IGNORED.test(p),
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.watcher
      .on('add', (p) => this.queue(p, 'upsert'))
      .on('change', (p) => this.queue(p, 'upsert'))
      .on('unlink', (p) => this.queue(p, 'remove'));
  }

  /**
   * Absolute paths to hand chokidar: the existing source base dirs plus the
   * current matches of any root-anchored globs (as individual files). This is
   * what keeps the watch set tiny instead of the whole monorepo.
   */
  private resolveWatchTargets(): string[] {
    const { dirs, rootAnchoredGlobs } = computeWatchScope(this.config.sources);
    const targets: string[] = [];
    for (const d of dirs) {
      const abs = path.join(this.config.root, d);
      if (existsSync(abs)) targets.push(abs);
    }
    if (rootAnchoredGlobs.length) {
      const files = fg.sync(rootAnchoredGlobs, {
        cwd: this.config.root,
        absolute: true,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
        ignore: FG_IGNORE,
      });
      targets.push(...files);
    }
    return targets;
  }

  private queue(absPath: string, op: 'upsert' | 'remove'): void {
    if (!absPath.endsWith('.md')) return;
    const sourceClass = this.indexer.classify(absPath);
    if (!sourceClass) return;
    const rel = path.relative(this.config.root, absPath).split(path.sep).join('/');
    this.pending.set(rel, op);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    const batch = Array.from(this.pending.entries());
    this.pending.clear();
    this.timer = null;
    for (const [rel, op] of batch) {
      try {
        if (op === 'remove') {
          this.indexer.removeFile(rel);
        } else {
          const sourceClass = this.indexer.classify(rel) ?? 'unknown';
          await this.indexer.indexFile(rel, sourceClass);
        }
      } catch {
        // Best-effort; a failed file is retried on its next change event.
      }
    }
    if (batch.length) this.onSettled();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    await this.watcher?.close();
    this.watcher = null;
  }
}
