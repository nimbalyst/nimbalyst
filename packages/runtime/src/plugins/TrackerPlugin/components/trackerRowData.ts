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
import {
  groupTrackerRecordsByAxis,
  normalizeTrackerGroupBy,
  resolveTrackerGroups,
  type TrackerGroupBy,
  type TrackerRelationshipLabelResolver,
} from '../models/trackerGrouping';
import {
  getCellValue,
  getEffectiveUpdatedDate,
  resolveColumnFieldName,
  type TrackerColumnDef,
} from './trackerColumns';

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
    || item.localKey?.toLowerCase().includes(q)
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

function isBlankCell(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function toEpoch(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Compare two raw cell values, preserving the value's real type.
 *
 * Dates are the reason this exists: RevoGrid's built-in comparer stringifies
 * every non-number, so a `Date` column sorts by `"wed may 20 2026"` -- weekday
 * then month *name* -- rather than chronologically. A single date column can
 * also legitimately hold a `Date` (unquoted YAML frontmatter), a `YYYY-MM-DD`
 * string (inline editor) or a full ISO string (JSON round-trip), so a mixed
 * pair is coerced to epoch rather than falling through to a string compare.
 *
 * Empty values sort as "greater", so they land last ascending and first
 * descending -- callers negate the whole result for `desc`.
 */
export function compareCellValues(
  aVal: unknown,
  bVal: unknown,
  render?: string,
): number {
  const aBlank = isBlankCell(aVal);
  const bBlank = isBlankCell(bVal);
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1;
  if (bBlank) return -1;

  if (render === 'date' || aVal instanceof Date || bVal instanceof Date) {
    const aTime = toEpoch(aVal);
    const bTime = toEpoch(bVal);
    if (aTime !== undefined && bTime !== undefined) return aTime - bTime;
  }
  if (typeof aVal === 'number' && typeof bVal === 'number') return aVal - bVal;
  if (typeof aVal === 'boolean' && typeof bVal === 'boolean') {
    return Number(aVal) - Number(bVal);
  }
  return String(aVal).localeCompare(String(bVal));
}

/**
 * Compare two records on a column.
 *
 * Empty values sort as "greater", so they land last ascending and first
 * descending. That is the ordering the table view has always had, and callers
 * negate this result for `desc` -- see {@link sortTrackerRecords}.
 *
 * Pass `columns` when the rows can span types (the "All" view): a role column reads a
 * different field per record, so sorting without them compares the wrong field -- or
 * nothing at all -- for any type that names it differently.
 */
export function compareRecords(
  a: TrackerRecord,
  b: TrackerRecord,
  sortBy: string,
  columns?: TrackerColumnDef[],
): number {
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
      const column = columns?.find(candidate => candidate.id === sortBy);
      const aValue = getCellValue(a, column ? resolveColumnFieldName(a.primaryType, column) : sortBy);
      const bValue = getCellValue(b, column ? resolveColumnFieldName(b.primaryType, column) : sortBy);
      return compareCellValues(aValue, bValue, column?.render);
    }
  }
}

export function sortTrackerRecords(
  records: TrackerRecord[],
  sortBy: string,
  direction: 'asc' | 'desc',
  columns?: TrackerColumnDef[],
): TrackerRecord[] {
  return [...records].sort((a, b) => {
    const compareValue = compareRecords(a, b, sortBy, columns);
    return direction === 'asc' ? compareValue : -compareValue;
  });
}

export interface TrackerRecordGroup {
  key: string;
  label: string | null;
  items: TrackerRecord[];
}

/** Resolve the user-facing bucket name for one record. */
export function getTrackerGroupLabel(
  record: TrackerRecord,
  groupBy: string | null,
  resolveLabel?: TrackerRelationshipLabelResolver,
): string {
  const normalized = normalizeTrackerGroupBy(groupBy);
  if (normalized === 'none') return '';
  return resolveTrackerGroups(record, normalized, resolveLabel).map(group => group.label).join(', ');
}

/**
 * Keep each group's records contiguous while preserving the current sort order
 * within groups and the first-seen order of the groups themselves.
 */
export function groupTrackerRecords(
  records: TrackerRecord[],
  groupBy: TrackerGroupBy | 'owner' | null,
  resolveLabel?: TrackerRelationshipLabelResolver,
): TrackerRecordGroup[] {
  const normalized = normalizeTrackerGroupBy(groupBy);
  if (normalized === 'none') return [{ key: '', label: null, items: records }];
  return groupTrackerRecordsByAxis(records, normalized, resolveLabel);
}
