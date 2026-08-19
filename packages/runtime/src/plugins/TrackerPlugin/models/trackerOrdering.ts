import type { TrackerRecord } from '../../../core/TrackerRecord';
import { getItemPublicationState } from '../trackerRecordAccessors';
import { resolveDisplayIssueKey } from './localIssueKey';

export const MANUAL_TRACKER_ORDERING = 'manual';
export const MANUAL_TRACKER_ORDER_FIELD = 'kanbanSortOrder';

/** `manual` uses the existing kanban sort key; every other value is a schema field id. */
export type TrackerOrdering = typeof MANUAL_TRACKER_ORDERING | (string & {});

export function normalizeTrackerOrdering(value: unknown): TrackerOrdering {
  return typeof value === 'string' && value.trim() ? value : MANUAL_TRACKER_ORDERING;
}

export function resolveTrackerOrderingField(ordering: TrackerOrdering): string {
  return ordering === MANUAL_TRACKER_ORDERING ? MANUAL_TRACKER_ORDER_FIELD : ordering;
}

/** Viewed timestamps are renderer-local enrichment and are absent in board/timeline inputs. */
function isTrackerOrderingColumnSupported(columnId: string): boolean {
  return columnId !== 'viewed';
}

export function getSupportedTrackerOrderingColumns<T extends { id: string; sortable: boolean }>(
  columns: readonly T[],
): T[] {
  return columns.filter(column => column.sortable && isTrackerOrderingColumnSupported(column.id));
}

export function resolveTrackerOrderingValue(item: TrackerRecord, ordering: TrackerOrdering): unknown {
  const field = resolveTrackerOrderingField(ordering);
  switch (field) {
    case 'type': return item.primaryType;
    // Sort on what the column shows, not on the raw field behind it.
    case 'key':
    case 'issueKey': return resolveDisplayIssueKey(item);
    case 'created': return item.system.createdAt;
    case 'updated':
    case 'lastIndexed': return item.system.lastIndexed ?? item.system.updatedAt;
    case 'module': return item.system.documentPath;
    case 'createdBy': return item.system.authorIdentity;
    case 'updatedBy': return item.system.lastModifiedBy;
    case 'source': return item.source;
    case 'shared': return getItemPublicationState(item);
    default: return item.fields[field];
  }
}
