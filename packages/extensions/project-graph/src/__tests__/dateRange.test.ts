// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { dateRangeFromInputs, formatDateInput, recentDateRange, recentHoursRange, timeSpansOverlap } from '../timeline/dateRange';
import { buildRulerTicks } from '../components/TimelineRuler';
import { fitPxPerDay, keepMostRecentRows } from '../components/TimelineView';

const HOUR = 60 * 60 * 1000;

describe('timeline date ranges', () => {
  it('turns date inputs into an inclusive local-day range', () => {
    const range = dateRangeFromInputs('2026-08-01', '2026-08-02');

    expect(range).not.toBeNull();
    expect(formatDateInput(range!.startMs)).toBe('2026-08-01');
    expect(formatDateInput(range!.endMs)).toBe('2026-08-02');
    expect(dateRangeFromInputs('2026-08-03', '2026-08-02')).toBeNull();
  });

  it('includes work whose lifecycle overlaps the selected range', () => {
    const range = { startMs: 100, endMs: 200 };

    expect(timeSpansOverlap(50, 100, range)).toBe(true);
    expect(timeSpansOverlap(150, 250, range)).toBe(true);
    expect(timeSpansOverlap(50, 250, range)).toBe(true);
    expect(timeSpansOverlap(1, 99, range)).toBe(false);
    expect(timeSpansOverlap(201, 300, range)).toBe(false);
  });

  it('builds presets from complete local calendar days', () => {
    const now = new Date(2026, 7, 2, 12, 0, 0).getTime();
    const range = recentDateRange(7, now);

    expect(formatDateInput(range.startMs)).toBe('2026-07-27');
    expect(formatDateInput(range.endMs)).toBe('2026-08-02');
  });

  it('builds the 24-hour preset as a rolling window ending now', () => {
    const now = new Date(2026, 7, 2, 12, 30, 0).getTime();
    expect(recentHoursRange(24, now)).toEqual({ startMs: now - 24 * HOUR, endMs: now });
  });

  it('fits a 24-hour range to the full viewport width', () => {
    // 1400px viewport minus the label gutter; one day must not be capped narrow.
    const pxd = fitPxPerDay(24 * HOUR, 1400);
    expect(pxd).toBeGreaterThan(1000);
  });

  it('keeps the most recently started rows when over the row cap', () => {
    // Long-open backlog items overlap every window; they must not crowd out today's work.
    const rows = [1, 2, 3, 4, 5].map(start => ({ start }));
    expect(keepMostRecentRows(rows, 3).map(r => r.start)).toEqual([3, 4, 5]);
    expect(keepMostRecentRows(rows, 10)).toBe(rows);
  });

  it('labels a 24-hour ruler in hours, marking midnight with the date', () => {
    const start = new Date(2026, 7, 1, 12, 30, 0).getTime();
    const ticks = buildRulerTicks(start, start + 24 * HOUR, fitPxPerDay(24 * HOUR, 1400));

    expect(ticks.length).toBeGreaterThanOrEqual(8);
    expect(ticks.every(t => t.x >= 0)).toBe(true);
    expect(ticks.length).toBeLessThanOrEqual(25);
    const midnight = ticks.find(t => new Date(t.ms).getHours() === 0)!;
    expect(midnight.major).toBe(true);
    expect(midnight.label).toMatch(/Aug/);
    const afternoon = ticks.find(t => new Date(t.ms).getHours() === 18)!;
    expect(afternoon.major).toBe(false);
    expect(afternoon.label).not.toMatch(/Aug/);
  });
});
