/**
 * Typed pages and table rows of the Local wiki, as tracker records.
 *
 * The type resolver, type tables and relationship pickers all read
 * `trackerItemsMapAtom`, which main fills from the app database. A Local wiki
 * item is a file (or a CSV row) that main never stores, so this adapter turns
 * the library's items into records with `source: 'local-wiki'` and merges them
 * into the same map; `trackerSyncListeners` merges them back after each full
 * replace. Such a record must never reach a database, sync or share write:
 * `isLocalWikiRecord` is the check every write path makes, and
 * `localWikiItemUpdate` is where their edits go instead (Tracker mode's writes
 * are in `localWikiTrackerWrites`).
 *
 * The library stores a relationship as bare ids; here each value is enriched to
 * `{ itemId, title, trackerType }` the way the UI expects, and an edit is
 * stored back as ids.
 */
import { store } from '@nimbalyst/runtime/store';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import { normalizeRelationshipValue, type TrackerRecord } from '@nimbalyst/tracker-core';
import type { LocalPage, LocalTrackerItem, LocalTrackerSnapshot } from '@nimbalyst/local-wiki';

export const LOCAL_WIKI_SOURCE = 'local-wiki' as const;

/** Records of each workspace's wiki, by id, as last merged. */
const recordsByWorkspace = new Map<string, Map<string, TrackerRecord>>();

export function isLocalWikiRecord(record: Pick<TrackerRecord, 'source'> | null | undefined): boolean {
  return record?.source === LOCAL_WIKI_SOURCE;
}

/** Whether an item id names a Local wiki record in the window's tracker map. */
export function isLocalWikiItemId(itemId: string): boolean {
  return isLocalWikiRecord(store.get(trackerItemsMapAtom).get(itemId));
}

function relationshipFieldNames(typeId: string): { name: string; multi: boolean }[] {
  const model = globalRegistry.get(typeId);
  return (model?.fields ?? [])
    .filter((field) => field.type === 'relationship' || field.type === 'reference')
    .map((field) => ({ name: field.name, multi: field.multiValue === true || field.type === 'reference' }));
}

function toIso(millis: number): string {
  return new Date(Number.isFinite(millis) && millis > 0 ? millis : 0).toISOString();
}

function joinPath(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${relative}`;
}

interface Draft {
  id: string;
  type: string;
  title: string;
  fields: Record<string, unknown>;
  path: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The library's items, as records; relationships enriched against `known` and each other. */
export function buildLocalWikiRecords(
  workspacePath: string,
  root: string,
  pages: readonly LocalPage[],
  tables: readonly LocalTrackerSnapshot[],
  known: ReadonlyMap<string, TrackerRecord>,
): TrackerRecord[] {
  const drafts: Draft[] = [];
  for (const page of pages) {
    if (!page.type || page.trashedAt !== null || page.malformed) continue;
    drafts.push({ id: page.id, type: page.type, title: page.title, fields: page.fields, path: page.path, createdAt: page.createdAt, updatedAt: page.updatedAt });
  }
  for (const table of tables) {
    for (const item of table.items as LocalTrackerItem[]) {
      drafts.push({ id: item.id, type: item.type, title: item.title, fields: item.fields, path: item.path, createdAt: item.createdAt, updatedAt: item.updatedAt });
    }
  }
  const titleOf = new Map<string, { title: string; type: string }>();
  for (const draft of drafts) titleOf.set(draft.id, { title: draft.title, type: draft.type });
  const describe = (itemId: string) => {
    const local = titleOf.get(itemId);
    if (local) return local;
    const other = known.get(itemId);
    return other ? { title: String(other.fields.title ?? ''), type: other.primaryType, issueKey: other.issueKey } : null;
  };

  return drafts.map((draft) => {
    const fields: Record<string, unknown> = { ...draft.fields, title: draft.title };
    for (const { name } of relationshipFieldNames(draft.type)) {
      if (fields[name] === undefined || fields[name] === null || fields[name] === '') continue;
      fields[name] = normalizeRelationshipValue(fields[name]).map((value) => {
        const target = describe(value.itemId);
        return {
          ...value,
          ...(target?.title ? { title: target.title } : {}),
          ...(target?.type ? { trackerType: target.type } : {}),
          ...(target && 'issueKey' in target && target.issueKey ? { issueKey: target.issueKey } : {}),
        };
      });
    }
    return {
      id: draft.id,
      primaryType: draft.type,
      typeTags: [draft.type],
      source: LOCAL_WIKI_SOURCE,
      archived: false,
      syncStatus: 'local',
      system: {
        workspace: workspacePath,
        ...(draft.path ? { documentPath: joinPath(root, draft.path) } : {}),
        createdAt: toIso(draft.createdAt),
        updatedAt: toIso(draft.updatedAt),
      },
      fields,
    } satisfies TrackerRecord;
  });
}

/**
 * The project the tracker map currently shows, set by `remergeLocalWikiRecords`.
 * Only its wiki records belong in the map; another open project's are kept
 * here until it becomes active. Null until the tracker listener knows it.
 */
let activeWorkspacePath: string | null = null;

/** Replaces this workspace's Local wiki records (in the tracker map only while it is the active project). */
export function mergeLocalWikiRecords(workspacePath: string, records: readonly TrackerRecord[]): void {
  const previous = recordsByWorkspace.get(workspacePath) ?? new Map<string, TrackerRecord>();
  const next = new Map(records.map((record) => [record.id, record]));
  recordsByWorkspace.set(workspacePath, next);
  if (activeWorkspacePath !== null && workspacePath !== activeWorkspacePath) return;
  const map = new Map(store.get(trackerItemsMapAtom));
  for (const id of previous.keys()) {
    if (!next.has(id) && isLocalWikiRecord(map.get(id))) map.delete(id);
  }
  for (const [id, record] of next) {
    // A database item with the same id (an exported page's twin) keeps its row.
    const existing = map.get(id);
    if (existing && !isLocalWikiRecord(existing)) continue;
    map.set(id, record);
  }
  store.set(trackerItemsMapAtom, map);
}

/**
 * After a project switch or a full replace of the tracker map from main: drop
 * every other project's wiki records and put the active project's back. A
 * record left from the previous project would show in this one, and editing it
 * would write to the previous project's files.
 */
export function remergeLocalWikiRecords(workspacePath: string | null): void {
  activeWorkspacePath = workspacePath;
  const current = store.get(trackerItemsMapAtom);
  const foreign = [...current].filter(([, record]) => isLocalWikiRecord(record) && record.system.workspace !== workspacePath);
  if (foreign.length > 0) {
    const map = new Map(current);
    for (const [id] of foreign) map.delete(id);
    store.set(trackerItemsMapAtom, map);
  }
  const records = workspacePath ? recordsByWorkspace.get(workspacePath) : undefined;
  if (workspacePath && records) mergeLocalWikiRecords(workspacePath, [...records.values()]);
}

/** The markdown file of a Local wiki typed page, or null for any other item (or a table row). */
export function localWikiFilePathForItem(itemId: string): string | null {
  const record = store.get(trackerItemsMapAtom).get(itemId);
  const filePath = isLocalWikiRecord(record) ? record?.system.documentPath : undefined;
  return filePath && filePath.endsWith('.md') ? filePath : null;
}

/** Field updates for the library: relationship values go back to bare ids. */
export function localWikiItemUpdate(record: TrackerRecord, updates: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...updates };
  for (const { name, multi } of relationshipFieldNames(record.primaryType)) {
    if (!(name in out)) continue;
    const ids = normalizeRelationshipValue(out[name]).map((value) => value.itemId);
    out[name] = ids.length === 0 ? null : multi ? ids : ids[0];
  }
  return out;
}

/** Sends a Local wiki record's field edit to the library. */
export async function updateLocalWikiItem(workspacePath: string, record: TrackerRecord, updates: Record<string, unknown>): Promise<void> {
  await window.electronAPI.invoke('local-wiki:tracker-command', workspacePath, record.primaryType, {
    type: 'update-item',
    input: { itemId: record.id, updates: localWikiItemUpdate(record, updates) },
  });
}

/**
 * Types placed in the Local wiki by this window. Placing a type writes
 * `storage:` into its YAML, but the registry learns that only when the schema
 * watcher reloads the file; an item created in between must still be a file.
 */
const placedWikiTypes = new Set<string>();

export function markPlacedLocalWikiType(typeId: string): void {
  placedWikiTypes.add(typeId);
}

/** Whether new items of this type are Local wiki files (its YAML declares `storage`, or it was just placed). */
export function isLocalWikiType(typeId: string): boolean {
  return placedWikiTypes.has(typeId) || Boolean(globalRegistry.get(typeId)?.storage);
}

/** Creates an item of a wiki type as a file (a page, or a table row) through the library. */
export async function createLocalWikiItem(
  workspacePath: string,
  input: { id: string; type: string; title: string; fields?: Record<string, unknown>; body?: string },
): Promise<{ success: true; id: string }> {
  const fields = Object.fromEntries(Object.entries(input.fields ?? {})
    .filter(([key, value]) => key !== 'title' && value !== undefined && value !== null && value !== ''));
  const result = await window.electronAPI.invoke('local-wiki:tracker-command', workspacePath, input.type, {
    type: 'create-item',
    item: { id: input.id, title: input.title, fields, ...(input.body ? { body: input.body } : {}) },
  }) as { id?: string };
  return { success: true, id: result?.id ?? input.id };
}

type CreateTrackerItem = typeof window.electronAPI.documentService.createTrackerItem;

/**
 * The one create call for every renderer surface (Decision 9): an item of a
 * wiki type becomes a file in the Local wiki, any other a row in the app
 * database. Only fields the type declares reach the file, so the payload's
 * default status and priority are not written into a type without them.
 */
export async function createTrackerItem(payload: Parameters<CreateTrackerItem>[0]): ReturnType<CreateTrackerItem> {
  if (!isLocalWikiType(payload.type)) return window.electronAPI.documentService.createTrackerItem(payload);
  const declared = new Set((globalRegistry.get(payload.type)?.fields ?? []).map((field) => field.name));
  const topLevel = { status: payload.status, priority: payload.priority, owner: payload.owner, tags: payload.tags, description: payload.description };
  const created = await createLocalWikiItem(payload.workspace, {
    id: payload.id,
    type: payload.type,
    title: payload.title,
    fields: { ...Object.fromEntries(Object.entries(topLevel).filter(([name]) => declared.has(name))), ...payload.customFields },
    body: payload.content,
  });
  return { success: true, item: { id: created.id, type: payload.type, title: payload.title } };
}
