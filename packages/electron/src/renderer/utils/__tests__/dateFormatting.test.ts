import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRelativeTimeCompact, getRelativeTimeString } from '../dateFormatting';

const NOW = new Date('2026-07-17T17:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

describe('relative time formatting', () => {
  it.each([
    [30_000, 'Just now', 'Just now'],
    [33 * 60_000, '33 mins ago', '33 mins'],
    [60 * 60_000, '1 hr ago', '1 hr'],
    [2 * 60 * 60_000, '2 hrs ago', '2 hrs'],
  ])('preserves full wording and only omits ago in compact mode', (offset, full, compact) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const timestamp = NOW.getTime() - offset;
    expect(getRelativeTimeString(timestamp)).toBe(full);
    expect(getRelativeTimeCompact(timestamp)).toBe(compact);
  });
});
