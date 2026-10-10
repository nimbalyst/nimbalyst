import { mkdir, readFile, rm, rmdir, unlink } from 'node:fs/promises';
import { watch as fsWatchSync } from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { contentVersion, idForFileName, ulid } from './ids.js';
import { composeMarkdownFile, flattenLegacy, parseMarkdownFile, RESERVED_KEYS } from './frontmatter.js';
import { fileStemForTitle, nameKey, uniqueStem } from './names.js';
import { atomicWrite, movePath, pathExists, relJoin } from './fsutil.js';
import { ACTIVITY_SUFFIX, MARKER_FILE, TRASH_DIR, TRASH_MANIFEST, type PageRecord, type TrashManifest } from './scan.js';
import { decodeRow } from './tableCodec.js';
import { tableInfo } from './project.js';
import { searchDocs, type SearchDoc } from './search.js';
import type {
  ActivityEntry,
  LocalSearchHit,
  LocalTrackerCommand,
  LocalTrackerItem,
  LocalTrackerSnapshot,
  LocalWikiChange,
  LocalWikiCommand,
  LocalWikiCommandResult,
  LocalWikiSnapshot,
  OpenWikiOptions,
  ReadBodyResult,
  WatchFactory,
  WriteBodyResult,
} from './types.js';
import type { WikiTypeDef } from './typeDefs.js';
import { FORMAT_VERSION, LocalWikiError, MARKER_HEADER, type MarkerData } from './core.js';
import { WikiTables } from './tables.js';
import { normalizeEditorTypes, parseSidecar, sidecarName, suffixForDocumentType, SIDECAR_RESERVED_KEYS } from './sidecar.js';

export { FORMAT_VERSION, LocalWikiError, type LocalWikiErrorCode } from './core.js';

/** Creates the wiki folder and its marker file when missing. Never touches existing content. */
export async function initWiki(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const marker = path.join(root, MARKER_FILE);
  if (!(await pathExists(marker))) await atomicWrite(marker, MARKER_HEADER + yaml.dump({ formatVersion: FORMAT_VERSION }));
}

export async function openWiki(root: string, options: OpenWikiOptions = {}): Promise<LocalWiki> {
  const absRoot = path.resolve(root);
  let marker: MarkerData;
  try {
    marker = (yaml.load(await readFile(path.join(absRoot, MARKER_FILE), 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? {}) as MarkerData;
  } catch {
    throw new LocalWikiError('not-a-wiki', `${absRoot} has no ${MARKER_FILE}`);
  }
  const version = typeof marker.formatVersion === 'number' ? marker.formatVersion : NaN;
  if (!(version >= 1)) throw new LocalWikiError('not-a-wiki', `${MARKER_FILE} has no formatVersion`);
  if (version > FORMAT_VERSION) {
    throw new LocalWikiError('unsupported-format', `Wiki format ${version} is newer than this library (${FORMAT_VERSION}); update Nimbalyst or nim`);
  }
  const wiki = new LocalWiki(absRoot, marker, options);
  await wiki.rescan();
  return wiki;
}

function defaultWatchFactory(dir: string, onEvent: () => void): { close(): void } {
  const watcher = fsWatchSync(dir, { recursive: true }, () => onEvent());
  watcher.on('error', () => {
    // A vanished folder ends the watch; the next explicit call rescans.
  });
  return { close: () => watcher.close() };
}

/** A local wiki folder. Every public call is serialized; see FORMAT.md for the file format. */
export class LocalWiki extends WikiTables {
  // ---------------------------------------------------------------- reading

  async snapshot(): Promise<LocalWikiSnapshot> {
    return this.exclusive(async () => this.project());
  }

  typeDefs(): WikiTypeDef[] {
    return [...this.types.values()];
  }

  async readBody(id: string): Promise<ReadBodyResult> {
    return this.exclusive(async () => {
      const page = this.state.pages.get(id);
      let rel: string | null;
      let raw: boolean;
      if (page) {
        rel = page.path;
        raw = page.sidecar !== null;
      } else {
        const trashed = this.state.trash.get(id);
        if (!trashed || trashed.manifest.kind !== 'page') throw new LocalWikiError('not-found', `No page ${id}`);
        const entries = trashed.manifest.entries ?? {};
        rel = entries.md ? relJoin(trashed.entryDir, entries.md) : entries.file ? relJoin(trashed.entryDir, entries.file) : null;
        raw = !entries.md && Boolean(entries.file);
      }
      if (!rel) return { markdown: '', version: contentVersion('') };
      const text = await readFile(this.abs(rel), 'utf8');
      // An editor page's body is its whole file.
      if (raw) return { markdown: text, version: contentVersion(text) };
      const parsed = parseMarkdownFile(text);
      if (!parsed.ok) return { markdown: text, version: contentVersion(text), malformed: true };
      return { markdown: parsed.body, version: contentVersion(parsed.body) };
    });
  }

  async trackerSnapshot(typeId: string): Promise<LocalTrackerSnapshot> {
    return this.exclusive(async () => {
      const def = this.types.get(typeId);
      if (def?.storage === 'table') {
        const table = this.state.tables.get(typeId);
        if (!table) return { typeId, storage: 'table', items: [], version: null };
        const info = tableInfo(this.state, table);
        const items = table.rows.map((row) => {
          const { id, fields } = decodeRow(table.header, row, def);
          return {
            id,
            type: typeId,
            title: String(fields[def.titleField] ?? ''),
            fields,
            storage: 'table' as const,
            path: table.path,
            parentId: info.parentId,
            parentKind: info.parentKind,
            order: null,
            createdAt: table.createdAt,
            updatedAt: table.updatedAt,
          };
        });
        return { typeId, storage: 'table', items, version: table.version };
      }
      const items: LocalTrackerItem[] = [...this.state.pages.values()]
        .filter((page) => page.type === typeId && !page.malformed)
        .map((page) => ({
          id: page.id,
          type: typeId,
          title: page.title,
          fields: page.fields,
          storage: 'pages' as const,
          path: page.path,
          parentId: page.parentId,
          parentKind: page.parentKind,
          order: page.order,
          createdAt: page.createdAt,
          updatedAt: page.updatedAt,
        }));
      return { typeId, storage: 'pages', items, version: null };
    });
  }

  async search(query: string, options: { limit?: number } = {}): Promise<LocalSearchHit[]> {
    return this.exclusive(async () => {
      const docs: SearchDoc[] = [];
      for (const page of this.state.pages.values()) {
        docs.push({ id: page.id, title: page.title, kind: 'page', type: page.type, path: page.path, body: page.body, fields: page.fields });
      }
      for (const table of this.state.tables.values()) {
        const def = this.types.get(table.typeId);
        for (const row of table.rows) {
          const { id, fields } = decodeRow(table.header, row, def);
          const title = String(fields[def?.titleField ?? 'title'] ?? id);
          docs.push({ id, title, kind: 'row', type: table.typeId, path: table.path, body: '', fields });
        }
      }
      return searchDocs(docs, query, options.limit ?? 50);
    });
  }

  async readActivity(id: string): Promise<ActivityEntry[]> {
    return this.exclusive(async () => {
      const page = this.state.pages.get(id);
      let rel: string | null = null;
      if (page) rel = this.activityPath(page);
      else {
        for (const table of this.state.tables.values()) {
          if (table.rows.some((row) => row[0].trim() === id)) rel = this.tableActivityPath(table);
        }
      }
      if (!rel) throw new LocalWikiError('not-found', `No item ${id}`);
      let text = '';
      try {
        text = await readFile(this.abs(rel), 'utf8');
      } catch {
        return [];
      }
      const out: ActivityEntry[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as ActivityEntry;
          if (entry.itemId === id) out.push(entry);
        } catch {
          // a torn last line from a crash; skip it
        }
      }
      return out;
    });
  }

  // ---------------------------------------------------------------- writing

  async writeBody(id: string, markdown: string, expectedVersion: string | null): Promise<WriteBodyResult> {
    return this.mutate(async () => {
      // Re-read under the lock: the version check below compares against the file as it is now.
      const page = await this.pageForWrite(id);
      this.requireWellFormed(page);
      let result: WriteBodyResult;
      if (page.sidecar && page.path) {
        const abs = this.abs(page.path);
        const text = await readFile(abs, 'utf8');
        const current = contentVersion(text);
        if (expectedVersion !== null && expectedVersion !== current) {
          return { ok: false, reason: 'conflict', currentVersion: current, markdown: text };
        }
        await atomicWrite(abs, markdown);
        result = { ok: true, version: contentVersion(markdown) };
      } else if (!page.path) {
        const current = contentVersion('');
        if (expectedVersion !== null && expectedVersion !== current) {
          return { ok: false, reason: 'conflict', currentVersion: current, markdown: '' };
        }
        await atomicWrite(this.abs(relJoin(page.parentDir, `${page.stem}.md`)), composeMarkdownFile({ id: page.id }, markdown));
        result = { ok: true, version: contentVersion(markdown) };
      } else {
        const text = await readFile(this.abs(page.path), 'utf8');
        const parsed = parseMarkdownFile(text);
        if (!parsed.ok) throw new LocalWikiError('malformed', `${page.path}: ${parsed.error}`);
        const current = contentVersion(parsed.body);
        if (expectedVersion !== null && expectedVersion !== current) {
          return { ok: false, reason: 'conflict', currentVersion: current, markdown: parsed.body };
        }
        const block = parsed.block === '' || parsed.block.endsWith('\n') ? parsed.block : parsed.block + '\n';
        await atomicWrite(this.abs(page.path), block + markdown);
        result = { ok: true, version: contentVersion(markdown) };
      }
      await this.refresh();
      return result;
    });
  }

  async command(cmd: LocalWikiCommand): Promise<LocalWikiCommandResult> {
    return this.mutate(async () => {
      switch (cmd.type) {
        case 'register-document': {
          const id = await this.createPage({
            id: cmd.documentId,
            title: cmd.title,
            parentId: cmd.parentFolderId,
            sortOrder: cmd.sortOrder ?? null,
            pageType: cmd.pageType ?? null,
            fields: cmd.fields ?? {},
            body: cmd.body ?? '',
            documentType: cmd.documentType ?? 'markdown',
            fileExtension: cmd.fileExtension ?? null,
          });
          return { ok: true, id };
        }
        case 'update-document-title': {
          const page = await this.pageForWrite(cmd.documentId);
          const parent = page.parentId ? this.state.pages.get(page.parentId) ?? null : null;
          await this.movePage(page, parent, cmd.title, undefined);
          return { ok: true, id: page.id };
        }
        case 'move-document':
        case 'set-item-placement': {
          const id = cmd.type === 'move-document' ? cmd.documentId : cmd.itemId;
          const parentId = cmd.type === 'move-document' ? cmd.parentFolderId : cmd.parentId;
          const page = await this.pageForWrite(id);
          const parent = parentId ? this.requireLivePage(parentId) : null;
          await this.movePage(page, parent, page.title, cmd.sortOrder);
          return { ok: true, id: page.id };
        }
        case 'set-document-fields': {
          const page = await this.pageForWrite(cmd.documentId);
          await this.patchFrontmatter(page, cmd.fields, undefined);
          return { ok: true, id: page.id };
        }
        case 'set-document-type': {
          const page = await this.pageForWrite(cmd.documentId);
          if (page.sidecar && cmd.pageType) {
            throw new LocalWikiError('invalid', `"${page.title}" is a ${page.documentType} page; only markdown pages can have a type`);
          }
          await this.patchFrontmatter(page, {}, cmd.pageType);
          return { ok: true, id: page.id };
        }
        case 'trash-document': {
          const page = await this.pageForWrite(cmd.documentId);
          await this.trashPage(page, cmd.trashedAt ?? this.now());
          return { ok: true, id: page.id };
        }
        case 'remove-document': {
          if (!cmd.purge) {
            const page = await this.pageForWrite(cmd.documentId);
            await this.trashPage(page, this.now());
            return { ok: true, id: page.id };
          }
          this.requireSafeId(cmd.documentId);
          const trashed = this.state.trash.get(cmd.documentId);
          if (!trashed) throw new LocalWikiError('not-trashed', `${cmd.documentId} is not in trash; trash it first`);
          await rm(this.abs(trashed.entryDir), { recursive: true });
          await this.refresh();
          return { ok: true, id: cmd.documentId, purged: 1 };
        }
        case 'restore-document':
          await this.restore(cmd.documentId);
          return { ok: true, id: cmd.documentId };
        case 'set-type-placement':
          await this.placeTable(cmd.typeId, cmd.parentFolderId, cmd.sortOrder);
          return { ok: true };
        case 'refresh':
          await this.refresh();
          return { ok: true };
        default: {
          const unknown: never = cmd;
          throw new LocalWikiError('invalid', `Unknown command ${(unknown as { type: string }).type}`);
        }
      }
    });
  }

  async trackerCommand(typeId: string, cmd: LocalTrackerCommand): Promise<LocalWikiCommandResult> {
    return this.mutate(async () => {
      const def = this.types.get(typeId);
      if (def?.storage === 'table') return this.tableCommand(def, cmd);
      switch (cmd.type) {
        case 'create-item': {
          const id = await this.createPage({
            id: cmd.item.id,
            title: cmd.item.title,
            parentId: cmd.item.parentId ?? null,
            sortOrder: null,
            pageType: typeId,
            fields: cmd.item.fields ?? {},
            body: cmd.item.body ?? '',
            documentType: 'markdown',
            fileExtension: null,
          });
          return { ok: true, id };
        }
        case 'update-item': {
          const page = await this.pageForWrite(cmd.input.itemId);
          const { title, ...fields } = cmd.input.updates;
          if (Object.keys(fields).length > 0) await this.patchFrontmatter(page, fields, undefined);
          if (typeof title === 'string' && title !== page.title) {
            const fresh = this.requireLivePage(page.id);
            const parent = fresh.parentId ? this.state.pages.get(fresh.parentId) ?? null : null;
            await this.movePage(fresh, parent, title, undefined);
          }
          return { ok: true, id: page.id };
        }
        case 'delete-item': {
          const page = await this.pageForWrite(cmd.itemId);
          await this.trashPage(page, this.now());
          return { ok: true, id: page.id };
        }
      }
    });
  }

  async rescan(): Promise<void> {
    return this.exclusive(() => this.refresh());
  }

  /**
   * Replaces the editor page suffix table (see `OpenWikiOptions.editorTypes`)
   * and rescans when it changed. Hosts call this when extensions load.
   */
  async setEditorTypes(table: Readonly<Record<string, string>>): Promise<void> {
    return this.exclusive(async () => {
      const next = normalizeEditorTypes(table);
      if (JSON.stringify([...next].sort()) === JSON.stringify([...this.editorTypes].sort())) return;
      this.editorTypes = next;
      await this.refresh();
    });
  }

  // ---------------------------------------------------------------- watching

  watch(onChange: (change: LocalWikiChange) => void): () => void {
    this.listeners.add(onChange);
    if (this.watchHandles.length === 0) {
      const factory: WatchFactory = this.options.watchFactory ?? defaultWatchFactory;
      const schedule = () => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          void this.exclusive(() => this.refresh()).catch(() => {
            // A scan that fails mid-change is retried by the next event.
          });
        }, this.options.debounceMs ?? 150);
      };
      this.watchHandles.push(factory(this.root, schedule));
      if (this.options.typesDir) {
        try {
          this.watchHandles.push(factory(this.options.typesDir, schedule));
        } catch {
          // no types folder yet
        }
      }
    }
    return () => {
      this.listeners.delete(onChange);
      if (this.listeners.size === 0) this.stopWatching();
    };
  }

  close(): void {
    this.listeners.clear();
    this.stopWatching();
  }

  private stopWatching() {
    for (const handle of this.watchHandles) handle.close();
    this.watchHandles = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private async createPage(input: {
    id?: string;
    title: string;
    parentId: string | null;
    sortOrder: number | null;
    pageType: string | null;
    fields: Record<string, unknown>;
    body: string;
    documentType: string;
    fileExtension: string | null;
  }): Promise<string> {
    const title = input.title.trim();
    if (!title) throw new LocalWikiError('invalid', 'A page needs a title');
    const editor = input.documentType !== 'markdown';
    let suffix = '.md';
    if (editor) {
      if (input.pageType) throw new LocalWikiError('invalid', `A ${input.documentType} page cannot have a type; only markdown pages can`);
      const given = input.fileExtension?.trim().toLowerCase();
      const resolved = given ? (given.startsWith('.') ? given : `.${given}`) : suffixForDocumentType(input.documentType, this.editorTypes);
      if (!resolved || resolved === '.md' || resolved.includes('/')) {
        throw new LocalWikiError('invalid', `No file extension is known for ${input.documentType} pages; pass fileExtension`);
      }
      suffix = resolved;
    }
    const id = input.id ?? ulid(this.now());
    this.requireSafeId(id);
    if (this.state.pages.has(id) || this.state.trash.has(id)) throw new LocalWikiError('exists', `Id ${id} is taken`);
    const reserved: readonly string[] = editor ? SIDECAR_RESERVED_KEYS : RESERVED_KEYS;
    for (const key of Object.keys(input.fields)) {
      if (reserved.includes(key) || (editor && key === 'type')) throw new LocalWikiError('invalid', `${key} is not a field`);
    }
    const parent = input.parentId ? this.requireLivePage(input.parentId) : null;
    const dir = parent?.dir ?? '';
    const stem = uniqueStem(fileStemForTitle(title), await this.occupiedNames(dir, null));
    const fields = Object.fromEntries(Object.entries(input.fields).filter(([, v]) => v !== null && v !== undefined));
    const order = input.sortOrder ?? this.nextOrder(dir);
    if (editor) {
      // Sidecar first: a crash between the two writes leaves an orphan sidecar (reported), never an unadopted file.
      await this.writeSidecar(relJoin(dir, sidecarName(stem + suffix)), {
        id,
        ...(title !== stem ? { title } : {}),
        documentType: input.documentType,
        order,
        ...fields,
      });
      await atomicWrite(this.abs(relJoin(dir, stem + suffix)), input.body);
      await this.refresh();
      return id;
    }
    const data = {
      id,
      ...(title !== stem ? { title } : {}),
      ...(input.pageType ? { type: input.pageType } : {}),
      order,
      ...fields,
    };
    const rel = relJoin(dir, `${stem}.md`);
    await atomicWrite(this.abs(rel), composeMarkdownFile(data, input.body));
    if (input.pageType) {
      await this.appendActivity(relJoin(dir, stem + ACTIVITY_SUFFIX), { itemId: id, action: 'create' });
    }
    await this.refresh();
    return id;
  }

  /** Field patch (null clears) and optional type change; flattens a legacy `trackerStatus` block. */
  private async patchFrontmatter(page: PageRecord, patch: Record<string, unknown>, pageType: string | null | undefined): Promise<void> {
    this.requireWellFormed(page);
    if (page.sidecar) {
      for (const key of Object.keys(patch)) {
        if ((SIDECAR_RESERVED_KEYS as readonly string[]).includes(key) || key === 'type') throw new LocalWikiError('invalid', `${key} is not a field`);
      }
      const data: Record<string, unknown> = { ...page.data, id: page.id };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) delete data[key];
        else data[key] = value;
      }
      if (JSON.stringify(data) !== JSON.stringify(page.data)) await this.writeSidecar(page.sidecar, data);
      await this.refresh();
      return;
    }
    for (const key of Object.keys(patch)) {
      if ((RESERVED_KEYS as readonly string[]).includes(key) || key === 'trackerStatus') {
        throw new LocalWikiError('invalid', `${key} is not a field`);
      }
    }
    const rel = page.path ?? relJoin(page.parentDir, `${page.stem}.md`);
    let data: Record<string, unknown> = { id: page.id };
    let body = '';
    if (page.path) {
      const parsed = parseMarkdownFile(await readFile(this.abs(page.path), 'utf8'));
      if (!parsed.ok) throw new LocalWikiError('malformed', `${page.path}: ${parsed.error}`);
      data = flattenLegacy(parsed.data);
      body = parsed.body;
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, value] of Object.entries(patch)) {
      const from = data[key];
      if (value === null || value === undefined) delete data[key];
      else data[key] = value;
      if (JSON.stringify(from) !== JSON.stringify(data[key])) changes[key] = { from: from ?? null, to: data[key] ?? null };
    }
    if (pageType !== undefined) {
      const from = data.type ?? null;
      if (pageType === null) delete data.type;
      else data.type = pageType;
      if (from !== (data.type ?? null)) changes.type = { from, to: data.type ?? null };
    }
    await atomicWrite(this.abs(rel), composeMarkdownFile(data, body));
    const typed = data.type ?? page.type;
    if (typed && Object.keys(changes).length > 0) {
      await this.appendActivity(this.activityPath(page), { itemId: page.id, action: 'update', changes });
    }
    await this.refresh();
  }

  private subtree(page: PageRecord): PageRecord[] {
    const prefix = nameKey(page.dir) + '/';
    return [...this.state.pages.values()].filter((p) => p.id === page.id || nameKey(p.path ?? p.dir).startsWith(prefix));
  }

  /**
   * Moves (or renames) a page with its child folder and activity file, then
   * repoints every link into or out of the moved pages.
   */
  private async movePage(page: PageRecord, parent: PageRecord | null, title: string, sortOrder: number | null | undefined): Promise<void> {
    this.requireWellFormed(page);
    title = title.trim();
    if (!title) throw new LocalWikiError('invalid', 'A page needs a title');
    for (let p: PageRecord | null | undefined = parent; p; p = p.parentId ? this.state.pages.get(p.parentId) : null) {
      if (p.id === page.id) throw new LocalWikiError('cycle', 'A page cannot move under itself');
    }
    const targetDir = parent?.dir ?? '';
    const sameDir = nameKey(targetDir) === nameKey(page.parentDir);
    const stem = uniqueStem(fileStemForTitle(title), await this.occupiedNames(targetDir, sameDir ? page : null));
    const newDir = relJoin(targetDir, stem);

    // Link plan, taken before anything moves: who points at the moved pages, and where each link points.
    const moved = this.subtree(page);
    const movedIds = new Set(moved.map((p) => p.id));
    const plan = new Map<string, (string | null)[]>();
    for (const p of this.state.pages.values()) {
      if (movedIds.has(p.id) || p.linkTargets.some((t) => t !== null && movedIds.has(t))) plan.set(p.id, [...p.linkTargets]);
    }

    const order = sortOrder !== undefined ? sortOrder : sameDir ? page.order : this.nextOrder(targetDir);
    const dirExists = await pathExists(this.abs(page.dir));
    let newPath: string | null = null;
    let newSidecar: string | null = null;
    if (page.bodySource === 'file' && page.path) {
      newPath = relJoin(targetDir, `${stem}${page.fileExtension}`);
      await movePath(this.abs(page.path), this.abs(newPath));
      if (page.sidecar) {
        newSidecar = relJoin(targetDir, sidecarName(path.posix.basename(newPath)));
        if (await pathExists(this.abs(page.sidecar))) await movePath(this.abs(page.sidecar), this.abs(newSidecar));
      }
      if (dirExists) await movePath(this.abs(page.dir), this.abs(newDir));
      const activity = this.activityPath(page);
      if (await pathExists(this.abs(activity))) await movePath(this.abs(activity), this.abs(relJoin(targetDir, stem + ACTIVITY_SUFFIX)));
    } else {
      await movePath(this.abs(page.dir), this.abs(newDir));
      if (page.path) newPath = relJoin(newDir, path.posix.basename(page.path));
    }

    // Title and order live in frontmatter. A bare folder gets a `Name.md` only when there is something to keep.
    const wantTitle = title !== stem ? title : undefined;
    if (newSidecar) {
      // Editor page: title and order live in the sidecar. Written even when unchanged if it was missing, so the id persists.
      const data: Record<string, unknown> = { ...page.data, id: page.id };
      if (wantTitle) data.title = wantTitle;
      else delete data.title;
      if (order === null) delete data.order;
      else data.order = order;
      const existed = await pathExists(this.abs(newSidecar));
      if (!existed || JSON.stringify(data) !== JSON.stringify(page.data)) await this.writeSidecar(newSidecar, data);
    } else if (newPath) {
      const abs = this.abs(newPath);
      const parsed = parseMarkdownFile(await readFile(abs, 'utf8'));
      if (parsed.ok) {
        const data = { ...parsed.data };
        if (wantTitle) data.title = wantTitle;
        else delete data.title;
        if (order === null) delete data.order;
        else data.order = order;
        if (JSON.stringify(data) !== JSON.stringify(parsed.data)) await atomicWrite(abs, composeMarkdownFile(data, parsed.body));
      }
    } else if (wantTitle || order !== null) {
      const data = { id: page.id, ...(wantTitle ? { title: wantTitle } : {}), ...(order !== null ? { order } : {}) };
      await atomicWrite(this.abs(relJoin(targetDir, `${stem}.md`)), composeMarkdownFile(data, ''));
    }

    if (page.type && !sameDir) {
      await this.appendActivity(relJoin(targetDir, stem + ACTIVITY_SUFFIX), {
        itemId: page.id,
        action: 'update',
        changes: { parent: { from: page.parentId, to: parent?.id ?? null } },
      });
    }

    await this.scan(false);
    for (const [id, targets] of plan) {
      const p = this.state.pages.get(id);
      if (p) await this.relinkPage(p, targets, movedIds.has(id) ? null : movedIds);
    }
    await this.refresh();
  }

  /** Moves a page, its folder and its activity file into `.trash/`. The manifest is written first. */
  private async trashPage(page: PageRecord, trashedAt: number): Promise<void> {
    const entryDir = relJoin(TRASH_DIR, `${trashedAt}-${idForFileName(page.id)}`);
    const moves: Array<[string, string]> = [];
    const entries: NonNullable<TrashManifest['entries']> = {};
    if (page.sidecar && page.path) {
      entries.file = path.posix.basename(page.path);
      moves.push([page.path, relJoin(entryDir, entries.file)]);
      if (await pathExists(this.abs(page.sidecar))) {
        entries.sidecar = path.posix.basename(page.sidecar);
        moves.push([page.sidecar, relJoin(entryDir, entries.sidecar)]);
      }
    } else if (page.bodySource === 'file' && page.path) {
      entries.md = path.posix.basename(page.path);
      moves.push([page.path, relJoin(entryDir, entries.md)]);
    }
    if (await pathExists(this.abs(page.dir))) {
      entries.dir = path.posix.basename(page.dir);
      moves.push([page.dir, relJoin(entryDir, entries.dir)]);
      if (page.bodySource === 'readme' && page.path) entries.md = relJoin(entries.dir, path.posix.basename(page.path));
    }
    const activity = this.activityPath(page);
    // Appended first so it travels into trash with the page.
    if (page.type) await this.appendActivity(activity, { itemId: page.id, action: 'trash' });
    if (await pathExists(this.abs(activity))) {
      entries.activity = path.posix.basename(activity);
      moves.push([activity, relJoin(entryDir, entries.activity)]);
    }
    await this.writeTrashManifest(entryDir, {
      formatVersion: 1,
      kind: 'page',
      id: page.id,
      title: page.title,
      trashedAt,
      originalParentId: page.parentId,
      originalDir: page.parentDir,
      entries,
      pageType: page.type,
      ...(page.sidecar ? { documentType: page.documentType, fileExtension: page.fileExtension } : {}),
    });
    for (const [from, to] of moves) await movePath(this.abs(from), this.abs(to));
    await this.refresh();
  }

  private async restore(id: string): Promise<void> {
    this.requireSafeId(id);
    const trashed = this.state.trash.get(id);
    if (!trashed) throw new LocalWikiError('not-trashed', `${id} is not in trash`);
    const { manifest, entryDir } = trashed;
    if (manifest.kind === 'row') {
      await this.restoreRow(manifest);
    } else if (manifest.kind === 'page') {
      const parent = manifest.originalParentId ? this.state.pages.get(manifest.originalParentId) : undefined;
      const targetDir = parent ? parent.dir : manifest.originalDir === '' || (await pathExists(this.abs(manifest.originalDir))) ? manifest.originalDir : '';
      const entries = manifest.entries ?? {};
      const fileSuffix = entries.file ? manifest.fileExtension ?? this.pageSuffix(entries.file, true) ?? '' : '';
      const oldStem = entries.file
        ? entries.file.slice(0, entries.file.length - fileSuffix.length)
        : entries.md && !entries.md.includes('/') ? entries.md.slice(0, -3) : entries.dir ?? fileStemForTitle(manifest.title);
      const stem = uniqueStem(oldStem, await this.occupiedNames(targetDir, null));
      if (entries.file) {
        const fileName = stem + fileSuffix;
        await movePath(this.abs(relJoin(entryDir, entries.file)), this.abs(relJoin(targetDir, fileName)));
        const sidecarRel = relJoin(targetDir, sidecarName(fileName));
        if (entries.sidecar) await movePath(this.abs(relJoin(entryDir, entries.sidecar)), this.abs(sidecarRel));
        if (stem !== oldStem || !entries.sidecar) {
          // Restored under a clash suffix (keep its title), or without a sidecar (keep its id).
          const text = entries.sidecar ? await readFile(this.abs(sidecarRel), 'utf8').catch(() => '') : '';
          const parsed = parseSidecar(text);
          const data: Record<string, unknown> = parsed.ok ? parsed.data : {};
          await this.writeSidecar(sidecarRel, { ...data, id, ...(data.title === undefined && stem !== oldStem ? { title: manifest.title } : {}) });
        }
      }
      if (entries.md && !entries.md.includes('/')) await movePath(this.abs(relJoin(entryDir, entries.md)), this.abs(relJoin(targetDir, `${stem}.md`)));
      if (entries.dir) await movePath(this.abs(relJoin(entryDir, entries.dir)), this.abs(relJoin(targetDir, stem)));
      if (entries.activity) await movePath(this.abs(relJoin(entryDir, entries.activity)), this.abs(relJoin(targetDir, stem + ACTIVITY_SUFFIX)));
      if (stem !== oldStem && entries.md && !entries.md.includes('/')) {
        // Restored under a clash suffix: keep the title it had.
        const abs = this.abs(relJoin(targetDir, `${stem}.md`));
        const parsed = parseMarkdownFile(await readFile(abs, 'utf8'));
        if (parsed.ok && parsed.data.title === undefined) await atomicWrite(abs, composeMarkdownFile({ ...parsed.data, title: manifest.title }, parsed.body));
      }
      if (manifest.pageType) await this.appendActivity(relJoin(targetDir, stem + ACTIVITY_SUFFIX), { itemId: id, action: 'restore' });
    } else {
      throw new LocalWikiError('invalid', `${id} is a trashed table; move its CSV back by hand`);
    }
    await unlink(this.abs(relJoin(entryDir, TRASH_MANIFEST)));
    await rmdir(this.abs(entryDir)).catch(() => {
      // Something else was left in the entry; keep it.
    });
    await this.refresh();
  }

}
