// @vitest-environment node

/**
 * A tracker `date` field stores a calendar day (`YYYY-MM-DD`), not an instant.
 * Rendering it through bare `new Date(str)` parses it as UTC midnight, which
 * reads as the previous day west of Greenwich (nimbalyst#1135). These tests run
 * under America/New_York so that shift is observable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const originalTz = process.env.TZ;

beforeAll(() => { process.env.TZ = 'America/New_York'; });
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
