/**
 * Shared record shaping for tracker table surfaces.
 *
 * `TrackerTable` (the row list) and `TrackerGridView` (RevoGrid) must show the
 * same rows in the same order for the same filters, so the normalize/filter/sort
 * steps live here rather than being re-implemented per surface.
 */

import type { TrackerRecord } from '../../../core/TrackerRecord';
import type { TrackerItemType } from '../../../core/DocumentService';
import {
  getRecordPriority,
  getRecordStatus,
  getRecordTitle,
  getFieldByRole,
} from '../trackerRecordAccessors';
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
    case 'createdBy': {
      const identityValue = (record: TrackerRecord): string => {
        const identity = record.system.authorIdentity;
        return identity?.displayName || identity?.email || identity?.gitEmail || identity?.gitName || '';
      };
      return identityValue(a).localeCompare(identityValue(b));
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

export interface TrackerRecordGroup {
  key: string;
  label: string | null;
  items: TrackerRecord[];
}

function identityLabel(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value ?? '');
  const identity = value as Record<string, unknown>;
  return String(
    identity.displayName
    ?? identity.email
    ?? identity.gitEmail
    ?? identity.gitName
    ?? '',
  );
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
}

/** Resolve the user-facing bucket name for one record. */
export function getTrackerGroupLabel(record: TrackerRecord, groupBy: string | null): string {
  switch (groupBy) {
    case 'status':
      return titleCase(getRecordStatus(record) || 'None');
    case 'priority':
      return titleCase(getRecordPriority(record) || 'None');
    case 'type':
      return titleCase(record.primaryType || 'None');
    case 'owner':
    case 'assignee': {
      const label = identityLabel(getFieldByRole(record, 'assignee'));
      return label || 'Unassigned';
    }
    default: {
      if (!groupBy) return '';
      const value = getCellValue(record, groupBy);
      if (Array.isArray(value)) return value.map(identityLabel).filter(Boolean).join(', ') || 'None';
      return identityLabel(value) || 'None';
    }
  }
}

/**
 * Keep each group's records contiguous while preserving the current sort order
 * within groups and the first-seen order of the groups themselves.
 */
export function groupTrackerRecords(
  records: TrackerRecord[],
  groupBy: string | null,
): TrackerRecordGroup[] {
  if (!groupBy) return [{ key: '', label: null, items: records }];

  const groups = new Map<string, TrackerRecord[]>();
  for (const record of records) {
    const label = getTrackerGroupLabel(record, groupBy);
    const bucket = groups.get(label);
    if (bucket) bucket.push(record);
    else groups.set(label, [record]);
  }
  return Array.from(groups, ([label, items]) => ({ key: label, label, items }));
}
