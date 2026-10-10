/**
 * The single write path for editing tracker fields from a UI surface.
 *
 * File-backed records (frontmatter, imports, inline blocks) round-trip through
 * the document so the file stays the source of truth; everything else writes to
 * the tracker store directly. Both paths then reindex relationships.
 *
 * `kanbanSortOrder` is the one field that never belongs to a source file -- it
 * is board state, not item content -- so it always takes the store path even
 * when the rest of the update goes to a document.
 *
 * `saveTrackerFieldsBatch` is the same routing for many items, sent as ONE IPC
 * call plus one reindex call. A bulk milestone assign over fifty cards would
 * otherwise be a hundred renderer-to-main round trips.
 */

import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { isLocalWikiRecord } from '../../services/localWikiTrackerRecords';
import { saveLocalWikiItemFields } from '../../services/localWikiTrackerWrites';

const FILE_BACKED_SOURCES = new Set(['frontmatter', 'import', 'inline']);

const SORT_ORDER_FIELD = 'kanbanSortOrder';

/** One item's routed writes: to its source file, to the store, or both. */
interface RoutedTrackerWrite {
  itemId: string;
  /** Field updates for the item's source file, when it is file-backed. */
  fileUpdates?: Record<string, unknown>;
  /** Field updates for the tracker store. */
  storeUpdates?: Record<string, unknown>;
  sharing: 'personal' | 'team';
  draftByDefault: boolean;
}

/**
 * Split one item's updates the way `saveTrackerFields` does: content fields
 * follow the item's source, board state always goes to the store.
 */
function routeTrackerWrite(
  item: TrackerRecord,
  updates: Record<string, unknown>,
): RoutedTrackerWrite {
  const { [SORT_ORDER_FIELD]: sortOrder, ...fieldUpdates } = updates;
  const tracker = globalRegistry.get(item.primaryType);
  const fileBacked = FILE_BACKED_SOURCES.has(item.source) && Boolean(item.system.documentPath);
  const hasFieldUpdates = Object.keys(fieldUpdates).length > 0;

  const storeUpdates: Record<string, unknown> = {};
  if (hasFieldUpdates && !fileBacked) Object.assign(storeUpdates, fieldUpdates);
  if (sortOrder !== undefined) storeUpdates[SORT_ORDER_FIELD] = sortOrder;

  return {
    itemId: item.id,
    ...(hasFieldUpdates && fileBacked ? { fileUpdates: fieldUpdates } : {}),
    ...(Object.keys(storeUpdates).length > 0 ? { storeUpdates } : {}),
    sharing: tracker?.sharing ?? 'personal',
    draftByDefault: tracker?.draftByDefault ?? false,
  };
}

export async function saveTrackerField(
  item: TrackerRecord,
  fieldName: string,
  value: unknown,
): Promise<void> {
  return saveTrackerFields(item, { [fieldName]: value });
}

export async function saveTrackerFields(
  item: TrackerRecord,
  updates: Record<string, unknown>,
): Promise<void> {
  if (isLocalWikiRecord(item)) {
    // A Local wiki item is a file: the wiki library writes it.
    await saveLocalWikiItemFields(item, updates);
    return;
  }
  const routed = routeTrackerWrite(item, updates);

  try {
    if (routed.fileUpdates) {
      await window.electronAPI.documentService.updateTrackerItemInFile({
        itemId: routed.itemId,
        updates: routed.fileUpdates,
      });
    }
    if (routed.storeUpdates) {
      await window.electronAPI.documentService.updateTrackerItem({
        itemId: routed.itemId,
        updates: routed.storeUpdates,
        sharing: routed.sharing,
        draftByDefault: routed.draftByDefault,
      });
    }

    window.electronAPI
      .invoke('document-service:tracker-item-reindex-relationships', { itemId: item.id })
      .catch(() => {});
  } catch (error) {
    console.error('[trackerFieldSave] Failed to save field:', error);
  }
}

export interface TrackerBatchSaveEntry {
  item: TrackerRecord;
  updates: Record<string, unknown>;
}

export interface TrackerBatchSaveResult {
  /** Items main reported as written. */
  written: number;
  /** Items main reported as failed, plus the whole batch when the call throws. */
  failed: number;
}

/**
 * Write many items' fields in one round trip.
 *
 * The per-item work in main (file rewrite or row update, sync, inverse
 * propagation) is unavoidable -- each item owns its own frontmatter -- but the
 * renderer pays for exactly two IPC calls no matter how many items are in the
 * batch: one update, one relationship reindex.
 */
export async function saveTrackerFieldsBatch(
  entries: readonly TrackerBatchSaveEntry[],
): Promise<TrackerBatchSaveResult> {
  let wikiWritten = 0;
  let wikiFailed = 0;
  for (const entry of entries) {
    if (!isLocalWikiRecord(entry.item)) continue;
    if (await saveLocalWikiItemFields(entry.item, entry.updates)) wikiWritten += 1;
    else wikiFailed += 1;
  }
  const routed = entries
    .filter(entry => !isLocalWikiRecord(entry.item))
    .map(entry => routeTrackerWrite(entry.item, entry.updates))
    .filter(entry => entry.fileUpdates || entry.storeUpdates);
  if (routed.length === 0) return { written: wikiWritten, failed: wikiFailed };

  try {
    const result = await window.electronAPI.documentService.updateTrackerItems({
      entries: routed.map(entry => ({
        itemId: entry.itemId,
        fileUpdates: entry.fileUpdates,
        storeUpdates: entry.storeUpdates,
        sharing: entry.sharing,
        draftByDefault: entry.draftByDefault,
      })),
    });

    const failed = (result.results ?? []).filter(item => !item.success).length;

    window.electronAPI
      .invoke('document-service:tracker-item-reindex-relationships', {
        itemIds: routed.map(entry => entry.itemId),
      })
      .catch(() => {});

    return { written: wikiWritten + routed.length - failed, failed: wikiFailed + failed };
  } catch (error) {
    console.error('[trackerFieldSave] Failed to save a batch of fields:', error);
    return { written: wikiWritten, failed: wikiFailed + routed.length };
  }
}
