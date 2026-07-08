import { describe, expect, it } from 'vitest';
import { createStore } from 'jotai';
import {
  applyDocReceiptAtom,
  docReceiptsAtom,
  docUnreadAtom,
  docUnreadByOrgAtom,
  recomputeDocUnreadAtom,
} from '../docUnread';
import type { SharedDocument } from '../collabDocuments';
import type { ReadReceipt } from '@nimbalyst/runtime/readReceipts/readReceipts';

const ORG = 'org-1';
const ME = 'member-me';
const TEAMMATE = 'member-teammate';

function doc(documentId: string, updatedAt: number, lastWriterUserId: string | null): SharedDocument {
  return {
    documentId,
    title: documentId,
    documentType: 'markdown',
    createdBy: TEAMMATE,
    createdAt: 0,
    updatedAt,
    lastWriterUserId,
  };
}

describe('recomputeDocUnreadAtom', () => {
  it('marks a never-viewed teammate-written doc as unread', () => {
    const store = createStore();
    store.set(recomputeDocUnreadAtom, {
      orgId: ORG,
      docs: [doc('d1', 1000, TEAMMATE)],
      receipts: new Map(),
      currentUserId: ME,
    });
    expect(store.get(docUnreadAtom('d1'))).toBe(true);
    expect(store.get(docUnreadByOrgAtom).get(ORG)?.has('d1')).toBe(true);
  });

  it('suppresses the user own most-recent edit', () => {
    const store = createStore();
    store.set(recomputeDocUnreadAtom, {
      orgId: ORG,
      docs: [doc('d1', 1000, ME)],
      receipts: new Map(),
      currentUserId: ME,
    });
    expect(store.get(docUnreadAtom('d1'))).toBe(false);
  });

  it('is read once the receipt watermark reaches the doc updatedAt', () => {
    const store = createStore();
    const receipts = new Map<string, ReadReceipt>([
      ['d1', { lastSeenVersion: null, lastViewedAt: 1000 }],
    ]);
    store.set(recomputeDocUnreadAtom, {
      orgId: ORG,
      docs: [doc('d1', 1000, TEAMMATE)],
      receipts,
      currentUserId: ME,
    });
    expect(store.get(docUnreadAtom('d1'))).toBe(false);
  });
});

describe('applyDocReceiptAtom', () => {
  it('clears the dot and keeps it cleared on the next recompute', () => {
    const store = createStore();
    const docs = [doc('d1', 1000, TEAMMATE)];

    store.set(recomputeDocUnreadAtom, {
      orgId: ORG,
      docs,
      receipts: new Map(),
      currentUserId: ME,
    });
    expect(store.get(docUnreadAtom('d1'))).toBe(true);

    store.set(applyDocReceiptAtom, {
      documentId: 'd1',
      orgId: ORG,
      receipt: { lastSeenVersion: null, lastViewedAt: 1000 },
    });
    expect(store.get(docUnreadAtom('d1'))).toBe(false);

    store.set(recomputeDocUnreadAtom, {
      orgId: ORG,
      docs,
      receipts: store.get(docReceiptsAtom),
      currentUserId: ME,
    });
    expect(store.get(docUnreadAtom('d1'))).toBe(false);
  });
});
