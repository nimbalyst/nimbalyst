/**
 * Every typed item in the local wiki (typed pages and table rows of every
 * type) as one tracker data source, over `nim wiki serve`. The tracker UI
 * (type tables, typed pages, the tree's type resolver) reads it through
 * `TrackersUIProvider`.
 *
 * There are no saved views, presence, comments or revisions here: the file
 * format has none of them.
 */
import {
  TrackerRevisionsUnsupportedError,
  type TrackerDataChange,
  type TrackerDataCommand,
  type TrackerDataCommandResult,
  type TrackerDataSnapshot,
  type TrackerDataSource,
  type TrackerItem,
  type TrackerSyncState,
} from '@nimbalyst/collab-bundle/trackers-ui';
import type { LocalTrackerItem } from '@nimbalyst/local-wiki';
import { wikiApi, wikiChanges, type WikiTypeInfo } from '../api/client';
import { toStoredUpdates, toTrackerItem, type ItemLookup } from './trackerItems';

const ok = (result: Record<string, unknown> = { success: true }): TrackerDataCommandResult => ({ ok: true, result });

export class LocalTrackerDataSource implements TrackerDataSource {
  private readonly listeners = new Set<(change: TrackerDataChange) => void>();
  private readonly sync: TrackerSyncState;
  private types = new Map<string, WikiTypeInfo>();
  private items: TrackerItem[] = [];
  private feedUnsubscribe: (() => void) | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private refreshQueued = false;
  private disposed = false;

  constructor(readonly workspace: string, types: readonly WikiTypeInfo[]) {
    this.sync = { workspacePath: workspace, projectId: workspace, status: 'connected', access: null };
    this.setTypes(types);
  }

  setTypes(types: readonly WikiTypeInfo[]): void {
    this.types = new Map(types.map((type) => [type.typeId, type]));
  }

  typeInfo(typeId: string): WikiTypeInfo | undefined {
    return this.types.get(typeId);
  }

  /** Every wiki type, by plural name. */
  allTypes(): WikiTypeInfo[] {
    return [...this.types.values()].sort((a, b) => a.displayNamePlural.localeCompare(b.displayNamePlural));
  }

  private async load(): Promise<TrackerItem[]> {
    const snapshots = await Promise.all([...this.types.keys()].map((typeId) => wikiApi.trackerSnapshot(typeId)));
    const all: LocalTrackerItem[] = snapshots.flatMap((snapshot) => snapshot.items);
    // Relationship targets are looked up across every type, so a field pointing
    // at another type's item shows that item's title.
    const lookup: ItemLookup = new Map(all.map((item) => [item.id, { title: item.title, type: item.type }]));
    this.items = all.map((item) => toTrackerItem(item, this.types.get(item.type), lookup, this.workspace));
    return this.items;
  }

  async snapshot(): Promise<TrackerDataSnapshot> {
    return { items: await this.load(), savedViews: [], presence: [], sync: this.sync };
  }

  subscribe(cb: (change: TrackerDataChange) => void): () => void {
    this.listeners.add(cb);
    if (!this.feedUnsubscribe && !this.disposed) {
      this.feedUnsubscribe = wikiChanges.subscribe((event) => {
        if (event.type !== 'down') void this.refresh();
      });
    }
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) {
        this.feedUnsubscribe?.();
        this.feedUnsubscribe = null;
      }
    };
  }

  private typeOf(itemId: string): string {
    const item = this.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error(`No item ${itemId} in the local wiki`);
    return item.type;
  }

  async command(command: TrackerDataCommand): Promise<TrackerDataCommandResult> {
    switch (command.type) {
      case 'list-items':
      case 'refresh-items':
        await this.refresh();
        return { ok: true, items: this.items };
      case 'reconnect':
        return ok();
      case 'create-item': {
        const { item } = command;
        const def = this.types.get(item.type);
        const fields = toStoredUpdates({ ...(item.customFields ?? {}), ...(item.status ? { status: item.status } : {}), ...(item.priority ? { priority: item.priority } : {}), ...(item.tags?.length ? { tags: item.tags } : {}) }, def);
        if (def?.storage === 'table') fields[def.titleField] = item.title;
        const result = await wikiApi.trackerCommand(item.type, { type: 'create-item', item: { id: item.id, title: item.title, fields } });
        await this.refresh();
        return ok({ success: true, id: result.id });
      }
      case 'update-item': {
        const typeId = this.typeOf(command.input.itemId);
        await wikiApi.trackerCommand(typeId, {
          type: 'update-item',
          input: { itemId: command.input.itemId, updates: toStoredUpdates(command.input.updates, this.types.get(typeId)) },
        });
        await this.refresh();
        return ok();
      }
      case 'update-items': {
        for (const entry of command.input.entries) {
          const typeId = this.typeOf(entry.itemId);
          const updates = { ...(entry.fileUpdates ?? {}), ...(entry.storeUpdates ?? {}) };
          await wikiApi.trackerCommand(typeId, { type: 'update-item', input: { itemId: entry.itemId, updates: toStoredUpdates(updates, this.types.get(typeId)) } });
        }
        await this.refresh();
        return ok();
      }
      // Archiving and deleting both move the item to the wiki's trash, from which it can be restored.
      case 'archive-item':
        if (!command.archive) return ok({ success: false, error: 'Restore it from the trash instead' });
        return this.trash(command.itemId);
      case 'delete-item':
        return this.trash(command.itemId);
      case 'update-item-content':
        return ok({ success: false, error: 'A typed page body is saved through its editor' });
      case 'add-comment':
      case 'update-comment':
        return ok({ success: false, error: 'Local wiki items have no comments' });
      case 'share-saved-view':
      case 'unshare-saved-view':
        return ok({ success: false, error: 'Saved views are not stored in the local wiki' });
      default:
        throw new Error(`Unsupported tracker command: ${(command as { type?: string }).type}`);
    }
  }

  private async trash(itemId: string): Promise<TrackerDataCommandResult> {
    await wikiApi.trackerCommand(this.typeOf(itemId), { type: 'delete-item', itemId });
    await this.refresh();
    return ok();
  }

  status(): TrackerSyncState {
    return this.sync;
  }

  async getItemRevision(): Promise<never> {
    throw new TrackerRevisionsUnsupportedError('The local wiki');
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.feedUnsubscribe?.();
    this.feedUnsubscribe = null;
  }

  /** One read at a time; a change during a read schedules one more. */
  refresh(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }
    this.refreshInFlight = (async () => {
      try {
        do {
          this.refreshQueued = false;
          const items = await this.load();
          if (this.disposed) return;
          for (const listener of this.listeners) listener({ type: 'items-replaced', items });
        } while (this.refreshQueued && !this.disposed);
      } catch (error) {
        console.error('[wiki-web] Failed to refresh tracker items:', error);
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }
}
