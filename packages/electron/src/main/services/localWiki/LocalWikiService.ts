/**
 * The Local section of the Wiki: a folder of files read and written through
 * `@nimbalyst/local-wiki`, the same library `nim` uses. One library instance
 * per wiki folder, opened lazily on the first Local call; several windows (a
 * project and its worktrees) share it.
 *
 * Nothing is created just because a window opened: the folder and its marker
 * are written when the user creates the first page, or when the folder is
 * already there.
 *
 * Changes (the library's watcher, and every write made here) are broadcast as
 * `local-wiki:changed { workspacePath }` to the central renderer listener.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrowserWindow } from 'electron';
import {
  DEFAULT_EDITOR_TYPES,
  initWiki,
  MARKER_FILE,
  openWiki,
  type LocalSearchHit,
  type LocalTrackerCommand,
  type LocalTrackerSnapshot,
  type LocalWiki,
  type LocalWikiCommand,
  type LocalWikiCommandResult,
  type LocalWikiSnapshot,
  type ReadBodyResult,
  type WikiIssue,
  type WriteBodyResult,
} from '@nimbalyst/local-wiki';
import type { PageSearchHit, PageSearchRequest, PageSearchResponse } from '@nimbalyst/collab-protocol';
import { safeHandle } from '../../utils/ipcRegistry';
import { logger } from '../../utils/logger';
import { resolveLocalWikiLocation, type LocalWikiLocation } from './localWikiLocation';
import { logLegacyPersonalPagesHeartbeat, registerPersonalPagesExportIpc } from './personalPagesExportIpc';
import { forgetLocalWikiItemIds, rememberLocalWikiItemIds } from './localWikiItemIds';
import { ensureWikiTypeStorage, readTypeStorage } from './localWikiTypeStorage';
import { isTypePageProse } from './personalPagesExport';
import { getTrackerSchemaLoadFailures, onTrackerSchemaLoadFailuresChanged } from '../tracker/trackerSchemaLoadFailures';

export const LOCAL_WIKI_CHANGED_CHANNEL = 'local-wiki:changed';

/** The library snapshot plus where it lives, so the renderer can open page files. */
export interface LocalWikiSnapshotPayload extends LocalWikiSnapshot {
  /** Absolute wiki folder. */
  root: string;
  /** The folder relative to the project root. */
  location: string;
  /** False until the folder exists; the snapshot is then empty. */
  exists: boolean;
}

export interface LocalWikiServiceDeps {
  resolveLocation?: (workspacePath: string) => LocalWikiLocation;
  broadcast?: (workspacePath: string) => void;
  /** Start the library's fs watcher on open. Default true. */
  watch?: boolean;
  actor?: string;
}

interface Entry {
  location: LocalWikiLocation;
  opening: Promise<LocalWiki | null> | null;
  wiki: LocalWiki | null;
  workspaces: Set<string>;
  unwatch: (() => void) | null;
}

const MUTATING_COMMANDS_THAT_CREATE = new Set<LocalWikiCommand['type']>(['register-document']);

function broadcastChanged(workspacePath: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(LOCAL_WIKI_CHANGED_CHANNEL, { workspacePath });
  }
}

function requireWorkspace(workspacePath: unknown): string {
  if (!workspacePath || typeof workspacePath !== 'string') throw new Error('workspacePath is required');
  return workspacePath;
}

function requireId(value: unknown, name: string): string {
  if (!value || typeof value !== 'string') throw new Error(`${name} is required`);
  return value;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A type page's description (`type-page:<typeId>`) lives in the database
 * Personal pages store, not in the wiki. Before that routing was fixed, giving
 * a Personal type a description could write a stray `<Type>.md` carrying that
 * id into the wiki folder. Such a file is left on disk (it is the user's), but
 * it is not a page: it must not hide the real description row, open in its
 * place, or show in the tree or search.
 */
const reportedStrayTypePages = new Set<string>();

function withoutTypePageProse(snapshot: LocalWikiSnapshot, root: string): LocalWikiSnapshot {
  const stray = snapshot.pages.filter((page) => isTypePageProse(page.id));
  if (stray.length === 0) return snapshot;
  for (const page of stray) {
    const key = `${root}::${page.id}`;
    if (reportedStrayTypePages.has(key)) continue;
    reportedStrayTypePages.add(key);
    logger.main.warn('[LocalWikiService] Ignoring a type description file in the wiki folder; the description is kept in the app', { root, id: page.id, path: page.path });
  }
  return {
    ...snapshot,
    items: snapshot.items.filter((item) => !isTypePageProse(item.documentId)),
    pages: snapshot.pages.filter((page) => !isTypePageProse(page.id)),
  };
}

/**
 * Type files the app could not load, as `malformed-type` issues carrying the
 * type id, so the Local section shows the type as broken instead of dropping
 * its table and typed pages (NIM-7437). The library reports a file that is not
 * YAML at all, without an id; the app's report of the same file replaces it.
 */
function withSchemaLoadFailures<T extends LocalWikiSnapshot>(snapshot: T, workspacePath: string): T {
  const failures = getTrackerSchemaLoadFailures(workspacePath);
  if (failures.length === 0) return snapshot;
  const failedPaths = new Set(failures.map((failure) => failure.filePath));
  const issues: WikiIssue[] = [
    ...failures.map((failure): WikiIssue => ({ code: 'malformed-type', path: failure.filePath, message: failure.message, id: failure.typeId })),
    ...snapshot.issues.filter((issue) => !(issue.code === 'malformed-type' && failedPaths.has(issue.path))),
  ];
  return { ...snapshot, issues };
}

export function emptyLocalWikiSnapshot(location: LocalWikiLocation): LocalWikiSnapshotPayload {
  return {
    items: [],
    containers: [],
    typePlacements: [],
    itemPlacements: [],
    pageTree: true,
    pageFields: true,
    primaryProjectId: null,
    formatVersion: 1,
    pages: [],
    tables: [],
    issues: [],
    root: location.root,
    location: location.location,
    exists: false,
  };
}

/** Where each query word sits in a snippet, for the search result highlight. */
function highlightsIn(snippet: string, query: string): PageSearchHit['highlights'] {
  const lower = snippet.toLowerCase();
  const out: PageSearchHit['highlights'] = [];
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    let from = 0;
    for (let at = lower.indexOf(word, from); at !== -1; at = lower.indexOf(word, from)) {
      out.push({ start: at, end: at + word.length });
      from = at + word.length;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function toPageSearchHit(hit: LocalSearchHit, query: string): PageSearchHit {
  return {
    kind: hit.type ? 'typed' : 'page',
    id: hit.id,
    documentId: hit.id,
    title: hit.title,
    issueKey: null,
    snippet: hit.snippet,
    highlights: highlightsIn(hit.snippet, query),
    updatedAt: null,
    score: hit.score,
  };
}

export class LocalWikiService {
  private readonly entries = new Map<string, Entry>();
  private readonly resolveLocation: (workspacePath: string) => LocalWikiLocation;
  private readonly broadcast: (workspacePath: string) => void;
  private readonly watchFiles: boolean;
  private readonly actor: string | undefined;
  /** Editor page suffixes: the library's built-in ones plus what the renderer's type catalog adds. */
  private editorTypes: Record<string, string> = { ...DEFAULT_EDITOR_TYPES };
  private disposed = false;

  constructor(deps: LocalWikiServiceDeps = {}) {
    this.resolveLocation = deps.resolveLocation ?? resolveLocalWikiLocation;
    this.broadcast = deps.broadcast ?? broadcastChanged;
    this.watchFiles = deps.watch ?? true;
    this.actor = deps.actor;
  }

  location(workspacePath: string): LocalWikiLocation {
    return this.resolveLocation(requireWorkspace(workspacePath));
  }

  /**
   * The wiki for a workspace. Opens an existing wiki; initializes a folder
   * that already exists; creates the folder only with `create`. Null when
   * there is no folder and `create` is false.
   */
  async wikiFor(workspacePath: string, create = false): Promise<LocalWiki | null> {
    if (this.disposed) throw new Error('LocalWikiService is disposed');
    const ws = requireWorkspace(workspacePath);
    const location = this.resolveLocation(ws);
    let entry = this.entries.get(location.root);
    if (!entry) {
      entry = { location, opening: null, wiki: null, workspaces: new Set(), unwatch: null };
      this.entries.set(location.root, entry);
    }
    entry.workspaces.add(ws);
    if (entry.wiki) return entry.wiki;
    if (entry.opening) {
      const opened = await entry.opening;
      if (opened || !create) return opened;
    }
    const current = entry;
    current.opening = this.open(current, create).finally(() => {
      current.opening = null;
    });
    return current.opening;
  }

  private async open(entry: Entry, create: boolean): Promise<LocalWiki | null> {
    const { root, typesDir } = entry.location;
    const hasMarker = fs.existsSync(path.join(root, MARKER_FILE));
    if (!hasMarker) {
      if (!create && !isDirectory(root)) return null;
      logger.main.info('[LocalWikiService] Initializing local wiki folder', { root, reason: create ? 'first page' : 'folder exists' });
      await initWiki(root);
    }
    const wiki = await openWiki(root, { typesDir, editorTypes: this.editorTypes, ...(this.actor ? { actor: this.actor } : {}) });
    entry.wiki = wiki;
    if (this.watchFiles) {
      entry.unwatch = wiki.watch(() => {
        void this.rememberItemIds(wiki);
        this.notify(entry);
      });
    }
    await this.rememberItemIds(wiki);
    logger.main.info('[LocalWikiService] Opened local wiki', { root });
    return wiki;
  }

  /** Keeps the typed-page and row ids current for the write guards (`localWikiItemIds`). Never throws. */
  private async rememberItemIds(wiki: LocalWiki, snapshot?: LocalWikiSnapshot): Promise<void> {
    try {
      const current = snapshot ?? await wiki.snapshot();
      const ids = current.pages.filter((page) => page.type && page.trashedAt === null).map((page) => page.id);
      for (const table of current.tables) {
        for (const item of (await wiki.trackerSnapshot(table.typeId)).items) ids.push(item.id);
      }
      rememberLocalWikiItemIds(wiki.root, ids);
    } catch (error) {
      logger.main.warn('[LocalWikiService] Could not read the wiki item ids', { root: wiki.root, error });
    }
  }

  private notify(entry: Entry): void {
    for (const ws of entry.workspaces) this.broadcast(ws);
  }

  /**
   * Every write is announced here as well as by the watcher: the watcher is
   * debounced and does not run in tests, and the renderer coalesces repeats.
   */
  announceChange(workspacePath: string): void {
    const entry = this.entries.get(this.resolveLocation(workspacePath).root);
    if (entry) this.notify(entry);
    else this.broadcast(workspacePath);
  }

  /**
   * The editor types the renderer's catalog can share (suffix to document
   * type), added to the built-in ones so every reader agrees on at least those.
   * Open wikis rescan when the table changed; their watchers announce it.
   */
  async setEditorTypes(table: Record<string, string>): Promise<void> {
    if (!table || typeof table !== 'object' || Object.values(table).some((value) => typeof value !== 'string')) {
      throw new Error('editor types must map file suffixes to document types');
    }
    const next = { ...DEFAULT_EDITOR_TYPES, ...table };
    if (JSON.stringify(Object.entries(next).sort()) === JSON.stringify(Object.entries(this.editorTypes).sort())) return;
    this.editorTypes = next;
    for (const entry of this.entries.values()) {
      if (!entry.wiki) continue;
      await entry.wiki.setEditorTypes(next);
      this.notify(entry);
    }
  }

  private async requireWiki(workspacePath: string, create = false): Promise<LocalWiki> {
    const wiki = await this.wikiFor(workspacePath, create);
    if (!wiki) throw new Error(`There is no local wiki yet at ${this.resolveLocation(workspacePath).location}; create a page first`);
    return wiki;
  }

  async snapshot(workspacePath: string): Promise<LocalWikiSnapshotPayload> {
    const ws = requireWorkspace(workspacePath);
    const location = this.resolveLocation(ws);
    const wiki = await this.wikiFor(ws);
    if (!wiki) return withSchemaLoadFailures(emptyLocalWikiSnapshot(location), ws);
    const snapshot = await wiki.snapshot();
    await this.rememberItemIds(wiki, snapshot);
    return withSchemaLoadFailures(
      { ...withoutTypePageProse(snapshot, wiki.root), root: wiki.root, location: location.location, exists: true },
      ws,
    );
  }

  async command(workspacePath: string, command: LocalWikiCommand): Promise<LocalWikiCommandResult> {
    const ws = requireWorkspace(workspacePath);
    if (!command || typeof command !== 'object' || typeof command.type !== 'string') throw new Error('command is required');
    if (command.type === 'set-type-placement') return this.placeType(ws, command);
    if (command.type === 'set-document-type' && command.pageType) {
      // Decision 9: only a wiki type's items are files.
      const storage = await readTypeStorage(this.resolveLocation(ws).typesDir, command.pageType);
      if (storage !== 'pages') {
        throw new Error(storage === 'table'
          ? `"${command.pageType}" keeps its items as rows of a table; add a row there instead`
          : `"${command.pageType}" is not a Local wiki type; place it in the Local section first`);
      }
    }
    const wiki = await this.requireWiki(ws, MUTATING_COMMANDS_THAT_CREATE.has(command.type));
    const result = await wiki.command(command);
    await this.rememberItemIds(wiki);
    if (command.type !== 'refresh') this.announceChange(ws);
    return result;
  }

  /**
   * Place type in the Local section: the type becomes a wiki type (`storage:`
   * in its YAML, `pages` unless it already says otherwise). A page type has no
   * placement of its own, since its items are files wherever they sit; a table
   * type's CSV moves to the named parent.
   */
  private async placeType(workspacePath: string, command: Extract<LocalWikiCommand, { type: 'set-type-placement' }>): Promise<LocalWikiCommandResult> {
    const storage = await ensureWikiTypeStorage(this.resolveLocation(workspacePath).typesDir, command.typeId);
    const wiki = await this.requireWiki(workspacePath, true);
    const result = storage === 'table' ? await wiki.command(command) : await wiki.command({ type: 'refresh' });
    this.announceChange(workspacePath);
    return result;
  }

  async readBody(workspacePath: string, id: string): Promise<ReadBodyResult> {
    const wiki = await this.requireWiki(requireWorkspace(workspacePath));
    return wiki.readBody(requireId(id, 'id'));
  }

  async writeBody(workspacePath: string, id: string, markdown: string, expectedVersion: string | null): Promise<WriteBodyResult> {
    const ws = requireWorkspace(workspacePath);
    if (typeof markdown !== 'string') throw new Error('markdown must be a string');
    const wiki = await this.requireWiki(ws);
    const result = await wiki.writeBody(requireId(id, 'id'), markdown, expectedVersion ?? null);
    if (result.ok) this.announceChange(ws);
    return result;
  }

  async trackerSnapshot(workspacePath: string, typeId: string): Promise<LocalTrackerSnapshot> {
    const ws = requireWorkspace(workspacePath);
    const wiki = await this.wikiFor(ws);
    if (!wiki) return { typeId: requireId(typeId, 'typeId'), storage: 'pages', items: [], version: null };
    return wiki.trackerSnapshot(requireId(typeId, 'typeId'));
  }

  async trackerCommand(workspacePath: string, typeId: string, command: LocalTrackerCommand): Promise<LocalWikiCommandResult> {
    const ws = requireWorkspace(workspacePath);
    if (!command || typeof command !== 'object') throw new Error('command is required');
    if (command.type === 'create-item' && !(await readTypeStorage(this.resolveLocation(ws).typesDir, typeId))) {
      // Decision 9: only a wiki type's items are files; the rest stay in the app database.
      throw new Error(`"${typeId}" is not a Local wiki type; its items stay in the app database`);
    }
    const wiki = await this.requireWiki(ws, command.type === 'create-item');
    const result = await wiki.trackerCommand(requireId(typeId, 'typeId'), command);
    await this.rememberItemIds(wiki);
    this.announceChange(ws);
    return result;
  }

  async search(workspacePath: string, request: PageSearchRequest): Promise<PageSearchResponse> {
    const ws = requireWorkspace(workspacePath);
    const query = typeof request?.query === 'string' ? request.query : '';
    const wiki = await this.wikiFor(ws);
    if (!wiki || !query.trim()) return { hits: [], status: 'ready' };
    const typeIds = Array.isArray(request.typeIds) ? new Set(request.typeIds) : null;
    const hits = (await wiki.search(query, { limit: Math.min(request.limit ?? 20, 50) * 2 }))
      .filter((hit) => !isTypePageProse(hit.id))
      .filter((hit) => !hit.type || !typeIds || typeIds.has(hit.type))
      .slice(0, Math.min(request.limit ?? 20, 50))
      .map((hit) => toPageSearchHit(hit, query));
    return { hits, status: 'ready' };
  }

  /** Absolute path of a page's file (markdown or editor file); null for a bare folder page or an unknown id. */
  async pageFilePath(workspacePath: string, id: string): Promise<string | null> {
    const wiki = await this.wikiFor(requireWorkspace(workspacePath));
    if (!wiki || isTypePageProse(id)) return null;
    const page = (await wiki.snapshot()).pages.find((candidate) => candidate.id === id && candidate.trashedAt === null);
    return page?.path ? path.join(wiki.root, ...page.path.split('/')) : null;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.unwatch?.();
      entry.wiki?.close();
      forgetLocalWikiItemIds(entry.location.root);
    }
    this.entries.clear();
  }
}

let service: LocalWikiService | null = null;

export function getLocalWikiService(): LocalWikiService {
  service ??= new LocalWikiService();
  return service;
}

export function initLocalWikiService(): void {
  const instance = getLocalWikiService();
  safeHandle('local-wiki:snapshot', async (_event, workspacePath: string) => instance.snapshot(workspacePath));
  safeHandle('local-wiki:command', async (_event, workspacePath: string, command: LocalWikiCommand) =>
    instance.command(workspacePath, command));
  safeHandle('local-wiki:read-body', async (_event, workspacePath: string, id: string) => instance.readBody(workspacePath, id));
  safeHandle(
    'local-wiki:write-body',
    async (_event, workspacePath: string, id: string, markdown: string, expectedVersion: string | null) =>
      instance.writeBody(workspacePath, id, markdown, expectedVersion),
  );
  safeHandle('local-wiki:tracker-snapshot', async (_event, workspacePath: string, typeId: string) =>
    instance.trackerSnapshot(workspacePath, typeId));
  safeHandle('local-wiki:tracker-command', async (_event, workspacePath: string, typeId: string, command: LocalTrackerCommand) =>
    instance.trackerCommand(workspacePath, typeId, command));
  safeHandle('local-wiki:search', async (_event, workspacePath: string, request: PageSearchRequest) =>
    instance.search(workspacePath, request ?? { query: '' }));
  safeHandle('local-wiki:set-editor-types', async (_event, table: Record<string, string>) => instance.setEditorTypes(table));
  registerPersonalPagesExportIpc(instance);
  onTrackerSchemaLoadFailuresChanged((workspacePath) => instance.announceChange(workspacePath));
  void logLegacyPersonalPagesHeartbeat();
}

export function disposeLocalWikiService(): void {
  service?.dispose();
  service = null;
}
