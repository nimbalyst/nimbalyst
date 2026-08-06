// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { atom, createStore, Provider } from 'jotai';
import type { CollabHost } from '@nimbalyst/collab-client/core';
import type { CollabDocsSession, SharedDocument, SharedFolder } from '@nimbalyst/collab-client/docs';
import { CollabDocsUIProvider } from '../CollabDocsUIProvider';
import { CollabSidebar } from '../CollabSidebar';
import { SharedDocsListView } from '../SharedDocsListView';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));
vi.mock('@nimbalyst/runtime', () => ({}));

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
    lastWriterUserId: 'member-self',
    parentFolderId: 'folder-engineering',
  },
  {
    documentId: 'doc-in-marketing',
    teamProjectId: 'project-primary',
    title: 'Marketing/Launch plan.md',
    documentType: 'markdown',
    createdBy: 'member-self',
    createdAt: 2,
    updatedAt: 20,
    lastWriterUserId: 'member-self',
    parentFolderId: 'folder-marketing',
  },
] as unknown as SharedDocument[];

// Stable identities: `useSyncExternalStore` and the unread atom family both
// re-render forever if the getter mints a new value each call.
const documentTypes = [] as const;
const notUnread = atom(false);

function renderDocsUI(children: React.ReactNode) {
  const host = {
    surface: 'web_console',
    documents: {
      documentTypes: () => documentTypes,
      onDocumentTypesChanged: () => () => undefined,
    },
    getMembers: async () => [{ memberId: 'member-self', email: 'self@example.test', name: 'Self' }],
    openArtifact: vi.fn(),
  } as unknown as CollabHost;
  const session = {
    scope: {
      scopeKey: 'web-console:org-folder-test:project-primary',
      orgId: 'org-folder-test',
      indexConfig: { serverUrl: 'ws://sync.test', teamProjectId: 'project-primary', userId: 'member-self' },
    },
    host,
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
    toggleFavorite: vi.fn(),
    markAllDocumentsViewed: vi.fn(),
    markDocumentViewed: vi.fn(),
  } as unknown as CollabDocsSession;

  return render(
    <Provider store={createStore()}>
      <CollabDocsUIProvider session={session}>{children}</CollabDocsUIProvider>
    </Provider>,
  );
}

afterEach(cleanup);

/**
 * NIM-2436. A folder is an addressable surface in the browser console
 * (`/docs/folder/:folderId`), so clicking one in the tree has to report the
 * folder the host should route to, and a folder-scoped list has to show that
 * folder rather than the whole project.
 */
describe('routed folder scope', () => {
  it('reports the clicked folder to a host that routes folders', () => {
    const onSelectFolder = vi.fn();
    const { container } = renderDocsUI(<CollabSidebar onSelectFolder={onSelectFolder} />);

    const engineering = [...container.querySelectorAll('.file-tree-directory')]
      .find((row) => row.textContent?.includes('Engineering'))!;
    fireEvent.click(engineering);

    expect(onSelectFolder).toHaveBeenCalledWith('folder-engineering');
  });

  it('narrows the list to one folder when the route names it', () => {
    const scoped = renderDocsUI(<SharedDocsListView folderId="folder-engineering" />);
    expect(scoped.container.textContent).toContain('Sync protocol notes');
    expect(scoped.container.textContent).not.toContain('Launch plan');

    cleanup();

    const unscoped = renderDocsUI(<SharedDocsListView />);
    expect(unscoped.container.textContent).toContain('Sync protocol notes');
    expect(unscoped.container.textContent).toContain('Launch plan');
  });

  /**
   * The route wins over the folder facet, so on a folder page the checkbox menu
   * was live but ignored: picking another folder, unchecking this one, and
   * Clear all mutated state the list no longer reads. The page reports its
   * scope instead, and the facet stays a real filter everywhere it is one.
   */
  it('reports the routed folder as scope instead of an inert filter menu', () => {
    const scoped = renderDocsUI(<SharedDocsListView folderId="folder-engineering" />);
    const routedFacet = scoped.container.querySelector('[data-facet="folder"]')!;
    expect(routedFacet.textContent).toContain('Engineering');
    fireEvent.click(routedFacet);
    expect(document.querySelector('.shared-docs-facet-menu')).toBeNull();

    cleanup();

    const unscoped = renderDocsUI(<SharedDocsListView />);
    fireEvent.click(unscoped.container.querySelector('[data-facet="folder"]')!);
    const marketing = [...document.querySelectorAll('.shared-docs-facet-option')]
      .find((option) => option.textContent?.includes('Marketing'))!;
    fireEvent.click(marketing);

    expect(unscoped.container.textContent).toContain('Launch plan');
    expect(unscoped.container.textContent).not.toContain('Sync protocol notes');
  });
});
