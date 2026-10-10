/**
 * Shared record shaping for tracker table surfaces.
 *
 * `TrackerTable` (the row list) and `TrackerGridView` (RevoGrid) must show the
 * same rows in the same order for the same filters, so the normalize/filter/sort
 * steps live here rather than being re-implemented per surface.
 */
import type { TrackerRecord } from '../../../core/TrackerRecord';
import type { TrackerItemType } from '../../../core/DocumentService';
import { type TrackerGroupBy, type TrackerRelationshipLabelResolver } from '../models/trackerGrouping';
import { type TrackerColumnDef } from './trackerColumns';
/**
 * Stamp `system.lastIndexed` with the record's effective updated date so
 * sorting by "Updated" matches what the Updated column renders.
 */
export declare function withEffectiveUpdated(records: TrackerRecord[]): TrackerRecord[];
/** Whether a record matches the free-text search box. */
export declare function searchMatchesRecord(item: TrackerRecord, query: string): boolean;
export interface TrackerRecordFilter {
    searchTerm?: string;
    typeFilter?: TrackerItemType | 'all';
}
export declare function filterTrackerRecords(records: TrackerRecord[], { searchTerm, typeFilter }: TrackerRecordFilter): TrackerRecord[];
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
export declare function compareCellValues(aVal: unknown, bVal: unknown, render?: string): number;
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
export declare function compareRecords(a: TrackerRecord, b: TrackerRecord, sortBy: string, columns?: TrackerColumnDef[]): number;
export declare function sortTrackerRecords(records: TrackerRecord[], sortBy: string, direction: 'asc' | 'desc', columns?: TrackerColumnDef[]): TrackerRecord[];
export interface TrackerRecordGroup {
    key: string;
    label: string | null;
    items: TrackerRecord[];
}
/** Resolve the user-facing bucket name for one record. */
export declare function getTrackerGroupLabel(record: TrackerRecord, groupBy: TrackerGroupBy | string | null, resolveLabel?: TrackerRelationshipLabelResolver): string;
/**
 * Keep each group's records contiguous while preserving the current sort order
 * within groups and the first-seen order of the groups themselves.
 */
export declare function groupTrackerRecords(records: TrackerRecord[], groupBy: TrackerGroupBy | 'owner' | null, resolveLabel?: TrackerRelationshipLabelResolver): TrackerRecordGroup[];
