// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { dateRangeFromInputs, formatDateInput, recentDateRange, timeSpansOverlap } from '../timeline/dateRange';

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
});
