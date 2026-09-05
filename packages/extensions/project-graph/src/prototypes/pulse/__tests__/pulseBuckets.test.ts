// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  autoBucketUnit,
  buildBuckets,
  bucketIndexFor,
  resolveBuckets,
  startOfLocalWeek,
} from '../pulseBuckets';

const HOUR = 3_600_000;

/**
 * Bucketing is local-calendar arithmetic, so the interesting failure -- a naive
 * `+86400000` step -- only shows up in a timezone that observes DST. Node
 * re-reads `process.env.TZ` for subsequent Date operations; when that does not
 * take effect the DST-specific expectations are skipped and the
 * timezone-independent invariants below still cover the rest.
 */
const originalTz = process.env.TZ;
let observesDst = false;

beforeAll(() => {
  process.env.TZ = 'America/New_York';
  observesDst =
    new Date(2026, 0, 15).getTimezoneOffset() !== new Date(2026, 6, 15).getTimezoneOffset();
});

afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

function localRange(
  start: [number, number, number],
  end: [number, number, number],
) {
  const startMs = new Date(start[0], start[1], start[2], 0, 0, 0, 0).getTime();
  const endMs = new Date(end[0], end[1], end[2], 23, 59, 59, 999).getTime();
  return { startMs, endMs };
}

describe('pulse day bucketing', () => {
  it('emits one bucket per calendar day even when the day is not 24 hours', () => {
    // 2026 US transitions: spring forward Mar 8, fall back Nov 1.
    const spring = buildBuckets(localRange([2026, 2, 6], [2026, 2, 10]), 'day');
    expect(spring).toHaveLength(5);

    const gaps = spring.map((bucket) => (bucket.calendarEndMs + 1 - bucket.calendarStartMs) / HOUR);
    expect(gaps.every((hours) => hours === 23 || hours === 24 || hours === 25)).toBe(true);
    expect(spring.map((bucket) => new Date(bucket.calendarStartMs).getDate())).toEqual([
      6, 7, 8, 9, 10,
    ]);
    expect(spring.every((bucket) => new Date(bucket.calendarStartMs).getHours() === 0)).toBe(true);

    if (observesDst) {
      expect(gaps[2]).toBe(23);
      const fall = buildBuckets(localRange([2026, 10, 1], [2026, 10, 2]), 'day');
      expect((fall[0].calendarEndMs + 1 - fall[0].calendarStartMs) / HOUR).toBe(25);
    }
  });

  it('leaves no seam between consecutive buckets', () => {
    const buckets = buildBuckets(localRange([2026, 2, 1], [2026, 3, 15]), 'day');
    for (let index = 1; index < buckets.length; index += 1) {
      expect(buckets[index].calendarStartMs).toBe(buckets[index - 1].calendarEndMs + 1);
    }
  });

  it('clips edge buckets to the requested range and marks them partial', () => {
    const startMs = new Date(2026, 8, 1, 14, 30, 0, 0).getTime();
    const endMs = new Date(2026, 8, 3, 9, 0, 0, 0).getTime();
    const buckets = buildBuckets({ startMs, endMs }, 'day');

    expect(buckets).toHaveLength(3);
    expect(buckets[0].startMs).toBe(startMs);
    expect(buckets[0].partial).toBe(true);
    expect(buckets[1].partial).toBe(false);
    expect(buckets[2].endMs).toBe(endMs);
    expect(buckets[2].partial).toBe(true);
  });

  it('returns nothing for an inverted or non-finite range', () => {
    expect(buildBuckets({ startMs: 200, endMs: 100 }, 'day')).toEqual([]);
    expect(buildBuckets({ startMs: Number.NaN, endMs: 100 }, 'day')).toEqual([]);
  });
});

describe('pulse week and month bucketing', () => {
  it('starts weeks on Monday', () => {
    const wednesday = new Date(2026, 8, 2, 11, 0, 0, 0).getTime();
    const weekStart = new Date(startOfLocalWeek(wednesday));
    expect(weekStart.getDay()).toBe(1);
    expect(weekStart.getDate()).toBe(31);
    expect(weekStart.getHours()).toBe(0);
  });

  it('groups a quarter into calendar months of unequal length', () => {
    const buckets = buildBuckets(localRange([2026, 0, 1], [2026, 2, 31]), 'month');
    expect(buckets).toHaveLength(3);
    expect(buckets.map((bucket) => new Date(bucket.calendarStartMs).getMonth())).toEqual([0, 1, 2]);
    expect(buckets.every((bucket) => new Date(bucket.calendarStartMs).getDate() === 1)).toBe(true);
  });
});

describe('bucket unit resolution', () => {
  it('picks a unit that stays scannable for the span', () => {
    expect(autoBucketUnit(localRange([2026, 8, 1], [2026, 8, 7]))).toBe('day');
    expect(autoBucketUnit(localRange([2026, 5, 1], [2026, 8, 1]))).toBe('week');
    expect(autoBucketUnit(localRange([2022, 0, 1], [2026, 0, 1]))).toBe('month');
  });

  it('widens a requested unit that would produce too many columns', () => {
    const year = localRange([2025, 8, 1], [2026, 8, 1]);
    const widened = resolveBuckets(year, 'day');
    expect(widened.unit).toBe('week');
    expect(widened.escalatedFrom).toBe('day');
    expect(widened.buckets.length).toBeLessThanOrEqual(120);

    const fiveYears = resolveBuckets(localRange([2021, 0, 1], [2026, 0, 1]), 'day');
    expect(fiveYears.unit).toBe('month');
    expect(fiveYears.escalatedFrom).toBe('day');
  });

  it('honours an explicit unit that fits and reports no escalation', () => {
    const resolved = resolveBuckets(localRange([2026, 8, 1], [2026, 8, 7]), 'week');
    expect(resolved.unit).toBe('week');
    expect(resolved.escalatedFrom).toBeNull();
  });
});

describe('bucketIndexFor', () => {
  const startMs = new Date(2026, 8, 1, 12, 0, 0, 0).getTime();
  const endMs = new Date(2026, 8, 4, 23, 59, 59, 999).getTime();
  const buckets = buildBuckets({ startMs, endMs }, 'day');

  it('locates a timestamp inside the clipped range', () => {
    expect(bucketIndexFor(buckets, new Date(2026, 8, 3, 8, 0, 0, 0).getTime())).toBe(2);
    expect(bucketIndexFor(buckets, startMs)).toBe(0);
    expect(bucketIndexFor(buckets, endMs)).toBe(3);
  });

  it('rejects a timestamp inside the calendar day but outside the range', () => {
    // Same calendar day as bucket 0, but before the range begins.
    expect(bucketIndexFor(buckets, new Date(2026, 8, 1, 6, 0, 0, 0).getTime())).toBe(-1);
    expect(bucketIndexFor(buckets, new Date(2026, 8, 9, 6, 0, 0, 0).getTime())).toBe(-1);
  });
});
