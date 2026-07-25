/**
 * Shared record shaping for tracker table surfaces.
 *
 * `TrackerTableGrid` (CSS grid) and `TrackerGridView` (RevoGrid) must show the
 * same rows in the same order for the same filters, so the normalize/filter/sort
 * steps live here rather than being re-implemented per surface.
 */

import type { TrackerRecord } from '../../../core/TrackerRecord';
import type { TrackerItemType } from '../../../core/DocumentService';
import { getRecordTitle, getFieldByRole } from '../trackerRecordAccessors';
import { getCellValue, getEffectiveUpdatedDate } from './trackerColumns';

/**
 * Stamp `system.lastIndexed` with the record's effective updated date so
 * sorting by "Updated" matches what the Updated column renders.
 */
export function withEffectiveUpdated(records: TrackerRecord[]): TrackerRecord[] {
  return records.map(item => {
    const actualDate = getEffectiveUpdatedDate(item);
    const lastIndexed = actualDate
      ? actualDate.toISOString()
      : (item.system.lastIndexed || new Date(0).toISOString());
    return { ...item, system: { ...item.system, lastIndexed } };
  });
}

/** Whether a record matches the free-text search box. */
export function searchMatchesRecord(item: TrackerRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const tags = getFieldByRole(item, 'tags');
  return Boolean(
    item.issueKey?.toLowerCase().includes(q)
    || String(item.issueNumber ?? '').includes(q)
    || getRecordTitle(item).toLowerCase().includes(q)
    || (item.system.documentPath ?? '').toLowerCase().includes(q)
    || String(getFieldByRole(item, 'assignee') ?? '').toLowerCase().includes(q)
    || (Array.isArray(tags) && (tags as string[]).some(tag => tag.toLowerCase().includes(q))),
  );
}

export interface TrackerRecordFilter {
  searchTerm?: string;
  typeFilter?: TrackerItemType | 'all';
}

export function filterTrackerRecords(
  records: TrackerRecord[],
  { searchTerm = '', typeFilter = 'all' }: TrackerRecordFilter,
): TrackerRecord[] {
  return records.filter(item => {
    if (!searchMatchesRecord(item, searchTerm)) return false;
    if (typeFilter !== 'all' && item.primaryType !== typeFilter) return false;
    return true;
  });
}

/**
 * Compare two records on a column.
 *
 * Empty values sort as "greater", so they land last ascending and first
 * descending. That is the ordering the table view has always had, and callers
 * negate this result for `desc` -- see {@link sortTrackerRecords}.
 */
export function compareRecords(a: TrackerRecord, b: TrackerRecord, sortBy: string): number {
  switch (sortBy) {
    case 'type':
      return a.primaryType.localeCompare(b.primaryType);
    case 'module':
      return (a.system.documentPath ?? '').localeCompare(b.system.documentPath ?? '');
    case 'lastIndexed': {
      const aTime = a.system.lastIndexed ? new Date(a.system.lastIndexed).getTime() : 0;
      const bTime = b.system.lastIndexed ? new Date(b.system.lastIndexed).getTime() : 0;
      return aTime - bTime;
    }
    default: {
      const aVal = getCellValue(a, sortBy);
      const bVal = getCellValue(b, sortBy);
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      if (aVal instanceof Date && bVal instanceof Date) return aVal.getTime() - bVal.getTime();
      if (typeof aVal === 'number' && typeof bVal === 'number') return aVal - bVal;
      if (typeof aVal === 'boolean' && typeof bVal === 'boolean') {
        return Number(aVal) - Number(bVal);
      }
      return String(aVal).localeCompare(String(bVal));
    }
  }
}

export function sortTrackerRecords(
  records: TrackerRecord[],
  sortBy: string,
  direction: 'asc' | 'desc',
): TrackerRecord[] {
  return [...records].sort((a, b) => {
    const compareValue = compareRecords(a, b, sortBy);
    return direction === 'asc' ? compareValue : -compareValue;
  });
}
