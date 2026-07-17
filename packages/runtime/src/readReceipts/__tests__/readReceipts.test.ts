import { describe, expect, it } from 'vitest';
import {
  isEntityUnread,
  mergeReceipt,
  receiptAdvances,
  type ReadReceipt,
  type UnreadEntitySnapshot,
} from '../readReceipts';

const ME = 'me@example.com';
const TEAMMATE = 'teammate@example.com';
const AGENT = 'agent:mcp'; // distinct actor id an agent would carry

function snapshot(partial: Partial<UnreadEntitySnapshot> = {}): UnreadEntitySnapshot {
  return {
    currentVersion: 5,
    currentVersionTimestamp: 1000,
    lastChangeActorId: TEAMMATE,
    ...partial,
  };
}

describe('isEntityUnread', () => {
  it('is unread when never viewed (no receipt) and last change was someone else', () => {
    expect(isEntityUnread(snapshot(), null, ME)).toBe(true);
  });

  it('is unread when the version advanced since the receipt', () => {
    const receipt: ReadReceipt = { lastSeenVersion: 4, lastViewedAt: 900 };
    expect(isEntityUnread(snapshot({ currentVersion: 5 }), receipt, ME)).toBe(true);
  });

  it('is NOT unread when the receipt is at the current version', () => {
    const receipt: ReadReceipt = { lastSeenVersion: 5, lastViewedAt: 900 };
    expect(isEntityUnread(snapshot({ currentVersion: 5 }), receipt, ME)).toBe(false);
  });

  it('suppresses the human own most-recent edit even with no receipt', () => {
    expect(isEntityUnread(snapshot({ lastChangeActorId: ME }), null, ME)).toBe(false);
  });

  it('does NOT suppress an agent edit (agent is a distinct actor)', () => {
    // Agent made the last change; current human is ME -> still unread.
    expect(isEntityUnread(snapshot({ lastChangeActorId: AGENT }), null, ME)).toBe(true);
  });

  it('does not suppress when there is no current identity', () => {
    expect(isEntityUnread(snapshot({ lastChangeActorId: ME }), null, null)).toBe(true);
  });

  it('falls back to timestamp when versions are missing', () => {
    const receipt: ReadReceipt = { lastSeenVersion: null, lastViewedAt: 900 };
    expect(
      isEntityUnread(snapshot({ currentVersion: null, currentVersionTimestamp: 1000 }), receipt, ME),
    ).toBe(true);
    expect(
      isEntityUnread(snapshot({ currentVersion: null, currentVersionTimestamp: 800 }), receipt, ME),
    ).toBe(false);
  });
});

describe('mergeReceipt (advance-only)', () => {
  it('returns the incoming when there is no existing receipt', () => {
    const incoming: ReadReceipt = { lastSeenVersion: 3, lastViewedAt: 500 };
    expect(mergeReceipt(null, incoming)).toEqual(incoming);
  });

  it('advances version and viewedAt forward', () => {
    const existing: ReadReceipt = { lastSeenVersion: 3, lastViewedAt: 500 };
    const incoming: ReadReceipt = { lastSeenVersion: 5, lastViewedAt: 900 };
    expect(mergeReceipt(existing, incoming)).toEqual({ lastSeenVersion: 5, lastViewedAt: 900 });
  });

  it('never regresses on a stale incoming receipt', () => {
    const existing: ReadReceipt = { lastSeenVersion: 5, lastViewedAt: 900 };
    const incoming: ReadReceipt = { lastSeenVersion: 3, lastViewedAt: 500 };
    expect(mergeReceipt(existing, incoming)).toEqual({ lastSeenVersion: 5, lastViewedAt: 900 });
  });

  it('keeps the existing version when incoming has none', () => {
    const existing: ReadReceipt = { lastSeenVersion: 5, lastViewedAt: 900 };
    const incoming: ReadReceipt = { lastSeenVersion: null, lastViewedAt: 950 };
    expect(mergeReceipt(existing, incoming)).toEqual({ lastSeenVersion: 5, lastViewedAt: 950 });
  });
});

describe('receiptAdvances', () => {
  it('is true when there is no existing receipt', () => {
    expect(receiptAdvances(null, { lastSeenVersion: 1, lastViewedAt: 1 })).toBe(true);
  });

  it('is false for a stale (regressing) incoming receipt', () => {
    const existing: ReadReceipt = { lastSeenVersion: 5, lastViewedAt: 900 };
    expect(receiptAdvances(existing, { lastSeenVersion: 3, lastViewedAt: 500 })).toBe(false);
  });

  it('is true when only the viewedAt advances', () => {
    const existing: ReadReceipt = { lastSeenVersion: 5, lastViewedAt: 900 };
    expect(receiptAdvances(existing, { lastSeenVersion: 5, lastViewedAt: 950 })).toBe(true);
  });
});
