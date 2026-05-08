import { describe, expect, it } from 'vitest';
import { formatTurnFinishedAt } from '../dateUtils';

describe('formatTurnFinishedAt', () => {
  it('shows only the time for turns that ended earlier today', () => {
    const turnEndedAt = new Date(2026, 4, 6, 10, 33, 0);
    const reference = new Date(2026, 4, 6, 16, 0, 0);

    expect(formatTurnFinishedAt(turnEndedAt, reference)).toBe('at 10:33 am');
  });

  it('omits the finish timestamp for turns that ended within the last five minutes', () => {
    const turnEndedAt = new Date(2026, 4, 6, 10, 33, 0);
    const reference = new Date(2026, 4, 6, 10, 38, 0);

    expect(formatTurnFinishedAt(turnEndedAt, reference)).toBe('');
  });

  it('shows the full date for turns that ended on a prior day', () => {
    const turnEndedAt = new Date(2026, 4, 5, 10, 33, 0);
    const reference = new Date(2026, 4, 6, 16, 0, 0);

    expect(formatTurnFinishedAt(turnEndedAt, reference)).toBe('at 10:33 am, Tue May 5th, 2026');
  });

  it('formats ordinal suffixes correctly for teen dates', () => {
    const turnEndedAt = new Date(2026, 4, 13, 10, 33, 0);
    const reference = new Date(2026, 4, 14, 16, 0, 0);

    expect(formatTurnFinishedAt(turnEndedAt, reference)).toBe('at 10:33 am, Wed May 13th, 2026');
  });
});
