// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { atom, createStore, Provider } from 'jotai';
import type { CollabHost } from '@nimbalyst/collab-client/core';
import type { CollabDocsSession, SharedDocument } from '@nimbalyst/collab-client/docs';
import { CollabDocsUIProvider } from '../CollabDocsUIProvider';
import { CollabSidebar } from '../CollabSidebar';
import { SharedDocsListView } from '../SharedDocsListView';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

vi.mock('@nimbalyst/runtime', () => ({}));

const scope = {
  scopeKey: '/availability-test',
  orgId: 'org-availability-test',
  indexConfig: {
    serverUrl: 'ws://sync.test',
    teamProjectId: 'project-primary',
    userId: 'member-self',
    userEmail: 'self@example.test',
  },
};

const documents: SharedDocument[] = [
  {
    documentId: 'doc-older',
    teamProjectId: 'project-secondary',
    title: 'Older.md',
    documentType: 'markdown',
    createdBy: 'member-other',
    createdAt: 1,
    updatedAt: 10,
    lastWriterUserId: 'member-other',
    parentFolderId: null,
  },
  {
    documentId: 'doc-newer',
    teamProjectId: 'project-primary',
    title: 'Newer.md',
    documentType: 'markdown',
    createdBy: 'member-self',
    createdAt: 2,
    updatedAt: 20,
    lastWriterUserId: 'member-self',
    parentFolderId: null,
  },
];

function createSurface(personalState: boolean, readReceipts: boolean) {
  const documentTypes = [] as const;
  const host = {
    surface: personalState ? 'desktop' : 'web_console',
    documents: {
      documentTypes: () => documentTypes,
      onDocumentTypesChanged: () => () => undefined,
    },
    getMembers: async () => [
      { memberId: 'member-self', email: 'self@example.test', name: 'Self' },
      { memberId: 'member-other', email: 'other@example.test', name: 'Other' },
    ],
    openArtifact: vi.fn(),
  } as unknown as CollabHost;
  const unreadByDocument = new Map(documents.map((document) => [
    document.documentId,
    atom(document.documentId === 'doc-older'),
  ]));
  const session = {
    scope,
    host,
    uiCapabilities: { personalState, readReceipts },
    atoms: {
      sharedDocuments: atom(documents),
      allSharedDocuments: atom(documents),
      trashedSharedDocuments: atom([]),
      sharedFolders: atom([]),
      syncStatus: atom('connected'),
      hasTeam: atom(true),
      activeTeamUserId: atom('member-self'),
      favorites: atom(['doc-older']),
      changedDocumentIds: atom(new Set(['doc-older'])),
      openedAt: atom({ 'doc-older': 5 }),
      receipts: atom(new Map([[
        'doc-older',
        { lastSeenVersion: null, lastViewedAt: 5 },
      ]])),
      treeFilter: atom<'all' | 'favorites' | 'updated'>('all'),
      showUnreadBubbles: atom(true),
      pendingFolder: atom(null),
      unreadDocument: (documentId: string) => unreadByDocument.get(documentId)!,
    },
    toggleFavorite: vi.fn(),
    markAllDocumentsViewed: vi.fn(),
    markDocumentViewed: vi.fn(),
  } as unknown as CollabDocsSession;

  return render(
    <Provider store={createStore()}>
      <CollabDocsUIProvider session={session}>
        <CollabSidebar />
        <SharedDocsListView />
      </CollabDocsUIProvider>
    </Provider>,
  );
}

afterEach(cleanup);

describe('personal UI capability availability', () => {
  it('keeps desktop personal affordances and removes them structurally when lanes are unavailable', () => {
    const desktop = createSurface(true, true);
    expect(desktop.container.querySelector('.collab-tree-filter')?.textContent)
      .toContain('Favorites');
    expect(desktop.container.querySelector('.collab-tree-filter')?.textContent)
      .toContain('Updated');
    expect(desktop.container.querySelector('.collab-fav-star')).not.toBeNull();
    expect(desktop.container.querySelector('.doc-unread-dot')).not.toBeNull();
    expect(desktop.container.querySelector('[data-segment="favorites"]')).not.toBeNull();
    expect(desktop.container.querySelector('[data-segment="review"]')).not.toBeNull();
    expect(desktop.container.querySelector('[data-segment="recent"]')).not.toBeNull();
    expect(desktop.container.querySelector('.shared-docs-star')).not.toBeNull();
    expect(desktop.container.querySelector('.shared-docs-review-dot')).not.toBeNull();
    desktop.unmount();

    const browser = createSurface(false, false);
    expect(browser.container.querySelector('.collab-tree-filter')).toBeNull();
    expect(browser.container.querySelector('.collab-fav-star')).toBeNull();
    expect(browser.container.querySelector('.doc-unread-dot')).toBeNull();
    expect([...browser.container.querySelectorAll('[data-segment]')].map((node) =>
      node.getAttribute('data-segment'))).toEqual(['all', 'sharedWithMe', 'sharedByMe']);
    expect(browser.container.querySelector('.shared-docs-star')).toBeNull();
    expect(browser.container.querySelector('.shared-docs-review-dot')).toBeNull();
    expect(browser.queryByText('Viewed by me')).toBeNull();
    expect([...browser.container.querySelectorAll('tbody tr')].map((row) =>
      row.getAttribute('data-document-id'))).toEqual(['doc-newer', 'doc-older']);
    browser.getByText('Sorted by last edited');
  });

  /**
   * Rename is a worker-backed metadata mutation, but it was nested inside the
   * optional desktop-only local-origin block, so any host omitting that
   * controller silently lost Rename while keeping Delete. Nothing in the markup
   * reveals which actions a browser host ends up with.
   */
  it('keeps worker-backed document actions when the desktop local-origin controller is absent', () => {
    const browser = createSurface(false, false);
    const documentRow = browser.container.querySelector('.file-tree-file')!;
    fireEvent.contextMenu(documentRow);

    browser.getByText('Rename');
    browser.getByText('Move to Trash');
    expect(browser.queryByText('Open Local Source')).toBeNull();
    expect(browser.queryByText('Re-upload From Local')).toBeNull();
    expect(browser.queryByText(/Link Local Source/)).toBeNull();
  });
});
