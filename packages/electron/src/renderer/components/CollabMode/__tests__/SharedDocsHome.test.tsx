// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, screen } from '@testing-library/react';
import { store } from '@nimbalyst/runtime/store';
import { Provider } from 'jotai';
import { SharedDocsHome } from '../SharedDocsHome';
import { activeWorkspacePathAtom } from '../../../store/atoms/openProjects';
import { allSharedDocumentsAtom } from '../../../store/atoms/collabDocuments';

// MaterialSymbol pulls in font/asset side-effects we don't need for a layout test.
vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

vi.mock('../../../services/CollaborativeDocumentTypeCatalog', () => ({
  getCollaborativeDocumentTypeCatalog: () => ({
    subscribe: () => () => {},
    getSnapshot: () => 0,
  }),
}));

vi.mock('../../../utils/sharedDocumentTypeMetadata', () => ({
  resolveSharedDocumentTypePresentation: () => ({
    state: 'ready',
    icon: 'description',
    typeLabel: 'Markdown',
    metadata: { metadataVersion: 2, fileExtension: '.md', editorId: 'builtin.lexical' },
  }),
}));

afterEach(() => {
  cleanup();
  store.set(allSharedDocumentsAtom, []);
  store.set(activeWorkspacePathAtom, null);
  vi.restoreAllMocks();
});

describe('SharedDocsHome', () => {
  it('applies the theme background so the empty state is not transparent', () => {
    // Regression: the full-bleed empty state rendered without a background,
    // showing the bare window color (looked wrong under Solarized Light).
    const { container } = render(
      <Provider store={store}>
        <SharedDocsHome workspacePath="/workspace" onDocumentSelect={() => {}} />
      </Provider>,
    );
    const root = container.querySelector('.shared-docs-home');
    expect(root).toBeTruthy();
    expect(root?.classList.contains('bg-nim')).toBe(true);
  });

  it('shows trashed documents only in the dedicated Trash view', () => {
    store.set(activeWorkspacePathAtom, '/workspace');
    store.set(allSharedDocumentsAtom, [{
      documentId: 'trashed-doc',
      title: 'Old empty draft',
      documentType: 'markdown',
      createdBy: 'user',
      createdAt: 1,
      updatedAt: 2,
      trashedAt: 2,
    }]);

    render(
      <Provider store={store}>
        <SharedDocsHome workspacePath="/workspace" onDocumentSelect={() => {}} />
      </Provider>,
    );
    expect(screen.queryByText('Old empty draft')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Trash (1)' }));
    expect(screen.getByText('Old empty draft')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Restore' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
