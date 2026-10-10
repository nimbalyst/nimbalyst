/**
 * The page tree's data source over `nim wiki serve`. The same seam as the
 * desktop's Local section (`PersonalPagesDataSource`), with fetch in place of
 * IPC and the server's SSE change stream in place of the main-process events.
 * There is no account and no team, so the status is always `connected`.
 */
import type {
  CollabDocsCommand,
  CollabDocsCommandResult,
  CollabDocsDataChange,
  CollabDocsDataSource,
  CollabDocsSnapshot,
  SharedDocument,
} from '@nimbalyst/collab-bundle/docs-ui';
import type { LocalPage, LocalWikiCommand } from '@nimbalyst/local-wiki';
import { wikiApi, wikiChanges } from '../api/client';

type PageSearchRequest = Parameters<NonNullable<CollabDocsDataSource['searchPages']>>[0];
type PageSearchResponse = NonNullable<Awaited<ReturnType<NonNullable<CollabDocsDataSource['searchPages']>>>>;

/** The stored title of an editor page: the tree shows it with its extension, the wiki keeps the stem. */
function stemTitle(title: string, fileExtension: string | undefined): string {
  return fileExtension && title.toLowerCase().endsWith(fileExtension.toLowerCase()) && title.length > fileExtension.length
    ? title.slice(0, -fileExtension.length)
    : title;
}

/**
 * A tree command as a library command; null for one that has nothing to do
 * locally. `editorExtension` names the file suffix of an editor page (a
 * drawing, mind map...), whose tree title carries it.
 */
export function toLocalCommand(command: CollabDocsCommand, editorExtension: (id: string) => string | undefined = () => undefined): LocalWikiCommand | null {
  switch (command.type) {
    case 'refresh-folders':
    case 'refresh-type-placements':
    case 'refresh-item-placements':
    case 'reconnect':
      return null;
    case 'register-document':
      if ((command.documentType ?? 'markdown') !== 'markdown') {
        throw new Error(`A ${command.documentType} page needs its editor; create it in Nimbalyst`);
      }
      return {
        type: 'register-document',
        documentId: command.documentId,
        title: command.title,
        parentFolderId: command.parentFolderId ?? null,
        ...(command.parentKind ? { parentKind: command.parentKind } : {}),
        sortOrder: command.sortOrder ?? null,
      };
    case 'register-folder':
      return { type: 'register-document', documentId: command.folderId, title: command.name, parentFolderId: command.parentFolderId ?? null };
    case 'update-document-title':
      return { type: 'update-document-title', documentId: command.documentId, title: stemTitle(command.title, editorExtension(command.documentId)) };
    case 'rename-folder':
      return { type: 'update-document-title', documentId: command.folderId, title: stemTitle(command.name, editorExtension(command.folderId)) };
    case 'set-document-fields':
      return { type: 'set-document-fields', documentId: command.documentId, fields: command.fields };
    case 'trash-document':
      return { type: 'trash-document', documentId: command.documentId, trashedAt: command.trashedAt };
    case 'restore-document':
      return { type: 'restore-document', documentId: command.documentId };
    case 'remove-document':
      return { type: 'remove-document', documentId: command.documentId, ...(command.purge ? { purge: true as const } : {}) };
    case 'remove-folder':
      // A page is trashed with its folder, and purged with what is below it.
      return { type: 'remove-document', documentId: command.folderId, ...(command.purge ? { purge: true as const } : {}) };
    case 'move-document':
    case 'move-folder': {
      const isDocument = command.type === 'move-document';
      return {
        type: 'move-document',
        documentId: isDocument ? command.documentId : command.folderId,
        parentFolderId: command.parentFolderId ?? null,
        ...(isDocument && command.parentKind ? { parentKind: command.parentKind } : {}),
        ...(isDocument && command.sortOrder !== undefined ? { sortOrder: command.sortOrder } : {}),
      };
    }
    case 'set-type-placement':
      return {
        type: 'set-type-placement',
        typeId: command.typeId,
        parentFolderId: command.parentFolderId ?? null,
        sortOrder: command.sortOrder,
        ...(command.parentKind ? { parentKind: command.parentKind } : {}),
      };
    case 'remove-type-placement':
      throw new Error('A table type in the local wiki is a CSV file in the wiki folder; move it instead of removing it');
    case 'set-item-placement':
      return {
        type: 'set-item-placement',
        itemId: command.itemId,
        parentId: command.parentId ?? null,
        sortOrder: command.sortOrder,
        ...(command.parentKind ? { parentKind: command.parentKind } : {}),
      };
    case 'remove-item-placement':
      throw new Error('A typed page in the local wiki is a file in the wiki folder; move it instead of removing its placement');
    default:
      throw new Error(`Unsupported local wiki command: ${(command as { type?: string }).type}`);
  }
}

export class LocalPagesDataSource implements CollabDocsDataSource {
  private readonly listeners = new Set<(change: CollabDocsDataChange) => void>();
  private feedUnsubscribe: (() => void) | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private refreshQueued = false;
  private disposed = false;
  /** Ids in the last snapshot read, to name what a later one dropped. */
  private lastItemIds = new Set<string>();
  private pages = new Map<string, LocalPage>();

  async snapshot(): Promise<CollabDocsSnapshot> {
    const wiki = await wikiApi.snapshot();
    this.pages = new Map(wiki.pages.map((page) => [page.id, page]));
    this.lastItemIds = new Set(wiki.items.map((item) => item.documentId));
    // An editor page shows with its extension, as in the desktop app.
    const items = wiki.items.map((item) => item.documentType === 'markdown' ? item : { ...item, title: `${item.title}${item.fileExtension}` });
    return {
      items: items as SharedDocument[],
      containers: [],
      typePlacements: wiki.typePlacements,
      itemPlacements: wiki.itemPlacements,
      pageTree: true,
      pageFields: true,
    };
  }

  /** The library's page record from the last snapshot (body version, path, type). */
  page(id: string): LocalPage | undefined {
    return this.pages.get(id);
  }

  /** Every page from the last snapshot read, typed pages included. */
  allPages(): Iterable<LocalPage> {
    return this.pages.values();
  }

  subscribe(cb: (change: CollabDocsDataChange) => void): () => void {
    this.listeners.add(cb);
    // The session starts `disconnected` and only a status change moves it; the
    // sidebar refuses renames and moves until it reads `connected`.
    cb({ type: 'status', status: 'connected' });
    if (!this.feedUnsubscribe && !this.disposed) {
      this.feedUnsubscribe = wikiChanges.subscribe((event) => {
        if (event.type !== 'down') void this.refresh();
      });
    }
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.stopWatching();
    };
  }

  async command(cmd: CollabDocsCommand): Promise<CollabDocsCommandResult> {
    const local = toLocalCommand(cmd, (id) => {
      const page = this.pages.get(id);
      return page && page.documentType !== 'markdown' ? page.fileExtension : undefined;
    });
    if (!local) return { ok: true };
    const result = await wikiApi.command(local);
    if (result?.ok !== true) throw new Error(`The local wiki refused ${cmd.type}`);
    // The write is on disk when the server answers. Refresh now rather than
    // waiting for the file watcher, so the tree shows it on this tick.
    void this.refresh();
    return {
      ok: true,
      ...(result.purged !== undefined ? { purged: result.purged } : {}),
      ...(cmd.type === 'register-document' ? { registrationAcked: true } : {}),
    };
  }

  async searchPages(request: PageSearchRequest): Promise<PageSearchResponse> {
    const hits = await wikiApi.search(request.query, request.limit);
    const typeIds = request.typeIds ? new Set(request.typeIds) : null;
    return {
      status: 'ready',
      hits: hits
        .filter((hit) => !hit.type || !typeIds || typeIds.has(hit.type))
        .map((hit) => ({
          kind: hit.type ? ('typed' as const) : ('page' as const),
          id: hit.id,
          documentId: hit.id,
          title: hit.title,
          issueKey: null,
          snippet: hit.snippet,
          highlights: [],
          updatedAt: this.pages.get(hit.id)?.updatedAt ?? null,
          score: hit.score,
        })),
    };
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
  refresh(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }
    this.refreshInFlight = (async () => {
      try {
        do {
          this.refreshQueued = false;
          const previous = this.lastItemIds;
          const snapshot = await this.snapshot();
          if (this.disposed) return;
          // The session merges a snapshot into what it holds and keeps rows the
          // snapshot lacks, so a page trashed elsewhere must be named as removed.
          const removed = [...previous].filter((id) => !this.lastItemIds.has(id));
          const changes: CollabDocsDataChange[] = [{ type: 'snapshot', snapshot }];
          if (removed.length > 0) changes.push({ type: 'items-removed', itemIds: removed });
          for (const change of changes) for (const listener of this.listeners) listener(change);
        } while (this.refreshQueued && !this.disposed);
      } catch (error) {
        console.error('[wiki-web] Failed to refresh the page tree:', error);
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  private stopWatching(): void {
    this.feedUnsubscribe?.();
    this.feedUnsubscribe = null;
  }
}
