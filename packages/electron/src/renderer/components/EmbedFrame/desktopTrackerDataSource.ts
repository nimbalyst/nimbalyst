/**
 * The `TrackerDataSource` a saved-view embed (`nimbalyst://view/<id>`) reads on desktop.
 *
 * Reads come from the renderer's tracker atoms, which already hold every local
 * and synced item of the window's workspace (the tracker listeners keep them
 * current), so an embed adds no second full item load or IPC subscription.
 * Saved views come from the same place Tracker mode lists them: the project's
 * personal views and the team's shared ones.
 * Writes and revision reads go to the existing IPC data source, which routes
 * them through the same main-process mutations every tracker surface uses; a
 * team item's write reaches its room the way it does from the tracker table.
 *
 * `status()` answers for the read model, not a socket: `connected` once the
 * atoms have loaded, so a reference to an item that does not exist resolves to
 * "missing" rather than "loading" forever in a local project.
 *
 * Every edit made in the embed goes through `command`, so this is where
 * desktop's write rules are applied:
 *  - a file-backed item's fields go to its source file, as the tracker detail
 *    pane writes them, not to the database row the next scan would overwrite;
 *  - each item is written in its own type's lane, whatever lane the caller
 *    assumed;
 *  - a write the main process refused (`{ success: false }` inside an `ok`
 *    IPC answer) is thrown, so no consumer mistakes it for a saved change;
 *  - a Local wiki item (`source: 'local-wiki'`) and a new item of a wiki type
 *    (one whose YAML declares `storage`) go to the wiki library, never to the
 *    database or a room.
 */

import type {
  TrackerBatchUpdateInput,
  TrackerDataChange,
  TrackerDataCommand,
  TrackerDataCommandResult,
  TrackerDataSnapshot,
  TrackerDataSource,
  TrackerItem,
  TrackerSyncState,
} from '@nimbalyst/collab-client/trackers';
import { trackerRecordToItem, type TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry, type TrackerDataModelRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { trackerDataLoadedAtom, trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import type { store as runtimeStore } from '@nimbalyst/runtime/store';
import { serializeSharedSavedView, type TrackerSavedViewRecord } from '@nimbalyst/collab-client/trackers';
import { allTrackerSavedViewsAtom } from '../../store/atoms/trackers';
import { isLocalWikiRecord, isLocalWikiType, localWikiItemUpdate } from '../../services/localWikiTrackerRecords';

type JotaiStore = typeof runtimeStore;

export interface DesktopTrackerDataSourceOptions {
  workspacePath: string;
  store: JotaiStore;
  /** Where commands and revision reads go: the IPC data source. */
  writer: Pick<TrackerDataSource, 'command' | 'getItemRevision'>;
  /** The tracker IPC, for the source-file write the IPC data source has no command for. */
  ipc?: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
  registry?: TrackerDataModelRegistry;
}

/** One conversion per record object; an unchanged record keeps its item. */
const itemCache = new WeakMap<TrackerRecord, TrackerItem>();
function toItem(record: TrackerRecord): TrackerItem {
  let item = itemCache.get(record);
  if (!item) {
    item = trackerRecordToItem(record) as TrackerItem;
    itemCache.set(record, item);
  }
  return item;
}

const FILE_BACKED_SOURCES = new Set(['frontmatter', 'import', 'inline']);

type SourceLike = { source?: string; system?: { documentPath?: string } } | null | undefined;

/** Fields of a file-backed record with a document are written to that document (the tracker detail pane's rule). */
function isFileBackedRecord(record: SourceLike): boolean {
  return Boolean(record?.source && FILE_BACKED_SOURCES.has(record.source) && record.system?.documentPath);
}

/** An inline marker (`#type[...]`) cannot hold a link value; its links are edited in its document. */
function canWriteLinks(record: SourceLike): boolean {
  return !(record?.source === 'inline' && isFileBackedRecord(record));
}

function refusal(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const answer = result as { success?: unknown; error?: unknown; results?: Array<{ success?: unknown; error?: unknown }> };
  if (answer.success !== false) return null;
  // A batch answers per item; the first refused item says why.
  const error = answer.results?.find((entry) => entry.success === false)?.error ?? answer.error;
  return typeof error === 'string' && error ? error : 'The change was not saved';
}

/** Board order is never item content, so it stays in the store even for a file-backed item. */
const SORT_ORDER_FIELD = 'kanbanSortOrder';

/** The records that differ between two maps, by identity. */
function diffTrackerRecordMaps(
  previous: ReadonlyMap<string, TrackerRecord>,
  next: ReadonlyMap<string, TrackerRecord>,
): { upserted: TrackerRecord[]; removed: string[] } {
  const upserted: TrackerRecord[] = [];
  const removed: string[] = [];
  for (const [id, record] of next) if (previous.get(id) !== record) upserted.push(record);
  for (const id of previous.keys()) if (!next.has(id)) removed.push(id);
  return { upserted, removed };
}

export function createDesktopTrackerDataSource({
  workspacePath,
  store,
  writer,
  ipc,
  registry = globalRegistry,
}: DesktopTrackerDataSourceOptions): TrackerDataSource {
  const listeners = new Set<(change: TrackerDataChange) => void>();

  /** The lane a type's schema writes in; the caller's guess only when the schema is not loaded. */
  const laneOf = (type: string | undefined, hint: 'personal' | 'team' | undefined) => {
    const model = type ? registry.get(type) : undefined;
    return model ? model.sharing ?? 'personal' : hint;
  };

  const assertLinksWritable = (record: TrackerRecord | undefined, itemId: string, updates: Record<string, unknown>) => {
    if (!isFileBackedRecord(record) || canWriteLinks(record)) return;
    const fields = registry.get(record!.primaryType)?.fields ?? [];
    if (Object.keys(updates).some((name) => fields.find((field) => field.name === name)?.type === 'relationship')) {
      throw new Error(`Links on "${record!.fields.title ?? itemId}" are kept in ${record!.system.documentPath}; edit them there.`);
    }
  };

  /** A view's cell edits: each entry routed the way `update-item` routes one item, sent as one call. */
  const dispatchBatch = async (input: TrackerBatchUpdateInput): Promise<TrackerDataCommandResult> => {
    const items = store.get(trackerItemsMapAtom);
    const entries = input.entries.map((entry) => {
      const record = items.get(entry.itemId);
      const model = record ? registry.get(record.primaryType) : undefined;
      const lane = { sharing: laneOf(record?.primaryType, entry.sharing), draftByDefault: model?.draftByDefault ?? entry.draftByDefault ?? false };
      if (!isFileBackedRecord(record) || !entry.storeUpdates) return { ...entry, ...lane };
      const { [SORT_ORDER_FIELD]: sortOrder, ...fields } = entry.storeUpdates;
      assertLinksWritable(record, entry.itemId, fields);
      return {
        itemId: entry.itemId,
        ...(Object.keys(fields).length > 0 || entry.fileUpdates ? { fileUpdates: { ...entry.fileUpdates, ...fields } } : {}),
        ...(sortOrder !== undefined ? { storeUpdates: { [SORT_ORDER_FIELD]: sortOrder } } : {}),
        ...lane,
      };
    });
    const outcome = await writer.command({ type: 'update-items', input: { entries } });
    if (!refusal(outcome.result)) {
      const invoker = ipc ?? window.electronAPI;
      void invoker.invoke('document-service:tracker-item-reindex-relationships', { itemIds: entries.map((entry) => entry.itemId) }).catch(() => {});
    }
    return outcome;
  };

  /** A Local wiki item's command, sent to the library; null for anything else. */
  const dispatchLocalWiki = async (command: TrackerDataCommand): Promise<TrackerDataCommandResult | null> => {
    const send = async (typeId: string, libraryCommand: unknown) => ({
      ok: true as const,
      result: { success: true, ...(await (ipc ?? window.electronAPI).invoke('local-wiki:tracker-command', workspacePath, typeId, libraryCommand) as object) },
    });
    if (command.type === 'create-item') {
      if (!registry.get(command.item.type)?.storage && !isLocalWikiType(command.item.type)) return null;
      const { title, status, priority, owner, tags, description, customFields } = command.item;
      const fields = Object.fromEntries(Object.entries({ status, priority, owner, tags, description, ...customFields })
        .filter(([, value]) => value !== undefined && value !== null && value !== ''));
      return send(command.item.type, { type: 'create-item', item: { id: command.item.id, title, fields } });
    }
    const itemId = command.type === 'update-item' ? command.input.itemId
      : command.type === 'delete-item' || command.type === 'archive-item' || command.type === 'update-item-content' ? command.itemId
        : null;
    const record = itemId ? store.get(trackerItemsMapAtom).get(itemId) : undefined;
    if (!record || !isLocalWikiRecord(record)) return null;
    if (command.type === 'update-item') {
      return send(record.primaryType, { type: 'update-item', input: { itemId: record.id, updates: localWikiItemUpdate(record, command.input.updates) } });
    }
    if (command.type === 'delete-item') return send(record.primaryType, { type: 'delete-item', itemId: record.id });
    throw new Error(`"${record.fields.title ?? record.id}" is a file in the Local wiki; open it to change ${command.type === 'archive-item' ? 'whether it is archived' : 'its text'}.`);
  };

  const dispatch = async (command: TrackerDataCommand): Promise<TrackerDataCommandResult> => {
    const local = await dispatchLocalWiki(command);
    if (local) return local;
    if (command.type === 'update-items' && command.input.entries.some((entry) => isLocalWikiRecord(store.get(trackerItemsMapAtom).get(entry.itemId)))) {
      // One by one: wiki items go to the library, the rest to the database in one call.
      const items = store.get(trackerItemsMapAtom);
      const [wiki, rest] = [command.input.entries.filter((entry) => isLocalWikiRecord(items.get(entry.itemId))), command.input.entries.filter((entry) => !isLocalWikiRecord(items.get(entry.itemId)))];
      for (const entry of wiki) {
        await dispatchLocalWiki({ type: 'update-item', input: { itemId: entry.itemId, updates: { ...entry.fileUpdates, ...entry.storeUpdates } } as never });
      }
      if (rest.length > 0) return dispatchBatch({ ...command.input, entries: rest });
      return { ok: true, result: { success: true } };
    }
    if (command.type === 'create-item') {
      const sharing = laneOf(command.item.type, command.item.sharing);
      return writer.command({ ...command, item: { ...command.item, ...(sharing ? { sharing } : {}) } });
    }
    if (command.type === 'update-items') return dispatchBatch(command.input);
    if (command.type !== 'update-item') return writer.command(command);

    const { itemId, updates } = command.input;
    const record = store.get(trackerItemsMapAtom).get(itemId);
    if (isFileBackedRecord(record)) {
      assertLinksWritable(record, itemId, updates);
      const invoker = ipc ?? window.electronAPI;
      const result = await invoker.invoke('document-service:tracker-item-update-in-file', { itemId, updates });
      // The tracker detail pane refreshes backlinks after a file write too.
      if (!refusal(result)) void invoker.invoke('document-service:tracker-item-reindex-relationships', { itemId }).catch(() => {});
      return { ok: true, result };
    }
    const sharing = laneOf(record?.primaryType, command.input.sharing);
    return writer.command({ ...command, input: { ...command.input, ...(sharing ? { sharing } : {}) } });
  };
  let unsubscribeAtoms: (() => void) | null = null;
  let seen: ReadonlyMap<string, TrackerRecord> = store.get(trackerItemsMapAtom);

  // The project's personal and team views, in the shared-row shape the store parses.
  const savedViews = (): TrackerSavedViewRecord[] =>
    store.get(allTrackerSavedViewsAtom).map((view) => ({ viewId: view.id, payload: serializeSharedSavedView(view) }));

  const status = (): TrackerSyncState => ({
    workspacePath,
    status: store.get(trackerDataLoadedAtom) ? 'connected' : 'connecting',
    projectId: null,
  });
  const emit = (change: TrackerDataChange) => {
    for (const listener of [...listeners]) listener(change);
  };

  const watch = () => {
    if (unsubscribeAtoms) return;
    seen = store.get(trackerItemsMapAtom);
    const offItems = store.sub(trackerItemsMapAtom, () => {
      const next = store.get(trackerItemsMapAtom);
      const { upserted, removed } = diffTrackerRecordMaps(seen, next);
      seen = next;
      if (upserted.length > 0) emit({ type: 'items-upserted', items: upserted.map(toItem) });
      if (removed.length > 0) emit({ type: 'items-removed', itemIds: removed });
    });
    const offLoaded = store.sub(trackerDataLoadedAtom, () => emit({ type: 'status', sync: status() }));
    const offViews = store.sub(allTrackerSavedViewsAtom, () => emit({ type: 'saved-views-replaced', savedViews: savedViews() }));
    unsubscribeAtoms = () => {
      offItems();
      offLoaded();
      offViews();
    };
  };

  return {
    async snapshot(): Promise<TrackerDataSnapshot> {
      const records = store.get(trackerItemsMapAtom);
      return { items: [...records.values()].map(toItem), savedViews: savedViews(), presence: [], sync: status() };
    },
    subscribe(listener) {
      listeners.add(listener);
      watch();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeAtoms?.();
          unsubscribeAtoms = null;
        }
      };
    },
    status,
    async command(command) {
      const outcome = await dispatch(command);
      const refused = refusal(outcome.result);
      if (refused) throw new Error(refused);
      return outcome;
    },
    getItemRevision(itemId, ref) {
      return writer.getItemRevision(itemId, ref);
    },
    // Only releases the atom subscription. It holds no other resource, and
    // staying usable afterwards is what lets a development double-mount (which
    // stops and restarts the provider's store) subscribe again.
    dispose() {
      listeners.clear();
      unsubscribeAtoms?.();
      unsubscribeAtoms = null;
    },
  };
}
