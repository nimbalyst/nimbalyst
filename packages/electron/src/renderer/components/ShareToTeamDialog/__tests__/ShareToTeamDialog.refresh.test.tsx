// @vitest-environment jsdom
import React from 'react';
import { Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../../../store/atoms/openProjects';
import {
  activeCollabScopeAtom,
  refreshSharedFolders,
  sharedFoldersAtom,
  type SharedFolder,
} from '../../../store/atoms/collabDocuments';
import { ShareToTeamDialog } from '../ShareToTeamDialog';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

vi.mock('../../../store/atoms/collabDocuments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../store/atoms/collabDocuments')>();
  return {
    ...actual,
    refreshSharedFolders: vi.fn().mockResolvedValue(true),
  };
});

const workspacePath = '/workspace/share-picker-refresh';
const collabScope = {
  scopeKey: workspacePath,
  orgId: 'team-1',
  indexConfig: { serverUrl: 'ws://sync', userId: 'user-1' },
};
const markdownDescriptor = {
  documentType: 'markdown',
  displayName: 'Markdown',
  fileExtensions: ['.md', '.markdown'],
  defaultExtension: '.md',
  icon: 'description',
  editor: { kind: 'lexical' as const },
  content: { strategy: 'lexical' as const, codecId: 'markdown' },
  creation: { defaultContent: '', source: 'builtin' as const },
  capabilities: {
    localCreate: true,
    shareToTeam: true,
    sharedCreate: true,
    history: true,
    export: true,
    embed: false,
  },
};

function folder(folderId: string, name: string, parentFolderId: string | null): SharedFolder {
  return {
    folderId,
    parentFolderId,
    name,
    sortOrder: 0,
    createdBy: 'user-1',
    createdAt: 1,
    updatedAt: 1,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  store.set(sharedFoldersAtom, []);
  store.set(activeCollabScopeAtom, null);
  store.set(activeWorkspacePathAtom, null);
});

describe('ShareToTeamDialog folder refresh', () => {
  it('warns about linked documents and returns the deselected subset', async () => {
    const onConfirm = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn().mockResolvedValue({ collabTree: {} }),
      },
    });
    store.set(activeWorkspacePathAtom, workspacePath);
    store.set(activeCollabScopeAtom, collabScope);

    render(
      <Provider store={store}>
        <ShareToTeamDialog
          isOpen
          onClose={() => {}}
          fileName="notes.md"
          sourceRelPath="notes.md"
          descriptor={markdownDescriptor}
          embeddedDocuments={[
            {
              absolutePath: '/workspace/wireframe.mockup.html',
              sourceHref: './wireframe.mockup.html',
              fileName: 'wireframe.mockup.html',
              fileExtension: '.mockup.html',
              descriptor: {
                ...markdownDescriptor,
                documentType: 'mockup',
                displayName: 'Mockup',
                defaultExtension: '.mockup.html',
                fileExtensions: ['.mockup.html'],
                icon: 'web',
                editor: { kind: 'extension', extensionId: 'mockup' },
              },
              occurrences: 1,
              alreadyShared: { documentId: 'mockup-1', orgId: 'team-1' },
            },
            {
              absolutePath: '/workspace/budget.calc.md',
              sourceHref: './budget.calc.md',
              fileName: 'budget.calc.md',
              fileExtension: '.calc.md',
              descriptor: {
                ...markdownDescriptor,
                documentType: 'calc',
                displayName: 'Calc Sheet',
                defaultExtension: '.calc.md',
                fileExtensions: ['.calc.md'],
                icon: 'table',
                editor: { kind: 'extension', extensionId: 'calc' },
              },
              occurrences: 1,
            },
          ]}
          onConfirm={onConfirm}
        />
      </Provider>,
    );

    screen.getByText(/will also share the documents it embeds/i);
    screen.getByText('Already shared');
    // The mockup is already shared -- it is reused, not created -- so the
    // count is the parent plus the one calc sheet.
    screen.getByRole('button', { name: 'Share 2 documents' });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Share budget.calc.md' }));
    screen.getByText(/teammates cannot open/i);
    screen.getByRole('button', { name: 'Share 1 document' });

    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Share 1 document' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Share 1 document' }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      selectedEmbeddedDocumentPaths: ['/workspace/wireframe.mockup.html'],
    }));
  });

  it('refreshes on every open and rebuilds paths from current first-class rows', async () => {
    const onConfirm = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn().mockResolvedValue({
          collabTree: { lastSharedFolderId: 'specs' },
        }),
      },
    });
    store.set(activeWorkspacePathAtom, workspacePath);
    store.set(activeCollabScopeAtom, collabScope);
    store.set(sharedFoldersAtom, [
      folder('engineering', 'Engineering', null),
      folder('specs', 'Specs', 'engineering'),
    ]);

    const { rerender } = render(
      <Provider store={store}>
        <ShareToTeamDialog
          isOpen
          onClose={() => {}}
          fileName="notes.md"
          sourceRelPath="notes.md"
          descriptor={markdownDescriptor}
          onConfirm={onConfirm}
        />
      </Provider>,
    );

    await waitFor(() => expect(refreshSharedFolders).toHaveBeenCalledTimes(1));
    await waitFor(() => screen.getByText('Engineering / Specs /'));

    rerender(
      <Provider store={store}>
        <ShareToTeamDialog
          isOpen={false}
          onClose={() => {}}
          fileName="notes.md"
          sourceRelPath="notes.md"
          descriptor={markdownDescriptor}
          onConfirm={onConfirm}
        />
      </Provider>,
    );
    store.set(sharedFoldersAtom, [
      folder('engineering', 'Product', null),
      folder('specs', 'Specs', null),
    ]);
    rerender(
      <Provider store={store}>
        <ShareToTeamDialog
          isOpen
          onClose={() => {}}
          fileName="notes.md"
          sourceRelPath="notes.md"
          descriptor={markdownDescriptor}
          onConfirm={onConfirm}
        />
      </Provider>,
    );

    await waitFor(() => expect(refreshSharedFolders).toHaveBeenCalledTimes(2));
    await waitFor(() => screen.getByText('Specs /'));
    // The reopen's async refresh re-seeds selection; until it settles the confirm
    // button is disabled (hasInitializedSelection === false) even though the stale
    // selection already renders "Specs /". Wait for it to be enabled before clicking,
    // otherwise the click is a no-op and onConfirm is never called.
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Share to Team' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Share to Team' }));
    expect(onConfirm).toHaveBeenCalledWith({
      folderId: 'specs',
      folderPath: 'Specs',
      sharedName: 'notes.md',
      selectedEmbeddedDocumentPaths: [],
    });
  });
});
