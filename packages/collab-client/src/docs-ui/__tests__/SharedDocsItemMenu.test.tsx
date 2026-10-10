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
  {
    documentId: 'doc-bare-child',
    teamProjectId: 'project-primary',
    title: 'Child',
    documentType: 'markdown',
    createdBy: 'member-self',
    createdAt: 1,
    updatedAt: 11,
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
    isPageTree: () => false,
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
    // A move stores the bare name; the parent is the page's position.
    await vi.waitFor(() => {
      expect(session.updateDocumentTitle).toHaveBeenCalledWith('doc-in-engineering', 'Sync protocol notes');
    });
  });

  it('moves a nested page with a bare title to root, and renames to a bare name', async () => {
    const { container, session } = renderList({ folderId: 'folder-engineering', onSelectFolder: () => undefined });
    const row = container.querySelector('[data-document-id="doc-bare-child"]')!;

    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('Move to…'));
    fireEvent.click(document.querySelector('[data-folder-option="root"]')!);
    fireEvent.click(document.querySelector('.shared-docs-move-confirm')!);
    expect(session.moveDocument).toHaveBeenCalledWith('doc-bare-child', null);
    expect(session.updateDocumentTitle).not.toHaveBeenCalled();

    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('Rename'));
    const input = await screen.findByDisplayValue('Child');
    fireEvent.change(input, { target: { value: 'Renamed child' } });
    fireEvent.click(screen.getAllByText('Rename').at(-1)!);
    await vi.waitFor(() => expect(session.updateDocumentTitle).toHaveBeenCalledWith('doc-bare-child', 'Renamed child'));
  });

  it('deletes a folder from its row only after the in-app descendant-count confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { container, session } = renderList({ onSelectFolder: () => undefined });
    const row = container.querySelector('[data-folder-id="folder-engineering"]')!;

    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('Delete'));
    const dialog = await screen.findByTestId('collab-confirm-dialog');
    expect(dialog.textContent).toContain('2 documents');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await vi.waitFor(() => expect(screen.queryByTestId('collab-confirm-dialog')).toBeNull());
    expect(session.removeFolder).not.toHaveBeenCalled();

    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('Delete'));
    fireEvent.click((await screen.findByTestId('collab-confirm-dialog')).querySelector('.collab-confirm-accept')!);
    await vi.waitFor(() => expect(session.removeFolder).toHaveBeenCalledWith('folder-engineering'));
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
