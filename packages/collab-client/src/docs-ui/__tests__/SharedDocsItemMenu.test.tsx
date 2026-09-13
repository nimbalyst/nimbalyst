// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { atom, createStore, Provider } from 'jotai';
import type { CollabHost } from '@nimbalyst/collab-client/core';
import type { CollabDocsSession, SharedDocument, SharedFolder } from '@nimbalyst/collab-client/docs';
import { CollabDocsUIProvider } from '../CollabDocsUIProvider';
import { SharedDocsListView } from '../SharedDocsListView';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const folders: SharedFolder[] = [
  { folderId: 'folder-engineering', name: 'Engineering', parentFolderId: null, createdAt: 1, updatedAt: 1 },
  { folderId: 'folder-marketing', name: 'Marketing', parentFolderId: null, createdAt: 1, updatedAt: 1 },
] as unknown as SharedFolder[];

const documents: SharedDocument[] = [
  {
    documentId: 'doc-in-engineering',
    teamProjectId: 'project-primary',
    title: 'Engineering/Sync protocol notes.md',
    documentType: 'markdown',
    createdBy: 'member-self',
    createdAt: 1,
    updatedAt: 10,
    parentFolderId: 'folder-engineering',
  },
] as unknown as SharedDocument[];

const documentTypes = [] as const;
const notUnread = atom(false);

function renderList(props: React.ComponentProps<typeof SharedDocsListView>) {
  const session = {
    scope: {
      scopeKey: 'web-console:org-menu-test:project-primary',
      orgId: 'org-menu-test',
      indexConfig: { serverUrl: 'ws://sync.test', teamProjectId: 'project-primary', teamMemberId: 'member-self' },
    },
    host: {
      surface: 'web_console',
      documents: { documentTypes: () => documentTypes, onDocumentTypesChanged: () => () => undefined },
      getMembers: async () => [],
      openArtifact: vi.fn(),
    } as unknown as CollabHost,
    uiCapabilities: { personalState: false, readReceipts: false },
    atoms: {
      sharedDocuments: atom(documents),
      allSharedDocuments: atom(documents),
      trashedSharedDocuments: atom([]),
      sharedFolders: atom(folders),
      syncStatus: atom('connected'),
      hasTeam: atom(true),
      activeTeamUserId: atom('member-self'),
      favorites: atom([]),
      changedDocumentIds: atom(new Set<string>()),
      openedAt: atom({}),
      receipts: atom(new Map()),
      treeFilter: atom<'all' | 'favorites' | 'updated'>('all'),
      showUnreadBubbles: atom(true),
      pendingFolder: atom(null),
      unreadDocument: () => notUnread,
    },
    trashDocument: vi.fn(),
    removeFolder: vi.fn(),
    moveDocument: vi.fn(),
    updateDocumentTitle: vi.fn(async () => undefined),
    toggleFavorite: vi.fn(),
  } as unknown as CollabDocsSession;
  const view = render(
    <Provider store={createStore()}>
      <CollabDocsUIProvider session={session}>
        <SharedDocsListView {...props} />
      </CollabDocsUIProvider>
    </Provider>,
  );
  return { ...view, session: session as unknown as Record<string, ReturnType<typeof vi.fn>> };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The list is the browser's only Shared Docs navigation, so the mutations the
 * folder tree carries -- trash, delete, move -- have to be reachable from a row.
 */
describe('row context menu', () => {
  it('trashes a document and moves it to another folder from its row', async () => {
    const { container, session } = renderList({ folderId: 'folder-engineering', onSelectFolder: () => undefined });
    const row = container.querySelector('[data-document-id="doc-in-engineering"]')!;

    fireEvent.contextMenu(row);
    // The menu is lazy-loaded, so its first appearance is awaited.
    fireEvent.click(await screen.findByText('Move to Trash'));
    expect(session.trashDocument).toHaveBeenCalledWith('doc-in-engineering');

    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('Move to…'));
    fireEvent.click(document.querySelector('[data-folder-option="folder-marketing"]')!);
    fireEvent.click(document.querySelector('.shared-docs-move-confirm')!);
    expect(session.moveDocument).toHaveBeenCalledWith('doc-in-engineering', 'folder-marketing');
    await vi.waitFor(() => {
      expect(session.updateDocumentTitle).toHaveBeenCalledWith('doc-in-engineering', 'Marketing/Sync protocol notes.md');
    });
  });

  it('deletes a folder from its row after the descendant-count confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container, session } = renderList({ onSelectFolder: () => undefined });
    fireEvent.contextMenu(container.querySelector('[data-folder-id="folder-engineering"]')!);
    fireEvent.click(await screen.findByText('Delete'));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('1 document'));
    expect(session.removeFolder).toHaveBeenCalledWith('folder-engineering');
  });
});
