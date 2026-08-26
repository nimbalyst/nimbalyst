// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { calculateNextRun } from '../scheduleUtils';

describe('calculateNextRun weekly', () => {
  it('treats a scalar days value the same as a single-element list', () => {
    const now = new Date('2026-08-24T00:00:00'); // a Monday
    const scalar = calculateNextRun(
      { type: 'weekly', days: 'mon' as unknown as never, time: '06:00' },
      now,
    );
    const list = calculateNextRun({ type: 'weekly', days: ['mon'], time: '06:00' }, now);

    expect(scalar).not.toBeNull();
    expect(scalar).toEqual(list);
  });

  it('does not throw and returns null when days is missing', () => {
    expect(() =>
      calculateNextRun({ type: 'weekly', days: undefined as unknown as never, time: '06:00' }),
    ).not.toThrow();
  });
});
