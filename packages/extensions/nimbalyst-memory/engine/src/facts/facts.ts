/**
 * Markdown-first facts store. Facts are the source of truth as `.md` files with
 * YAML frontmatter (`category`, `scope`, `priority`) under `factsDir`; the
 * in-memory list here is a derived projection used for fast scoped `recall` and
 * top-N start-injection.
 *
 * `remember` is ADD-only (mem0-style): it writes a NEW file and never mutates
 * existing ones. Contradictions are resolved at READ time by recency, not by a
 * fragile write-time reconciler.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { parseFrontmatter } from '../frontmatter.js';
import { sha256 } from '../hash.js';
import { Bm25Index, termFrequencies } from '../retrieval/bm25.js';
import type { Fact } from '../types.js';

export interface RememberInput {
  text: string;
  category?: string | null;
  scope?: string | null;
  priority?: number;
}

export interface RecallQuery {
  query?: string;
  category?: string | null;
  scope?: string | null;
  limit?: number;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'fact'
  );
}

function toNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function toStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export class FactsStore {
  /** @param root engine root @param factsDir relative dir holding fact files */
  constructor(private root: string, private factsDir: string) {}

  private dirAbs(): string {
    return path.join(this.root, this.factsDir);
  }

  /** Read + parse every fact file into the derived projection. */
  async list(): Promise<Fact[]> {
    const files = await fg('**/*.md', {
      cwd: this.dirAbs(),
      absolute: true,
      dot: true,
      onlyFiles: true,
      suppressErrors: true,
    });
    const facts: Fact[] = [];
    for (const abs of files) {
      try {
        const raw = await readFile(abs, 'utf8');
        const { data, body } = parseFrontmatter(raw);
        const text = body.trim();
        if (!text) continue;
        const st = await stat(abs);
        facts.push({
          sourcePath: path.relative(this.root, abs).split(path.sep).join('/'),
          text,
          category: toStr(data.category),
          scope: toStr(data.scope),
          priority: toNumber(data.priority, 0),
          mtime: st.mtimeMs,
        });
      } catch {
        // Skip unreadable/garbled fact files.
      }
    }
    return facts;
  }

  /** Append a new fact file. Returns the relative path written. */
  async remember(input: RememberInput): Promise<string> {
    const text = input.text.trim();
    if (!text) throw new Error('remember: text is required');
    const dir = this.dirAbs();
    await mkdir(dir, { recursive: true });

    const created = new Date().toISOString();
    const stamp = created.slice(0, 10).replace(/-/g, '');
    const fileName = `${stamp}-${slug(text)}-${sha256(text).slice(0, 8)}.md`;
    const abs = path.join(dir, fileName);

    const fm: string[] = ['---'];
    if (input.category) fm.push(`category: ${JSON.stringify(input.category)}`);
    if (input.scope) fm.push(`scope: ${JSON.stringify(input.scope)}`);
    fm.push(`priority: ${toNumber(input.priority, 0)}`);
    fm.push(`created: ${JSON.stringify(created)}`);
    fm.push('---', '', text, '');

    await writeFile(abs, fm.join('\n'), 'utf8');
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  /**
   * Delete a fact by its relative `sourcePath` (as returned by {@link list} /
   * {@link remember}). Returns true if a file was removed, false if it did not
   * exist. Throws if the resolved path escapes the facts directory — a fact path
   * must never reach outside `factsDir` (defense against a malicious/garbled
   * path from the UI).
   */
  async delete(sourcePath: string): Promise<boolean> {
    const dir = this.dirAbs();
    const abs = path.resolve(this.root, sourcePath);
    const rel = path.relative(dir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`delete: path escapes facts dir: ${sourcePath}`);
    }
    try {
      await rm(abs);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      throw err;
    }
  }

  /** Scoped recall. With a query, ranks by BM25; otherwise by priority×recency. */
  async recall(q: RecallQuery = {}): Promise<Fact[]> {
    const limit = q.limit ?? 8;
    let facts = await this.list();
    if (q.category) facts = facts.filter((f) => f.category === q.category);
    if (q.scope) facts = facts.filter((f) => f.scope === q.scope || f.scope === null);

    if (q.query && q.query.trim()) {
      const index = new Bm25Index(
        facts.map((f) => ({ id: f.sourcePath, tf: termFrequencies(f.text) }))
      );
      const ranked = index.search(q.query);
      const byPath = new Map(facts.map((f) => [f.sourcePath, f]));
      const hits = ranked.map((r) => byPath.get(r.id)!).filter(Boolean);
      // Recency-break ties so the newest of contradictory facts wins.
      return hits.slice(0, limit);
    }

    return facts
      .sort((a, b) => b.priority - a.priority || b.mtime - a.mtime)
      .slice(0, limit);
  }

  /** Top-N facts for session-start injection (priority, then recency). */
  async top(limit = 8): Promise<Fact[]> {
    const facts = await this.list();
    return facts
      .sort((a, b) => b.priority - a.priority || b.mtime - a.mtime)
      .slice(0, limit);
  }
}
