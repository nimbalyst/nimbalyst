// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the read-receipt IPC facade so markDocViewed's await resolves without a
// real main process. markAllSharedDocsViewed only needs the write to succeed.
vi.mock('../../../services/RendererReadReceiptService', () => ({
  readReceiptService: {
    markViewed: vi.fn(async () => ({ lastSeenVersion: null, lastViewedAt: 0 })),
    getForScope: vi.fn(async () => []),
  },
}));

import { store } from '@nimbalyst/runtime/store';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import {
  collabFavoritesAtom,
  markAllSharedDocsViewed,
  recentSharedDocsAtom,
  changedSharedDocsAtom,
  recordDocOpened,
  toggleFavoriteDoc,
} from '../collabDiscovery';
import { docReceiptsAtom } from '../docUnread';
import { activeCollabScopeAtom, sharedDocumentsAtom } from '../collabDocuments';
import type { SharedDocument } from '../collabDocuments';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import { markDocViewed } from '../../../hooks/useDocUnread';

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

describe('markAllSharedDocsViewed', () => {
  // Each test uses a unique workspace path: the shared singleton store + jotai
  // atomFamily makes reused-key derived atoms retain stale dependencies across
  // tests, which is a test artifact, not product behavior.
  let wsSeq = 0;
  function freshScope(): CollabScope {
    const scopeKey = `/tmp/ws-collab-${wsSeq++}`;
    const scope: CollabScope = {
      scopeKey,
      orgId: `org-${wsSeq}`,
      indexConfig: { serverUrl: 'wss://example.test', teamMemberId: asTeamMemberId(`user-${wsSeq}`) },
    };
    store.set(activeCollabScopeAtom, scope);
    store.set(docReceiptsAtom, new Map());
    store.set(sharedDocumentsAtom, []);
    return scope;
  }

  beforeEach(() => {
    vi.stubGlobal('window', { electronAPI: { invoke: vi.fn(async () => ({ success: true })) } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears unread without adding docs to recently-opened', async () => {
    const scope = freshScope();
    const docs = [doc('a', 1000), doc('b', 2000)];
    store.set(sharedDocumentsAtom, docs);

    // Precondition: both docs are unread (never viewed), none recently opened.
    expect(store.get(changedSharedDocsAtom).map((c) => c.doc.documentId).sort()).toEqual(['a', 'b']);
    expect(store.get(recentSharedDocsAtom)).toEqual([]);

    await markAllSharedDocsViewed(scope);

    // Unread cleared…
    expect(store.get(changedSharedDocsAtom)).toEqual([]);
    // …but the user never OPENED these docs, so they must not appear as recent.
    expect(store.get(recentSharedDocsAtom)).toEqual([]);
  });

  it('keeps all docs read when a delayed pre-click sync has a newer updatedAt', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(3000);
    const scope = freshScope();
    store.set(sharedDocumentsAtom, [doc('a', 1000)]);

    await markAllSharedDocsViewed(scope);

    // This update arrived after the click, but it was authored before the click.
    store.set(sharedDocumentsAtom, [doc('a', 2000)]);

    expect(store.get(changedSharedDocsAtom)).toEqual([]);
  });

  it('keeps a single doc read when a delayed pre-click sync has a newer updatedAt', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(3000);
    freshScope();
    store.set(sharedDocumentsAtom, [doc('a', 1000)]);

    await markDocViewed('a', 'org-1', 1000);

    store.set(sharedDocumentsAtom, [doc('a', 2000)]);

    expect(store.get(changedSharedDocsAtom)).toEqual([]);
  });

  it('recordDocOpened surfaces a genuinely-opened doc in recent', () => {
    const scope = freshScope();
    const docs = [doc('a', 1000), doc('b', 2000)];
    store.set(sharedDocumentsAtom, docs);

    recordDocOpened(scope, 'b');

    expect(store.get(recentSharedDocsAtom).map((d) => d.documentId)).toEqual(['b']);
  });

  it('keeps favorites and opened watermarks isolated by opaque scope key', () => {
    const first = freshScope();
    store.set(sharedDocumentsAtom, [doc('first-doc', 1000)]);
    toggleFavoriteDoc(first, 'first-doc');
    recordDocOpened(first, 'first-doc');

    const second = freshScope();
    store.set(sharedDocumentsAtom, [doc('second-doc', 2000)]);

    expect(store.get(collabFavoritesAtom)).toEqual([]);
    expect(store.get(recentSharedDocsAtom)).toEqual([]);

    store.set(activeCollabScopeAtom, first);
    expect(store.get(collabFavoritesAtom)).toEqual(['first-doc']);
    expect(store.get(recentSharedDocsAtom).map((item) => item.documentId)).toEqual(['first-doc']);

    store.set(activeCollabScopeAtom, second);
    expect(store.get(sharedDocumentsAtom).map((item) => item.documentId)).toEqual(['second-doc']);
  });
});
