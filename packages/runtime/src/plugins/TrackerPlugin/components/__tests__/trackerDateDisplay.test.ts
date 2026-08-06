// @vitest-environment node

/**
 * A tracker `date` field stores a calendar day (`YYYY-MM-DD`), not an instant.
 * Rendering it through bare `new Date(str)` parses it as UTC midnight, which
 * reads as the previous day west of Greenwich (nimbalyst#1135). These tests run
 * under America/New_York so that shift is observable.
 */

import { afterAll, describe, expect, it } from 'vitest';

const originalTz = process.env.TZ;

// Set at module scope, not in a `beforeAll`: the describe bodies below build
// Date literals while the file is collected, which is before any hook runs. On
// a UTC machine that gave the reference date a different offset than the dates
// built inside the tests.
process.env.TZ = 'America/New_York';

afterAll(() => { process.env.TZ = originalTz; });

describe('tracker date-only display in a behind-UTC timezone', () => {
  it('renders a calendar-day string as the day that was entered', async () => {
    const { formatDateTimeDisplay } = await import('../TrackerFieldEditor');
    expect(formatDateTimeDisplay('2026-07-31').display).toBe('Jul 31, 2026');
  });

  it('still renders a datetime instant in local time', async () => {
    const { formatDateTimeDisplay } = await import('../TrackerFieldEditor');
    // 2026-07-31T02:00Z is 10pm on Jul 30 in New York.
    expect(formatDateTimeDisplay('2026-07-31T02:00:00.000Z').display).toBe('Jul 30, 2026');
  });

  /**
   * Both the detail chips and the table's date column now route through
   * parseDate, so this is the shared contract that keeps them from drifting
   * back to `new Date` independently.
   */
  it('parses a calendar day as local midnight, not UTC midnight', async () => {
    const { parseDate } = await import('../../models/dateUtils');
    const parsed = parseDate('2026-07-31')!;
    expect([parsed.getFullYear(), parsed.getMonth(), parsed.getDate()]).toEqual([2026, 6, 31]);
  });
});

/**
 * The relative formatter used by the grid and table columns. A calendar day is
 * not an instant, so it is compared by local calendar day rather than elapsed
 * milliseconds; without that, "today" at 8pm reads "20h ago" and every future
 * date falls through the `minutes < 1` branch to "Just now" (nimbalyst#1156).
 */
describe('relative tracker date labels around the reported 8pm-ET boundary', () => {
  // Aug 4 2026, 8:00pm in New York -- the moment from the bug report.
  const now = new Date(2026, 7, 4, 20, 0, 0);

  it('labels a date-only field by calendar day in both directions', async () => {
    const { formatTrackerDateCell } = await import('../trackerColumns');
    expect(formatTrackerDateCell('2026-08-04', now).display).toBe('Today');
    expect(formatTrackerDateCell('2026-08-05', now).display).toBe('Tomorrow');
    expect(formatTrackerDateCell('2026-08-03', now).display).toBe('Yesterday');
    expect(formatTrackerDateCell('2026-08-09', now).display).toBe('in 5 days');
    expect(formatTrackerDateCell('2026-07-30', now).display).toBe('5 days ago');
  });

  it('falls back to an absolute date well outside the relative window', async () => {
    const { formatTrackerDateCell } = await import('../trackerColumns');
    expect(formatTrackerDateCell('2026-12-25', now).display).toBe('12/25/2026');
  });

  it('carries the exact date as hover text', async () => {
    const { formatTrackerDateCell } = await import('../trackerColumns');
    expect(formatTrackerDateCell('2026-08-09', now).title).toBe('Sunday, August 9, 2026');
    // A real instant keeps its time of day in the tooltip.
    expect(formatTrackerDateCell('2026-08-09T18:30:00.000Z', now).title)
      .toBe('Aug 9, 2026, 2:30 PM');
  });

  it('keeps elapsed-time labels for genuine timestamps, future included', async () => {
    const { formatRelativeDate } = await import('../trackerColumns');
    expect(formatRelativeDate(new Date(2026, 7, 4, 17, 0, 0), now)).toBe('3h ago');
    expect(formatRelativeDate(new Date(2026, 7, 4, 23, 0, 0), now)).toBe('in 3h');
    expect(formatRelativeDate(new Date(2026, 7, 7, 20, 0, 0), now)).toBe('in 3d');
  });
});
