/**
 * Local-calendar bucketing for the Pulse prototype.
 *
 * Every boundary is built with local `Date` field arithmetic rather than fixed
 * millisecond offsets, so a day that is 23 or 25 hours long across a DST
 * transition still produces exactly one bucket. Buckets are clipped to the
 * caller's range; a bucket whose calendar span reaches outside the range is
 * marked `partial` so the view can refuse period-over-period claims.
 */
import type { PrototypeRange } from '../contracts';

export type PulseBucketUnit = 'day' | 'week' | 'month';

export interface PulseBucket {
  index: number;
  /** Inclusive start, clipped to the requested range. */
  startMs: number;
  /** Inclusive end, clipped to the requested range. */
  endMs: number;
  /** Unclipped local-calendar boundaries. */
  calendarStartMs: number;
  calendarEndMs: number;
  /** True when the calendar span reaches outside the requested range. */
  partial: boolean;
  label: string;
  sublabel: string;
  fullLabel: string;
}

export interface ResolvedBuckets {
  unit: PulseBucketUnit;
  buckets: PulseBucket[];
  /** Set when the requested unit produced too many columns and was widened. */
  escalatedFrom: PulseBucketUnit | null;
}

/** Columns beyond this stop being scannable, so the unit widens instead. */
export const MAX_BUCKETS = 120;

/** Guards a pathological range from spinning the loop before escalation. */
const HARD_CAP = 4000;

const DAY_MS = 86_400_000;

/** Monday-first weeks. Stated in the UI so the grouping is never implicit. */
const WEEK_STARTS_ON = 1;

export function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function startOfLocalWeek(ms: number): number {
  const date = new Date(startOfLocalDay(ms));
  const shift = (date.getDay() - WEEK_STARTS_ON + 7) % 7;
  date.setDate(date.getDate() - shift);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function startOfLocalMonth(ms: number): number {
  const date = new Date(ms);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfBucket(ms: number, unit: PulseBucketUnit): number {
  if (unit === 'day') return startOfLocalDay(ms);
  if (unit === 'week') return startOfLocalWeek(ms);
  return startOfLocalMonth(ms);
}

function nextBucketStart(startMs: number, unit: PulseBucketUnit): number {
  const date = new Date(startMs);
  if (unit === 'day') date.setDate(date.getDate() + 1);
  else if (unit === 'week') date.setDate(date.getDate() + 7);
  else date.setMonth(date.getMonth() + 1);
  // A DST-skip timezone can leave midnight nonexistent; normalizing back to the
  // start of the local day keeps the boundary on the calendar day it names.
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function labelsFor(startMs: number, endMs: number, unit: PulseBucketUnit) {
  const start = new Date(startMs);
  if (unit === 'day') {
    return {
      label: String(start.getDate()),
      sublabel: start.toLocaleDateString(undefined, { weekday: 'narrow' }),
      fullLabel: start.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    };
  }
  if (unit === 'week') {
    const end = new Date(endMs);
    return {
      label: start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      sublabel: 'wk',
      fullLabel: `Week of ${start.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`,
    };
  }
  return {
    label: start.toLocaleDateString(undefined, { month: 'short' }),
    sublabel: String(start.getFullYear()),
    fullLabel: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  };
}

/** Widest unit that still reads as "recent change" for the given span. */
export function autoBucketUnit(range: PrototypeRange): PulseBucketUnit {
  const days = Math.max(1, Math.round((range.endMs - range.startMs) / DAY_MS));
  if (days <= 45) return 'day';
  if (days <= 400) return 'week';
  return 'month';
}

export function buildBuckets(range: PrototypeRange, unit: PulseBucketUnit): PulseBucket[] {
  if (!Number.isFinite(range.startMs) || !Number.isFinite(range.endMs)) return [];
  if (range.endMs < range.startMs) return [];

  const buckets: PulseBucket[] = [];
  let cursor = startOfBucket(range.startMs, unit);
  while (cursor <= range.endMs && buckets.length < HARD_CAP) {
    const nextStart = nextBucketStart(cursor, unit);
    if (nextStart <= cursor) break;
    const calendarEndMs = nextStart - 1;
    buckets.push({
      index: buckets.length,
      calendarStartMs: cursor,
      calendarEndMs,
      startMs: Math.max(cursor, range.startMs),
      endMs: Math.min(calendarEndMs, range.endMs),
      partial: cursor < range.startMs || calendarEndMs > range.endMs,
      ...labelsFor(cursor, calendarEndMs, unit),
    });
    cursor = nextStart;
  }
  return buckets;
}

export function resolveBuckets(
  range: PrototypeRange,
  requested?: PulseBucketUnit | null,
): ResolvedBuckets {
  const preferred = requested ?? autoBucketUnit(range);
  let unit = preferred;
  let buckets = buildBuckets(range, unit);
  let escalatedFrom: PulseBucketUnit | null = null;

  while (buckets.length > MAX_BUCKETS && unit !== 'month') {
    escalatedFrom = escalatedFrom ?? preferred;
    unit = unit === 'day' ? 'week' : 'month';
    buckets = buildBuckets(range, unit);
  }
  return { unit, buckets, escalatedFrom };
}

/**
 * Index of the bucket containing `atMs`, or -1 when it falls outside the
 * clipped range. Binary search, because buckets are variable width.
 */
export function bucketIndexFor(buckets: PulseBucket[], atMs: number): number {
  let low = 0;
  let high = buckets.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const bucket = buckets[mid];
    if (atMs < bucket.calendarStartMs) high = mid - 1;
    else if (atMs > bucket.calendarEndMs) low = mid + 1;
    else return atMs >= bucket.startMs && atMs <= bucket.endMs ? mid : -1;
  }
  return -1;
}

export function bucketRangeLabel(buckets: PulseBucket[], from: number, to: number): string {
  const first = buckets[Math.min(from, to)];
  const last = buckets[Math.max(from, to)];
  if (!first || !last) return '';
  if (first === last) return first.fullLabel;
  return `${first.fullLabel} – ${last.fullLabel}`;
}
