import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const persistenceMocks = vi.hoisted(() => ({
  load: vi.fn(),
  persist: vi.fn(),
}));
const openerMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('@nimbalyst/runtime/store', () => ({
  store: { get: vi.fn(() => []), set: vi.fn() },
}));

vi.mock('../../../utils/collabOpenDocsPersistence', () => ({
  loadOpenCollabDocs: persistenceMocks.load,
  persistOpenCollabDocs: persistenceMocks.persist,
}));

vi.mock('../../../utils/collabDocumentOpener', () => ({
  getCollabConfig: vi.fn(() => undefined),
  updateCollabConfigDisplayMetadata: vi.fn(),
  openCollabDocumentViaIPC: openerMocks.open,
}));

vi.mock('../../../store/atoms/collabDocuments', async () => {
  const { atom } = await import('jotai');
  return {
    initSharedDocuments: vi.fn(),
    pendingCollabDocumentAtom: atom(null),
    sharedDocumentsAtom: atom([]),
    sharedFoldersAtom: atom([]),
  };
});

vi.mock('../../../store/atoms/collabDiscovery', () => ({
  hydrateCollabDiscovery: vi.fn(),
}));

vi.mock('../../../services/ErrorNotificationService', () => ({
  errorNotificationService: { showError: vi.fn() },
}));

vi.mock('../../UnifiedAI/TextSelectionIndicator', () => ({
  getTextSelection: vi.fn(() => null),
}));

vi.mock('../../../stores/editorContextStore', () => ({
  getActiveEditorContextItems: vi.fn(() => []),
}));

vi.mock('../CollabSidebar', () => ({
  CollabSidebar: () => <div data-testid="collab-sidebar" />,
}));

vi.mock('../../TabManager/TabManager', () => ({
  TabManager: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tab-manager">{children}</div>
  ),
}));

vi.mock('../../TabContent/TabContent', () => ({
  TabContent: () => <div data-testid="tab-content" />,
}));

vi.mock('../../ChatSidebar', () => ({
  ChatSidebar: () => <div data-testid="chat-sidebar" />,
}));

import { TabsProvider, useTabs } from '../../../contexts/TabsContext';
import { CollabModeInner } from '../CollabMode';

function TabProbe() {
  const { tabs } = useTabs();
  return (
    <div data-testid="tab-probe">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          data-testid="collab-tab"
          data-filename={tab.fileName}
          data-pinned={String(tab.isPinned)}
        />
      ))}
    </div>
  );
}

describe('CollabMode pinned tab persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).electronAPI = {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'workspace:get-state') return {};
        if (channel === 'workspace:update-state') return undefined;
        throw new Error(`Unexpected channel: ${channel}`);
      }),
    };

    persistenceMocks.load.mockResolvedValue([
      {
        documentId: 'pinned-doc',
        documentType: 'markdown',
        displayPath: 'Pinned document',
        isPinned: true,
      },
      {
        documentId: 'regular-doc',
        documentType: 'markdown',
        displayPath: 'Regular document',
        isPinned: false,
      },
    ]);
    persistenceMocks.persist.mockResolvedValue(undefined);
    openerMocks.open.mockImplementation(async (options: any) => {
      const uri = `collab://org:test-org:doc:${options.documentId}`;
      const initialState = options.isPinned === undefined
        ? undefined
        : { isPinned: options.isPinned };
      return options.addTab(uri, '', true, options.title, initialState);
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as any).electronAPI;
  });

  it('restores persisted pin state and tab order, then writes both back', async () => {
    render(
      <TabsProvider workspacePath="/workspace" disablePersistence>
        <CollabModeInner
          workspacePath="/workspace"
          isActive
          onFileOpen={() => {}}
        />
        <TabProbe />
      </TabsProvider>,
    );

    await waitFor(() => expect(openerMocks.open).toHaveBeenCalledTimes(2));
    expect(openerMocks.open.mock.calls.map(([options]) => ({
      documentId: options.documentId,
      isPinned: options.isPinned,
    }))).toEqual([
      { documentId: 'pinned-doc', isPinned: true },
      { documentId: 'regular-doc', isPinned: false },
    ]);

    await waitFor(() => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="collab-tab"]'));
      expect(tabs.slice(0, 2).map((tab) => ({
        title: tab.dataset.filename,
        isPinned: tab.dataset.pinned,
      }))).toEqual([
        { title: 'Pinned document', isPinned: 'true' },
        { title: 'Regular document', isPinned: 'false' },
      ]);
    });

    await waitFor(() => expect(persistenceMocks.persist).toHaveBeenCalledWith(
      '/workspace',
      [
        expect.objectContaining({ documentId: 'pinned-doc', isPinned: true }),
        expect.objectContaining({ documentId: 'regular-doc', isPinned: false }),
      ],
    ));
  });
});
