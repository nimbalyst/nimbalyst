// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, createEvent, fireEvent, render, waitFor } from '@testing-library/react';
import { atom, createStore, Provider } from 'jotai';
import type { CollabHost } from '@nimbalyst/collab-client/core';
import {
  projectPagesAsFolders,
  type CollabDocsSession,
  type SharedDocument,
  type SharedFolder,
  type SharedItemPlacement,
  type SharedTypePlacement,
} from '@nimbalyst/collab-client/docs';
import { CollabDocsUIProvider } from '../CollabDocsUIProvider';
import { CollabSidebar } from '../CollabSidebar';
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
  return renderDocsUIWithHost(children);
}

function renderDocsUIWithHost(
  children: React.ReactNode,
  typePlacements: SharedTypePlacement[] = [],
  pageTree?: { documents: SharedDocument[]; itemPlacements: SharedItemPlacement[] },
  types: readonly unknown[] = documentTypes,
) {
  const docs = pageTree?.documents ?? documents;
  const host = {
    surface: 'web_console',
    documents: {
      documentTypes: () => types,
      onDocumentTypesChanged: () => () => undefined,
    },
    getMembers: async () => [{ memberId: 'member-self', email: 'self@example.test', name: 'Self' }],
    openArtifact: vi.fn(),
    // As in the console: page rows render as real links, which is what a
    // right-click lands on in the browser.
    artifactUrl: (ref: { documentId?: string }) => `/org/org-folder-test/project/project-primary/document/${ref.documentId}`,
  } as unknown as CollabHost;
  const session = {
    scope: {
      scopeKey: 'web-console:org-folder-test:project-primary',
      orgId: 'org-folder-test',
      indexConfig: { serverUrl: 'ws://sync.test', teamProjectId: 'project-primary', teamMemberId: 'member-self' },
    },
    host,
    uiCapabilities: { personalState: false, readReceipts: false },
    atoms: {
      sharedDocuments: atom(docs),
      allSharedDocuments: atom(docs),
      trashedSharedDocuments: atom([]),
      sharedFolders: atom(pageTree ? projectPagesAsFolders(docs) : folders),
      typePlacements: atom(typePlacements),
      itemPlacements: atom(pageTree?.itemPlacements ?? []),
      pageTree: atom(!!pageTree),
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
    placeType: vi.fn(async () => undefined),
    moveTypePlacement: vi.fn(async () => undefined),
    movePage: vi.fn(() => true),
    setItemPlacement: vi.fn(async () => ({ ok: true })),
    removeItemPlacement: vi.fn(async () => ({ ok: true })),
    updateDocumentTitle: vi.fn(async () => undefined),
    removePage: vi.fn(),
    createDocument: vi.fn(async () => undefined),
  } as unknown as CollabDocsSession;

  const result = render(
    <Provider store={createStore()}>
      <CollabDocsUIProvider session={session}>{children}</CollabDocsUIProvider>
    </Provider>,
  );
  return { ...result, host, session };
}

afterEach(() => {
  cleanup();
});

const found = <T,>(lookup: () => T | null | undefined) => waitFor(() => {
  const element = lookup();
  if (!element) throw new Error('not rendered yet');
  return element;
});

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
   * A host with no tree beside the list (the browser console) browses folders
   * in it: the level's folders are rows, only the level's documents show, and
   * a search leaves the level for the whole project.
   */
  it('browses folders as rows for a host with no tree', () => {
    const onSelectFolder = vi.fn();
    const root = renderDocsUI(<SharedDocsListView onSelectFolder={onSelectFolder} />);
    expect(root.container.querySelectorAll('.shared-docs-folder-row')).toHaveLength(2);
    expect(root.container.textContent).not.toContain('Sync protocol notes');
    const engineering = [...root.container.querySelectorAll('.shared-docs-folder-row')]
      .find((row) => row.textContent?.includes('Engineering'))!;
    fireEvent.click(engineering);
    expect(onSelectFolder).toHaveBeenCalledWith('folder-engineering');

    cleanup();

    const scoped = renderDocsUI(<SharedDocsListView folderId="folder-engineering" onSelectFolder={onSelectFolder} />);
    expect(scoped.container.querySelectorAll('.shared-docs-folder-row')).toHaveLength(0);
    expect(scoped.container.textContent).toContain('Sync protocol notes');
    expect(scoped.container.textContent).not.toContain('Launch plan');
    fireEvent.change(scoped.getByLabelText('Search shared documents'), { target: { value: 'launch' } });
    expect(scoped.container.textContent).toContain('Launch plan');
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

describe('placed tracker types', () => {
  // Placements are read from the sidebar's own session, never the window's
  // active scope: the Personal section is a session that is never active.
  it('opens the type from its row and an item from the expanded type', () => {
    const typeResolver = {
      typeName: (typeId: string) => (typeId === 'module' ? 'Modules' : null),
      itemsOfType: () => [{ itemId: 'mod-1', title: 'Tracking' }, { itemId: 'mod-2', title: 'Identity' }],
    };
    const { container, host } = renderDocsUIWithHost(<CollabSidebar typeResolver={typeResolver} />, [{
      typeId: 'module', projectId: null, parentFolderId: null, sortOrder: 0,
      createdBy: 'member-self', createdAt: 1, updatedAt: 1,
    }]);

    const typeRow = container.querySelector<HTMLElement>('.collab-tree-type-row')!;
    expect(typeRow.textContent).toContain('Modules');
    expect(typeRow.textContent).toContain('2');
    fireEvent.click(typeRow);
    expect(host.openArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'type', typeId: 'module' }),
      'sidebar',
      { newTab: false },
    );

    const items = container.querySelectorAll<HTMLElement>('.collab-tree-item-row');
    expect([...items].map((row) => row.textContent)).toEqual(['1Tracking', '2Identity']);
    fireEvent.click(items[1], { metaKey: true });
    expect(host.openArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'tracker', trackerId: 'mod-2' }),
      'sidebar',
      { newTab: true },
    );
  });

  it('highlights the open type, or the open typed page, as it does the open page', () => {
    const typeResolver = {
      typeName: (typeId: string) => (typeId === 'module' ? 'Modules' : null),
      itemsOfType: () => [{ itemId: 'mod-1', title: 'Tracking' }, { itemId: 'mod-2', title: 'Identity' }],
    };
    const placement = { typeId: 'module', projectId: null, parentFolderId: null, sortOrder: 0, createdBy: 'member-self', createdAt: 1, updatedAt: 1 };
    const activeRows = () => [...document.querySelectorAll('.collab-tree-type-row.active, .collab-tree-item-row.active')].map((row) => row.getAttribute('data-type-id') ?? row.getAttribute('data-item-id'));
    renderDocsUIWithHost(<CollabSidebar typeResolver={typeResolver} activeTypeId="module" />, [placement]);
    expect(activeRows()).toEqual(['module']);
    cleanup();

    // The open typed page's collapsed type opens to show it, once: collapsing
    // the type again is left alone.
    const { container } = renderDocsUIWithHost(<CollabSidebar typeResolver={typeResolver} activeItemId="mod-2" />, [placement]);
    expect(activeRows()).toEqual(['mod-2']);
    fireEvent.click(container.querySelector<HTMLElement>('.collab-tree-type-row .file-tree-chevron')!);
    expect(activeRows()).toEqual([]);
  });
});

describe('one page tree', () => {
  const page = (documentId: string, title: string, parentFolderId: string | null) => ({
    ...documents[0], documentId, title, parentFolderId,
  });

  it('nests pages and placed typed pages, with the page menu from the mockup', async () => {
    const typeResolver = {
      typeName: (typeId: string) => (typeId === 'module' ? 'Modules' : null),
      typeLabel: (typeId: string) => (typeId === 'module' ? 'Module' : null),
      itemsOfType: () => [{ itemId: 'mod-1', title: 'Sync engine' }, { itemId: 'mod-2', title: 'Tracker engine' }],
      item: (itemId: string) => (itemId === 'mod-1' ? { itemId, title: 'Sync engine', typeId: 'module' } : null),
    };
    const archiveItem = vi.fn(async () => undefined);
    const { container, host } = renderDocsUIWithHost(
      <CollabSidebar typeResolver={typeResolver} onArchiveItem={archiveItem} />,
      [{ typeId: 'module', projectId: null, parentFolderId: 'arch', sortOrder: 0, createdBy: 'm', createdAt: 1, updatedAt: 1 }],
      {
        documents: [
          page('arch', 'Architecture', null),
          page('overview', 'Overview', 'arch'),
          { ...page('notes', 'Notes', 'mod-1'), parentKind: 'item' as const },
        ],
        itemPlacements: [{ itemId: 'mod-1', projectId: null, parentId: 'overview', sortOrder: 0, createdBy: 'm', createdAt: 1, updatedAt: 1 }],
      },
    );

    // No folder rows: Architecture is a page, expanded because it has a child page.
    expect(container.querySelectorAll('.file-tree-directory:not(.collab-tree-type-row)')).toHaveLength(0);
    const rowText = () => [...container.querySelectorAll('.file-tree-file, .collab-tree-type-row')].map((row) => row.textContent);
    // The page tree builder loads lazily.
    await waitFor(() => expect(rowText()).toEqual(['Architecture', 'Modules2', 'Overview']));

    const overview = [...container.querySelectorAll<HTMLElement>('.file-tree-file')].find((row) => row.textContent === 'Overview')!;
    fireEvent.click(overview.querySelector('.file-tree-chevron')!);
    // The placed Module sits under Overview with its type shown faintly; it is
    // no longer listed under its type (the count still includes it).
    expect(rowText()).toEqual(['Architecture', 'Modules2', 'Overview', 'Sync engineModule']);
    // A typed page holds pages too.
    const placed = container.querySelector<HTMLElement>('.collab-tree-item-row[data-item-id="mod-1"]')!;
    fireEvent.click(placed.querySelector('.file-tree-chevron')!);
    expect(rowText()).toEqual(['Architecture', 'Modules2', 'Overview', 'Sync engineModule', 'Notes']);
    fireEvent.contextMenu(placed);
    await waitFor(() => expect(document.querySelector('.collab-item-new-inside')).not.toBeNull());
    expect(document.querySelector('.collab-item-place-type')).not.toBeNull();
    // Agent edits land directly, so a typed page's history is one click from its row.
    fireEvent.click(document.querySelector<HTMLElement>('.collab-page-history')!);
    expect(host.openArtifact).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'tracker', trackerId: 'mod-1' }), 'history');
    // A typed page is a tracker item with its own comments and sessions: it is
    // archived, not moved to Pages Trash, and only after the in-app confirm.
    fireEvent.contextMenu(placed);
    fireEvent.click(await found(() => document.querySelector<HTMLElement>('.collab-item-archive')));
    const confirm = await found(() => document.querySelector<HTMLElement>('[data-testid="collab-confirm-dialog"]'));
    expect(archiveItem).not.toHaveBeenCalled();
    fireEvent.click(confirm.querySelector('.collab-confirm-accept')!);
    await waitFor(() => expect(archiveItem).toHaveBeenCalledWith('mod-1'));

    const architecture = [...container.querySelectorAll<HTMLElement>('.file-tree-file')].find((row) => row.textContent === 'Architecture')!;
    fireEvent.contextMenu(architecture);
    await waitFor(() => expect(document.querySelector('.collab-page-set-type')).not.toBeNull());
    const entries = [...document.querySelectorAll('button')].map((button) => button.textContent);
    expect(entries).toEqual(expect.arrayContaining(['New pageinside', 'Set type', 'Rename', 'Move to...', 'Copy link', 'Move to Trash1 child page']));
    expect(document.querySelector<HTMLButtonElement>('.collab-page-set-type')!.disabled).toBe(true);
  });

  it('shows a page that holds pages but was never written as a folder', async () => {
    const { container } = renderDocsUIWithHost(<CollabSidebar />, [], {
      documents: [
        { ...page('specs', 'Specs', null), hasContent: false },
        page('spec-a', 'Spec A', 'specs'),
        // An older server sends no flag: still a page.
        page('arch', 'Architecture', null),
        page('overview', 'Overview', 'arch'),
        // Empty but holding nothing: a page.
        { ...page('draft', 'Draft', null), hasContent: false },
      ],
      itemPlacements: [],
    });
    const row = (name: string) => [...container.querySelectorAll<HTMLElement>('.file-tree-file')]
      .find((element) => element.querySelector('.file-tree-name')?.textContent === name);
    const icon = (name: string) => row(name)?.querySelector('.file-tree-icon [data-icon]')?.getAttribute('data-icon');
    await found(() => row('Spec A'));
    const pageIcon = icon('Draft');
    expect(pageIcon).not.toMatch(/^folder/);
    expect([icon('Architecture'), icon('Spec A')]).toEqual([pageIcon, pageIcon]);
    expect(icon('Specs')).toBe('folder_open');
    fireEvent.click(row('Specs')!.querySelector('.file-tree-chevron')!);
    expect(icon('Specs')).toBe('folder');
  });

  it('opens the collapsed pages above the open typed page', async () => {
    const typeResolver = {
      typeName: (typeId: string) => (typeId === 'module' ? 'Modules' : null),
      typeLabel: (typeId: string) => (typeId === 'module' ? 'Module' : null),
      itemsOfType: () => [{ itemId: 'mod-1', title: 'Sync engine' }],
      item: (itemId: string) => (itemId === 'mod-1' ? { itemId, title: 'Sync engine', typeId: 'module' } : null),
    };
    renderDocsUIWithHost(
      <CollabSidebar typeResolver={typeResolver} activeItemId="mod-1" />,
      [{ typeId: 'module', projectId: null, parentFolderId: null, sortOrder: 0, createdBy: 'm', createdAt: 1, updatedAt: 1 }],
      {
        documents: [page('arch', 'Architecture', null), page('overview', 'Overview', 'arch')],
        itemPlacements: [{ itemId: 'mod-1', projectId: null, parentId: 'overview', sortOrder: 0, createdBy: 'm', createdAt: 1, updatedAt: 1 }],
      },
    );
    // Overview starts collapsed (see above); the open typed page under it shows.
    await found(() => document.querySelector('.collab-tree-item-row.active[data-item-id="mod-1"]'));
  });

  it('moves a page under a typed page from the dialog, never offering a destination inside itself', async () => {
    const typeResolver = {
      typeName: (typeId: string) => (typeId === 'module' ? 'Modules' : null),
      typeLabel: (typeId: string) => (typeId === 'module' ? 'Module' : null),
      itemsOfType: () => [{ itemId: 'mod-1', title: 'Sync engine' }],
      item: (itemId: string) => (itemId === 'mod-1' ? { itemId, title: 'Sync engine', typeId: 'module' } : null),
    };
    const { container, session } = renderDocsUIWithHost(<CollabSidebar typeResolver={typeResolver} />, [], {
      documents: [page('arch', 'Architecture', null), page('zeta', 'Zeta', null), { ...page('notes', 'Notes', 'mod-1'), parentKind: 'item' as const }],
      itemPlacements: [{ itemId: 'mod-1', projectId: null, parentId: 'arch', sortOrder: 0, createdBy: 'm', createdAt: 1, updatedAt: 1 }],
    });
    const zeta = await found(() => [...container.querySelectorAll<HTMLElement>('.file-tree-file')].find((row) => row.textContent === 'Zeta'));
    fireEvent.contextMenu(zeta);
    fireEvent.click(await found(() => document.querySelector<HTMLElement>('.collab-page-move-to')));
    let dialog = await found(() => document.querySelector<HTMLElement>('.collab-page-move-dialog'));
    fireEvent.click(dialog.querySelector('[data-page-option="mod-1"]')!);
    fireEvent.click(dialog.querySelector('.collab-page-move-confirm')!);
    await waitFor(() => expect(session.movePage).toHaveBeenCalledWith('zeta', 'mod-1', { parentKind: 'item' }));

    // The typed page itself: its own child is not offered.
    const arch = [...container.querySelectorAll<HTMLElement>('.file-tree-file')].find((row) => row.textContent === 'Architecture')!;
    if (!container.querySelector('.collab-tree-item-row[data-item-id="mod-1"]')) fireEvent.click(arch.querySelector('.file-tree-chevron')!);
    const typed = await found(() => container.querySelector<HTMLElement>('.collab-tree-item-row[data-item-id="mod-1"]'));
    fireEvent.contextMenu(typed);
    fireEvent.click(await found(() => document.querySelector<HTMLElement>('.collab-item-move-to')));
    dialog = await found(() => document.querySelector<HTMLElement>('.collab-page-move-dialog'));
    expect(dialog.querySelector('[data-page-option="notes"]')).toBeNull();
    fireEvent.click(dialog.querySelector('[data-page-option="zeta"]')!);
    fireEvent.click(dialog.querySelector('.collab-page-move-confirm')!);
    await waitFor(() => expect(session.setItemPlacement).toHaveBeenCalledWith('mod-1', 'zeta', undefined, 'page'));
  });

  it('shows markdown pages without ".md"; a move changes only the parent and a rename stores the bare name', async () => {
    const board = { ...page('board', 'Board.canvas', null), documentType: 'canvas' };
    const { container, session } = renderDocsUIWithHost(<CollabSidebar />, [], {
      documents: [page('arch', 'Architecture.md', null), page('overview', 'Overview.md', 'arch'), board],
      itemPlacements: [],
    });
    const rowText = () => [...container.querySelectorAll('.file-tree-file')].map((row) => row.textContent);
    await waitFor(() => expect(rowText()).toEqual(['Architecture', 'Overview', 'Board.canvas']));

    const overview = [...container.querySelectorAll<HTMLElement>('.file-tree-file')].find((row) => row.textContent === 'Overview')!;
    fireEvent.contextMenu(overview);
    fireEvent.click(await found(() => document.querySelector<HTMLElement>('.collab-page-move-to')));
    const dialog = await found(() => document.querySelector<HTMLElement>('.collab-page-move-dialog'));
    expect(dialog.querySelector('h2')!.textContent).toBe('Move “Overview”');
    expect(dialog.querySelector('[data-page-option="arch"]')!.textContent).toBe('Architecture');
    fireEvent.click(dialog.querySelector('[data-page-option="root"]')!);
    fireEvent.click(dialog.querySelector('.collab-page-move-confirm')!);
    await waitFor(() => expect(session.movePage).toHaveBeenCalledWith('overview', null, { parentKind: 'page' }));
    expect(session.updateDocumentTitle).not.toHaveBeenCalled();

    // Rename edits the bare name and stores it bare.
    const architecture = [...container.querySelectorAll<HTMLElement>('.file-tree-file')].find((row) => row.textContent === 'Architecture')!;
    fireEvent.contextMenu(architecture);
    fireEvent.click(await found(() => [...document.querySelectorAll<HTMLElement>('button')].find((button) => button.textContent === 'Rename')));
    const input = await found(() => document.querySelector<HTMLInputElement>('.input-modal-input'));
    expect(input.value).toBe('Architecture');
    expect(document.querySelector('.input-modal-suffix')).toBeNull();
    fireEvent.change(input, { target: { value: 'System.md' } });
    fireEvent.click(document.querySelector<HTMLElement>('.input-modal-confirm')!);
    await waitFor(() => expect(session.updateDocumentTitle).toHaveBeenLastCalledWith('arch', 'System'));
  });

  // A native confirm blocks the renderer and any E2E run driving it.
  it('deletes a page with children only after the in-app confirm is accepted', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { container, session } = renderDocsUIWithHost(<CollabSidebar />, [], {
      documents: [page('arch', 'Architecture', null), page('overview', 'Overview', 'arch')],
      itemPlacements: [],
    });
    const arch = await found(() => [...container.querySelectorAll<HTMLElement>('.file-tree-file')].find((row) => row.textContent === 'Architecture'));
    const openDialog = async () => {
      fireEvent.contextMenu(arch);
      fireEvent.click(await found(() => document.querySelector<HTMLElement>('.collab-page-delete')));
      return found(() => document.querySelector<HTMLElement>('[data-testid="collab-confirm-dialog"]'));
    };

    fireEvent.click((await openDialog()).querySelector('.collab-confirm-cancel')!);
    await waitFor(() => expect(document.querySelector('[data-testid="collab-confirm-dialog"]')).toBeNull());
    expect(session.removePage).not.toHaveBeenCalled();

    const dialog = await openDialog();
    expect(dialog.textContent).toContain('1 child page');
    fireEvent.click(dialog.querySelector('.collab-confirm-accept')!);
    await waitFor(() => expect(session.removePage).toHaveBeenCalledWith('arch'));
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  // A new page from empty space, a section header or an empty tree lands at
  // the section root even while a page is selected.
  it('offers New page and Place type at the section root from empty space, the header and an empty tree', async () => {
    const markdown = {
      documentType: 'markdown', displayName: 'Markdown', defaultExtension: '.md', icon: 'description',
      editor: { kind: 'lexical' }, capabilities: { localCreate: true, sharedCreate: true }, creation: { defaultContent: '' },
    };
    const types = [markdown];
    const typeResolver = {
      typeName: () => 'Modules',
      itemsOfType: () => [],
      listedTypes: () => [{ typeId: 'module', name: 'Modules' }],
    };
    const createPage = async (open: () => Promise<void>, session: CollabDocsSession, name: string) => {
      await open();
      const input = await found(() => document.querySelector<HTMLInputElement>('[data-testid="collab-create-name-input"]'));
      fireEvent.change(input, { target: { value: name } });
      fireEvent.click(document.querySelector<HTMLElement>('.collab-create-confirm')!);
      await waitFor(() => expect(session.createDocument).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestedName: name, parentFolderId: null }),
      ));
    };
    const menuEntries = () => [...document.querySelectorAll('.collab-section-menu button')].map((button) => button.textContent);

    const { container, session } = renderDocsUIWithHost(
      <CollabSidebar typeResolver={typeResolver} sectionTitle="Team" />,
      [],
      { documents: [page('arch', 'Architecture', null)], itemPlacements: [] },
      types,
    );
    fireEvent.click(await found(() => [...container.querySelectorAll<HTMLElement>('.file-tree-file')].find((row) => row.textContent === 'Architecture')));

    const tree = container.querySelector<HTMLElement>('.collab-sidebar-tree')!;
    await createPage(async () => {
      fireEvent.contextMenu(tree);
      expect(menuEntries()).toEqual(['New page', 'Place type...']);
      fireEvent.click(document.querySelector<HTMLElement>('.collab-section-new-page')!);
    }, session, 'From empty space');

    fireEvent.contextMenu(tree);
    fireEvent.click(document.querySelector<HTMLElement>('.collab-section-place-type')!);
    fireEvent.click(await found(() => document.querySelector<HTMLElement>('.collab-place-type-option')));
    expect(session.placeType).toHaveBeenCalledWith('module', null, undefined);

    await createPage(async () => {
      fireEvent.contextMenu(container.querySelector<HTMLElement>('.collab-sidebar-section-header')!);
      expect(menuEntries()).toEqual(['New page', 'Place type...']);
      fireEvent.click(document.querySelector<HTMLElement>('.collab-section-new-page')!);
    }, session, 'From the header');

    cleanup();
    const empty = renderDocsUIWithHost(<CollabSidebar sectionTitle="Personal" />, [], { documents: [], itemPlacements: [] }, types);
    await createPage(async () => {
      fireEvent.click(await found(() => empty.container.querySelector<HTMLElement>('.collab-empty-new-page')));
    }, empty.session, 'First page');
  });

  it('places a type under a page, moves a type from its menu, and reorders types by edge drop', async () => {
    const names: Record<string, string> = { module: 'Modules', person: 'People', competitor: 'Competitors' };
    const typeResolver = {
      typeName: (typeId: string) => names[typeId] ?? null,
      itemsOfType: () => [],
      listedTypes: () => Object.entries(names).map(([typeId, name]) => ({ typeId, name })),
    };
    const placement = (typeId: string, sortOrder: number) => ({
      typeId, projectId: null, parentFolderId: null, sortOrder, createdBy: 'm', createdAt: 1, updatedAt: 1,
    });
    const { container, session, host } = renderDocsUIWithHost(
      <CollabSidebar typeResolver={typeResolver} />,
      [placement('module', 10), placement('person', 30)],
      { documents: [page('arch', 'Architecture', null)], itemPlacements: [] },
    );
    const pageRow = await found(() => [...container.querySelectorAll<HTMLElement>('.file-tree-file')].find((row) => row.textContent === 'Architecture'));

    fireEvent.contextMenu(pageRow);
    fireEvent.click(await found(() => document.querySelector<HTMLElement>('.collab-place-type-action')));
    fireEvent.click([...document.querySelectorAll<HTMLElement>('.collab-place-type-option')].find((option) => option.textContent === 'Competitors')!);
    expect(session.placeType).toHaveBeenCalledWith('competitor', 'arch', undefined);

    const typeRow = (typeId: string) => container.querySelector<HTMLElement>(`.collab-tree-type-row[data-type-id="${typeId}"]`)!;
    // The type page's prose has a history of its own.
    fireEvent.contextMenu(typeRow('module'));
    fireEvent.click(await found(() => document.querySelector<HTMLElement>('.collab-page-history')));
    expect(host.openArtifact).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'type', typeId: 'module' }), 'history');
    fireEvent.contextMenu(typeRow('person'));
    fireEvent.click(await found(() => document.querySelector<HTMLElement>('.collab-type-move-to')));
    fireEvent.click(await found(() => document.querySelector<HTMLElement>('[data-page-option="arch"]')));
    fireEvent.click(document.querySelector<HTMLElement>('.collab-page-move-confirm')!);
    expect(session.moveTypePlacement).toHaveBeenLastCalledWith('person', 'arch', undefined, 'page');

    // People dragged onto the upper edge of Modules lands before it.
    const target = typeRow('module');
    target.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 200, height: 28 });
    fireEvent.dragStart(typeRow('person'), { dataTransfer: { setData: () => undefined } });
    // jsdom has no DragEvent, so the pointer position is set by hand.
    const at = (event: Event) => Object.defineProperty(event, 'clientY', { value: 102 });
    fireEvent(target, at(createEvent.dragOver(target, { dataTransfer: {} })));
    expect(target.className).toContain('collab-tree-drop-before');
    fireEvent(target, at(createEvent.drop(target, { dataTransfer: {} })));
    expect(session.moveTypePlacement).toHaveBeenLastCalledWith('person', null, 9, 'page');
  });
});
