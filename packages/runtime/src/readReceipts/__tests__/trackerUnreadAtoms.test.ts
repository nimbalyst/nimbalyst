import { describe, expect, it } from 'vitest';
import { createStore } from 'jotai';
import type { TrackerRecord } from '../../core/TrackerRecord';
import {
  applyTrackerReceiptAtom,
  recomputeTrackerUnreadAtom,
  trackerReceiptsAtom,
  trackerUnreadAtom,
  trackerUnreadByWorkspaceAtom,
} from '../trackerUnreadAtoms';
import type { ReadReceipt } from '../readReceipts';

const WS = '/ws';
const ME = 'me@example.com';
const TEAMMATE = 'teammate@example.com';

function record(id: string, updatedAt: string, lastModifiedByEmail: string | null): TrackerRecord {
  return {
    id,
    primaryType: 'bug',
    typeTags: [],
    source: 'native',
    archived: false,
    syncStatus: 'synced',
    system: {
      workspace: WS,
      createdAt: updatedAt,
      updatedAt,
      lastModifiedBy: lastModifiedByEmail
        ? { email: lastModifiedByEmail, displayName: lastModifiedByEmail, gitName: null, gitEmail: null }
        : null,
    },
    fields: {},
  } as TrackerRecord;
}

describe('recomputeTrackerUnreadAtom', () => {
  it('marks a never-viewed teammate-authored item as unread', () => {
    const store = createStore();
    const items = [record('a', '2026-07-07T00:00:00.000Z', TEAMMATE)];
    store.set(recomputeTrackerUnreadAtom, {
      workspace: WS,
      items,
      receipts: new Map(),
      currentEmail: ME,
    });
    expect(store.get(trackerUnreadAtom('a'))).toBe(true);
    expect(store.get(trackerUnreadByWorkspaceAtom).get(WS)?.has('a')).toBe(true);
  });

  it('does not mark the human own edit as unread', () => {
    const store = createStore();
    const items = [record('a', '2026-07-07T00:00:00.000Z', ME)];
    store.set(recomputeTrackerUnreadAtom, {
      workspace: WS,
      items,
      receipts: new Map(),
      currentEmail: ME,
    });
    expect(store.get(trackerUnreadAtom('a'))).toBe(false);
  });

  it('clears unread once the receipt watermark reaches the item version', () => {
    const store = createStore();
    const items = [record('a', '2026-07-07T00:00:00.000Z', TEAMMATE)];
    const viewedMs = Date.parse('2026-07-07T00:00:00.000Z');
    const receipts = new Map<string, ReadReceipt>([
      ['a', { lastSeenVersion: null, lastViewedAt: viewedMs }],
    ]);
    store.set(recomputeTrackerUnreadAtom, {
      workspace: WS,
      items,
      receipts,
      currentEmail: ME,
    });
    expect(store.get(trackerUnreadAtom('a'))).toBe(false);
  });
});

describe('applyTrackerReceiptAtom', () => {
  it('clears the dot and keeps it cleared on the next recompute', () => {
    const store = createStore();
    const updatedAt = '2026-07-07T00:00:00.000Z';
    const items = [record('a', updatedAt, TEAMMATE)];

    // Initially unread.
    store.set(recomputeTrackerUnreadAtom, {
      workspace: WS,
      items,
      receipts: new Map(),
      currentEmail: ME,
    });
    expect(store.get(trackerUnreadAtom('a'))).toBe(true);

    // Mark viewed at the item's watermark.
    const viewedMs = Date.parse(updatedAt);
    store.set(applyTrackerReceiptAtom, {
      itemId: 'a',
      workspace: WS,
      receipt: { lastSeenVersion: null, lastViewedAt: viewedMs },
    });
    expect(store.get(trackerUnreadAtom('a'))).toBe(false);
    expect(store.get(trackerUnreadByWorkspaceAtom).get(WS)).toBeUndefined();

    // A recompute with the persisted receipt (seeded by applyTrackerReceiptAtom)
    // keeps it read.
    store.set(recomputeTrackerUnreadAtom, {
      workspace: WS,
      items,
      receipts: store.get(trackerReceiptsAtom),
      currentEmail: ME,
    });
    expect(store.get(trackerUnreadAtom('a'))).toBe(false);
  });
});
