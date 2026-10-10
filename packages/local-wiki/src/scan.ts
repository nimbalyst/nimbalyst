import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { contentVersion, derivedId, isSafeId, ulid } from './ids.js';
import { parseMarkdownFile, readPageMeta } from './frontmatter.js';
import { findLinks, type MarkdownLink } from './links.js';
import { fileStemForTitle, nameKey, titleForStem } from './names.js';
import { parseCsv } from './csv.js';
import { relDirname, relJoin, toAbs } from './fsutil.js';
import type { LocalPage, WikiIssue } from './types.js';
import type { WikiTypeDef } from './typeDefs.js';
import {
  editorSuffix,
  isSidecarName,
  looksBinary,
  parseSidecar,
  SCAN_READ_LIMIT,
  SEARCH_BODY_LIMIT,
  sidecarName,
  sidecarTarget,
} from './sidecar.js';

export const MARKER_FILE = '.nimbalyst-wiki.yaml';
export const TRASH_DIR = '.trash';
export const TRASH_MANIFEST = '.trash.json';
export const ACTIVITY_SUFFIX = '.activity.jsonl';

export interface PageRecord extends LocalPage {
  /** File stem (name without `.md` or the editor suffix), or folder name for a bare folder / README page. */
  stem: string;
  /** Editor pages: wiki-relative sidecar path (the file may not exist yet). Null for markdown. */
  sidecar: string | null;
  parentDir: string;
  /** Frontmatter as parsed (empty for a bare folder or malformed file). */
  data: Record<string, unknown>;
  body: string;
  links: MarkdownLink[];
  /** Resolved target id per page link, by ordinal; null when unresolved. */
  linkTargets: (string | null)[];
  legacyTrackerStatus: boolean;
}

export interface TableRecord {
  typeId: string;
  path: string;
  parentDir: string;
  header: string[];
  rows: string[][];
  version: string;
  createdAt: number;
  updatedAt: number;
  malformed?: string;
}

export interface TrashManifest {
  formatVersion: 1;
  kind: 'page' | 'row' | 'table';
  id: string;
  title: string;
  trashedAt: number;
  /** Parent page at trash time, and its folder as a fallback. */
  originalParentId: string | null;
  originalDir: string;
  /** Names moved into the entry folder, by role. `file` and `sidecar` belong to an editor page. */
  entries?: { md?: string; file?: string; sidecar?: string; dir?: string; activity?: string; csv?: string };
  /** Editor page kind: its document type and file suffix. */
  documentType?: string;
  fileExtension?: string;
  /** Page kind: the tracker type of a typed page. */
  pageType?: string | null;
  /** Row and table kinds: the type. */
  typeId?: string;
  /** Row kind: the row as column -> cell. */
  row?: Record<string, string>;
}

export interface TrashRecord {
  /** Wiki-relative entry folder, e.g. `.trash/1760000000000-01J...`. */
  entryDir: string;
  manifest: TrashManifest;
}

/**
 * A fix the scan found. Each carries what it assumed, and is applied only if
 * that still holds when the file is re-read under the write lock.
 */
export type Repair =
  /** `path` is a markdown file, or an editor page's sidecar (written when missing, with `documentType`). Assumes no id is stored. */
  | { kind: 'add-id'; path: string; id: string; documentType?: string }
  /** Assumes `path` still stores `from`, and `keeper` (the file that keeps it) does too. */
  | { kind: 'replace-id'; path: string; id: string; from: string; keeper: string }
  /** Assumes the page body is still at `version`. */
  | { kind: 'relink'; pageId: string; version: string }
  /** Assumes the CSV is still at `version`. */
  | { kind: 'table-ids'; typeId: string; version: string };

export interface ScanState {
  pages: Map<string, PageRecord>;
  /** nameKey(relative md path) -> page id */
  byFile: Map<string, string>;
  /** nameKey(relative dir path) -> page id */
  byDir: Map<string, string>;
  tables: Map<string, TableRecord>;
  trash: Map<string, TrashRecord>;
  issues: WikiIssue[];
  repairs: Repair[];
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  text: string;
}

/** Per-path read cache so a rescan only rereads files whose mtime or size moved. */
export type ScanCache = Map<string, CachedFile>;

/** When each duplicate (id and path of the copy) was first seen, so a transient one is not re-keyed. */
export type DuplicateLog = Map<string, number>;

async function readCached(
  root: string,
  rel: string,
  cache: ScanCache,
  limit = Infinity,
): Promise<{ text: string; mtimeMs: number; birthtimeMs: number; size: number; skipped: boolean } | null> {
  const abs = toAbs(root, rel);
  let st;
  try {
    st = await stat(abs);
  } catch {
    return null;
  }
  const birthtimeMs = st.birthtimeMs || st.ctimeMs;
  if (st.size > limit) return { text: '', mtimeMs: st.mtimeMs, birthtimeMs, size: st.size, skipped: true };
  const hit = cache.get(rel);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { text: hit.text, mtimeMs: st.mtimeMs, birthtimeMs, size: st.size, skipped: false };
  const text = await readFile(abs, 'utf8');
  cache.set(rel, { mtimeMs: st.mtimeMs, size: st.size, text });
  return { text, mtimeMs: st.mtimeMs, birthtimeMs, size: st.size, skipped: false };
}

function isHidden(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

export interface ScanInput {
  root: string;
  types: Map<string, WikiTypeDef>;
  /** Editor page suffixes (see `normalizeEditorTypes`). */
  editorTypes: ReadonlyMap<string, string>;
  repair: boolean;
  cache: ScanCache;
  now: number;
  duplicates: DuplicateLog;
  duplicateGraceMs: number;
}

/** The suffix project file sync gives the remote side of a diverged file. */
const CONFLICT_COPY = / \(conflict [^)]*\)$/i;

export async function scanWiki(input: ScanInput): Promise<ScanState> {
  const { root, types, editorTypes, repair, cache, now, duplicates, duplicateGraceMs } = input;
  const state: ScanState = {
    pages: new Map(),
    byFile: new Map(),
    byDir: new Map(),
    tables: new Map(),
    trash: new Map(),
    issues: [],
    repairs: [],
  };
  const tableNames = new Map<string, string>();
  for (const def of types.values()) {
    if (def.storage !== 'table') continue;
    tableNames.set(nameKey(fileStemForTitle(def.displayNamePlural)), def.typeId);
    if (!tableNames.has(nameKey(def.typeId))) tableNames.set(nameKey(def.typeId), def.typeId);
  }
  const seenRel = new Set<string>();
  const seenDuplicates = new Set<string>();

  // A copy loses the id to the file it was copied from. A sync conflict copy
  // (`Name (conflict <date>).md`) sorts before `Name.md` in walk order, so walk
  // order alone would hand the original's id to the copy and rewrite the original.
  const isConflictCopy = (p: PageRecord) =>
    CONFLICT_COPY.test(p.sidecar ? p.stem : path.posix.basename(p.path ?? p.dir).replace(/\.md$/i, ''));
  // A sync rename can arrive as add-then-delete, so a duplicate may be gone by
  // the next scan. Storing a new id in it would break the sync layer's move
  // detection and every link, so the copy is read under an id derived from its
  // path, and only given a stored id once the duplicate outlives the grace
  // period (or a command writes to it; see WikiCore.pageForWrite).
  const giveUpId = (loser: PageRecord, keeper: PageRecord) => {
    const where = loser.path ?? loser.dir;
    const key = `${loser.id}|${where}`;
    seenDuplicates.add(key);
    const since = duplicates.get(key) ?? now;
    duplicates.set(key, since);
    const metaPath = loser.sidecar ?? loser.path;
    const keeperPath = keeper.sidecar ?? keeper.path;
    if (repair && metaPath && keeperPath && !loser.malformed && now - since >= duplicateGraceMs) {
      const fresh = ulid();
      state.issues.push({ code: 'duplicate-id', path: where, id: loser.id, message: 'Duplicate id; this copy gets a new one' });
      state.repairs.push({ kind: 'replace-id', path: metaPath, id: fresh, from: loser.id, keeper: keeperPath });
      return fresh;
    }
    state.issues.push({ code: 'duplicate-id', path: where, id: loser.id, message: 'Duplicate id; this copy is read under a temporary id until it is written or the duplicate persists' });
    return derivedId('dup', where);
  };

  const addPage = (page: PageRecord) => {
    const existing = state.pages.get(page.id);
    if (existing) {
      if (isConflictCopy(existing) && !isConflictCopy(page)) {
        // The earlier record is the copy: re-key it (and anything already
        // parented under it) so the original keeps its id.
        const fresh = giveUpId(existing, page);
        const rekeyed = { ...existing, id: fresh };
        state.pages.delete(existing.id);
        state.pages.set(fresh, rekeyed);
        if (rekeyed.path) state.byFile.set(nameKey(rekeyed.path), fresh);
        state.byDir.set(nameKey(rekeyed.dir), fresh);
        for (const [id, other] of state.pages) if (other.parentId === existing.id) state.pages.set(id, { ...other, parentId: fresh });
      } else {
        page = { ...page, id: giveUpId(page, existing) };
      }
    }
    state.pages.set(page.id, page);
    if (page.path) state.byFile.set(nameKey(page.path), page.id);
    state.byDir.set(nameKey(page.dir), page.id);
    return page;
  };

  const loadFilePage = async (
    rel: string,
    stem: string,
    dir: string,
    bodySource: 'file' | 'readme',
    parent: PageRecord | null,
    parentDir: string,
  ): Promise<PageRecord | null> => {
    const read = await readCached(root, rel, cache);
    if (!read) return null;
    seenRel.add(rel);
    const parsed = parseMarkdownFile(read.text);
    const base = {
      stem,
      sidecar: null,
      documentType: 'markdown',
      fileExtension: '.md',
      parentDir,
      parentId: parent?.id ?? null,
      parentKind: parent ? (parent.type ? 'item' : 'page') : null,
      path: rel,
      dir,
      bodySource,
      createdAt: read.birthtimeMs,
      updatedAt: read.mtimeMs,
      trashedAt: null,
    } as const;
    const meta = parsed.ok ? readPageMeta(parsed.data) : null;
    const unsafeId = meta?.id !== null && meta?.id !== undefined && !isSafeId(meta.id);
    if (!parsed.ok || unsafeId) {
      if (!parsed.ok) state.issues.push({ code: 'malformed-frontmatter', path: rel, message: parsed.error });
      else state.issues.push({ code: 'unsafe-id', path: rel, id: meta!.id!, message: 'The id is not a safe token (letters, digits, _ and -, with an optional prefix:); the page is read-only until it is fixed by hand' });
      return {
        ...base,
        id: derivedId('bad', rel),
        title: stem,
        type: null,
        fields: {},
        order: null,
        version: contentVersion(read.text),
        hasContent: read.text.trim() !== '',
        malformed: true,
        data: {},
        body: read.text,
        links: [],
        linkTargets: [],
        legacyTrackerStatus: false,
      };
    }
    let id = meta!.id;
    if (!id) {
      if (repair) {
        id = ulid();
        state.repairs.push({ kind: 'add-id', path: rel, id });
      } else {
        id = derivedId('tmp', rel);
      }
    }
    return {
      ...base,
      id,
      title: titleForStem(stem, meta!.title),
      type: meta!.type,
      fields: meta!.fields,
      order: meta!.order,
      version: contentVersion(parsed.body),
      hasContent: parsed.body.trim() !== '',
      data: parsed.data,
      body: parsed.body,
      links: findLinks(parsed.body).filter((link) => link.isPageLink),
      linkTargets: [],
      legacyTrackerStatus: meta!.legacyTrackerStatus,
    };
  };

  /** An editor file (drawing, mind map, ...) with its sidecar. */
  const loadEditorPage = async (
    rel: string,
    stem: string,
    suffix: string,
    dir: string,
    hasSidecar: boolean,
    parent: PageRecord | null,
    parentDir: string,
  ): Promise<PageRecord | null> => {
    const read = await readCached(root, rel, cache, SCAN_READ_LIMIT);
    if (!read) return null;
    seenRel.add(rel);
    const sidecarRel = relJoin(parentDir, sidecarName(path.posix.basename(rel)));
    let data: Record<string, unknown> = {};
    let sidecarError: string | null = null;
    if (hasSidecar) {
      const sidecarRead = await readCached(root, sidecarRel, cache);
      if (sidecarRead) {
        seenRel.add(sidecarRel);
        const parsed = parseSidecar(sidecarRead.text);
        if (parsed.ok) data = parsed.data;
        else sidecarError = parsed.error;
      }
    }
    const recorded = typeof data.documentType === 'string' && data.documentType.trim() ? data.documentType.trim() : null;
    const documentType = editorTypes.get(suffix) ?? recorded ?? suffix.slice(1);
    const { documentType: _documentType, ...metaData } = data;
    const meta = readPageMeta(metaData);
    // An editor page is a plain page: a `type` key in its sidecar is kept but not read.
    const { type: _type, ...fields } = meta.fields;
    const searchable = !read.skipped && read.text.length <= SEARCH_BODY_LIMIT && !looksBinary(read.text);
    let id: string;
    if (sidecarError) {
      state.issues.push({ code: 'malformed-sidecar', path: sidecarRel, message: sidecarError });
      id = derivedId('bad', rel);
    } else if (meta.id && !isSafeId(meta.id)) {
      sidecarError = 'unsafe id';
      state.issues.push({ code: 'unsafe-id', path: sidecarRel, id: meta.id, message: 'The id is not a safe token (letters, digits, _ and -, with an optional prefix:); the page is read-only until it is fixed by hand' });
      id = derivedId('bad', rel);
    } else if (meta.id) {
      id = meta.id;
    } else if (repair) {
      id = ulid();
      state.repairs.push({ kind: 'add-id', path: sidecarRel, id, documentType });
    } else {
      id = derivedId('tmp', rel);
    }
    return {
      id,
      title: titleForStem(stem, meta.title),
      type: null,
      fields: sidecarError ? {} : fields,
      documentType,
      fileExtension: suffix,
      parentId: parent?.id ?? null,
      parentKind: parent ? (parent.type ? 'item' : 'page') : null,
      order: meta.order,
      path: rel,
      dir,
      bodySource: 'file',
      version: read.skipped ? `s${read.size}-${Math.floor(read.mtimeMs)}` : contentVersion(read.text),
      hasContent: read.skipped || read.text.trim() !== '',
      createdAt: read.birthtimeMs,
      updatedAt: read.mtimeMs,
      trashedAt: null,
      ...(sidecarError ? { malformed: true } : {}),
      stem,
      sidecar: sidecarRel,
      parentDir,
      data: sidecarError ? {} : data,
      body: searchable ? read.text : '',
      links: [],
      linkTargets: [],
      legacyTrackerStatus: false,
    };
  };

  const walk = async (dirRel: string, parent: PageRecord | null): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(toAbs(root, dirRel), { withFileTypes: true });
    } catch {
      return;
    }
    const sidecarTargets = new Set(entries.filter((e) => e.isFile() && isSidecarName(e.name)).map((e) => sidecarTarget(e.name)));
    entries = entries.filter((e) => !isHidden(e.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const fileNames = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    for (const target of sidecarTargets) {
      if (!fileNames.has(target)) {
        state.issues.push({ code: 'orphan-sidecar', path: relJoin(dirRel, sidecarName(target)), message: `Sidecar for ${target}, which is not in this folder` });
      }
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const consumedDirs = new Set<string>();
    const readmeName = parent?.bodySource === 'readme' && parent.dir === dirRel && parent.path ? path.posix.basename(parent.path) : null;
    const pagesHere: PageRecord[] = [];
    const keyNames = new Map<string, Set<string>>();
    const noteKey = (name: string) => {
      const key = nameKey(name);
      if (!keyNames.has(key)) keyNames.set(key, new Set());
      keyNames.get(key)!.add(name);
    };

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.csv')) {
        // A CSV named after a table type is that table; any other is a spreadsheet page.
        const typeId = tableNames.get(nameKey(entry.name.slice(0, -4)));
        if (typeId) {
          await loadTable(relJoin(dirRel, entry.name), typeId, dirRel);
          continue;
        }
      }
      if (entry.name === readmeName) continue;
      const hasSidecar = sidecarTargets.has(entry.name);
      const suffix = editorSuffix(entry.name, editorTypes) ?? (hasSidecar && !lower.endsWith('.md') ? path.posix.extname(entry.name).toLowerCase() || null : null);
      if (suffix) {
        const stem = entry.name.slice(0, -suffix.length);
        if (!stem) continue;
        noteKey(stem);
        const childDir = dirs.find((d) => d === stem) ?? dirs.find((d) => !consumedDirs.has(d) && nameKey(d) === nameKey(stem));
        if (childDir) consumedDirs.add(childDir);
        const page = await loadEditorPage(relJoin(dirRel, entry.name), stem, suffix, relJoin(dirRel, childDir ?? stem), hasSidecar, parent, dirRel);
        if (page) pagesHere.push(page);
        continue;
      }
      if (!lower.endsWith('.md')) continue;
      const stem = entry.name.slice(0, -3);
      noteKey(stem);
      let childDir = dirs.find((d) => d === stem) ?? dirs.find((d) => !consumedDirs.has(d) && nameKey(d) === nameKey(stem));
      if (childDir) consumedDirs.add(childDir);
      const page = await loadFilePage(relJoin(dirRel, entry.name), stem, relJoin(dirRel, childDir ?? stem), 'file', parent, dirRel);
      if (page) pagesHere.push(page);
    }
    for (const name of dirs) {
      if (consumedDirs.has(name)) continue;
      noteKey(name);
      const dir = relJoin(dirRel, name);
      let inner: string[] = [];
      try {
        inner = (await readdir(toAbs(root, dir))).sort();
      } catch {
        // unreadable folder: still a page, with no body
      }
      const readme = inner.find((n) => n.toLowerCase() === 'readme.md') ?? inner.find((n) => n.toLowerCase() === 'index.md');
      let page: PageRecord | null = null;
      if (readme) page = await loadFilePage(relJoin(dir, readme), name, dir, 'readme', parent, dirRel);
      if (!page) {
        let times = { birthtimeMs: 0, mtimeMs: 0 };
        try {
          const st = await stat(toAbs(root, dir));
          times = { birthtimeMs: st.birthtimeMs || st.ctimeMs, mtimeMs: st.mtimeMs };
        } catch {
          // keep zeros
        }
        page = {
          id: derivedId('dir', dir),
          title: name,
          type: null,
          fields: {},
          documentType: 'markdown',
          fileExtension: '.md',
          sidecar: null,
          parentId: parent?.id ?? null,
          parentKind: parent ? (parent.type ? 'item' : 'page') : null,
          order: null,
          path: null,
          dir,
          bodySource: 'none',
          version: contentVersion(''),
          hasContent: false,
          createdAt: times.birthtimeMs,
          updatedAt: times.mtimeMs,
          trashedAt: null,
          stem: name,
          parentDir: dirRel,
          data: {},
          body: '',
          links: [],
          linkTargets: [],
          legacyTrackerStatus: false,
        };
      }
      pagesHere.push(page);
    }
    for (const names of keyNames.values()) {
      if (names.size > 1) {
        state.issues.push({
          code: 'case-clash',
          path: relJoin(dirRel, [...names][0]),
          message: `Names differ only by case (${[...names].join(', ')}); they collide on macOS and Windows`,
        });
      }
    }
    for (const page of pagesHere.map(addPage)) {
      if (dirs.some((d) => relJoin(dirRel, d) === page.dir)) await walk(page.dir, page);
    }
  };

  const loadTable = async (rel: string, typeId: string, dirRel: string) => {
    if (state.tables.has(typeId)) {
      state.issues.push({ code: 'duplicate-table', path: rel, message: `A second CSV for ${typeId}; ${state.tables.get(typeId)!.path} is used` });
      return;
    }
    const read = await readCached(root, rel, cache);
    if (!read) return;
    seenRel.add(rel);
    const record: TableRecord = {
      typeId,
      path: rel,
      parentDir: dirRel,
      header: [],
      rows: [],
      version: contentVersion(read.text),
      createdAt: read.birthtimeMs,
      updatedAt: read.mtimeMs,
    };
    try {
      const rows = parseCsv(read.text);
      const header = rows[0] ?? ['id'];
      if (header[0]?.trim().toLowerCase() !== 'id') throw new Error('First column must be id');
      record.header = header.map((h) => h.trim());
      record.rows = rows.slice(1).map((row) => {
        const padded = [...row];
        while (padded.length < record.header.length) padded.push('');
        return padded;
      });
      const seen = new Set<string>();
      let needsIds = false;
      for (const row of record.rows) {
        const id = row[0].trim();
        if (id !== '' && !isSafeId(id)) {
          state.issues.push({ code: 'unsafe-id', path: rel, id, message: 'Row id is not a safe token (letters, digits, _ and -); the row is read-only until it is fixed by hand' });
        }
        if (id === '' || seen.has(id)) {
          needsIds = true;
          if (id !== '') state.issues.push({ code: 'duplicate-id', path: rel, id, message: 'Duplicate row id' });
        }
        seen.add(id);
      }
      if (needsIds && repair) state.repairs.push({ kind: 'table-ids', typeId, version: record.version });
    } catch (err) {
      record.malformed = (err as Error).message;
      state.issues.push({ code: 'malformed-table', path: rel, message: record.malformed });
    }
    state.tables.set(typeId, record);
  };

  await walk('', null);

  // Trash entries.
  try {
    const entries = await readdir(toAbs(root, TRASH_DIR), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryDir = relJoin(TRASH_DIR, entry.name);
      try {
        const manifest = JSON.parse(await readFile(toAbs(root, relJoin(entryDir, TRASH_MANIFEST)), 'utf8')) as TrashManifest;
        if (!manifest || typeof manifest.id !== 'string') continue;
        if (!isSafeId(manifest.id)) {
          state.issues.push({ code: 'unsafe-id', path: relJoin(entryDir, TRASH_MANIFEST), id: manifest.id, message: 'Trash entry id is not a safe token; it cannot be restored' });
          continue;
        }
        state.trash.set(manifest.id, { entryDir, manifest });
      } catch {
        // Not ours, or half-written: leave it alone.
      }
    }
  } catch {
    // no trash yet
  }

  resolveLinks(state, repair);
  for (const rel of [...cache.keys()]) if (!seenRel.has(rel)) cache.delete(rel);
  for (const key of [...duplicates.keys()]) if (!seenDuplicates.has(key)) duplicates.delete(key);
  return state;
}

/** Wiki-relative target of a link written in a file in `fromDir`; null when it leaves the wiki. */
export function resolveLinkPath(fromDir: string, linkPath: string): string | null {
  const joined = path.posix.normalize(path.posix.join(fromDir === '' ? '.' : fromDir, linkPath));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return null;
  return joined === '.' ? '' : joined.replace(/\/$/, '');
}

/** Folder a page's links are written relative to. */
export function linkBaseDir(page: { path: string | null; dir: string }): string {
  return page.path ? relDirname(page.path) : page.dir;
}

function resolveLinks(state: ScanState, repair: boolean) {
  for (const page of state.pages.values()) {
    const base = linkBaseDir(page);
    let stale = false;
    page.linkTargets = page.links.map((link) => {
      const target = resolveLinkPath(base, link.path);
      const byPath = target === null ? undefined : link.path.endsWith('/') ? state.byDir.get(nameKey(target)) : state.byFile.get(nameKey(target)) ?? state.byDir.get(nameKey(target));
      if (link.id) {
        if (state.pages.has(link.id)) {
          if (byPath !== link.id) stale = true;
          return link.id;
        }
        if (!state.trash.has(link.id)) {
          state.issues.push({ code: 'broken-link', path: page.path ?? page.dir, id: link.id, message: `Link to ${link.path} names an id that does not exist` });
        }
        return byPath ?? null;
      }
      return byPath ?? null;
    });
    // A copy read under a temporary id is left alone; it may be a sync rename in flight.
    if (stale && repair && !page.malformed && page.path && !page.id.startsWith('dup_')) state.repairs.push({ kind: 'relink', pageId: page.id, version: page.version });
  }
}
