/**
 * Shared date derivation and time-axis layout for the tracker timeline.
 *
 * Pure and React-free, because the two things most likely to be wrong here are
 * invisible on screen: which date an item is placed by, and whether a bucket is
 * computed in the user's calendar or in UTC.
 *
 * Three rules worth stating, because they are not obvious from the types:
 *
 *  - **No invented date field.** Placement uses only fields the schemas already
 *    declare -- `startDate` (plan, milestone), `targetDate` (milestone),
 *    `releasedAt` (release), `dueDate` (carried on the legacy item shape) -- plus
 *    any date/datetime field a custom schema declares, and finally the record's
 *    own `system.createdAt`. Nothing new is written or required.
 *  - **The epoch is "no date", not 1970.** `trackerItemToRecord` deliberately
 *    falls back to the epoch for an item with no `created`, so undated
 *    items sort to the bottom instead of churning to "just now". Placing those
 *    at 1970 would stretch every timeline across half a century, so a
 *    non-positive timestamp counts as absent.
 *  - **Every calendar computation is local.** Buckets, keys, and boundaries are
 *    built from `getFullYear`/`getMonth`/`getDate` and `new Date(y, m, d)`, never
 *    from `toISOString`. An item must land on the day the user sees it, and
 *    local-field arithmetic is also what keeps a DST boundary from shifting a
 *    bucket by an hour into the previous day.
 */

import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  globalRegistry,
  groupTrackerRecordsByAxis,
  parseDate,
  type TrackerGroupBy,
  type TrackerOrdering,
  type TrackerRelationshipLabelResolver,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { sortBoardColumnItems } from './trackerBoardColumns';

export type TrackerTimelineGranularity = 'day' | 'week' | 'month';

export interface TrackerTimelineDates {
  start: Date;
  /** Null when the item names an instant rather than a span; drawn as a point. */
  end: Date | null;
  /** Field the start came from -- a schema field name, or `created`. */
  startField: string;
  endField?: string;
}

/**
 * Start-side field names, most specific first. Matched case-insensitively
 * against the item's stored fields.
 */
const START_FIELD_NAMES = ['startdate', 'start', 'startsat'];

/** End-side field names, most specific first. */
const END_FIELD_NAMES = ['targetdate', 'duedate', 'enddate', 'end', 'releasedat', 'completedat'];

/** The synthetic `startField` used when only the record's creation instant places it. */
export const TIMELINE_CREATED_FIELD = 'created';

/**
 * Anything at or before this is the absent-date sentinel, not a date.
 *
 * A whole year rather than the exact epoch: the sentinel is stored as
 * `1970-01-01T00:00:00.000Z`, which `parseDate` reads as a calendar day and so
 * resolves to local midnight -- up to a day either side of the epoch instant. No
 * tracker item is legitimately dated 1970.
 */
const MIN_PLACEABLE_TIME = Date.UTC(1971, 0, 1);

/** A parsed date that actually names a moment, rather than the absent-date sentinel. */
function usableDate(value: unknown): Date | null {
  const parsed = parseDate(value);
  return parsed && parsed.getTime() > MIN_PLACEABLE_TIME ? parsed : null;
}

function firstNamedField(item: TrackerRecord, names: readonly string[]): { field: string; date: Date } | null {
  const byLowerName = new Map(Object.keys(item.fields).map((key) => [key.toLowerCase(), key]));
  for (const name of names) {
    const field = byLowerName.get(name);
    if (!field) continue;
    const date = usableDate(item.fields[field]);
    if (date) return { field, date };
  }
  return null;
}

/**
 * The first date-typed field the item's own schema declares, so a custom type
 * that names its dates something else still places on the timeline.
 *
 * `readOnly` date fields are skipped: `created`/`updated` are declared that way
 * on the builtin plan and decision schemas, but the record converter routes them
 * to `system`, so they are handled by the creation fallback instead.
 */
function firstDeclaredDateField(item: TrackerRecord): { field: string; date: Date } | null {
  const model = globalRegistry.get(item.primaryType);
  for (const field of model?.fields ?? []) {
    if (field.type !== 'date' && field.type !== 'datetime') continue;
    if (field.readOnly) continue;
    const date = usableDate(item.fields[field.name]);
    if (date) return { field: field.name, date };
  }
  return null;
}

/**
 * Where an item sits in time, or null when nothing places it.
 *
 * Preference: a declared start field, then an end-only field (a milestone with
 * only a target date belongs at its target date), then any other date field the
 * type declares, then the record's creation instant.
 */
export interface TrackerTimelineFields { start?: string; end?: string }

function selectedDate(item: TrackerRecord, field: string | undefined): { field: string; date: Date } | null {
  if (!field) return null;
  const date = usableDate(item.fields[field]);
  return date ? { field, date } : null;
}

export function resolveTimelineDates(item: TrackerRecord, fields?: TrackerTimelineFields): TrackerTimelineDates | null {
  const explicit = Boolean(fields?.start || fields?.end);
  const start = explicit ? selectedDate(item, fields?.start) : firstNamedField(item, START_FIELD_NAMES);
  const end = explicit ? selectedDate(item, fields?.end) : firstNamedField(item, END_FIELD_NAMES);

  if (start) {
    // An end at or before the start is contradictory data. Drawing the bar
    // backwards would be a lie about the span, so the item becomes a point.
    const spans = end && end.date.getTime() > start.date.getTime();
    return {
      start: start.date,
      end: spans ? end!.date : null,
      startField: start.field,
      ...(spans ? { endField: end!.field } : {}),
    };
  }
  if (end) return { start: end.date, end: null, startField: end.field };

  if (explicit) return null;
  const declared = firstDeclaredDateField(item);
  if (declared) return { start: declared.date, end: null, startField: declared.field };

  const created = usableDate(item.system.createdAt);
  return created ? { start: created, end: null, startField: TIMELINE_CREATED_FIELD } : null;
}

// ---------------------------------------------------------------------------
// Local-calendar bucketing
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight of the local day containing `date`. */
export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Midnight of the local Sunday that starts the week containing `date`. */
export function startOfLocalWeek(date: Date): Date {
  const day = startOfLocalDay(date);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - day.getDay());
}

export function startOfLocalMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** The start of the bucket `date` falls in, at the given granularity. */
export function timelineBucketStart(date: Date, granularity: TrackerTimelineGranularity): Date {
  switch (granularity) {
    case 'day':
      return startOfLocalDay(date);
    case 'week':
      return startOfLocalWeek(date);
    case 'month':
      return startOfLocalMonth(date);
  }
}

function nextBucketStart(start: Date, granularity: TrackerTimelineGranularity): Date {
  const y = start.getFullYear();
  const m = start.getMonth();
  const d = start.getDate();
  switch (granularity) {
    case 'day':
      return new Date(y, m, d + 1);
    case 'week':
      return new Date(y, m, d + 7);
    case 'month':
      return new Date(y, m + 1, 1);
  }
}

/**
 * Stable identity for the bucket a date falls in.
 *
 * Built from local calendar fields on purpose: an instant late on a local
 * evening is the same day the user is looking at, even when it is already
 * tomorrow in UTC.
 */
export function timelineBucketKey(date: Date, granularity: TrackerTimelineGranularity): string {
  const start = timelineBucketStart(date, granularity);
  const month = String(start.getMonth() + 1).padStart(2, '0');
  const day = String(start.getDate()).padStart(2, '0');
  return `${granularity}:${start.getFullYear()}-${month}-${day}`;
}

/** Coarser buckets as the span widens, so a timeline never draws hundreds of ticks. */
export function resolveTimelineGranularity(spanDays: number): TrackerTimelineGranularity {
  if (spanDays <= 45) return 'day';
  if (spanDays <= 400) return 'week';
  return 'month';
}

export interface TrackerTimelineRange {
  start: Date;
  end: Date;
}

export interface TrackerTimelineBucket {
  key: string;
  label: string;
  start: Date;
  /** Exclusive: the start of the next bucket. */
  end: Date;
}

function bucketLabel(start: Date, granularity: TrackerTimelineGranularity, showYear: boolean): string {
  const options: Intl.DateTimeFormatOptions =
    granularity === 'month' ? { month: 'short' } : { month: 'short', day: 'numeric' };
  if (showYear) options.year = 'numeric';
  return start.toLocaleDateString(undefined, options);
}

/** Every bucket covering `range`, left to right. */
export function buildTimelineBuckets(
  range: TrackerTimelineRange,
  granularity: TrackerTimelineGranularity,
): TrackerTimelineBucket[] {
  const buckets: TrackerTimelineBucket[] = [];
  let cursor = timelineBucketStart(range.start, granularity);
  let previousYear: number | null = null;
  // Bounded independently of the date math so a malformed range can never spin.
  while (cursor.getTime() < range.end.getTime() && buckets.length < 400) {
    const next = nextBucketStart(cursor, granularity);
    const showYear = previousYear !== null && cursor.getFullYear() !== previousYear;
    buckets.push({
      key: timelineBucketKey(cursor, granularity),
      label: bucketLabel(cursor, granularity, showYear || buckets.length === 0),
      start: cursor,
      end: next,
    });
    previousYear = cursor.getFullYear();
    cursor = next;
  }
  return buckets;
}

/** 0..1 position of an instant within the range, clamped to its ends. */
export function resolveTimelineFraction(date: Date, range: TrackerTimelineRange): number {
  const span = range.end.getTime() - range.start.getTime();
  if (span <= 0) return 0;
  const offset = (date.getTime() - range.start.getTime()) / span;
  return Math.min(1, Math.max(0, offset));
}

/** Where "now" sits, or null when the timeline does not cover it. */
export function resolveTodayFraction(now: Date, range: TrackerTimelineRange | null): number | null {
  if (!range) return null;
  const time = now.getTime();
  if (time < range.start.getTime() || time > range.end.getTime()) return null;
  return resolveTimelineFraction(now, range);
}

// ---------------------------------------------------------------------------
// The rendered model
// ---------------------------------------------------------------------------

export interface TrackerTimelineBar {
  item: TrackerRecord;
  dates: TrackerTimelineDates;
  startFraction: number;
  endFraction: number;
}

export interface TrackerTimelineRow {
  key: string;
  label: string;
  bars: TrackerTimelineBar[];
  /** Items in this group that no date places. Shown, never dropped. */
  undated: TrackerRecord[];
}

export interface TrackerTimelineModel {
  granularity: TrackerTimelineGranularity;
  /** Null when nothing in view carries a usable date. */
  range: TrackerTimelineRange | null;
  buckets: TrackerTimelineBucket[];
  rows: TrackerTimelineRow[];
  /** Counts of distinct items, so a multi-milestone item is not counted twice. */
  datedCount: number;
  undatedCount: number;
}

/**
 * The rows, buckets, and bar positions for one view.
 *
 * Rows come from the saved view's grouping axis, so `Group by: Milestone` is a
 * milestone-per-row timeline with no separate feature behind it.
 */
export function buildTrackerTimeline(
  items: TrackerRecord[],
  groupBy: TrackerGroupBy,
  ordering: TrackerOrdering,
  /** Names relationship rows from the referenced record; see the resolver's docs. */
  resolveLabel?: TrackerRelationshipLabelResolver,
  fields?: TrackerTimelineFields,
): TrackerTimelineModel {
  const datesById = new Map<string, TrackerTimelineDates | null>();
  for (const item of items) {
    if (!datesById.has(item.id)) datesById.set(item.id, resolveTimelineDates(item, fields));
  }

  const dated = [...datesById.values()].filter((d): d is TrackerTimelineDates => d !== null);
  const undatedCount = datesById.size - dated.length;

  let range: TrackerTimelineRange | null = null;
  let granularity: TrackerTimelineGranularity = 'week';
  let buckets: TrackerTimelineBucket[] = [];

  if (dated.length > 0) {
    const earliest = Math.min(...dated.map((d) => d.start.getTime()));
    const latest = Math.max(...dated.map((d) => (d.end ?? d.start).getTime()));
    granularity = resolveTimelineGranularity((latest - earliest) / DAY_MS);
    const start = timelineBucketStart(new Date(earliest), granularity);
    // The bucket containing the last date is included whole, so a bar never ends
    // flush against the right edge with nothing to read it against.
    const end = nextBucketStart(timelineBucketStart(new Date(latest), granularity), granularity);
    range = { start, end };
    buckets = buildTimelineBuckets(range, granularity);
  }

  const rows = groupTrackerRecordsByAxis(items, groupBy, resolveLabel).map((group) => {
    const ordered = sortBoardColumnItems(group.items, ordering);
    const bars: TrackerTimelineBar[] = [];
    const undated: TrackerRecord[] = [];
    for (const item of ordered) {
      const dates = datesById.get(item.id) ?? null;
      if (!dates || !range) {
        if (!dates) undated.push(item);
        continue;
      }
      bars.push({
        item,
        dates,
        startFraction: resolveTimelineFraction(dates.start, range),
        endFraction: resolveTimelineFraction(dates.end ?? dates.start, range),
      });
    }
    // Chronological within a row; the view's ordering survives as the tiebreak
    // because the sort above already applied it and Array#sort is stable.
    bars.sort((a, b) => a.dates.start.getTime() - b.dates.start.getTime());
    return { key: group.key, label: group.label, bars, undated };
  });

  return {
    granularity,
    range,
    buckets,
    rows,
    datedCount: dated.length,
    undatedCount,
  };
}
