// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { isEntityUnread } from '@nimbalyst/runtime/readReceipts/readReceipts';
import type { ReadReceipt } from '@nimbalyst/runtime/readReceipts/readReceipts';
import {
  classifyChangedDocs,
  selectFavoriteDocs,
  selectRecentDocs,
} from '../collabDiscovery';
import type { SharedDocument } from '../types';

const ME = 'member-me';
const TEAMMATE = 'member-teammate';

function doc(documentId: string, updatedAt: number, lastWriterUserId: string | null = TEAMMATE): SharedDocument {
  return {
    documentId,
    teamProjectId: null,
    title: documentId,
    documentType: 'markdown',
    createdBy: TEAMMATE,
    createdAt: 0,
    updatedAt,
    lastWriterUserId,
  };
}

/** Build the injected unread resolver the way the renderer atom does. */
function makeUnreadFn(receipts: Map<string, ReadReceipt>, currentUserId: string | null) {
  return (document: SharedDocument) => {
    const receipt = receipts.get(document.documentId) ?? null;
    return {
      unread: isEntityUnread({
        currentVersion: null,
        currentVersionTimestamp: document.updatedAt ?? 0,
        lastChangeActorId: document.lastWriterUserId ?? null,
      }, receipt, currentUserId),
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
    expect(result.map((entry) => entry.doc.documentId)).toEqual(['b', 'c', 'a']);
  });
});

describe('selectRecentDocs', () => {
  it('orders by openedAt desc and excludes never-opened', () => {
    const docs = [doc('a', 0), doc('b', 0), doc('c', 0)];
    const openedAt: Record<string, number> = {
      a: 100,
      c: 300,
      // 'b' never opened → excluded
    };
    const result = selectRecentDocs(docs, openedAt);
    expect(result.map((document) => document.documentId)).toEqual(['c', 'a']);
  });

  it('caps at the requested limit', () => {
    const docs = [doc('a', 0), doc('b', 0), doc('c', 0)];
    const openedAt: Record<string, number> = { a: 1, b: 2, c: 3 };
    expect(selectRecentDocs(docs, openedAt, 2).map((document) => document.documentId)).toEqual(['c', 'b']);
  });
});

describe('selectFavoriteDocs', () => {
  it('returns docs in favorite order, ignoring stale ids', () => {
    const docs = [doc('a', 0), doc('b', 0)];
    const result = selectFavoriteDocs(['b', 'missing', 'a'], docs);
    expect(result.map((document) => document.documentId)).toEqual(['b', 'a']);
  });

  it('returns empty for no favorites', () => {
    expect(selectFavoriteDocs([], [doc('a', 0)])).toEqual([]);
  });
});
