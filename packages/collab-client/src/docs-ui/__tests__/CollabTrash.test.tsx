// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { atom, createStore, Provider } from 'jotai';
import type { CollabHost } from '@nimbalyst/collab-client/core';
import type { CollabDocsSession, SharedDocument } from '@nimbalyst/collab-client/docs';
import { CollabDocsUIProvider } from '../CollabDocsUIProvider';
import { CollabSidebar } from '../CollabSidebar';
import { findPageNode, type CollabPageActionRequest } from '../usePageActionRequest';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const scope = {
  scopeKey: '/trash-test',
  orgId: 'org-trash-test',
  indexConfig: { serverUrl: 'ws://sync.test', teamProjectId: 'project-primary', userId: 'member-self' },
};

const page = (documentId: string, title: string, extra: Partial<SharedDocument> = {}): SharedDocument => ({
  documentId,
  teamProjectId: 'project-primary',
  title,
  documentType: 'markdown',
  createdBy: 'member-self',
  createdAt: 1,
  updatedAt: 10,
  lastWriterUserId: 'member-self',
  parentFolderId: null,
  ...extra,
});

const live = page('live', 'Live');
// `arch` went to Trash with the page under it; `orphan` was under a page that is gone.
const trashed = [
  page('orphan', 'Orphan', { parentFolderId: 'purged', trashedAt: 2_000 }),
  page('arch', 'Architecture', { trashedAt: 1_000, lastWriterUserId: 'member-other' }),
  page('arch-child', 'Overview', { parentFolderId: 'arch', trashedAt: 1_000, lastWriterUserId: 'member-other' }),
];

const notUnread = atom(false);
const noDocumentTypes = [] as const;

afterEach(cleanup);

function makeSession(extra: Record<string, unknown> = {}) {
  const host = {
    surface: 'desktop',
    documents: { documentTypes: () => noDocumentTypes, onDocumentTypesChanged: () => () => undefined },
    getMembers: async () => [{ memberId: 'member-other', email: 'other@example.test', name: 'Other Person' }],
    openArtifact: vi.fn(),
    notify: vi.fn(),
  } as unknown as CollabHost;
  return {
    scope,
    host,
    uiCapabilities: { personalState: false, readReceipts: false },
    atoms: {
      sharedDocuments: atom([live]),
      allSharedDocuments: atom([live, ...trashed]),
      trashedSharedDocuments: atom(trashed),
      sharedFolders: atom([]),
      typePlacements: atom([]),
      syncStatus: atom('connected'),
      hasTeam: atom(true),
      activeTeamUserId: atom('member-self'),
      favorites: atom([]),
      changedDocumentIds: atom(new Set()),
      openedAt: atom({}),
      receipts: atom(new Map()),
      treeFilter: atom<'all'>('all'),
      showUnreadBubbles: atom(false),
      pendingFolder: atom(null),
      unreadDocument: () => notUnread,
    },
    toggleFavorite: vi.fn(),
    ...extra,
  } as unknown as CollabDocsSession;
}


it('opens the section Trash from the Pages sidebar and restores a page with what went with it', async () => {
  const restoreDocument = vi.fn(async (documentId: string) => documentId === 'orphan'
    ? { ok: true as const, restored: 1, movedToRoot: true }
    : { ok: true as const, restored: 2, movedToRoot: false });
  const session = makeSession({ restoreDocument });

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <Provider store={createStore()}>
        <CollabDocsUIProvider session={session}>
          <CollabSidebar sectionTitle="Team" />
        </CollabDocsUIProvider>
      </Provider>,
    );
  });

  const entry = view.container.querySelector<HTMLButtonElement>('.collab-sidebar-trash-entry')!;
  expect(entry.textContent).toContain('2');
  await act(async () => { fireEvent.click(entry); });

  const dialog = await view.findByRole('dialog', { name: 'Team Trash' });
  // One row per trashing: the page under `arch` comes back with it, so it is not its own row.
  const rows = [...dialog.querySelectorAll('[data-trash-document-id]')];
  expect(rows.map((row) => row.getAttribute('data-trash-document-id'))).toEqual(['orphan', 'arch']);
  const archRow = within(rows[1] as HTMLElement);
  archRow.getByText(/Other Person/);
  archRow.getByText(/1 page inside/);

  await act(async () => { fireEvent.click(archRow.getByRole('button', { name: 'Restore' })); });
  expect(restoreDocument).toHaveBeenCalledWith('arch');

  await act(async () => { fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Restore' })); });
  expect(restoreDocument).toHaveBeenCalledWith('orphan');
  expect(dialog.querySelector('.collab-trash-notice')?.textContent).toMatch(/Orphan.*top of Team/);
});

it('runs a page header request with the row menu writes: Trash, Rename, and a warning for a page it lacks', async () => {
  const trashDocument = vi.fn();
  const session = makeSession({ trashDocument });
  const onHandled = vi.fn();
  const sidebar = (request: CollabPageActionRequest | null) => (
    <Provider store={createStore()}>
      <CollabDocsUIProvider session={session}>
        <CollabSidebar sectionTitle="Team" pageActionRequest={request} onPageActionHandled={onHandled} />
      </CollabDocsUIProvider>
    </Provider>
  );
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(sidebar({ pageId: 'live', action: 'trash' })); });
  expect(trashDocument).toHaveBeenCalledWith('live');
  expect(onHandled).toHaveBeenCalledTimes(1);

  await act(async () => { view.rerender(sidebar({ pageId: 'live', action: 'rename' })); });
  view.getByDisplayValue('Live');
  expect(onHandled).toHaveBeenCalledTimes(2);

  vi.useFakeTimers();
  try {
    await act(async () => { view.rerender(sidebar({ pageId: 'gone', action: 'moveTo' })); });
    expect(onHandled).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(onHandled).toHaveBeenCalledTimes(3);
    expect(session.host.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Page not found' }));
  } finally {
    vi.useRealTimers();
  }
});

it('tells a type row from a page that shares its id', () => {
  const pageNode = { id: 'document:module', type: 'document', path: 'module', name: 'Module', document: page('module', 'Module') };
  const typeNode = { id: 'type:module', type: 'type', typeId: 'module', path: 'type:module', name: 'Modules', count: 0, children: [] };
  const tree = [{ ...pageNode, children: [typeNode] }] as unknown as Parameters<typeof findPageNode>[0];
  expect(findPageNode(tree, { pageId: 'module' })?.type).toBe('document');
  expect(findPageNode(tree, { pageId: 'module', kind: 'type' })?.type).toBe('type');
});
