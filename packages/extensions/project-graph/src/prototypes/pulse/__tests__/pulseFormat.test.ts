// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { formatRelative } from '../pulseFormat';

/**
 * "Yesterday" is a calendar word. Counting 24-hour spans instead of local
 * calendar days puts an event from 11pm last night under "today" for the first
 * hour of the morning, and shifts every label by a day for part of a
 * DST-transition week.
 */
describe('formatRelative', () => {
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h, 0, 0, 0).getTime();

  it('names the calendar day, not the number of elapsed 24-hour spans', () => {
    // 21 hours apart, but two different calendar days.
    expect(formatRelative(at(2026, 8, 3, 23), at(2026, 8, 4, 20))).toBe('yesterday');
    // 23 hours apart, same calendar day.
    expect(formatRelative(at(2026, 8, 4, 0), at(2026, 8, 4, 23))).toBe('today');
    expect(formatRelative(at(2026, 8, 1), at(2026, 8, 4))).toBe('3d ago');
  });

  it('counts a short and a long DST day as exactly one day each', () => {
    // US spring forward, 2026-03-08: that local day is 23 hours long.
    expect(formatRelative(at(2026, 2, 7, 22), at(2026, 2, 8, 10))).toBe('yesterday');
    // US fall back, 2026-11-01: that local day is 25 hours long.
    expect(formatRelative(at(2026, 9, 31, 22), at(2026, 10, 1, 10))).toBe('yesterday');
    expect(formatRelative(at(2026, 2, 1), at(2026, 2, 15))).toBe('14d ago');
  });

  it('reports a stamp ahead of now rather than inventing a negative day count', () => {
    expect(formatRelative(at(2026, 8, 5), at(2026, 8, 4))).toBe('ahead of now');
  });
});
