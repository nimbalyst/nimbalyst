// @vitest-environment jsdom
import React, { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

const SCOPE: CollabScope = {
  scopeKey: '/workspace',
  orgId: 'test-org',
  indexConfig: { serverUrl: 'wss://example.test', teamMemberId: asTeamMemberId('test-user') },
};

const persistenceMocks = vi.hoisted(() => ({
  load: vi.fn(),
  persist: vi.fn(),
}));
const openerMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));
const hostMocks = vi.hoisted(() => ({
  adapter: null as null | ((ref: any, source: string) => void),
  personalAdapter: null as null | ((target: any, source: string) => void),
  /** Team scope resolution for the outer CollabMode's real lifecycle. */
  resolveScope: null as null | (() => Promise<CollabScope>),
}));
/** What a link can open: the current project's pages, then other projects'. */
const linkable = vi.hoisted(() => ({ documents: [] as any[] }));
const PERSONAL_SCOPE: CollabScope = {
  scopeKey: 'personal:/workspace',
  orgId: 'local',
  indexConfig: { serverUrl: '', teamMemberId: asTeamMemberId('local'), teamProjectId: null },
};

// No item here is a Local wiki file.
vi.mock('../../../services/localWikiTrackerRecords', () => ({ localWikiFilePathForItem: () => null }));
vi.mock('@nimbalyst/runtime/store', () => ({
  store: { get: vi.fn(() => []), set: vi.fn() },
}));

vi.mock('../../../utils/collabOpenDocsPersistence', () => ({
  loadOpenCollabTabs: persistenceMocks.load,
  persistOpenCollabDocs: persistenceMocks.persist,
  isPersistedCollabPageEntry: (entry: any) => ['tracker', 'type', 'personal'].includes(entry.kind),
}));

vi.mock('../../../utils/collabDocumentOpener', () => ({
  getCollabConfig: vi.fn(() => undefined),
  updateCollabConfigDisplayMetadata: vi.fn(),
  openCollabDocumentViaIPC: openerMocks.open,
}));

vi.mock('../../../store/atoms/collabDocuments', async () => {
  const { atom } = await import('jotai');
  // One session per scope, like the real getter: a new atom per render never settles.
  const teamSession = { atoms: { sharedDocuments: atom([]) } };
  return {
    initSharedDocuments: vi.fn(),
    getElectronCollabHostForScopeKey: () => ({
      resolveScope: () => hostMocks.resolveScope!(),
      onScopeChanged: () => () => undefined,
    }),
    rebindElectronCollabHostScope: vi.fn(),
    getElectronCollabHost: () => ({
      setOpenArtifactAdapter: vi.fn((adapter: (ref: any, source: string) => void) => {
        hostMocks.adapter = adapter;
        return () => undefined;
      }),
    }),
    getPersonalCollabHost: () => ({
      setOpenArtifactAdapter: vi.fn((adapter: (target: any, source: string) => void) => {
        hostMocks.personalAdapter = adapter;
        return () => undefined;
      }),
      source: () => ({ filePathsById: () => new Map(), documentIdForFile: () => null }),
    }),
    getPersonalCollabDocsSession: () => personalSession,
    getElectronCollabDocsSession: () => teamSession,
    pendingCollabDocumentAtom: atom(null),
    sharedDocumentsAtom: atom([]),
    sharedFoldersAtom: atom([]),
    linkableSharedDocumentsAtom: atom(() => linkable.documents),
    getLinkableSharedDocumentsForScopeKey: () => linkable.documents,
  };
});
const personalSession = vi.hoisted(() => ({
  scope: null as any,
  start: async () => undefined,
  atoms: { sharedDocuments: null as any },
}));

vi.mock('../../../hooks/useDocUnread', () => ({ useDocUnread: () => undefined }));

vi.mock('../../../store/atoms/collabDiscovery', async () => {
  const { atom } = await import('jotai');
  return {
    changedDocIdsAtom: atom(new Set<string>()),
    hydrateCollabDiscovery: vi.fn(),
    hydrateCollabPersonalState: vi.fn(async () => undefined),
  };
});

vi.mock('../../../utils/teamAnalytics', () => ({
  trackTeamAnalyticsEvent: vi.fn(),
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

vi.mock('@nimbalyst/collab-client/docs-ui', () => ({
  CollabSidebar: ({ sectionTitle }: { sectionTitle?: string }) => (
    <div data-testid={sectionTitle === 'Local' ? 'collab-sidebar-personal' : 'collab-sidebar'} />
  ),
  PagesSectionEntries: () => null,
}));

vi.mock('../ElectronCollabDocsUIProvider', () => ({
  ElectronCollabDocsUIRoot: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../useCollabTypeResolver', () => ({ useCollabTypeResolver: () => undefined }));

vi.mock('../../TabManager/TabManager', () => ({
  TabManager: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tab-manager">{children}</div>
  ),
}));

// Lists the provider's tabs, so a test that mounts the outer CollabMode (and
// so cannot place a probe inside its TabsProvider) can still read them.
vi.mock('../../TabContent/TabContent', async () => {
  const { useTabs: useProviderTabs } = await import('../../../contexts/TabsContext');
  return {
    TabContent: () => (
      <div data-testid="tab-content">
        {useProviderTabs().tabs.map((tab) => (
          <div key={tab.id} data-testid="content-tab" data-path={tab.filePath} data-filename={tab.fileName} />
        ))}
      </div>
    ),
  };
});

vi.mock('../../ChatSidebar', () => ({
  ChatSidebar: () => <div data-testid="chat-sidebar" />,
}));

import { TabsProvider, useTabs } from '../../../contexts/TabsContext';
import { CollabScopeResolutionError } from '@nimbalyst/collab-client/core';
import { CollabMode, CollabModeInner, type CollabModeRef } from '../CollabMode';

function TabProbe() {
  const { tabs } = useTabs();
  return (
    <div data-testid="tab-probe">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          data-testid="collab-tab"
          data-filename={tab.fileName}
          data-path={tab.filePath}
          data-pinned={String(tab.isPinned)}
        />
      ))}
    </div>
  );
}

describe('CollabMode pinned tab persistence', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { atom } = await import('jotai');
    personalSession.atoms.sharedDocuments = atom([]);
    personalSession.scope = PERSONAL_SCOPE;
    hostMocks.resolveScope = async () => SCOPE;
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

  afterEach(async () => {
    cleanup();
    delete (window as any).electronAPI;
    linkable.documents = [];
    // CollabMode clears a pending deep link through the mocked runtime store.
    const { getDefaultStore } = await import('jotai');
    const { pendingCollabDocumentAtom } = await import('../../../store/atoms/collabDocuments');
    getDefaultStore().set(pendingCollabDocumentAtom as any, null);
  });

  // Another project's page is not in the window's lists, but a link to it
  // still opens with its title and in its own editor.
  it("opens a link or deep link to another project's page with its metadata", async () => {
    persistenceMocks.load.mockResolvedValue([]);
    linkable.documents = [{
      documentId: 'their-diagram',
      teamProjectId: 'project-b',
      title: 'Their diagram',
      documentType: 'excalidraw',
      editorId: 'builtin.excalidraw',
      createdBy: 'u',
      createdAt: 1,
      updatedAt: 1,
    }, {
      documentId: 'their-mockup',
      teamProjectId: 'project-b',
      title: 'Their mockup',
      documentType: 'mockup',
      createdBy: 'u',
      createdAt: 1,
      updatedAt: 1,
    }];
    render(
      <TabsProvider workspacePath="/workspace" disablePersistence>
        <CollabModeInner workspacePath="/workspace" teamScope={SCOPE} personalScope={PERSONAL_SCOPE} isActive onFileOpen={() => {}} />
        <TabProbe />
      </TabsProvider>,
    );
    await waitFor(() => expect(hostMocks.adapter).not.toBeNull());

    act(() => {
      hostMocks.adapter!({ kind: 'document', scope: SCOPE, documentId: 'their-diagram', teamProjectId: 'project-b' }, 'sidebar');
    });
    await waitFor(() => expect(openerMocks.open).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'their-diagram', title: 'Their diagram', documentType: 'excalidraw', editorId: 'builtin.excalidraw',
    })));

    openerMocks.open.mockClear();
    const { getDefaultStore } = await import('jotai');
    const { pendingCollabDocumentAtom } = await import('../../../store/atoms/collabDocuments');
    act(() => {
      getDefaultStore().set(pendingCollabDocumentAtom as any, { scopeKey: SCOPE.scopeKey, orgId: SCOPE.orgId, documentId: 'their-mockup' });
    });
    await waitFor(() => expect(openerMocks.open).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'their-mockup', title: 'Their mockup', documentType: 'mockup',
    })));
  });

  it('restores persisted pin state and tab order, then writes both back', async () => {
    render(
      <TabsProvider workspacePath="/workspace" disablePersistence>
        <CollabModeInner
          workspacePath="/workspace"
          teamScope={SCOPE}
          personalScope={PERSONAL_SCOPE}
          isActive
          onFileOpen={() => {}}
        />
        <TabProbe />
      </TabsProvider>,
    );

    expect(screen.getByTestId('collab-sidebar')).toBeTruthy();

    await waitFor(() => expect(openerMocks.open).toHaveBeenCalledTimes(2));
    expect(openerMocks.open.mock.calls.map(([options]) => ({
      documentId: options.documentId,
      isPinned: options.isPinned,
      scope: options.scope,
    }))).toEqual([
      { documentId: 'pinned-doc', isPinned: true, scope: SCOPE },
      { documentId: 'regular-doc', isPinned: false, scope: SCOPE },
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
      SCOPE,
      [
        expect.objectContaining({ documentId: 'pinned-doc', isPinned: true }),
        expect.objectContaining({ documentId: 'regular-doc', isPinned: false }),
      ],
    ));
  });

  it('restores item and type page tabs between doc tabs, then writes all of them back in order', async () => {
    persistenceMocks.load.mockResolvedValue([
      { kind: 'type', artifactId: 'module', title: 'Modules', isPinned: true },
      { documentId: 'regular-doc', documentType: 'markdown', displayPath: 'Regular document' },
      { kind: 'tracker', artifactId: 'item-flags', title: 'Flags' },
    ]);
    render(
      <TabsProvider workspacePath="/workspace" disablePersistence>
        <CollabModeInner workspacePath="/workspace" teamScope={SCOPE} personalScope={PERSONAL_SCOPE} isActive onFileOpen={() => {}} />
        <TabProbe />
      </TabsProvider>,
    );

    await waitFor(() => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="collab-tab"]'));
      expect(tabs.slice(0, 3).map((tab) => [tab.dataset.path, tab.dataset.filename, tab.dataset.pinned])).toEqual([
        ['type://module', 'Modules', 'true'],
        ['collab://org:test-org:doc:regular-doc', 'Regular document', 'false'],
        ['tracker://item-flags', 'Flags', 'false'],
      ]);
    });
    expect(openerMocks.open).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(persistenceMocks.persist).toHaveBeenLastCalledWith(SCOPE, [
      { kind: 'type', artifactId: 'module', title: 'Modules', isPinned: true },
      expect.objectContaining({ documentId: 'regular-doc' }),
      { kind: 'tracker', artifactId: 'item-flags', title: 'Flags', isPinned: false },
    ]));
  });

  it('opens tracker and type artifacts as tabs in this mode', async () => {
    persistenceMocks.load.mockResolvedValue([]);
    render(
      <TabsProvider workspacePath="/workspace" disablePersistence>
        <CollabModeInner workspacePath="/workspace" teamScope={SCOPE} personalScope={PERSONAL_SCOPE} isActive onFileOpen={() => {}} />
        <TabProbe />
      </TabsProvider>,
    );
    await waitFor(() => expect(hostMocks.adapter).not.toBeNull());

    act(() => {
      hostMocks.adapter!({ kind: 'type', scope: SCOPE, typeId: 'module' }, 'sidebar');
      hostMocks.adapter!({ kind: 'tracker', scope: SCOPE, trackerId: 'item-flags' }, 'sidebar');
      hostMocks.adapter!({ kind: 'tracker', scope: { ...SCOPE, scopeKey: '/elsewhere' }, trackerId: 'x' }, 'sidebar');
    });

    await waitFor(() => {
      const paths = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="collab-tab"]'))
        .map((tab) => tab.dataset.path);
      expect(paths).toContain('type://module');
      expect(paths).toContain('tracker://item-flags');
      expect(paths).not.toContain('tracker://x');
    });
  });

  it('runs the Personal section when signed out: personal tabs open, team doc tabs are held, no error logged', async () => {
    hostMocks.resolveScope = async () => {
      throw new CollabScopeResolutionError('Not authenticated', { retryable: false });
    };
    const consoleError = vi.spyOn(console, 'error');
    persistenceMocks.load.mockResolvedValue([
      { kind: 'personal', artifactId: 'pdoc-1', title: 'Reading list' },
      { documentId: 'team-doc', documentType: 'markdown', displayPath: 'Team doc' },
    ]);
    render(<CollabMode workspacePath="/workspace" isActive onFileOpen={() => {}} />);

    expect(screen.getByTestId('collab-sidebar-personal')).toBeTruthy();
    expect(screen.queryByTestId('collab-sidebar')).toBeNull();
    expect(screen.getByTestId('pages-sidebar-team-note').textContent)
      .toBe('Sign in and share this project to see team pages');
    await waitFor(() => expect(hostMocks.personalAdapter).not.toBeNull());
    act(() => {
      hostMocks.personalAdapter!({ kind: 'personal-page', documentId: 'pdoc-2', path: 'personal://pdoc-2', title: 'Ideas' }, 'sidebar');
    });

    await waitFor(() => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="content-tab"]'))
        .map((tab) => [tab.dataset.path, tab.dataset.filename]);
      expect(tabs).toEqual([['personal://pdoc-1', 'Reading list'], ['personal://pdoc-2', 'Ideas']]);
    });
    // No team scope: no doc opens and no team home tab, but the doc entry survives.
    expect(openerMocks.open).not.toHaveBeenCalled();
    await waitFor(() => expect(persistenceMocks.persist).toHaveBeenLastCalledWith(
      expect.objectContaining({ scopeKey: '/workspace' }),
      [
        expect.objectContaining({ kind: 'personal', artifactId: 'pdoc-1' }),
        expect.objectContaining({ kind: 'personal', artifactId: 'pdoc-2' }),
        expect.objectContaining({ documentId: 'team-doc' }),
      ],
    ));
    // Signed out is the normal Personal-only state, not a failure.
    expect(consoleError).not.toHaveBeenCalledWith(
      '[CollabMode] Failed to resolve collaboration scope:',
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  it('keeps a held team tab that fails to reopen when the team scope arrives', async () => {
    persistenceMocks.load.mockResolvedValue([
      { documentId: 'good-doc', documentType: 'markdown', displayPath: 'Good doc' },
      { documentId: 'broken-doc', documentType: 'markdown', displayPath: 'Broken doc' },
    ]);
    const defaultOpen = openerMocks.open.getMockImplementation()!;
    openerMocks.open.mockImplementation(async (options: any) => {
      if (options.documentId === 'broken-doc') throw new Error('room unavailable');
      return defaultOpen(options);
    });
    const view = (teamScope: CollabScope | null) => (
      <TabsProvider workspacePath="/workspace" disablePersistence>
        <CollabModeInner workspacePath="/workspace" teamScope={teamScope} personalScope={PERSONAL_SCOPE} isActive onFileOpen={() => {}} />
        <TabProbe />
      </TabsProvider>
    );
    const { rerender } = render(view(null));
    await waitFor(() => expect(persistenceMocks.persist).toHaveBeenCalled());
    expect(openerMocks.open).not.toHaveBeenCalled();

    rerender(view(SCOPE));

    await waitFor(() => expect(openerMocks.open).toHaveBeenCalledTimes(2));
    // The reopened tab is written as a tab; the failed one stays held.
    await waitFor(() => expect(persistenceMocks.persist).toHaveBeenLastCalledWith(SCOPE, [
      expect.objectContaining({ documentId: 'good-doc' }),
      expect.objectContaining({ documentId: 'broken-doc' }),
    ]));
  });

  it('exposes the existing persisted pane toggles and reports their state', async () => {
    const ref = createRef<CollabModeRef>();
    const onPanelStateChange = vi.fn();

    render(
      <TabsProvider workspacePath="/workspace" disablePersistence>
        <CollabModeInner
          ref={ref}
          workspacePath="/workspace"
          teamScope={SCOPE}
          personalScope={PERSONAL_SCOPE}
          isActive
          onFileOpen={() => {}}
          onPanelStateChange={onPanelStateChange}
        />
      </TabsProvider>,
    );

    await waitFor(() => expect(ref.current).not.toBeNull());
    await act(async () => {
      ref.current?.toggleSidebarCollapsed();
    });
    await waitFor(() => expect(onPanelStateChange).toHaveBeenLastCalledWith({
      sidebarCollapsed: true,
      chatCollapsed: false,
    }));
    await act(async () => {
      ref.current?.toggleChatCollapsed();
    });

    await waitFor(() => expect(onPanelStateChange).toHaveBeenLastCalledWith({
      sidebarCollapsed: true,
      chatCollapsed: true,
    }));
    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith(
        'workspace:update-state',
        '/workspace',
        expect.objectContaining({
          collabLayout: expect.objectContaining({
            sidebarCollapsed: true,
            chatCollapsed: true,
          }),
        }),
      );
    });
  });
});
