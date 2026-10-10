/**
 * Data source of the Wiki tree's Local section (formerly Personal): a folder
 * of files read and written by main through `@nimbalyst/local-wiki`, plus the
 * database Personal pages the user has not exported yet. It works with no
 * account, no team and no network, so its status is always `connected`.
 *
 * - `local-wiki:snapshot(workspacePath)` returns the library snapshot (one page
 *   tree, `pageTree` true, `containers` empty) with the folder's `root`.
 * - `local-wiki:legacy-snapshot(workspacePath)` returns the database pages and
 *   placements not in the wiki yet. They stay on the old `personal-pages:*`
 *   path until the user exports them, so nothing leaves the tree on upgrade.
 * - Commands are routed by `routeLocalCommand`.
 * - `local-wiki:changed` and `personal-pages:changed { workspacePath }` arrive
 *   through the central listener and are answered with a fresh `snapshot`.
 */

import type { Unsubscribe } from '@nimbalyst/collab-client/core';
import type {
  CollabDocsCommand,
  CollabDocsCommandResult,
  CollabDocsDataChange,
  CollabDocsDataSource,
  CollabDocsSnapshot,
  SharedDocument,
  SharedItemPlacement,
  SharedTypePlacement,
} from '@nimbalyst/collab-client/docs';
import type { PageSearchRequest, PageSearchResponse } from '@nimbalyst/collab-protocol';
import type { LocalPage, LocalTableInfo, LocalTrackerSnapshot } from '@nimbalyst/local-wiki';
import { store } from '@nimbalyst/runtime/store';
import { setLocalWikiRoot } from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/flatTypedPage';
import {
  initPersonalPagesListeners,
  personalPagesRevisionAtomFamily,
} from '../store/listeners/personalPagesListeners';
import { localWikiStatusAtomFamily, type LocalWikiStatus } from '../store/atoms/localWiki';
import { routeLocalCommand, type LegacyIds } from './localWikiCommands';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { buildLocalWikiRecords, markPlacedLocalWikiType, mergeLocalWikiRecords } from './localWikiTrackerRecords';
import { localPageTreeTitle } from './personalPageTypes';
import { brokenTypesFromIssues, placementsForUnshownBrokenTypes, sameBrokenTypes } from './localWikiBrokenTypes';

/** What main answers on `local-wiki:snapshot`. */
interface LocalWikiSnapshotPayload {
  items?: SharedDocument[];
  typePlacements?: SharedTypePlacement[];
  itemPlacements?: SharedItemPlacement[];
  pages?: LocalPage[];
  tables?: LocalTableInfo[];
  issues?: unknown[];
  root?: string;
  location?: string;
  exists?: boolean;
}

/** What main answers on `local-wiki:legacy-snapshot`. */
interface LegacySnapshotPayload {
  items?: SharedDocument[];
  typePlacements?: SharedTypePlacement[];
  itemPlacements?: SharedItemPlacement[];
  unexportedPageCount?: number;
}

const NO_LEGACY: LegacyIds = { documents: new Set(), types: new Set(), items: new Set() };

/** Joins a wiki-relative path onto the folder, keeping the folder's separator. */
function absolutePagePath(root: string, relative: string): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${relative.split('/').join(separator)}`;
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const ipc = window.electronAPI?.invoke;
  if (!ipc) return Promise.reject(new Error('Personal pages are unavailable in this window'));
  return ipc(channel, ...args) as Promise<T>;
}

export class PersonalPagesDataSource implements CollabDocsDataSource {
  private readonly listeners = new Set<(change: CollabDocsDataChange) => void>();
  private revisionUnsubscribe: Unsubscribe | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private refreshQueued = false;
  private disposed = false;
  /** Ids in the last snapshot read, to name what a later one dropped. */
  private lastItemIds = new Set<string>();
  private lastContainerIds = new Set<string>();

  /** Database rows shown beside the wiki until they are exported. */
  private legacy: LegacyIds = NO_LEGACY;
  /** Absolute file (markdown or editor file) of each live wiki page that has one. */
  private filePaths = new Map<string, string>();
  /** File suffix of each editor page (drawing, mind map...), by page id. */
  private editorPages = new Map<string, string>();

  constructor(private readonly workspacePath: string) {}

  async snapshot(): Promise<CollabDocsSnapshot> {
    const [wiki, legacy] = await Promise.all([
      invoke<LocalWikiSnapshotPayload | null>('local-wiki:snapshot', this.workspacePath),
      // The database may not be up yet (or ever, in a test window): the wiki still shows.
      invoke<LegacySnapshotPayload | null>('local-wiki:legacy-snapshot', this.workspacePath).catch((error) => {
        console.warn('[PersonalPagesDataSource] Database Personal pages are unavailable:', error);
        return null;
      }),
    ]);
    // An editor page shows with its extension, as the Team section shows one.
    const wikiItems = (wiki?.items ?? []).map((item) => item.documentType === 'markdown' || !item.fileExtension
      ? item
      : { ...item, title: localPageTreeTitle(item.title, item.documentType, item.fileExtension) });
    this.editorPages = new Map((wiki?.items ?? [])
      .filter((item) => item.documentType !== 'markdown' && item.fileExtension)
      .map((item) => [item.documentId, item.fileExtension!]));
    const legacyItems = legacy?.items ?? [];
    const wikiTypeIds = new Set((wiki?.typePlacements ?? []).map((placement) => placement.typeId));
    const wikiItemIds = new Set((wiki?.itemPlacements ?? []).map((placement) => placement.itemId));
    const legacyTypePlacements = (legacy?.typePlacements ?? []).filter((placement) => !wikiTypeIds.has(placement.typeId));
    const legacyItemPlacements = (legacy?.itemPlacements ?? []).filter((placement) => !wikiItemIds.has(placement.itemId));
    const statusAtom = localWikiStatusAtomFamily(this.workspacePath);
    const previousBroken = store.get(statusAtom).brokenTypes;
    const readBroken = brokenTypesFromIssues(wiki?.issues);
    const brokenTypes = sameBrokenTypes(previousBroken, readBroken) ? previousBroken : readBroken;
    const typePlacements = [...(wiki?.typePlacements ?? []), ...legacyTypePlacements];
    const result: CollabDocsSnapshot = {
      items: [...wikiItems, ...legacyItems],
      containers: [],
      typePlacements: [...typePlacements, ...placementsForUnshownBrokenTypes(brokenTypes, typePlacements, wiki?.pages ?? [])],
      itemPlacements: [...(wiki?.itemPlacements ?? []), ...legacyItemPlacements],
      pageTree: true,
      pageFields: true,
    };
    this.legacy = {
      documents: new Set(legacyItems.map((item) => item.documentId)),
      types: new Set(legacyTypePlacements.map((placement) => placement.typeId)),
      items: new Set(legacyItemPlacements.map((placement) => placement.itemId)),
    };
    const root = wiki?.root ?? null;
    this.filePaths = new Map((wiki?.pages ?? [])
      .filter((page) => page.trashedAt === null && page.path && root)
      .map((page) => [page.id, absolutePagePath(root!, page.path!)]));
    const status: LocalWikiStatus = {
      root,
      location: wiki?.location ?? null,
      exists: wiki?.exists === true,
      unexportedPageCount: legacy?.unexportedPageCount ?? 0,
      issueCount: wiki?.issues?.length ?? 0,
      brokenTypes,
    };
    store.set(statusAtom, status);
    // The file header reads a flat `type:` as a typed page only inside the wiki.
    setLocalWikiRoot(this.workspacePath, root);
    await this.mergeTrackerRecords(wiki, root);
    this.lastItemIds = new Set(result.items.map((item) => item.documentId));
    this.lastContainerIds = new Set();
    return result;
  }

  /**
   * Typed pages and table rows become tracker records, so type tables, the
   * type resolver and relationship pickers see them. Never throws: the tree
   * still shows when a table cannot be read.
   */
  private async mergeTrackerRecords(wiki: LocalWikiSnapshotPayload | null, root: string | null): Promise<void> {
    try {
      const tables = await Promise.all((wiki?.tables ?? []).map((table) =>
        invoke<LocalTrackerSnapshot>('local-wiki:tracker-snapshot', this.workspacePath, table.typeId)));
      const records = root
        ? buildLocalWikiRecords(this.workspacePath, root, wiki?.pages ?? [], tables, store.get(trackerItemsMapAtom))
        : [];
      mergeLocalWikiRecords(this.workspacePath, records);
    } catch (error) {
      console.warn('[PersonalPagesDataSource] Could not read the Local wiki items:', error);
    }
  }

  /** Whether a page is a database row the user has not exported yet. */
  isLegacyDocument(documentId: string): boolean {
    return this.legacy.documents.has(documentId);
  }

  /**
   * The page's markdown file. A page known only as a bare folder gets its
   * `Name.md` written first (the library keeps the folder's id), so it can
   * open like any other page.
   */
  async pageFilePath(documentId: string): Promise<string | null> {
    const known = this.filePaths.get(documentId);
    if (known) return known;
    let filePath = await invoke<string | null>('local-wiki:page-path', this.workspacePath, documentId);
    if (!filePath) {
      const written = await invoke<{ ok: boolean } | null>('local-wiki:write-body', this.workspacePath, documentId, '', null);
      if (written?.ok) filePath = await invoke<string | null>('local-wiki:page-path', this.workspacePath, documentId);
    }
    if (filePath) this.filePaths.set(documentId, filePath);
    return filePath;
  }

  /** The page whose markdown file this is, from the last snapshot read. */
  documentIdForFile(filePath: string): string | null {
    for (const [id, path] of this.filePaths) if (path === filePath) return id;
    return null;
  }

  /** Last-read absolute file of every live page with one, by page id. */
  filePathsById(): ReadonlyMap<string, string> {
    return this.filePaths;
  }

  subscribe(cb: (change: CollabDocsDataChange) => void): Unsubscribe {
    this.listeners.add(cb);
    // The session's status starts `disconnected` and only a status change moves
    // it; the sidebar refuses renames and moves until it reads `connected`.
    cb({ type: 'status', status: 'connected' });
    if (!this.revisionUnsubscribe && !this.disposed) {
      initPersonalPagesListeners();
      this.revisionUnsubscribe = store.sub(
        personalPagesRevisionAtomFamily(this.workspacePath),
        () => { void this.refresh(); },
      );
    }
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.stopWatching();
    };
  }

  async command(cmd: CollabDocsCommand): Promise<CollabDocsCommandResult> {
    const route = routeLocalCommand(cmd, this.legacy, this.editorPages);
    if (route.backend === 'none') return { ok: true };
    const result = route.backend === 'legacy'
      ? await invoke<Partial<CollabDocsCommandResult> | null>('personal-pages:command', this.workspacePath, cmd)
      : await invoke<Partial<CollabDocsCommandResult> | null>('local-wiki:command', this.workspacePath, route.command);
    // Main throws on a refused write, which rejects this call. Anything but an
    // explicit `ok` is a refusal too: never report a write that did not land.
    if (result?.ok !== true) {
      const reason = (result as { error?: unknown } | null)?.error;
      throw new Error(typeof reason === 'string' && reason
        ? reason
        : `Personal pages refused ${cmd.type}`);
    }
    if (route.backend === 'wiki' && cmd.type === 'set-type-placement') markPlacedLocalWikiType(cmd.typeId);
    // There is no server to wait on: a local write is committed when main
    // answers, so an accepted registration is confirmed.
    return {
      ...result,
      ok: true,
      ...(cmd.type === 'register-document' ? { registrationAcked: true } : {}),
    };
  }

  /** Body search over the wiki folder, and over the database pages not exported yet. */
  async searchPages(request: PageSearchRequest): Promise<PageSearchResponse | null> {
    const legacy = this.legacy;
    const [wiki, database] = await Promise.all([
      invoke<PageSearchResponse>('local-wiki:search', this.workspacePath, request),
      legacy.documents.size > 0
        ? invoke<PageSearchResponse>('personal-pages:search', this.workspacePath, request).catch(() => null)
        : Promise.resolve(null),
    ]);
    const databaseHits = (database?.hits ?? []).filter((hit) => hit.kind === 'page' && legacy.documents.has(hit.id));
    if (databaseHits.length === 0) return wiki;
    // Scores from the two indexes do not compare, so the wiki's hits come first.
    const hits = [...wiki.hits, ...databaseHits].slice(0, request.limit ?? 20);
    return { hits, status: wiki.status === 'ready' && database?.status !== 'partial' ? 'ready' : 'partial' };
  }

  status(): 'connected' {
    return 'connected';
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.stopWatching();
  }

  /** One snapshot read at a time; a change during a read schedules one more. */
  private refresh(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }
    this.refreshInFlight = (async () => {
      try {
        do {
          this.refreshQueued = false;
          const previousItemIds = this.lastItemIds;
          const previousContainerIds = this.lastContainerIds;
          const snapshot = await this.snapshot();
          if (this.disposed) return;
          // The session merges a snapshot into what it holds and keeps rows the
          // snapshot lacks, so a page or folder deleted in another window has to
          // be named as removed or it stays in the tree. Placements need nothing
          // extra: the snapshot's list replaces the session's.
          const itemIds = [...previousItemIds].filter((id) => !this.lastItemIds.has(id));
          const containerIds = [...previousContainerIds].filter((id) => !this.lastContainerIds.has(id));
          const changes: CollabDocsDataChange[] = [{ type: 'snapshot', snapshot }];
          if (itemIds.length > 0) changes.push({ type: 'items-removed', itemIds });
          if (containerIds.length > 0) changes.push({ type: 'containers-removed', containerIds, itemIds: [] });
          for (const change of changes) {
            for (const listener of this.listeners) listener(change);
          }
        } while (this.refreshQueued && !this.disposed);
      } catch (error) {
        console.error('[PersonalPagesDataSource] Failed to refresh personal pages:', error);
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  private stopWatching(): void {
    this.revisionUnsubscribe?.();
    this.revisionUnsubscribe = null;
  }
}
