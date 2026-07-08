import { describe, expect, it } from 'vitest';
import { isEntityUnread } from '@nimbalyst/runtime/readReceipts/readReceipts';
import type { ReadReceipt } from '@nimbalyst/runtime/readReceipts/readReceipts';
import {
  classifyChangedDocs,
  selectFavoriteDocs,
  selectRecentDocs,
} from '../collabDiscovery';
import { docSnapshot } from '../docUnread';
import type { SharedDocument } from '../collabDocuments';

const ME = 'member-me';
const TEAMMATE = 'member-teammate';

function doc(documentId: string, updatedAt: number, lastWriterUserId: string | null = TEAMMATE): SharedDocument {
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

/** Build the injected unread resolver the way changedSharedDocsAtom does. */
function makeUnreadFn(receipts: Map<string, ReadReceipt>, currentUserId: string | null) {
  return (d: SharedDocument) => {
    const receipt = receipts.get(d.documentId) ?? null;
    return {
      unread: isEntityUnread(docSnapshot(d), receipt, currentUserId),
      hasReceipt: receipt !== null,
    };
  };
}

describe('classifyChangedDocs', () => {
  it('classifies a never-viewed teammate doc as "new"', () => {
    const docs = [doc('d1', 1000)];
    const result = classifyChangedDocs(docs, makeUnreadFn(new Map(), ME));
    expect(result).toEqual([{ doc: docs[0], freshness: 'new' }]);
  });

  it('classifies a viewed-then-changed doc as "updated"', () => {
    const docs = [doc('d1', 2000)];
    const receipts = new Map<string, ReadReceipt>([
      ['d1', { lastSeenVersion: null, lastViewedAt: 1000 }],
    ]);
    const result = classifyChangedDocs(docs, makeUnreadFn(receipts, ME));
    expect(result).toEqual([{ doc: docs[0], freshness: 'updated' }]);
  });

  it('excludes a seen doc at the updatedAt === lastViewedAt boundary', () => {
    const docs = [doc('d1', 1000)];
    const receipts = new Map<string, ReadReceipt>([
      ['d1', { lastSeenVersion: null, lastViewedAt: 1000 }],
    ]);
    const result = classifyChangedDocs(docs, makeUnreadFn(receipts, ME));
    expect(result).toEqual([]);
  });

  it('suppresses the user\'s own latest edit (not unread)', () => {
    const docs = [doc('d1', 1000, ME)];
    const result = classifyChangedDocs(docs, makeUnreadFn(new Map(), ME));
    expect(result).toEqual([]);
  });

  it('skips decrypt-failed docs', () => {
    const locked = { ...doc('d1', 1000), decryptFailed: true };
    const result = classifyChangedDocs([locked], makeUnreadFn(new Map(), ME));
    expect(result).toEqual([]);
  });

  it('sorts changed docs most-recently-updated first', () => {
    const docs = [doc('a', 100), doc('b', 300), doc('c', 200)];
    const result = classifyChangedDocs(docs, makeUnreadFn(new Map(), ME));
    expect(result.map((r) => r.doc.documentId)).toEqual(['b', 'c', 'a']);
  });
});

describe('selectRecentDocs', () => {
  it('orders by lastViewedAt desc and excludes never-viewed', () => {
    const docs = [doc('a', 0), doc('b', 0), doc('c', 0)];
    const receipts = new Map<string, { lastViewedAt: number }>([
      ['a', { lastViewedAt: 100 }],
      ['c', { lastViewedAt: 300 }],
      // 'b' never viewed → excluded
    ]);
    const result = selectRecentDocs(docs, receipts);
    expect(result.map((d) => d.documentId)).toEqual(['c', 'a']);
  });

  it('caps at the requested limit', () => {
    const docs = [doc('a', 0), doc('b', 0), doc('c', 0)];
    const receipts = new Map<string, { lastViewedAt: number }>([
      ['a', { lastViewedAt: 1 }],
      ['b', { lastViewedAt: 2 }],
      ['c', { lastViewedAt: 3 }],
    ]);
    expect(selectRecentDocs(docs, receipts, 2).map((d) => d.documentId)).toEqual(['c', 'b']);
  });
});

describe('selectFavoriteDocs', () => {
  it('returns docs in favorite order, ignoring stale ids', () => {
    const docs = [doc('a', 0), doc('b', 0)];
    const result = selectFavoriteDocs(['b', 'missing', 'a'], docs);
    expect(result.map((d) => d.documentId)).toEqual(['b', 'a']);
  });

  it('returns empty for no favorites', () => {
    expect(selectFavoriteDocs([], [doc('a', 0)])).toEqual([]);
  });
});
