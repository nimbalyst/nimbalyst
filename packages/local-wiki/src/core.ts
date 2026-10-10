import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { contentVersion, isSafeId, ulid } from './ids.js';
import { composeMarkdownFile, insertIdIntoFile, parseMarkdownFile, readPageMeta } from './frontmatter.js';
import { rewriteLinks } from './links.js';
import { nameKey } from './names.js';
import { parseCsv, stringifyCsv } from './csv.js';
import { atomicWrite, pathExists, relDirname, relJoin, toAbs } from './fsutil.js';
import { acquireWriteLock } from './lock.js';
import {
  ACTIVITY_SUFFIX,
  linkBaseDir,
  resolveLinkPath,
  scanWiki,
  TRASH_MANIFEST,
  type DuplicateLog,
  type PageRecord,
  type Repair,
  type ScanCache,
  type ScanState,
  type TableRecord,
  type TrashManifest,
} from './scan.js';
import { loadTypeDefs, type WikiTypeDef } from './typeDefs.js';
import {
  DEFAULT_EDITOR_TYPES,
  editorSuffix,
  isSidecarName,
  normalizeEditorTypes,
  parseSidecar,
  serializeSidecar,
  sidecarTarget,
} from './sidecar.js';
import { ORDER_STEP, projectSnapshot } from './project.js';
import type { ActivityEntry, LocalWikiChange, LocalWikiSnapshot, OpenWikiOptions, WikiIssue } from './types.js';

export const FORMAT_VERSION = 1;

export type LocalWikiErrorCode =
  | 'not-a-wiki'
  | 'unsupported-format'
  | 'not-found'
  | 'malformed'
  | 'invalid'
  | 'cycle'
  | 'trashed'
  | 'not-trashed'
  | 'exists'
  | 'not-a-table';

export class LocalWikiError extends Error {
  constructor(readonly code: LocalWikiErrorCode, message: string) {
    super(message);
    this.name = 'LocalWikiError';
  }
}

export interface MarkerData {
  formatVersion: number;
  tables?: Record<string, { order?: number }>;
}

export const MARKER_HEADER = '# Nimbalyst local wiki. The format is described in @nimbalyst/local-wiki FORMAT.md.\n';

export interface TableRows {
  header: string[];
  rows: string[][];
}

/**
 * State, scanning, repair, change notification and the helpers every
 * mutation shares. `LocalWiki` is the public surface; this split only keeps
 * the files small.
 */
export class WikiCore {
  readonly root: string;
  protected readonly options: OpenWikiOptions;
  protected marker: MarkerData;
  protected types = new Map<string, WikiTypeDef>();
  protected editorTypes: Map<string, string>;
  protected typeIssues: WikiIssue[] = [];
  protected state!: ScanState;
  protected readonly cache: ScanCache = new Map();
  protected queue: Promise<unknown> = Promise.resolve();
  protected readonly listeners = new Set<(change: LocalWikiChange) => void>();
  protected signatures = new Map<string, string>();
  protected baselineRecorded = false;
  protected watchHandles: Array<{ close(): void }> = [];
  protected debounceTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly duplicates: DuplicateLog = new Map();
  /** True while this instance holds the cross-process write lock (always inside `exclusive`). */
  private lockHeld = false;

  constructor(root: string, marker: MarkerData, options: OpenWikiOptions) {
    this.root = root;
    this.marker = marker;
    this.options = options;
    this.editorTypes = normalizeEditorTypes(options.editorTypes ?? DEFAULT_EDITOR_TYPES);
  }

  // ---------------------------------------------------------------- internals

  protected now(): number {
    return (this.options.now ?? Date.now)();
  }

  protected exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Runs `fn` holding the wiki's cross-process write lock (see lock.ts). Reentrant within one instance. */
  protected async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.lockHeld) return fn();
    const release = await acquireWriteLock(this.root, {
      timeoutMs: this.options.lockTimeoutMs ?? 10_000,
      staleMs: this.options.lockStaleMs ?? 30_000,
    });
    if (!release) throw new LocalWikiError('exists', 'Another writer holds the wiki write lock; try again');
    this.lockHeld = true;
    try {
      return await fn();
    } finally {
      this.lockHeld = false;
      await release();
    }
  }

  /**
   * A mutation: serialized in this instance, holding the write lock, over a
   * scan taken under that lock, so it never acts on state another process has
   * since changed.
   */
  protected mutate<T>(fn: () => Promise<T>): Promise<T> {
    return this.exclusive(() =>
      this.withWriteLock(async () => {
        await this.refresh();
        return fn();
      }),
    );
  }

  /** Absolute path of a wiki-relative path. Refuses anything that resolves outside the root. */
  protected abs(rel: string): string {
    const abs = toAbs(this.root, rel);
    const back = path.relative(this.root, abs);
    if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
      throw new LocalWikiError('invalid', `${rel} is outside the wiki`);
    }
    return abs;
  }

  protected requireSafeId(id: string): void {
    if (!isSafeId(id)) throw new LocalWikiError('invalid', `${JSON.stringify(id)} is not a valid id (letters, digits, _ and -, with an optional prefix:)`);
  }

  protected projectInput() {
    const tableOrders: Record<string, number> = {};
    for (const [typeId, entry] of Object.entries(this.marker.tables ?? {})) {
      if (typeof entry?.order === 'number') tableOrders[typeId] = entry.order;
    }
    return { state: { ...this.state, issues: [...this.typeIssues, ...this.state.issues] }, formatVersion: this.marker.formatVersion, tableOrders };
  }

  protected project(): LocalWikiSnapshot {
    return projectSnapshot(this.projectInput());
  }

  protected async scan(repair: boolean): Promise<void> {
    const loaded = await loadTypeDefs(this.options.typesDir);
    this.types = loaded.types;
    this.typeIssues = loaded.issues;
    this.state = await scanWiki({
      root: this.root,
      types: this.types,
      editorTypes: this.editorTypes,
      repair,
      cache: this.cache,
      now: this.now(),
      duplicates: this.duplicates,
      duplicateGraceMs: this.options.duplicateGraceMs ?? 60_000,
    });
  }

  /**
   * Scan, apply what the scan can repair, and tell watchers what changed.
   * Repairs are written under the write lock, against a scan taken under it.
   */
  protected async refresh(): Promise<void> {
    const repair = this.options.repair ?? true;
    const held = this.lockHeld;
    await this.scan(repair);
    if (this.state.repairs.length > 0) {
      try {
        await this.withWriteLock(async () => {
          if (!held) await this.scan(repair);
          for (let round = 0; round < 2 && this.state.repairs.length > 0; round++) {
            await this.applyRepairs();
            await this.scan(repair);
          }
        });
      } catch (err) {
        if (held) throw err;
        // Busy or read-only: the repairs wait for the next scan; reading must not fail.
        this.state.issues.push({ code: 'repair-failed', path: '', message: (err as Error).message });
      }
    }
    this.notify();
  }

  /**
   * Applies the scan's repairs. Each one re-reads its file and is skipped if
   * what the scan assumed no longer holds (another writer got there first);
   * the rescan that follows sees the new state.
   */
  protected async applyRepairs(): Promise<void> {
    for (const repair of this.state.repairs) {
      try {
        if (!(await this.repairStillApplies(repair))) continue;
        if (repair.kind === 'add-id' || repair.kind === 'replace-id') {
          await this.storeId(repair.path, repair.id, repair.kind === 'add-id' ? repair.documentType : undefined);
        } else if (repair.kind === 'relink') {
          const page = this.state.pages.get(repair.pageId);
          if (page) await this.relinkPage(page, page.linkTargets, null);
        } else {
          const table = this.state.tables.get(repair.typeId);
          if (!table) continue;
          const { header, rows } = await this.readTableRows(table);
          const seen = new Set<string>();
          for (const row of rows) {
            if (row[0].trim() === '' || seen.has(row[0].trim())) row[0] = ulid();
            seen.add(row[0].trim());
          }
          await atomicWrite(this.abs(table.path), stringifyCsv([header, ...rows]));
        }
      } catch (err) {
        this.state.issues.push({ code: 'repair-failed', path: 'path' in repair ? repair.path : repair.kind, message: (err as Error).message });
      }
    }
  }

  private async repairStillApplies(repair: Repair): Promise<boolean> {
    switch (repair.kind) {
      case 'add-id': {
        if (isSidecarName(path.posix.basename(repair.path))) {
          // The editor file must still be there, or the sidecar would be an orphan.
          const target = relJoin(relDirname(repair.path), sidecarTarget(path.posix.basename(repair.path)));
          if (!(await pathExists(this.abs(target)))) return false;
        }
        return (await this.readStoredId(repair.path)) === null;
      }
      case 'replace-id':
        return (await this.readStoredId(repair.path)) === repair.from && (await this.readStoredId(repair.keeper)) === repair.from;
      case 'relink': {
        const page = this.state.pages.get(repair.pageId);
        if (!page?.path) return false;
        const parsed = parseMarkdownFile(await readFile(this.abs(page.path), 'utf8'));
        return parsed.ok && contentVersion(parsed.body) === repair.version;
      }
      case 'table-ids': {
        const table = this.state.tables.get(repair.typeId);
        if (!table) return false;
        return contentVersion(await readFile(this.abs(table.path), 'utf8')) === repair.version;
      }
    }
  }

  /**
   * The id stored in a markdown file or sidecar right now: the id, null when
   * none is stored (a missing sidecar counts), undefined when it cannot be read.
   */
  private async readStoredId(rel: string): Promise<string | null | undefined> {
    const text = await readFile(this.abs(rel), 'utf8').catch(() => null);
    if (isSidecarName(path.posix.basename(rel))) {
      if (text === null) return null;
      const parsed = parseSidecar(text);
      return parsed.ok ? readPageMeta(parsed.data).id : undefined;
    }
    if (text === null) return undefined;
    const parsed = parseMarkdownFile(text);
    return parsed.ok ? readPageMeta(parsed.data).id : undefined;
  }

  /** Writes `id` into a markdown file's frontmatter (inserting the line when absent) or a sidecar (creating it when missing). */
  private async storeId(rel: string, id: string, documentType?: string): Promise<void> {
    const abs = this.abs(rel);
    if (isSidecarName(path.posix.basename(rel))) {
      let data: Record<string, unknown> = {};
      const existing = await readFile(abs, 'utf8').catch(() => null);
      if (existing !== null) {
        const parsed = parseSidecar(existing);
        if (!parsed.ok) throw new LocalWikiError('malformed', `${rel}: ${parsed.error}`);
        data = parsed.data;
      }
      const recordType = documentType && data.documentType === undefined ? documentType : undefined;
      await this.writeSidecar(rel, { ...data, id, ...(recordType ? { documentType: recordType } : {}) });
      return;
    }
    const text = await readFile(abs, 'utf8');
    const parsed = parseMarkdownFile(text);
    if (!parsed.ok) throw new LocalWikiError('malformed', `${rel}: ${parsed.error}`);
    await atomicWrite(abs, 'id' in parsed.data ? composeMarkdownFile({ ...parsed.data, id }, parsed.body) : insertIdIntoFile(text, id));
  }

  /**
   * A live page about to be written. A duplicate copy, read under a temporary
   * `dup_` id (see scan.ts), first gets a stored id of its own, since the
   * write makes it a page in its own right.
   */
  protected async pageForWrite(id: string): Promise<PageRecord> {
    const page = this.requireLivePage(id);
    const metaPath = page.sidecar ?? page.path;
    if (!page.id.startsWith('dup_') || !metaPath || page.malformed) return page;
    const fresh = ulid(this.now());
    await this.storeId(metaPath, fresh);
    await this.refresh();
    return this.requireLivePage(fresh);
  }

  protected notify(): void {
    const next = new Map<string, string>();
    for (const page of this.state.pages.values()) {
      next.set(page.id, JSON.stringify([page.path, page.dir, page.title, page.order, page.parentId, page.version, page.type, page.fields]));
    }
    for (const [id, trashed] of this.state.trash) next.set(id, `trash:${trashed.manifest.trashedAt}`);
    const tableTypes: string[] = [];
    for (const table of this.state.tables.values()) {
      const key = `table:${table.typeId}`;
      const sig = `${table.path}|${table.version}`;
      if (this.signatures.get(key) !== sig) tableTypes.push(table.typeId);
      next.set(key, sig);
      for (const row of table.rows) next.set(row[0].trim(), JSON.stringify(row));
    }
    const changedIds: string[] = [];
    const removedIds: string[] = [];
    for (const [id, sig] of next) if (!id.startsWith('table:') && this.signatures.get(id) !== sig) changedIds.push(id);
    for (const id of this.signatures.keys()) {
      if (next.has(id)) continue;
      if (id.startsWith('table:')) tableTypes.push(id.slice('table:'.length));
      else removedIds.push(id);
    }
    // The opening scan only records a baseline. Keyed on a flag, not on an
    // empty map, so the first page created in an empty wiki still notifies.
    const first = !this.baselineRecorded;
    this.baselineRecorded = true;
    this.signatures = next;
    if (first || (changedIds.length === 0 && removedIds.length === 0 && tableTypes.length === 0)) return;
    const change: LocalWikiChange = { changedIds, removedIds, tableTypes };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  protected requireLivePage(id: string): PageRecord {
    this.requireSafeId(id);
    const page = this.state.pages.get(id);
    if (page) return page;
    if (this.state.trash.has(id)) throw new LocalWikiError('trashed', `${id} is in trash; restore it first`);
    throw new LocalWikiError('not-found', `No page ${id}`);
  }

  protected requireWellFormed(page: PageRecord): void {
    if (page.malformed) throw new LocalWikiError('malformed', `${page.path} has frontmatter that does not parse or an unsafe id; fix it by hand first`);
  }

  protected activityPath(page: PageRecord): string {
    return relJoin(page.parentDir, page.stem + ACTIVITY_SUFFIX);
  }

  protected tableActivityPath(table: TableRecord): string {
    return table.path.slice(0, -4) + ACTIVITY_SUFFIX;
  }

  protected async appendActivity(rel: string, entry: Omit<ActivityEntry, 'at' | 'actor'>): Promise<void> {
    const full: ActivityEntry = { at: new Date(this.now()).toISOString(), ...entry, ...(this.options.actor ? { actor: this.options.actor } : {}) };
    await mkdir(path.dirname(this.abs(rel)), { recursive: true });
    await appendFile(this.abs(rel), JSON.stringify(full) + '\n');
  }

  /** Names taken in `dir` under the clash rule (markdown stems, editor page stems, folders), minus `self`'s own file and folder. */
  protected async occupiedNames(dir: string, self: PageRecord | null): Promise<Set<string>> {
    const occupied = new Set<string>();
    let names: string[] = [];
    try {
      const entries = await readdir(this.abs(dir), { withFileTypes: true });
      const sidecarTargets = new Set(entries.filter((e) => e.isFile() && isSidecarName(e.name)).map((e) => sidecarTarget(e.name)));
      const tableFiles = new Set([...this.state.tables.values()].map((table) => nameKey(table.path)));
      names = entries.filter((e) => !e.name.startsWith('.')).map((e) => {
        if (e.isDirectory()) return e.name;
        if (!e.isFile() || tableFiles.has(nameKey(relJoin(dir, e.name)))) return '';
        const suffix = this.pageSuffix(e.name, sidecarTargets.has(e.name));
        return suffix ? e.name.slice(0, -suffix.length) : '';
      }).filter(Boolean);
    } catch {
      // folder does not exist yet
    }
    const skip = self && nameKey(self.parentDir) === nameKey(dir) ? nameKey(self.stem) : null;
    for (const name of names) if (nameKey(name) !== skip) occupied.add(nameKey(name));
    // In a folder whose page has no `Name.md`, a child called README or index would become the parent's body.
    const owner = dir === '' ? null : this.state.pages.get(this.state.byDir.get(nameKey(dir)) ?? '');
    if (owner && owner.bodySource !== 'file') {
      occupied.add('readme');
      occupied.add('index');
    }
    return occupied;
  }

  /** The suffix that makes `fileName` a page file (`.md` or an editor suffix), or null. Mirrors the scan. */
  protected pageSuffix(fileName: string, hasSidecar: boolean): string | null {
    const lower = fileName.toLowerCase();
    const editor = editorSuffix(fileName, this.editorTypes);
    if (editor) return editor;
    if (lower.endsWith('.md')) return '.md';
    return hasSidecar ? path.posix.extname(lower) || null : null;
  }

  protected async writeSidecar(rel: string, data: Record<string, unknown>): Promise<void> {
    await atomicWrite(this.abs(rel), serializeSidecar(data));
  }

  protected nextOrder(dir: string): number {
    let max = 0;
    for (const page of this.state.pages.values()) {
      if (nameKey(page.parentDir) === nameKey(dir) && page.order !== null) max = Math.max(max, page.order);
    }
    for (const table of this.state.tables.values()) {
      const order = this.marker.tables?.[table.typeId]?.order;
      if (nameKey(table.parentDir) === nameKey(dir) && typeof order === 'number') max = Math.max(max, order);
    }
    return Math.floor(max / ORDER_STEP) * ORDER_STEP + ORDER_STEP;
  }

  /**
   * Rewrites links in `page` whose path no longer reaches their target.
   * `targets` gives each page link's target by ordinal; `only` limits the
   * rewrite to links aimed at those ids.
   */
  protected async relinkPage(page: PageRecord, targets: (string | null)[], only: Set<string> | null): Promise<void> {
    if (!page.path || page.malformed || page.sidecar) return;
    const abs = this.abs(page.path);
    const parsed = parseMarkdownFile(await readFile(abs, 'utf8'));
    if (!parsed.ok) return;
    const base = linkBaseDir(page);
    const body = rewriteLinks(parsed.body, (link, ordinal) => {
      const targetId = targets[ordinal];
      if (!targetId || (only && !only.has(targetId))) return null;
      const target = this.state.pages.get(targetId);
      if (!target) return null;
      const resolved = resolveLinkPath(base, link.path);
      const current = resolved === null ? undefined : this.state.byFile.get(nameKey(resolved)) ?? this.state.byDir.get(nameKey(resolved));
      if (current === targetId && link.id === targetId) return null;
      if (current === targetId && link.id === null) return null;
      const targetPath = target.path ?? target.dir;
      let rel = path.posix.relative(base, targetPath);
      if (!target.path) rel = (rel === '' ? '.' : rel) + '/';
      return { path: rel, id: targetId };
    });
    if (body !== parsed.body) {
      const block = parsed.block === '' || parsed.block.endsWith('\n') ? parsed.block : parsed.block + '\n';
      await atomicWrite(abs, block + body);
    }
  }

  protected async writeTrashManifest(entryDir: string, manifest: TrashManifest): Promise<void> {
    await atomicWrite(this.abs(relJoin(entryDir, TRASH_MANIFEST)), JSON.stringify(manifest, null, 2) + '\n');
  }

  protected async readTableRows(table: TableRecord): Promise<TableRows> {
    if (table.malformed) throw new LocalWikiError('malformed', `${table.path}: ${table.malformed}`);
    const rows = parseCsv(await readFile(this.abs(table.path), 'utf8'));
    const header = (rows[0] ?? ['id']).map((h) => h.trim());
    if (header[0]?.toLowerCase() !== 'id') throw new LocalWikiError('malformed', `${table.path}: first column must be id`);
    return {
      header,
      rows: rows.slice(1).map((row) => {
        const padded = [...row];
        while (padded.length < header.length) padded.push('');
        return padded;
      }),
    };
  }

}
