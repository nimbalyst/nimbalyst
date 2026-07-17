import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isEntityUnread } from '@nimbalyst/runtime/readReceipts/readReceipts';
import type { ReadReceipt } from '@nimbalyst/runtime/readReceipts/readReceipts';

// Mock the read-receipt IPC facade so markDocViewed's await resolves without a
// real main process. markAllSharedDocsViewed only needs the write to succeed.
vi.mock('../../../services/RendererReadReceiptService', () => ({
  readReceiptService: {
    markViewed: vi.fn(async () => ({ lastSeenVersion: null, lastViewedAt: 0 })),
    getForScope: vi.fn(async () => []),
  },
}));

import { store } from '@nimbalyst/runtime/store';
import {
  classifyChangedDocs,
  selectFavoriteDocs,
  selectRecentDocs,
  markAllSharedDocsViewed,
  recentSharedDocsAtom,
  changedSharedDocsAtom,
  recordDocOpened,
} from '../collabDiscovery';
import { docSnapshot, docReceiptsAtom } from '../docUnread';
import { sharedDocumentsAtom } from '../collabDocuments';
import { activeWorkspacePathAtom } from '../openProjects';
import type { SharedDocument } from '../collabDocuments';
import { markDocViewed } from '../../../hooks/useDocUnread';

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
  it('orders by openedAt desc and excludes never-opened', () => {
    const docs = [doc('a', 0), doc('b', 0), doc('c', 0)];
    const openedAt: Record<string, number> = {
      a: 100,
      c: 300,
      // 'b' never opened → excluded
    };
    const result = selectRecentDocs(docs, openedAt);
    expect(result.map((d) => d.documentId)).toEqual(['c', 'a']);
  });

  it('caps at the requested limit', () => {
    const docs = [doc('a', 0), doc('b', 0), doc('c', 0)];
    const openedAt: Record<string, number> = { a: 1, b: 2, c: 3 };
    expect(selectRecentDocs(docs, openedAt, 2).map((d) => d.documentId)).toEqual(['c', 'b']);
  });
});

describe('markAllSharedDocsViewed', () => {
  // Each test uses a unique workspace path: the shared singleton store + jotai
  // atomFamily makes reused-key derived atoms retain stale dependencies across
  // tests, which is a test artifact, not product behavior.
  let wsSeq = 0;
  function freshWorkspace(): string {
    const ws = `/tmp/ws-collab-${wsSeq++}`;
    store.set(activeWorkspacePathAtom, ws);
    store.set(docReceiptsAtom, new Map());
    store.set(sharedDocumentsAtom, []);
    return ws;
  }

  beforeEach(() => {
    vi.stubGlobal('window', { electronAPI: { invoke: vi.fn(async () => ({ success: true })) } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears unread without adding docs to recently-opened', async () => {
    freshWorkspace();
    const docs = [doc('a', 1000), doc('b', 2000)];
    store.set(sharedDocumentsAtom, docs);

    // Precondition: both docs are unread (never viewed), none recently opened.
    expect(store.get(changedSharedDocsAtom).map((c) => c.doc.documentId).sort()).toEqual(['a', 'b']);
    expect(store.get(recentSharedDocsAtom)).toEqual([]);

    await markAllSharedDocsViewed('org-1');

    // Unread cleared…
    expect(store.get(changedSharedDocsAtom)).toEqual([]);
    // …but the user never OPENED these docs, so they must not appear as recent.
    expect(store.get(recentSharedDocsAtom)).toEqual([]);
  });

  it('keeps all docs read when a delayed pre-click sync has a newer updatedAt', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(3000);
    freshWorkspace();
    store.set(sharedDocumentsAtom, [doc('a', 1000)]);

    await markAllSharedDocsViewed('org-1');

    // This update arrived after the click, but it was authored before the click.
    store.set(sharedDocumentsAtom, [doc('a', 2000)]);

    expect(store.get(changedSharedDocsAtom)).toEqual([]);
  });

  it('keeps a single doc read when a delayed pre-click sync has a newer updatedAt', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(3000);
    freshWorkspace();
    store.set(sharedDocumentsAtom, [doc('a', 1000)]);

    await markDocViewed('a', 'org-1', 1000);

    store.set(sharedDocumentsAtom, [doc('a', 2000)]);

    expect(store.get(changedSharedDocsAtom)).toEqual([]);
  });

  it('recordDocOpened surfaces a genuinely-opened doc in recent', () => {
    freshWorkspace();
    const docs = [doc('a', 1000), doc('b', 2000)];
    store.set(sharedDocumentsAtom, docs);

    recordDocOpened('b');

    expect(store.get(recentSharedDocsAtom).map((d) => d.documentId)).toEqual(['b']);
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
