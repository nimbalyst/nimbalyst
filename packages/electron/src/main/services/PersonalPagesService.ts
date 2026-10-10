/**
 * Personal pages: one page tree of documents, tracker-type placements and
 * typed-page placements that live in the app database for one workspace, with
 * no account. Since schema 0050 any page can hold child pages (a document's
 * `parentFolderId` names its parent page) and the snapshot says `pageTree`;
 * folder commands from an older renderer are mapped onto pages. The command surface is
 * the shared-docs `CollabDocsCommand` union, so the page tree can drive this
 * store and a team room the same way. Documents keep the shared-docs model and
 * stable ids so a later promotion to the team can follow
 * `publishTrackerCreation.ts`; `publication_status` stays 'local' until then.
 *
 * Since 0051 a parent can also be a typed page (a tracker item, `parentKind:
 * 'item'`), and pages carry a sibling order. Validation follows the team
 * store, and goes further where only a local store can: a typed-page parent
 * must exist in this workspace, and the cycle check walks through typed pages
 * and, for an unplaced one, through its type.
 *
 * Rows are only deleted by a `purge` of a page already in Trash, as in the team
 * store: `remove-document` for the page, `remove-folder` for it and the pages
 * in Trash below it. Without that, both move a live page (and, for
 * `remove-folder`, its subtree) to Trash; nothing deletes on one call.
 */
import { BrowserWindow } from 'electron';
import type {
  CollabDocsCommand,
  CollabDocsCommandResult,
  SharedDocument,
  SharedFolder,
  SharedItemPlacement,
  SharedParentKind,
  SharedTypePlacement,
} from '@nimbalyst/collab-client/docs';
import type { PageSearchRequest } from '@nimbalyst/collab-protocol';
import { getDatabase } from '../database/initialize';
import { historyManager, type HistoryManager } from '../HistoryManager';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import * as store from './personalPages/personalPagesStore';
import { searchPersonalPages } from './personalPages/personalPagesSearch';
import { seedPersonalHomeOnce, workspaceStateHomeSeedFlags, type PersonalHomeSeedFlags } from './personalPages/personalHomePage';

export interface PersonalPagesSnapshot {
  items: SharedDocument[];
  /** Always empty: personal folders became pages in schema 0050. */
  containers: SharedFolder[];
  typePlacements: SharedTypePlacement[];
  itemPlacements: SharedItemPlacement[];
  pageTree: true;
  pageFields: true;
}

export type PersonalBodyWriteResult =
  | { version: number }
  | { conflict: true; version: number; content: string };

export interface PersonalPagesDeps {
  db?: () => store.PersonalPagesDb | null;
  history?: Pick<HistoryManager, 'createSnapshot'>;
  notify?: (workspacePath: string) => void;
  /** Seeds a Home page on a workspace's first snapshot. Absent: no seeding. */
  homeSeed?: PersonalHomeSeedFlags;
}

export function personalDocHistoryKey(documentId: string): string {
  return `personal-doc://${documentId}`;
}

function broadcastChanged(workspacePath: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('personal-pages:changed', { workspacePath });
  }
}

function requireWorkspace(workspacePath: string): string {
  if (!workspacePath || typeof workspacePath !== 'string') throw new Error('workspacePath is required');
  return workspacePath;
}

function requireId(value: unknown, name: string): string {
  if (!value || typeof value !== 'string') throw new Error(`${name} is required`);
  return value;
}

const OK: CollabDocsCommandResult = { ok: true };

/** A purge reports how many pages it deleted for good; any other remove is plain OK. */
const purgeOutcome = (purged: number | null): CollabDocsCommandResult => (purged === null ? OK : { ok: true, purged });

/** A page in Trash and the pages in Trash below it, by page parents, as `purgeTrashedPageSubtree` walks them. */
function trashedSubtreeIds(documents: SharedDocument[], rootId: string): string[] {
  const ids = [rootId];
  for (let index = 0; index < ids.length; index++) {
    for (const document of documents) {
      if (document.parentFolderId === ids[index] && (document.parentKind ?? 'page') === 'page'
        && document.trashedAt != null && !ids.includes(document.documentId)) ids.push(document.documentId);
    }
  }
  return ids;
}

const kindOf = (value: unknown): SharedParentKind => (value === 'item' ? 'item' : 'page');
const orderOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** A node in the tree, for the cycle walk. */
type TreeRef = { kind: SharedParentKind | 'type'; id: string };

export class PersonalPagesService {
  private readonly getDb: () => store.PersonalPagesDb | null;
  private readonly history: Pick<HistoryManager, 'createSnapshot'>;
  private readonly notify: (workspacePath: string) => void;
  private readonly homeSeed: PersonalHomeSeedFlags | undefined;
  /** Workspaces whose Home seed was already settled in this process. */
  private readonly homeChecked = new Set<string>();
  private disposed = false;

  constructor(deps: PersonalPagesDeps = {}) {
    this.getDb = deps.db ?? (() => getDatabase() as store.PersonalPagesDb | null);
    this.history = deps.history ?? historyManager;
    this.notify = deps.notify ?? broadcastChanged;
    this.homeSeed = deps.homeSeed;
  }

  dispose(): void {
    this.disposed = true;
  }

  private db(): store.PersonalPagesDb {
    if (this.disposed) throw new Error('PersonalPagesService is disposed');
    const db = this.getDb();
    if (!db) throw new Error('Database not initialized');
    return db;
  }

  async snapshot(workspacePath: string): Promise<PersonalPagesSnapshot> {
    const ws = requireWorkspace(workspacePath);
    const db = this.db();
    if (this.homeSeed && !this.homeChecked.has(ws)) {
      await seedPersonalHomeOnce(db, ws, this.homeSeed);
      this.homeChecked.add(ws);
    }
    const [items, typePlacements, itemPlacements] = await Promise.all([
      store.listDocuments(db, ws),
      store.listTypePlacements(db, ws),
      store.listItemPlacements(db, ws),
    ]);
    return { items, containers: [], typePlacements, itemPlacements, pageTree: true, pageFields: true };
  }

  async command(workspacePath: string, command: CollabDocsCommand): Promise<CollabDocsCommandResult> {
    const ws = requireWorkspace(workspacePath);
    if (!command || typeof command !== 'object') throw new Error('command is required');
    const db = this.db();
    switch (command.type) {
      case 'refresh-folders':
      case 'refresh-type-placements':
      case 'refresh-item-placements':
      case 'reconnect':
        return OK;
      case 'register-document':
        await this.assertParent(db, ws, command.parentFolderId ?? null, kindOf(command.parentKind));
        await store.upsertDocument(db, ws, {
          documentId: requireId(command.documentId, 'documentId'),
          title: command.title ?? '',
          documentType: requireId(command.documentType, 'documentType'),
          parentFolderId: command.parentFolderId ?? null,
          parentKind: command.parentFolderId ? kindOf(command.parentKind) : 'page',
          sortOrder: orderOf(command.sortOrder),
          editorId: command.metadata?.editorId ?? null,
          fileExtension: command.metadata?.fileExtension ?? null,
        });
        break;
      case 'update-document-title':
        await this.mustUpdateDocument(db, ws, command.documentId, { title: command.title ?? '' });
        break;
      case 'set-document-fields':
        if (!command.fields || typeof command.fields !== 'object') throw new Error('fields is required');
        if (!await store.patchDocumentFields(db, ws, requireId(command.documentId, 'documentId'), command.fields)) {
          throw new Error(`No personal page ${command.documentId}`);
        }
        break;
      case 'trash-document':
        await this.mustUpdateDocument(db, ws, command.documentId, {
          trashed_at: new Date(Number.isFinite(command.trashedAt) ? command.trashedAt : Date.now()),
        });
        break;
      case 'restore-document':
        await this.mustUpdateDocument(db, ws, command.documentId, { trashed_at: null });
        break;
      case 'move-document':
        await this.movePage(
          db, ws, requireId(command.documentId, 'documentId'), command.parentFolderId ?? null,
          kindOf(command.parentKind), orderOf(command.sortOrder),
        );
        break;
      case 'remove-document':
        return purgeOutcome(await this.removeDocument(db, ws, requireId(command.documentId, 'documentId'), command.purge === true));
      // Folder commands from a renderer that predates the page tree: a folder
      // is a page with an empty body.
      case 'register-folder': {
        const pageId = requireId(command.folderId, 'folderId');
        await this.assertParent(db, ws, command.parentFolderId ?? null, 'page');
        await store.upsertDocument(db, ws, {
          documentId: pageId,
          title: (command.name ?? '').trim().slice(0, 120),
          documentType: 'markdown',
          parentFolderId: command.parentFolderId ?? null,
          parentKind: 'page',
          sortOrder: null,
          editorId: null,
          fileExtension: null,
        });
        break;
      }
      case 'rename-folder':
        await this.mustUpdateDocument(db, ws, command.folderId, { title: (command.name ?? '').trim().slice(0, 120) });
        break;
      case 'move-folder':
        await this.movePage(db, ws, requireId(command.folderId, 'folderId'), command.parentFolderId ?? null, 'page', null);
        break;
      case 'remove-folder':
        return purgeOutcome(await this.removePageSubtree(db, ws, requireId(command.folderId, 'folderId'), command.purge === true));
      case 'set-type-placement': {
        const typeId = requireId(command.typeId, 'typeId');
        const parentKind = command.parentFolderId ? kindOf(command.parentKind) : 'page';
        await this.assertParent(db, ws, command.parentFolderId ?? null, parentKind);
        await this.assertNoCycle(db, ws, { kind: 'type', id: typeId }, command.parentFolderId ?? null, parentKind);
        await store.upsertTypePlacement(db, ws, {
          typeId,
          parentFolderId: command.parentFolderId ?? null,
          parentKind,
          sortOrder: Number.isFinite(command.sortOrder) ? command.sortOrder : 0,
        });
        break;
      }
      case 'remove-type-placement':
        await store.deleteTypePlacement(db, ws, requireId(command.typeId, 'typeId'));
        break;
      case 'set-item-placement': {
        const itemId = requireId(command.itemId, 'itemId');
        const parentKind = command.parentId ? kindOf(command.parentKind) : 'page';
        await this.assertParent(db, ws, command.parentId ?? null, parentKind);
        await this.assertNoCycle(db, ws, { kind: 'item', id: itemId }, command.parentId ?? null, parentKind);
        await store.upsertItemPlacement(db, ws, {
          itemId,
          parentId: command.parentId ?? null,
          parentKind,
          sortOrder: Number.isFinite(command.sortOrder) ? command.sortOrder : 0,
        });
        break;
      }
      case 'remove-item-placement':
        await store.deleteItemPlacement(db, ws, requireId(command.itemId, 'itemId'));
        break;
      default:
        throw new Error(`Unsupported personal pages command: ${(command as { type?: string }).type}`);
    }
    this.notify(ws);
    return OK;
  }

  async getBody(workspacePath: string, documentId: string): Promise<{ content: string; version: number } | null> {
    return store.readBody(this.db(), requireWorkspace(workspacePath), requireId(documentId, 'documentId'));
  }

  async updateBody(
    workspacePath: string,
    documentId: string,
    content: string,
    expectedVersion?: number,
  ): Promise<PersonalBodyWriteResult> {
    const ws = requireWorkspace(workspacePath);
    requireId(documentId, 'documentId');
    if (typeof content !== 'string') throw new Error('content must be a string');
    if (expectedVersion !== undefined && !Number.isInteger(expectedVersion)) {
      throw new Error('expectedVersion must be an integer');
    }
    const db = this.db();
    const version = await store.writeBody(db, ws, documentId, content, expectedVersion);
    if (version === null) {
      const current = await store.readBody(db, ws, documentId);
      if (!current) throw new Error(`Unknown personal document '${documentId}'`);
      return { conflict: true, version: current.version, content: current.content };
    }
    await this.recordSnapshot(ws, documentId, content);
    this.notify(ws);
    return { version };
  }

  /** Never throws: the body is already saved and a history failure must not fail the save. */
  private async recordSnapshot(ws: string, documentId: string, content: string): Promise<void> {
    try {
      await this.history.createSnapshot(personalDocHistoryKey(documentId), content, 'auto-save', 'Auto-save');
    } catch (error) {
      logger.main.error('[PersonalPagesService] Failed to snapshot personal document body:', { documentId, error });
    }
  }

  /**
   * A parent is a page (a non-trashed document in this workspace), a typed page
   * (a tracker item of this workspace that is not deleted), or null for root.
   */
  private async assertParent(db: store.PersonalPagesDb, ws: string, parentId: string | null, kind: SharedParentKind): Promise<void> {
    if (parentId === null) return;
    if (kind === 'item') {
      if (!(await store.itemType(db, ws, parentId))) throw new Error(`Unknown typed page '${parentId}'`);
      return;
    }
    const documents = await store.listDocuments(db, ws);
    if (!documents.some((document) => document.documentId === parentId && document.trashedAt == null)) {
      throw new Error(`Unknown personal page '${parentId}'`);
    }
  }

  /**
   * Refuse a parent whose way up reaches `moving`: through page parents, typed
   * page placements and, for a typed page with no placement, its type's
   * placement (where the tree shows it).
   */
  private async assertNoCycle(
    db: store.PersonalPagesDb,
    ws: string,
    moving: TreeRef,
    parentId: string | null,
    parentKind: SharedParentKind,
  ): Promise<void> {
    if (parentId === null) return;
    const [documents, typePlacements, itemPlacements] = await Promise.all([
      store.listDocuments(db, ws),
      store.listTypePlacements(db, ws),
      store.listItemPlacements(db, ws),
    ]);
    const documentById = new Map(documents.map((document) => [document.documentId, document]));
    const typeById = new Map(typePlacements.map((placement) => [placement.typeId, placement]));
    const itemById = new Map(itemPlacements.map((placement) => [placement.itemId, placement]));
    const up = (id: string | null | undefined, kind: SharedParentKind | undefined): TreeRef | null =>
      id ? { id, kind: kind ?? 'page' } : null;
    const seen = new Set<string>();
    let ref: TreeRef | null = { id: parentId, kind: parentKind };
    while (ref && !seen.has(`${ref.kind}:${ref.id}`)) {
      if (ref.kind === moving.kind && ref.id === moving.id) {
        throw new Error(`Refusing to put '${moving.id}' under its own descendant (cycle)`);
      }
      seen.add(`${ref.kind}:${ref.id}`);
      if (ref.kind === 'page') {
        const document = documentById.get(ref.id);
        ref = up(document?.parentFolderId, document?.parentKind);
      } else if (ref.kind === 'type') {
        const placement = typeById.get(ref.id);
        ref = up(placement?.parentFolderId, placement?.parentKind);
      } else {
        const placement = itemById.get(ref.id);
        if (placement) {
          ref = up(placement.parentId, placement.parentKind);
        } else {
          const typeId = await store.itemType(db, ws, ref.id);
          ref = typeId ? { id: typeId, kind: 'type' } : null;
        }
      }
    }
  }

  /**
   * Reparent or reorder a page. The new parent must exist and must not be the
   * page or below it; an order absent on the move leaves the page unordered.
   */
  private async movePage(
    db: store.PersonalPagesDb,
    ws: string,
    pageId: string,
    parentId: string | null,
    parentKind: SharedParentKind,
    sortOrder: number | null,
  ): Promise<void> {
    const kind = parentId ? parentKind : 'page';
    await this.assertParent(db, ws, parentId, kind);
    await this.assertNoCycle(db, ws, { kind: 'page', id: pageId }, parentId, kind);
    await this.mustUpdateDocument(db, ws, pageId, { parent_folder_id: parentId, parent_kind: kind, sort_order: sortOrder });
  }

  /**
   * The team store's rule: a live page goes to Trash, purge or not, and only a
   * purge of a page already in Trash deletes it. A plain remove of a page in
   * Trash (a replayed or stale write) changes nothing. With `purge`, returns
   * how many pages went; 0 when another window restored the page since it was
   * read here (the delete re-checks that inside its own statement).
   */
  private async removeDocument(db: store.PersonalPagesDb, ws: string, documentId: string, purge: boolean): Promise<number | null> {
    const document = (await store.listDocuments(db, ws)).find((candidate) => candidate.documentId === documentId);
    if (document?.trashedAt == null) {
      if (document) await this.mustUpdateDocument(db, ws, documentId, { trashed_at: new Date() });
      return purge ? 0 : null;
    }
    return purge ? store.deleteTrashedDocument(db, ws, documentId, new Date(document.trashedAt)) : null;
  }

  /**
   * `remove-folder`, from a renderer that predates the page tree, under the
   * same rule: a live page goes to Trash with its subtree, and only a purge of
   * a page already in Trash deletes it, with the pages in Trash below it. With
   * `purge`, returns how many pages went; 0 when another window restored the
   * page since it was read here (the transaction re-checks that).
   */
  private async removePageSubtree(db: store.PersonalPagesDb, ws: string, pageId: string, purge: boolean): Promise<number | null> {
    const documents = await store.listDocuments(db, ws);
    const page = documents.find((candidate) => candidate.documentId === pageId);
    if (page?.trashedAt == null) {
      if (page) await store.trashPageSubtree(db, ws, pageId, new Date());
      return purge ? 0 : null;
    }
    if (!purge) return null;
    const candidates = trashedSubtreeIds(documents, pageId);
    await store.purgeTrashedPageSubtree(db, ws, pageId, new Date(page.trashedAt));
    // Counted, not assumed: the transaction may have found the page restored.
    const remaining = new Set((await store.listDocuments(db, ws)).map((document) => document.documentId));
    return candidates.filter((id) => !remaining.has(id)).length;
  }

  private async mustUpdateDocument(db: store.PersonalPagesDb, ws: string, documentId: string, values: Record<string, unknown>) {
    if (!(await store.updateDocument(db, ws, requireId(documentId, 'documentId'), values))) {
      throw new Error(`Unknown personal document '${documentId}'`);
    }
  }
}

let service: PersonalPagesService | null = null;

export function initPersonalPagesService(): void {
  if (service) return;
  const instance = new PersonalPagesService({ homeSeed: workspaceStateHomeSeedFlags });
  service = instance;
  safeHandle('personal-pages:snapshot', async (_event, workspacePath: string) => {
    return instance.snapshot(workspacePath);
  });
  safeHandle('personal-pages:command', async (_event, workspacePath: string, command: CollabDocsCommand) => {
    return instance.command(workspacePath, command);
  });
  safeHandle('personal-pages:search', async (_event, workspacePath: string, request: PageSearchRequest) => {
    const db = getDatabase();
    if (!db) throw new Error('Database not initialized');
    return searchPersonalPages(db, requireWorkspace(workspacePath), request ?? { query: '' });
  });
  safeHandle('personal-pages:get-body', async (_event, workspacePath: string, documentId: string) => {
    return instance.getBody(workspacePath, documentId);
  });
  safeHandle(
    'personal-pages:update-body',
    async (_event, workspacePath: string, documentId: string, content: string, expectedVersion?: number) => {
      return instance.updateBody(workspacePath, documentId, content, expectedVersion ?? undefined);
    },
  );
}
