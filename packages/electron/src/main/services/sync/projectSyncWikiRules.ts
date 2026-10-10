/**
 * Project file sync rules for the project's Local wiki folder (see
 * `packages/local-wiki/FORMAT.md`).
 *
 * File identity on the wire is the path, so a page rename or move on one
 * desktop reaches the others as delete(old) + add(new). Desktops never remove a
 * local file on a remote delete (`ProjectFileSyncService.applyRemoteDelete`), so
 * the old copy stayed, was offered back to the server, and the wiki library
 * then found two files with one `id` and rewrote one of them. Inside the wiki a
 * page carries its own identity in frontmatter, which lets a desktop tell a
 * move from a delete: when the `id` of the file a remote delete names now lives
 * at another path in the wiki, the delete was a move. The stale copy then goes
 * to the wiki's `.trash/` in the library's trash format, never to `unlink`.
 * Table CSVs have no id; their identity is their type (`projectSyncWikiTables.ts`).
 *
 * The wiki's `.trash/` itself is never synced. Markdown syncs everywhere; the
 * wiki's table files (`.csv`) sync only inside a wiki that exists (its marker
 * is on disk), the same rule config discovery uses to tell the phone where the
 * wiki is. The marker itself is eligible at the configured location whether
 * or not it exists yet: that is how a second desktop bootstraps the wiki from
 * the first, after which its tables follow.
 */
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import yaml from 'js-yaml';
import { ACTIVITY_SUFFIX, MARKER_FILE, TRASH_DIR, acquireWriteLock } from '@nimbalyst/local-wiki';
import { logger } from '../../utils/logger';
import { dirtyEditorRegistry } from '../DirtyEditorRegistry';
import { localWikiFolderWithin } from '../localWiki/localWikiLocation';
import { liveTableElsewhere, wikiTableTypeOf, type WikiTableType } from './projectSyncWikiTables';

/** FORMAT.md "Trash": written into each entry before anything moves. */
const TRASH_MANIFEST = '.trash.json';
const WIKI_FOLDER_TTL_MS = 5_000;
const MAX_PENDING_DELETES = 500;

const wikiFolderCache = new Map<string, { folder: string | null; at: number }>();

/** The wiki folder relative to the workspace (`/` separators), or null. Cached briefly: the watcher asks per event. */
function wikiFolder(workspacePath: string): string | null {
  const hit = wikiFolderCache.get(workspacePath);
  if (hit && Date.now() - hit.at < WIKI_FOLDER_TTL_MS) return hit.folder;
  const folder = localWikiFolderWithin(workspacePath);
  wikiFolderCache.set(workspacePath, { folder, at: Date.now() });
  return folder;
}

function wikiRootWithin(workspacePath: string): string | null {
  const folder = wikiFolder(workspacePath);
  return folder ? path.join(workspacePath, ...folder.split('/')) : null;
}

function relPosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

function isInside(root: string, filePath: string): boolean {
  const rel = relPosix(root, filePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** True for the wiki's `.trash/` folder and anything under it. */
export function isInWikiTrash(filePath: string, workspacePath: string): boolean {
  const root = wikiRootWithin(workspacePath);
  if (!root) return false;
  const rel = relPosix(root, filePath);
  return rel === TRASH_DIR || rel.startsWith(`${TRASH_DIR}/`);
}

/**
 * The one filter for the paths project file sync carries: markdown anywhere,
 * the marker at the wiki location, and `.csv` tables inside a wiki whose
 * marker exists; never the wiki's trash. The marker check is not cached, so a
 * table that arrives right after the marker in one batch is accepted.
 */
export function isProjectSyncPath(filePath: string, workspacePath: string): boolean {
  if (filePath.endsWith('.md')) return !isInWikiTrash(filePath, workspacePath);
  if (path.basename(filePath) === MARKER_FILE) return isWikiMarkerPath(filePath, workspacePath);
  return isWikiTablePath(filePath, workspacePath) && existsSync(path.join(wikiRootWithin(workspacePath)!, MARKER_FILE));
}

/** The marker at the wiki location, whether or not it exists yet. */
export function isWikiMarkerPath(filePath: string, workspacePath: string): boolean {
  const root = wikiRootWithin(workspacePath);
  return root !== null && path.resolve(filePath) === path.join(root, MARKER_FILE);
}

/**
 * The server does not order a batch; the wiki marker goes first so the tables
 * it makes eligible on a desktop that lacks the wiki are not refused.
 */
export function wikiMarkerFirst<T extends { relativePath: string }>(files: T[], workspacePath: string): T[] {
  const isMarker = (f: T) => isWikiMarkerPath(path.join(workspacePath, f.relativePath), workspacePath);
  return [...files.filter(isMarker), ...files.filter((f) => !isMarker(f))];
}

/** A `.csv` inside the wiki location, outside its trash; synced once the marker exists. */
function isWikiTablePath(filePath: string, workspacePath: string): boolean {
  const root = wikiRootWithin(workspacePath);
  return root !== null && filePath.endsWith('.csv') && isInside(root, filePath) && !isInWikiTrash(filePath, workspacePath);
}

/** The wiki's syncable tables on disk (dot-names and trash skipped, as the library does). */
export async function wikiTableFiles(workspacePath: string): Promise<string[]> {
  const root = wikiRootWithin(workspacePath);
  if (!root) return [];
  const found: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile() && isProjectSyncPath(abs, workspacePath)) found.push(abs);
    }
  };
  await walk(root);
  return found.filter((f) => f.endsWith('.csv'));
}

const FRONTMATTER_OPEN = /^﻿?---[ \t]*\r?\n/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;

/** Frontmatter as the library reads it (YAML core schema), or null when absent or unparseable. */
function readFrontmatter(text: string): Record<string, unknown> | null {
  const open = FRONTMATTER_OPEN.exec(text);
  if (!open) return null;
  const rest = text.slice(open[0].length);
  const close = FRONTMATTER_CLOSE.exec(rest);
  if (!close) return null;
  try {
    const data = yaml.load(rest.slice(0, close.index), { schema: yaml.CORE_SCHEMA });
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pageId(text: string): string | null {
  const id = readFrontmatter(text)?.id;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
}

/** What makes two wiki files the same item: a page's frontmatter id, or a table's type. */
interface WikiIdentity {
  /** The page id, or `table:<typeId>` (the library's trash id for a table). */
  id: string;
  table: WikiTableType | null;
}

async function identityOf(workspacePath: string, filePath: string, text: string): Promise<WikiIdentity | null> {
  if (filePath.toLowerCase().endsWith('.csv')) {
    const table = await wikiTableTypeOf(workspacePath, filePath);
    return table ? { id: `table:${table.typeId}`, table } : null;
  }
  const id = pageId(text);
  return id ? { id, table: null } : null;
}

/** Where the item with this content now lives, verified on disk, or null when it did not move. */
async function liveElsewhere(root: string, filePath: string, identity: WikiIdentity, text: string, candidates?: string[]): Promise<string | null> {
  if (identity.table) return liveTableElsewhere(root, filePath, identity.table, text, candidates);
  return firstVerified(candidates ?? await livePagesWithId(root, identity.id, filePath), identity.id);
}

const idCache = new Map<string, { mtimeMs: number; size: number; id: string | null }>();

/** Live wiki pages (dot-names and trash skipped, as the library does) whose frontmatter `id` is `id`. */
async function livePagesWithId(root: string, id: string, exclude: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile() && entry.name.endsWith('.md') && abs !== exclude) {
        try {
          const st = await fs.stat(abs);
          let hit = idCache.get(abs);
          if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
            hit = { mtimeMs: st.mtimeMs, size: st.size, id: pageId(await fs.readFile(abs, 'utf-8')) };
            idCache.set(abs, hit);
          }
          if (hit.id === id) found.push(abs);
        } catch {
          // vanished or unreadable: not a match
        }
      }
    }
  };
  await walk(root);
  return found;
}

/** Re-read from disk, uncached: the other copy must really carry the id and parse. */
async function firstVerified(paths: string[], id: string): Promise<string | null> {
  for (const candidate of paths) {
    try {
      if (pageId(await fs.readFile(candidate, 'utf-8')) === id) return candidate;
    } catch {
      // gone since the walk
    }
  }
  return null;
}

export interface StaleWikiCopyEvent {
  workspacePath: string;
  /** The page id, or `table:<typeId>` for a table CSV. */
  id: string;
  /** The copy a remote delete named, about to move into trash. */
  stalePath: string;
  /** The verified live page carrying the same id, or the table's current file. */
  livePath: string;
}

/** Emits `stale-copy` before a stale copy moves into the wiki trash, so an interrupted move is still on record. */
export const projectSyncWikiEvents = new EventEmitter();

export interface WikiRulesHost {
  /** Content hash both sides last agreed on for a synced file. */
  baselineHash(projectId: string, syncId: string): string | undefined;
  /** Drop sync state for a path that moved into the wiki trash (no longer synced). */
  forget(projectId: string, syncId: string, filePath: string): Promise<void>;
}

interface PendingDelete {
  projectId: string;
  workspacePath: string;
  syncId: string;
  filePath: string;
  /** The identity the kept file carried when its delete arrived. */
  id: string;
  /** The exact content the delete was decided on; newer content at the path is never trashed by it. */
  hash: string;
}

/** A verified move: the stale copy's bytes and identity, and where the item lives now. */
interface MoveDecision {
  identity: WikiIdentity;
  text: string;
  livePath: string;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export class ProjectSyncWikiRules {
  // Remote page deletes inside the wiki that were kept because the page's new
  // path had not arrived yet. A rename sends its delete before its add, so the
  // add settles them. Keyed by absolute path. Table deletes are never held: a
  // table's evidence is its rows, and a later delivery of the same delete (the
  // server's tombstone on reconnect) decides again.
  private pendingDeletes = new Map<string, PendingDelete>();

  constructor(private readonly host: WikiRulesHost) {}

  /**
   * A remote delete for `filePath`. Returns true when it was a move and the
   * stale copy is now in the wiki trash; false leaves today's behavior (keep).
   */
  async applyRemoteDelete(projectId: string, workspacePath: string, syncId: string, filePath: string): Promise<boolean> {
    const root = wikiRootWithin(workspacePath);
    if (!root || !isInside(root, filePath) || isInWikiTrash(filePath, workspacePath)) return false;
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf-8');
    } catch {
      return false; // gone already
    }
    const identity = await identityOf(workspacePath, filePath, text);
    if (!identity) return false;
    const pending = { projectId, workspacePath, syncId, filePath, id: identity.id, hash: sha256(text) };
    if (await this.trashIfMoved(root, pending)) return true;
    this.pendingDeletes.delete(filePath);
    if (identity.table) return false;
    this.pendingDeletes.set(filePath, pending);
    if (this.pendingDeletes.size > MAX_PENDING_DELETES) this.pendingDeletes.delete(this.pendingDeletes.keys().next().value!);
    return false;
  }

  /** A remote write landed at `filePath`; a kept delete whose page it carries was a move. */
  async afterRemoteWrite(projectId: string, workspacePath: string, filePath: string, content: string): Promise<void> {
    // Newer content at a held path supersedes the delete that named it.
    this.pendingDeletes.delete(filePath);
    if (this.pendingDeletes.size === 0) return;
    const root = wikiRootWithin(workspacePath);
    // Dot-names are not pages to the library, so they cannot be where a page moved.
    if (!root || !isInside(root, filePath) || relPosix(root, filePath).split('/').some((s) => s.startsWith('.'))) return;
    const identity = await identityOf(workspacePath, filePath, content);
    if (!identity || identity.table) return;
    for (const pending of [...this.pendingDeletes.values()]) {
      if (pending.projectId !== projectId || pending.id !== identity.id) continue;
      if (await this.trashIfMoved(root, pending, [filePath])) this.pendingDeletes.delete(pending.filePath);
    }
  }

  /**
   * True when the server offers back a wiki page or table this desktop moved
   * away while sync was not running: the path is gone locally, the server holds
   * exactly the content this desktop last agreed on, and that page's id (or a
   * table of the same type holding all its rows, cell for cell) now lives at another path
   * here. The caller propagates the local delete instead of writing the old
   * path back.
   */
  async isMovedAwayLocally(
    projectId: string,
    workspacePath: string,
    file: { syncId: string; relativePath: string; content: string; contentHash: string },
  ): Promise<boolean> {
    const filePath = path.join(workspacePath, file.relativePath);
    const root = wikiRootWithin(workspacePath);
    if (!root || !isInside(root, filePath)) return false;
    if (this.host.baselineHash(projectId, file.syncId) !== file.contentHash) return false;
    const identity = await identityOf(workspacePath, filePath, file.content);
    if (!identity) return false;
    const live = await liveElsewhere(root, filePath, identity, file.content);
    if (!live) return false;
    logger.main.warn(`[ProjectFileSync] ${relPosix(workspacePath, filePath)} moved to ${relPosix(workspacePath, live)} on this desktop; sending the delete instead of restoring the old path`);
    return true;
  }

  /**
   * The whole move decision, from disk. `candidates`: where the live copy is
   * expected; the whole wiki is searched when omitted.
   */
  private async decideMove(root: string, pending: PendingDelete, candidates?: string[]): Promise<MoveDecision | null> {
    const { projectId, workspacePath, syncId, filePath } = pending;
    if (dirtyEditorRegistry.isDirty(filePath)) return null;
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
    // Only the content the delete concerned, and only while both sides still agree on it (no unsynced local edits).
    if (sha256(text) !== pending.hash || this.host.baselineHash(projectId, syncId) !== pending.hash) return null;
    const identity = await identityOf(workspacePath, filePath, text);
    if (!identity || identity.id !== pending.id) return null;
    const livePath = await liveElsewhere(root, filePath, identity, text, candidates);
    return livePath ? { identity, text, livePath } : null;
  }

  private async trashIfMoved(root: string, pending: PendingDelete, candidates?: string[]): Promise<boolean> {
    const decision = await this.decideMove(root, pending, candidates);
    if (!decision) return false;
    const { projectId, workspacePath, syncId, filePath } = pending;
    const { id } = decision.identity;

    const event: StaleWikiCopyEvent = { workspacePath, id, stalePath: filePath, livePath: decision.livePath };
    logger.main.warn(`[ProjectFileSync] Remote delete of ${relPosix(workspacePath, filePath)} was a move to ${relPosix(workspacePath, decision.livePath)} (id ${id}); moving the stale copy to the wiki trash`);
    projectSyncWikiEvents.emit('stale-copy', event);

    // Decided again under the lock: the live copy, the type definitions, the
    // editor and the old bytes may all have changed while it was awaited.
    const entryDir = await moveToTrash(root, filePath, async () => {
      const again = await this.decideMove(root, pending, [decision.livePath]);
      return again && again.identity.id === id ? again : null;
    });
    if (!entryDir) return false;
    await this.host.forget(projectId, syncId, filePath);
    await removeEmptyFolders(root, filePath);
    logger.main.info(`[ProjectFileSync] Stale copy kept in ${relPosix(workspacePath, entryDir)}`);
    return true;
  }
}

/**
 * Moves the stale copy under the wiki's write lock, so it cannot interleave
 * with a library write from this app or `nim`, and only if the move still
 * holds once the lock is taken.
 */
async function moveToTrash(root: string, filePath: string, redecide: () => Promise<MoveDecision | null>): Promise<string | null> {
  const release = await acquireWriteLock(root, { timeoutMs: 10_000, staleMs: 30_000 });
  if (!release) {
    logger.main.warn(`[ProjectFileSync] Wiki write lock busy; stale copy ${filePath} left in place for now`);
    return null;
  }
  try {
    const decision = await redecide();
    if (!decision) {
      logger.main.info(`[ProjectFileSync] ${filePath} is no longer a verified move; left in place`);
      return null;
    }
    const entry = await trashEntry(root, filePath, decision);
    return entry ? await moveToTrashLocked(root, filePath, entry) : null;
  } finally {
    await release();
  }
}

/** `ids.ts` `isSafeId`: an id that cannot name a path. */
const SAFE_ID = /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?$/;

interface TrashEntry {
  /** The entry folder name for an entry trashed at `trashedAt`. */
  dirName(trashedAt: number): string;
  manifest(trashedAt: number): Record<string, unknown>;
  /** The item's activity log beside it, moved with it (FORMAT.md "Activity"). */
  activity: string | null;
}

/** A page or table entry in the library's trash format (`tables.ts` writes tables the same way). */
async function trashEntry(root: string, filePath: string, { identity, text }: MoveDecision): Promise<TrashEntry | null> {
  if (identity.id.length > 200 || !SAFE_ID.test(identity.id)) {
    logger.main.warn(`[ProjectFileSync] ${JSON.stringify(identity.id)} is not a safe id; ${filePath} left in place`);
    return null;
  }
  const name = path.basename(filePath);
  const activityName = `${name.slice(0, -path.extname(name).length)}${ACTIVITY_SUFFIX}`;
  const activity = await fs.stat(path.join(path.dirname(filePath), activityName)).then((s) => s.isFile(), () => false)
    ? path.join(path.dirname(filePath), activityName)
    : null;
  const withActivity = activity ? { activity: activityName } : {};
  const originalDir = relPosix(root, path.dirname(filePath));
  const { table } = identity;
  if (table) {
    return {
      dirName: (trashedAt) => `${trashedAt}-table-${table.typeId}`,
      manifest: (trashedAt) => ({
        formatVersion: 1, kind: 'table', id: identity.id, title: table.displayNamePlural, trashedAt,
        originalParentId: null, originalDir, typeId: table.typeId, entries: { csv: name, ...withActivity },
      }),
      activity,
    };
  }
  const meta = readFrontmatter(text) ?? {};
  return {
    dirName: (trashedAt) => `${trashedAt}-${identity.id.replace(/:/g, '_')}`,
    manifest: (trashedAt) => ({
      formatVersion: 1, kind: 'page', id: identity.id,
      title: typeof meta.title === 'string' ? meta.title : path.basename(filePath, '.md'),
      trashedAt, originalParentId: null, originalDir, entries: { md: name, ...withActivity },
      pageType: typeof meta.type === 'string' ? meta.type : null,
    }),
    activity,
  };
}

/** The manifest first, then the file and its activity log. Returns the entry folder, or null. */
async function moveToTrashLocked(root: string, filePath: string, entry: TrashEntry): Promise<string | null> {
  const trashRoot = path.join(root, TRASH_DIR);
  let trashedAt = Date.now();
  let entryDir = path.join(trashRoot, entry.dirName(trashedAt));
  for (;;) {
    if (path.dirname(entryDir) !== trashRoot) {
      logger.main.error(`[ProjectFileSync] Trash entry ${entryDir} is outside ${trashRoot}; ${filePath} left in place`);
      return null;
    }
    try {
      await fs.mkdir(trashRoot, { recursive: true });
      await fs.mkdir(entryDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        logger.main.error(`[ProjectFileSync] Could not create a wiki trash entry for ${filePath}; left in place:`, err);
        return null;
      }
      trashedAt += 1;
      entryDir = path.join(trashRoot, entry.dirName(trashedAt));
    }
  }
  try {
    const tmp = path.join(entryDir, `${TRASH_MANIFEST}.${randomBytes(4).toString('hex')}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(entry.manifest(trashedAt), null, 2) + '\n', 'utf-8');
    await fs.rename(tmp, path.join(entryDir, TRASH_MANIFEST));
    // The lock does not stop typing: an editor that turned dirty during the awaits above keeps its file.
    // Nothing is awaited between this check and the rename.
    if (dirtyEditorRegistry.isDirty(filePath)) throw new Error('its editor has unsaved edits');
    await fs.rename(filePath, path.join(entryDir, path.basename(filePath)));
  } catch (err) {
    logger.main.error(`[ProjectFileSync] Could not move ${filePath} into the wiki trash; left in place:`, err);
    // Only our manifest is in the entry; the file never left its path.
    await fs.rm(entryDir, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
  if (entry.activity) {
    await fs.rename(entry.activity, path.join(entryDir, path.basename(entry.activity))).catch((err) => {
      logger.main.error(`[ProjectFileSync] Activity log ${entry.activity} stayed beside the trashed file:`, err);
    });
  }
  return entryDir;
}

/**
 * A moved page's children arrive as their own delete+add pairs, so the old
 * child folder empties out one file at a time. An empty folder left behind
 * would read as a bare folder page, so remove it. `rmdir` only succeeds on an
 * empty folder.
 */
async function removeEmptyFolders(root: string, filePath: string): Promise<void> {
  const candidates = filePath.endsWith('.md') ? [filePath.slice(0, -'.md'.length), path.dirname(filePath)] : [path.dirname(filePath)];
  for (const dir of candidates) {
    if (!isInside(root, dir)) continue;
    await fs.rmdir(dir).catch(() => undefined);
  }
}
