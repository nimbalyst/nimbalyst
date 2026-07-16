// @vitest-environment jsdom
import React from 'react';
import { Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../../../store/atoms/openProjects';
import {
  refreshSharedFolders,
  sharedFoldersAtom,
  type SharedFolder,
} from '../../../store/atoms/collabDocuments';
import { ShareToTeamDialog } from '../ShareToTeamDialog';

vi.mock('@nimbalyst/runtime', () => ({
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
  store.set(activeWorkspacePathAtom, null);
});

describe('ShareToTeamDialog folder refresh', () => {
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
    await waitFor(() => expect(screen.getByText('Engineering / Specs /')).toBeTruthy());

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
    await waitFor(() => expect(screen.getByText('Specs /')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Share to Team' }));
    expect(onConfirm).toHaveBeenCalledWith({
      folderId: 'specs',
      folderPath: 'Specs',
      sharedName: 'notes.md',
    });
  });
});
