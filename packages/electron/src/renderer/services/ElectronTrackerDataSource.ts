import type {
  TrackerDataChange,
  TrackerDataCommand,
  TrackerDataCommandResult,
  TrackerDataSnapshot,
  TrackerDataSource,
  TrackerItem,
  TrackerItemRevisionRecord,
  TrackerPresenceMember,
  TrackerRevisionRef,
  TrackerSavedViewRecord,
  TrackerSyncState,
  TrackerSyncStatus,
} from '@nimbalyst/collab-client/trackers';
import { TrackerRevisionUnavailableError } from '@nimbalyst/collab-client/trackers';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

interface TrackerItemChangeEvent {
  added?: TrackerItem[];
  updated?: TrackerItem[];
  removed?: string[];
}

export interface ElectronTrackerDataSourceIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, callback: (value: any) => void): () => void;
}

export interface ElectronTrackerDataSourceOptions {
  workspacePath: string;
  ipc?: ElectronTrackerDataSourceIpc;
}

/**
 * Trailing window for collapsing a burst of `metadata-changed` events into one
 * full tracker-item reload. Long enough to swallow a run of keystrokes inside a
 * frontmatter block, short enough that a deliberate frontmatter edit still
 * shows up in the tracker views without feeling stale.
 */
const METADATA_RELOAD_COALESCE_MS = 500;

function normalizeSavedViews(value: unknown): TrackerSavedViewRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is TrackerSavedViewRecord =>
      !!row && typeof row === 'object' && typeof row.viewId === 'string' && typeof row.payload === 'string',
  );
}

function normalizeStatus(value: unknown): TrackerSyncStatus {
  return value === 'connecting' || value === 'syncing' || value === 'connected' || value === 'error'
    ? value
    : 'disconnected';
}

function normalizePresence(value: unknown): TrackerPresenceMember[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((member) => {
    if (!member || typeof member !== 'object') return [];
    const candidate = member as Record<string, unknown>;
    if (typeof candidate.teamMemberId !== 'string' || typeof candidate.displayName !== 'string') return [];
    return [{
      teamMemberId: asTeamMemberId(candidate.teamMemberId),
      displayName: candidate.displayName,
      avatarUrl: typeof candidate.avatarUrl === 'string' ? candidate.avatarUrl : null,
    }];
  });
}

/** Electron renderer adapter over the existing main-process tracker IPC surface. */
export class ElectronTrackerDataSource implements TrackerDataSource {
  private readonly workspacePath: string;
  private readonly ipc: ElectronTrackerDataSourceIpc;
  private readonly listeners = new Set<(change: TrackerDataChange) => void>();
  private readonly ipcCleanups: Array<() => void> = [];
  private watching = false;
  private disposed = false;
  private syncState: TrackerSyncState;
  private metadataReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadInFlight = false;
  private reloadRequestedWhileInFlight = false;

  constructor(options: ElectronTrackerDataSourceOptions) {
    this.workspacePath = options.workspacePath;
    this.ipc = options.ipc ?? window.electronAPI;
    this.syncState = {
      workspacePath: options.workspacePath,
      status: 'disconnected',
      projectId: null,
    };
  }

  async snapshot(): Promise<TrackerDataSnapshot> {
    this.assertActive();
    const [itemsValue, savedViewsValue, presenceValue, statusValue] = await Promise.all([
      this.ipc.invoke('document-service:tracker-items-list', this.workspacePath),
      this.ipc.invoke('tracker-saved-views:list', this.workspacePath),
      this.ipc.invoke('tracker-sync:get-presence', { workspacePath: this.workspacePath }),
      this.ipc.invoke('tracker-sync:get-status', {
        workspacePath: this.workspacePath,
      }),
    ]);
    this.syncState = this.readSyncState(statusValue);
    return {
      items: Array.isArray(itemsValue) ? (itemsValue as TrackerItem[]) : [],
      savedViews: normalizeSavedViews(savedViewsValue),
      presence: normalizePresence(presenceValue),
      sync: this.syncState,
    };
  }

  subscribe(cb: (change: TrackerDataChange) => void): () => void {
    this.assertActive();
    this.listeners.add(cb);
    this.ensureWatching();
    return () => {
      this.listeners.delete(cb);
    };
  }

  status(): TrackerSyncState {
    return this.syncState;
  }

  /**
   * One exact revision from the local revision log (knowledge-scopes 4.2).
   *
   * The main process answers with a coded failure rather than throwing across
   * IPC (an Error loses its type on the crossing), so the code is re-raised
   * here as `TrackerRevisionUnavailableError`. Every other failure throws a
   * plain Error: only "that revision does not exist" gets the specific type,
   * because only that one means the pinned evidence is gone rather than that
   * the read itself broke.
   *
   * There is deliberately no fallback to the live item.
   */
  async getItemRevision(itemId: string, ref: TrackerRevisionRef): Promise<TrackerItemRevisionRecord> {
    this.assertActive();
    const response = await this.ipc.invoke('tracker-revision:get', {
      workspacePath: this.workspacePath,
      itemId,
      ...ref,
    }) as
      | { success: true; revision: TrackerItemRevisionRecord }
      | { success: false; code?: string; error?: string }
      | undefined;

    if (response?.success) return response.revision;
    if (response?.code === 'revision-not-found') {
      throw new TrackerRevisionUnavailableError(itemId, ref, response.error);
    }
    throw new Error(response?.error ?? `Failed to read revision for tracker item '${itemId}'`);
  }

  async command(command: TrackerDataCommand): Promise<TrackerDataCommandResult> {
    this.assertActive();
    switch (command.type) {
      case 'list-items': {
        const value = await this.ipc.invoke('document-service:tracker-items-list', this.workspacePath);
        return {
          ok: true,
          items: Array.isArray(value) ? (value as TrackerItem[]) : [],
        };
      }
      case 'refresh-items':
        return this.invokeResult('document-service:refresh-workspace');
      case 'create-item':
        return this.invokeResult('document-service:create-tracker-item', command.item);
      case 'update-item':
        return this.invokeResult('document-service:update-tracker-item', command.input);
      case 'update-items':
        return this.invokeResult('document-service:update-tracker-items', command.input);
      case 'archive-item':
        return this.invokeResult('document-service:tracker-item-archive', {
          itemId: command.itemId,
          archive: command.archive,
        });
      case 'delete-item':
        return this.invokeResult('document-service:tracker-item-delete', {
          itemId: command.itemId,
        });
      case 'update-item-content':
        return this.invokeResult('document-service:tracker-item-update-content', {
          itemId: command.itemId,
          content: command.content,
        });
      case 'add-comment':
        return this.invokeResult('document-service:tracker-item-add-comment', {
          itemId: command.itemId,
          body: command.body,
        });
      case 'update-comment':
        return this.invokeResult('document-service:tracker-item-update-comment', {
          itemId: command.itemId,
          commentId: command.commentId,
          ...(command.body === undefined ? {} : { body: command.body }),
          ...(command.deleted === undefined ? {} : { deleted: command.deleted }),
        });
      case 'share-saved-view': {
        const savedViews = normalizeSavedViews(
          await this.ipc.invoke('tracker-saved-views:share', this.workspacePath, command.savedView),
        );
        return { ok: true, savedViews };
      }
      case 'unshare-saved-view': {
        const savedViews = normalizeSavedViews(
          await this.ipc.invoke('tracker-saved-views:unshare', this.workspacePath, command.viewId),
        );
        return { ok: true, savedViews };
      }
      case 'reconnect':
        return this.invokeResult('tracker-sync:connect', {
          workspacePath: this.workspacePath,
        });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.metadataReloadTimer !== null) {
      clearTimeout(this.metadataReloadTimer);
      this.metadataReloadTimer = null;
    }
    this.listeners.clear();
    for (const cleanup of this.ipcCleanups.splice(0)) cleanup();
  }

  private ensureWatching(): void {
    if (this.watching) return;
    this.watching = true;

    this.ipc.send('document-service:tracker-items-watch');
    this.ipc.send('document-service:metadata-watch');
    this.ipcCleanups.push(
      this.ipc.on('document-service:tracker-items-changed', (change: TrackerItemChangeEvent) => {
        const belongsToWorkspace = (item: TrackerItem) => !item.workspace || item.workspace === this.workspacePath;
        const upserted = [...(change?.added ?? []), ...(change?.updated ?? [])].filter(belongsToWorkspace);
        if (upserted.length > 0) this.emit({ type: 'items-upserted', items: upserted });
        if (change?.removed?.length) {
          this.emit({ type: 'items-removed', itemIds: change.removed });
        }
      }),
      this.ipc.on('document-service:metadata-changed', () => {
        this.scheduleMetadataReload();
      }),
      this.ipc.on('tracker-saved-views:changed', (data: { workspacePath?: string }) => {
        if (data?.workspacePath !== this.workspacePath) return;
        void this.reloadSavedViews();
      }),
      this.ipc.on(
        'tracker-sync:status-changed',
        (value: string | { workspacePath: string; status: string; shared?: boolean }) => {
          const eventWorkspace = typeof value === 'string' ? this.workspacePath : value?.workspacePath;
          if (eventWorkspace !== this.workspacePath) return;
          this.syncState = {
            // Spread, so a socket status change does not silently clear a drain
            // hold that is still in force.
            ...this.syncState,
            workspacePath: this.workspacePath,
            status: normalizeStatus(typeof value === 'string' ? value : value.status),
            projectId: typeof value !== 'string' && value.shared ? 'shared' : this.syncState.projectId,
          };
          this.emit({ type: 'status', sync: this.syncState });
        },
      ),
      this.ipc.on('tracker-sync:mutation-rejected', (rejection) => {
        if (rejection) this.emit({ type: 'mutation-rejected', rejection });
      }),
      // The drain refused to touch the team room. The socket is still
      // `connected`, so this cannot ride on `status` (NIM-2968).
      this.ipc.on(
        'tracker-sync:drain-aborted',
        (event: { workspacePath?: string; reason?: string; heldBack?: number }) => {
          if (event?.workspacePath !== this.workspacePath) return;
          this.syncState = {
            ...this.syncState,
            drainHold: {
              reason: event.reason === 'zero-upserts-with-deletes'
                ? 'zero-upserts-with-deletes'
                : 'unresolved-policy-would-delete',
              rowsHeldBack: event.heldBack ?? 0,
            },
          };
          this.emit({ type: 'status', sync: this.syncState });
        },
      ),
      this.ipc.on('tracker-sync:drain-recovered', (event: { workspacePath?: string }) => {
        if (event?.workspacePath !== this.workspacePath) return;
        if (!this.syncState.drainHold) return;
        this.syncState = { ...this.syncState, drainHold: null };
        this.emit({ type: 'status', sync: this.syncState });
      }),
      this.ipc.on('tracker-sync:presence-changed', (data) => {
        if (data?.workspacePath !== this.workspacePath) return;
        this.emit({ type: 'presence', members: normalizePresence(data.members) });
      }),
      this.ipc.on('tracker-sync:config-changed', (data) => {
        if (!data?.workspacePath || !data.config) return;
        this.emit({
          type: 'config-changed',
          workspacePath: data.workspacePath,
          config: data.config,
        });
      }),
    );
  }

  /**
   * `metadata-changed` is the only signal for frontmatter-projected tracker
   * items (they are derived from the metadata cache, not from `tracker_items`),
   * so it has to reload -- but `items-replaced` is the most expensive change
   * this source can emit. The list is a single IPC payload of every item in the
   * workspace (measured at 5,698 items / 27 MB / ~400 ms on the Nimbalyst repo)
   * and the subscribers rebuild every tracker atom and recompute unread across
   * the whole set from it.
   *
   * So: never more than one reload in flight, and collapse a burst into one
   * trailing pass. Editing inside a frontmatter block emits a metadata change
   * per keystroke; without this each one queued its own full reload behind the
   * last and the renderer spent the whole burst blocked.
   */
  private scheduleMetadataReload(): void {
    if (this.disposed) return;
    if (this.metadataReloadTimer !== null) return;
    this.metadataReloadTimer = setTimeout(() => {
      this.metadataReloadTimer = null;
      void this.reloadItems();
    }, METADATA_RELOAD_COALESCE_MS);
  }

  private async reloadItems(): Promise<void> {
    // A reload already running will observe the writes that triggered this one,
    // and a second concurrent fetch of the full list only competes with it for
    // the DB worker and the main thread.
    if (this.reloadInFlight) {
      this.reloadRequestedWhileInFlight = true;
      return;
    }
    this.reloadInFlight = true;
    try {
      const value = await this.ipc.invoke('document-service:tracker-items-list', this.workspacePath);
      if (!this.disposed) {
        this.emit({
          type: 'items-replaced',
          items: Array.isArray(value) ? (value as TrackerItem[]) : [],
        });
      }
    } catch (error) {
      console.error('[ElectronTrackerDataSource] Failed to reload tracker items:', error);
    } finally {
      this.reloadInFlight = false;
      if (this.reloadRequestedWhileInFlight && !this.disposed) {
        this.reloadRequestedWhileInFlight = false;
        this.scheduleMetadataReload();
      } else {
        this.reloadRequestedWhileInFlight = false;
      }
    }
  }

  private async reloadSavedViews(): Promise<void> {
    try {
      const value = await this.ipc.invoke('tracker-saved-views:list', this.workspacePath);
      if (!this.disposed) {
        this.emit({
          type: 'saved-views-replaced',
          savedViews: normalizeSavedViews(value),
        });
      }
    } catch (error) {
      console.error('[ElectronTrackerDataSource] Failed to reload saved views:', error);
    }
  }

  private readSyncState(value: unknown): TrackerSyncState {
    const result = value && typeof value === 'object' ? (value as { status?: unknown; projectId?: unknown }) : {};
    return {
      workspacePath: this.workspacePath,
      status: normalizeStatus(result.status),
      projectId: typeof result.projectId === 'string' ? result.projectId : null,
    };
  }

  private async invokeResult(channel: string, ...args: unknown[]): Promise<TrackerDataCommandResult> {
    return { ok: true, result: await this.ipc.invoke(channel, ...args) };
  }

  private emit(change: TrackerDataChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Tracker data source has been disposed');
  }
}
