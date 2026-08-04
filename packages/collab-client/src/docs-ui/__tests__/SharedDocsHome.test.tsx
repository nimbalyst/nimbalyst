// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, screen } from '@testing-library/react';
import { store } from '@nimbalyst/runtime/store';
import { atom, Provider } from 'jotai';
import { CollabDocsUIProvider, type CollabDocsUIController } from '../CollabDocsUIProvider';
import { SharedDocsHome } from '../SharedDocsHome';
import type { CollabHost } from '@nimbalyst/collab-client/core';
import type { CollabDocsSession, SharedDocument } from '@nimbalyst/collab-client/docs';

const TEST_SCOPE = {
  scopeKey: '/workspace',
  orgId: 'org-1',
  indexConfig: { serverUrl: 'ws://sync', userId: 'user-1' },
};

// MaterialSymbol pulls in font/asset side-effects we don't need for a layout test.
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

// Something reached transitively from this tree still imports the bare runtime
// barrel, which pulls in AgentTranscript's injected stylesheet. Its `:has()`
// rules make jsdom's nwsapi build a selector out of each candidate element's
// classes, and Tailwind arbitrary values (`max-w-[860px]`) are not escaped, so
// it throws "is not a valid selector". Stub the barrel to keep it out of the tree.
vi.mock('@nimbalyst/runtime', () => ({}));

const visibleDocumentsAtom = atom<SharedDocument[]>([]);
const trashedDocumentsAtom = atom<SharedDocument[]>([]);
const emptyDocumentsAtom = atom<SharedDocument[]>([]);
const emptyChangedDocumentsAtom = atom([]);
const emptyFavoritesAtom = atom<string[]>([]);

const controller = {
} satisfies CollabDocsUIController;

const documentTypes = [] as const;
const host = {
  surface: 'desktop',
  documents: {
    documentTypes: () => documentTypes,
    onDocumentTypesChanged: () => () => undefined,
  },
  openArtifact: vi.fn(),
} as unknown as CollabHost;

const session = {
  scope: TEST_SCOPE,
  host,
  atoms: {
    sharedDocuments: visibleDocumentsAtom,
    trashedSharedDocuments: trashedDocumentsAtom,
    favoriteDocuments: emptyDocumentsAtom,
    recentDocuments: emptyDocumentsAtom,
    changedDocuments: emptyChangedDocumentsAtom,
    favorites: emptyFavoritesAtom,
    syncStatus: atom('disconnected'),
  },
  toggleFavorite: vi.fn(),
  emptyTrash: vi.fn(),
  restoreDocument: vi.fn(),
  removeDocument: vi.fn(),
} as unknown as CollabDocsSession;

function renderHome() {
  return render(
    <Provider store={store}>
      <CollabDocsUIProvider session={session} controller={controller}>
        <SharedDocsHome />
      </CollabDocsUIProvider>
    </Provider>,
  );
}

afterEach(() => {
  cleanup();
  store.set(visibleDocumentsAtom, []);
  store.set(trashedDocumentsAtom, []);
  vi.restoreAllMocks();
});

describe('SharedDocsHome', () => {
  it('applies the theme background so the empty state is not transparent', () => {
    // Regression: the full-bleed empty state rendered without a background,
    // showing the bare window color (looked wrong under Solarized Light).
    const { container } = renderHome();
    const root = container.querySelector('.shared-docs-home');
    expect(root).toBeTruthy();
    expect(root?.classList.contains('bg-nim')).toBe(true);
  });

  it('shows trashed documents only in the dedicated Trash view', () => {
    store.set(trashedDocumentsAtom, [{
      documentId: 'trashed-doc',
      teamProjectId: null,
      title: 'Old empty draft',
      documentType: 'markdown',
      createdBy: 'user',
      createdAt: 1,
      updatedAt: 2,
      trashedAt: 2,
    }]);

    renderHome();
    expect(screen.queryByText('Old empty draft')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Trash (1)' }));
    screen.getByText('Old empty draft');
    expect((screen.getByRole('button', { name: 'Restore' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
