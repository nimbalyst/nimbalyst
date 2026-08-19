// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import {
  activeCollabScopeAtom,
  pendingCollabDocumentAtom,
  sharedDocumentsAtom,
  workspaceHasTeamAtom,
  type SharedDocument,
} from '../../store/atoms/collabDocuments';
import { windowModeAtom } from '../../store/atoms/windowMode';
import { openNavigationDialogRequestAtom } from '../../store/atoms/appCommands';

const { openUnifiedQuickOpenMock } = vi.hoisted(() => ({
  openUnifiedQuickOpenMock: vi.fn(),
}));

vi.mock('../../dialogs', () => ({
  useNavigationDialogs: () => ({
    openUnifiedQuickOpen: openUnifiedQuickOpenMock,
  }),
}));

// The four legacy quick-open dialogs are now collapsed into UnifiedQuickOpen.
// This test still exercises the Projects-tab pathway, asserting the lightweight
// recent-workspaces IPC (not the heavy workspaceManager handler) is the source
// of project data.

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ className }: { className?: string }) => <span className={className} />,
}));

vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', async (importOriginal) => ({
  ...await importOriginal<typeof import('@nimbalyst/runtime/ui/icons/ProviderIcons')>(),
  ProviderIcon: () => null,
}));

vi.mock('posthog-js/react', () => ({
  usePostHog: () => undefined,
}));

import { UnifiedQuickOpen } from '../UnifiedQuickOpen';
import { NavigationDialogKeyboardHandler } from '../NavigationDialogKeyboardHandler';

const WORKSPACE = '/Users/ghinkle/sources/crystal';
const TEAM_SCOPE = {
  scopeKey: WORKSPACE,
  orgId: 'team-1',
  indexConfig: { serverUrl: 'ws://sync', teamMemberId: asTeamMemberId('user-1') },
};

function activateTeam(store: ReturnType<typeof createStore>): void {
  store.set(activeCollabScopeAtom, TEAM_SCOPE);
  store.set(workspaceHasTeamAtom, true);
}

function setupElectronApiMock(trackerItems: unknown[] = []) {
  const appSettings = new Map<string, unknown>();
  const invoke = vi.fn().mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'app-settings:get') {
      return appSettings.get(args[0] as string);
    }
    if (channel === 'app-settings:set') {
      appSettings.set(args[0] as string, args[1]);
      return true;
    }
    if (channel === 'get-recent-workspaces') {
      return [
        {
          path: WORKSPACE,
          name: 'crystal',
          timestamp: 123,
        },
        {
          path: '/Users/ghinkle/sources/aurora',
          name: 'aurora',
          timestamp: 122,
        },
      ];
    }
    if (channel === 'sessions:list') {
      return { success: true, sessions: [] };
    }
    if (channel === 'document-service:tracker-items-list') {
      return trackerItems;
    }
    // Any other channel is incidental to what these tests assert; a throw here
    // just turns every unrelated IPC addition into a failure in this file.
    return undefined;
  });

  const getRecentWorkspaces = vi.fn().mockResolvedValue([
    {
      path: '/Users/ghinkle/sources/should-not-be-used',
      name: 'heavy-handler',
      lastOpened: 999,
    },
  ]);

  const getOpenWorkspaces = vi.fn().mockResolvedValue([WORKSPACE]);
  const semanticSearch = {
    isAvailable: vi.fn().mockResolvedValue(false),
    query: vi.fn().mockResolvedValue([]),
  };
  const listUserPrompts = vi.fn().mockResolvedValue({ success: true, prompts: [] });

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      invoke,
      workspaceManager: {
        getRecentWorkspaces,
        getOpenWorkspaces,
        openWorkspace: vi.fn().mockResolvedValue({ success: true }),
      },
      ai: {
        listUserPrompts,
      },
      getRecentWorkspaceFiles: vi.fn().mockResolvedValue([]),
      buildQuickOpenCache: vi.fn().mockResolvedValue(undefined),
      searchWorkspaceFileNames: vi.fn().mockResolvedValue([]),
      searchWorkspaceFileContent: vi.fn().mockResolvedValue([]),
      semanticSearch,
    },
  });

  return { invoke, getRecentWorkspaces, getOpenWorkspaces, appSettings, semanticSearch, listUserPrompts };
}

function renderQuickOpen(
  overrides: Partial<React.ComponentProps<typeof UnifiedQuickOpen>> = {},
  store = createStore(),
) {
  return render(
    <JotaiProvider store={store}>
      <UnifiedQuickOpen
        isOpen={true}
        onClose={vi.fn()}
        workspacePath={WORKSPACE}
        onFileSelect={vi.fn()}
        onSessionSelect={vi.fn()}
        onPromptSelect={vi.fn()}
        {...overrides}
      />
    </JotaiProvider>
  );
}

function sharedDoc(
  documentId: string,
  title: string,
  extra: Partial<SharedDocument> = {},
): SharedDocument {
  return {
    documentId,
    teamProjectId: null,
    title,
    documentType: 'markdown',
    createdBy: 'user-1',
    createdAt: 100,
    updatedAt: 200,
    ...extra,
  };
}

function typeSearch(value: string) {
  fireEvent.change(screen.getByTestId('unified-quick-open-search'), { target: { value } });
}

function renderKeyboardHandler(store = createStore()) {
  return render(
    <JotaiProvider store={store}>
      <NavigationDialogKeyboardHandler
        workspaceMode={true}
        workspacePath={WORKSPACE}
        currentFilePath={null}
        onFileSelect={vi.fn()}
        onSessionSelect={vi.fn()}
        onPromptSelect={vi.fn()}
        documentContext={{}}
      />
    </JotaiProvider>
  );
}

describe('UnifiedQuickOpen — Projects tab', () => {
  beforeEach(() => {
    setupElectronApiMock();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('loads recent projects from the lightweight recent-workspaces IPC', async () => {
    renderQuickOpen({ initialTab: 'projects' });

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('get-recent-workspaces');
    });

    expect(window.electronAPI.workspaceManager.getOpenWorkspaces).toHaveBeenCalled();
    expect(window.electronAPI.workspaceManager.getRecentWorkspaces).not.toHaveBeenCalled();
    await screen.findByText('crystal');
  });

  it('does not filter hidden projects while typing in the Files tab', async () => {
    renderQuickOpen({ initialTab: 'files' });

    await screen.findByText('crystal');
    await screen.findByText('aurora');

    typeSearch('crystal');

    await waitFor(() => {
      expect(window.electronAPI.searchWorkspaceFileNames).toHaveBeenCalledWith(
        WORKSPACE,
        'crystal',
        undefined,
      );
    });

    screen.getByText('aurora');
  });

  it('finds a shared file in the Files tab and opens it collaboratively', async () => {
    const store = createStore();
    const onClose = vi.fn();
    const onFileSelect = vi.fn();
    store.set(activeWorkspacePathAtom, WORKSPACE);
    activateTeam(store);
    store.set(sharedDocumentsAtom, [sharedDoc('doc-roadmap', 'Planning/Product Roadmap')]);

    renderQuickOpen({ initialTab: 'files', onClose, onFileSelect }, store);

    typeSearch('roadmap');

    const sharedResult = await screen.findByTestId('shared-file-quick-open-doc-roadmap');
    expect(sharedResult.textContent).toContain('Product Roadmap');

    fireEvent.click(sharedResult);

    expect(onFileSelect).not.toHaveBeenCalled();
    expect(store.get(pendingCollabDocumentAtom)).toEqual({
      documentId: 'doc-roadmap',
      documentType: 'markdown',
      scopeKey: WORKSPACE,
      orgId: 'team-1',
      analyticsSource: 'quick_open',
    });
    expect(store.get(windowModeAtom)).toBe('collab');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('passes the file mask to file-name search before result truncation', async () => {
    renderQuickOpen({ initialTab: 'files' });

    fireEvent.click(screen.getByTitle('Mask'));
    fireEvent.change(screen.getByPlaceholderText('*.ts,*.tsx'), {
      target: { value: '*.md' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText('*.ts,*.tsx'), {
      key: 'Enter',
      code: 'Enter',
    });

    typeSearch('tracker');

    await waitFor(() => {
      expect(window.electronAPI.searchWorkspaceFileNames).toHaveBeenCalledWith(
        WORKSPACE,
        'tracker',
        { fileMask: '*.md' },
      );
    });
  });

  it('remembers the selected file mask across dialog remounts', async () => {
    const { appSettings } = setupElectronApiMock();

    const { unmount } = renderQuickOpen({ initialTab: 'files' });

    fireEvent.click(screen.getByTitle('Mask'));
    fireEvent.click(screen.getByText('Markdown'));

    await waitFor(() => {
      expect(appSettings.get('unifiedQuickOpen.selectedFileMask')).toBe('*.md,*.mdx');
    });

    unmount();

    renderQuickOpen({ initialTab: 'files' });

    await waitFor(() => {
      screen.getByTitle('Mask: Markdown');
    });
  });

  it('opens the tracker type picker with Ctrl+T', async () => {
    renderQuickOpen({ initialTab: 'files' });

    fireEvent.keyDown(window, {
      key: 't',
      code: 'KeyT',
      ctrlKey: true,
    });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Trackers/ }).getAttribute('aria-selected')).toBe('true');
      screen.getByPlaceholderText('custom-type');
    });
  });
});

describe('UnifiedQuickOpen — Memory tab', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('merges Tracker navigation into visible single-select Memory bubbles', async () => {
    const { semanticSearch } = setupElectronApiMock();
    semanticSearch.isAvailable.mockResolvedValue(true);

    renderQuickOpen({ initialTab: 'search' });

    await screen.findByRole('tab', { name: /Memory/ });
    expect(screen.queryByRole('tab', { name: /Trackers/ })).toBeNull();
    const scopeGroup = await screen.findByRole('group', { name: 'Search in' });
    const allScope = within(scopeGroup).getByRole('button', { name: 'All' });
    const docsScope = within(scopeGroup).getByRole('button', { name: 'Docs' });
    const trackersScope = within(scopeGroup).getByRole('button', { name: 'Trackers' });
    const sessionsScope = within(scopeGroup).getByRole('button', { name: 'Sessions' });

    expect(allScope.getAttribute('aria-pressed')).toBe('true');
    expect(docsScope.getAttribute('aria-pressed')).toBe('false');
    expect(trackersScope.getAttribute('aria-pressed')).toBe('false');
    expect(sessionsScope.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(trackersScope);
    typeSearch('login failure');

    await waitFor(() => {
      expect(semanticSearch.query).toHaveBeenLastCalledWith(
        WORKSPACE,
        'login failure',
        25,
        ['trackers'],
      );
    });
    expect(trackersScope.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(docsScope);

    await waitFor(() => {
      expect(semanticSearch.query).toHaveBeenLastCalledWith(
        WORKSPACE,
        'login failure',
        25,
        ['design', 'docs', 'plans', 'claude', 'facts'],
      );
    });
    expect(docsScope.getAttribute('aria-pressed')).toBe('true');
    expect(trackersScope.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(docsScope);
    expect(allScope.getAttribute('aria-pressed')).toBe('true');
    expect(docsScope.getAttribute('aria-pressed')).toBe('false');
  });

  it('adds semantic tracker hits to the rich Tracker results', async () => {
    const { semanticSearch } = setupElectronApiMock([
      {
        id: 'tracker-semantic',
        issueKey: 'NIM-4242',
        title: 'Collaboration retry policy',
        description: 'Handles reconnect backoff for shared rooms.',
        type: 'bug',
        typeTags: [],
        status: 'open',
        priority: 'high',
        tags: [],
        archived: false,
        updated: '2026-07-23T12:00:00.000Z',
      },
    ]);
    semanticSearch.isAvailable.mockResolvedValue(true);
    semanticSearch.query.mockResolvedValue([
      {
        refType: 'tracker',
        refId: 'tracker-semantic',
        sourceClass: 'trackers',
        sourcePath: 'tracker:tracker-semantic',
        title: 'Collaboration retry policy',
        snippet: 'Handles reconnect backoff for shared rooms.',
        score: 0.91,
        signals: { dense: true, sparse: false },
      },
    ]);

    renderQuickOpen({ initialTab: 'search' });

    await screen.findByRole('group', { name: 'Search in' });
    fireEvent.click(screen.getByRole('button', { name: 'Trackers' }));
    // The query matches nothing lexically, so the hit can only come from the
    // semantic route being merged into the tracker results.
    typeSearch('shared room resilience');

    await screen.findByText('Collaboration retry policy');
  });

  it('keeps local file-content search on the separate ripgrep route', async () => {
    const { semanticSearch } = setupElectronApiMock();

    renderQuickOpen({ initialTab: 'in-files' });

    typeSearch('UnifiedQuickOpen');

    await waitFor(() => {
      expect(window.electronAPI.searchWorkspaceFileContent).toHaveBeenCalledWith(
        WORKSPACE,
        'UnifiedQuickOpen',
      );
    });
    expect(semanticSearch.query).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Search in' })).toBeNull();
  });
});

describe('UnifiedQuickOpen — Prompts tab', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('filters forward-provenance prompts with visible actor toggles', async () => {
    const { listUserPrompts } = setupElectronApiMock();
    listUserPrompts.mockResolvedValue({
      success: true,
      prompts: [
        {
          id: 'human-prompt',
          sessionId: 'session-human',
          content: 'web console design question',
          createdAt: 3,
          sessionTitle: 'Human session',
          provider: 'openai-codex',
          promptActor: 'human',
        },
        {
          id: 'agent-prompt',
          sessionId: 'session-agent',
          content: 'web console implementation task',
          createdAt: 2,
          sessionTitle: 'Agent session',
          provider: 'claude-code',
          promptActor: 'agent',
        },
        {
          id: 'historical-prompt',
          sessionId: 'session-old',
          content: 'web console historical prompt',
          createdAt: 1,
          sessionTitle: 'Historical session',
          provider: 'claude-code',
        },
      ],
    });

    renderQuickOpen({ initialTab: 'prompts' });

    await screen.findByText('web console design question');
    const actorGroup = screen.getByRole('group', { name: 'Prompts from' });
    const allPrompts = within(actorGroup).getByRole('button', { name: 'All' });
    const myPrompts = within(actorGroup).getByRole('button', { name: 'Me' });
    const agentPrompts = within(actorGroup).getByRole('button', { name: 'Agents' });

    expect(allPrompts.getAttribute('aria-pressed')).toBe('true');
    screen.getByText('web console implementation task');
    screen.getByText('web console historical prompt');

    typeSearch('web');
    fireEvent.click(myPrompts);
    screen.getByText('web console design question');
    expect(screen.queryByText('web console implementation task')).toBeNull();
    expect(screen.queryByText('web console historical prompt')).toBeNull();
    expect(myPrompts.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(agentPrompts);
    screen.getByText('web console implementation task');
    expect(screen.queryByText('web console design question')).toBeNull();
    expect(screen.queryByText('web console historical prompt')).toBeNull();
    expect(agentPrompts.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(agentPrompts);
    expect(allPrompts.getAttribute('aria-pressed')).toBe('true');
    screen.getByText('web console design question');
    screen.getByText('web console implementation task');
    screen.getByText('web console historical prompt');
  });
});

describe('UnifiedQuickOpen — Team tab', () => {
  beforeEach(() => {
    setupElectronApiMock();
    openUnifiedQuickOpenMock.mockReset();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('only shows shared documents when the active workspace has a team', async () => {
    const withoutTeamStore = createStore();
    withoutTeamStore.set(activeWorkspacePathAtom, WORKSPACE);

    const { unmount } = renderQuickOpen({}, withoutTeamStore);

    expect(screen.queryByRole('tab', { name: /Team/ })).toBeNull();
    unmount();

    const withTeamStore = createStore();
    withTeamStore.set(activeWorkspacePathAtom, WORKSPACE);
    activateTeam(withTeamStore);
    withTeamStore.set(sharedDocumentsAtom, [sharedDoc('doc-roadmap', 'Planning/Product Roadmap')]);

    renderQuickOpen({ initialTab: 'team' }, withTeamStore);

    await screen.findByRole('tab', { name: /Team/ });
    screen.getByText('Product Roadmap');
  });

  it('filters by display name and excludes locked documents', async () => {
    const store = createStore();
    store.set(activeWorkspacePathAtom, WORKSPACE);
    activateTeam(store);
    store.set(sharedDocumentsAtom, [
      sharedDoc('doc-roadmap', 'Planning/Product Roadmap'),
      sharedDoc('doc-retro', 'Planning/Team Retrospective'),
      sharedDoc('doc-locked', 'Planning/Locked Strategy', { decryptFailed: true }),
    ]);

    renderQuickOpen({ initialTab: 'team' }, store);

    screen.getByText('Product Roadmap');
    screen.getByText('Team Retrospective');
    expect(screen.queryByText('Locked Strategy')).toBeNull();

    typeSearch('roadmap');

    screen.getByText('Product Roadmap');
    expect(screen.queryByText('Team Retrospective')).toBeNull();
  });

  it('routes selection through the pending shared-document atom and collab mode', async () => {
    const store = createStore();
    const onClose = vi.fn();
    store.set(activeWorkspacePathAtom, WORKSPACE);
    activateTeam(store);
    store.set(sharedDocumentsAtom, [
      sharedDoc('doc-canvas', 'Design/Launch Canvas', { documentType: 'excalidraw' }),
    ]);

    renderQuickOpen({ initialTab: 'team', onClose }, store);

    fireEvent.click(screen.getByText('Launch Canvas'));

    expect(store.get(pendingCollabDocumentAtom)).toEqual({
      documentId: 'doc-canvas',
      documentType: 'excalidraw',
      scopeKey: WORKSPACE,
      orgId: 'team-1',
      analyticsSource: 'quick_open',
    });
    expect(store.get(windowModeAtom)).toBe('collab');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('jumps to the Team tab with Cmd+Shift+D while the palette is open', async () => {
    const store = createStore();
    store.set(activeWorkspacePathAtom, WORKSPACE);
    activateTeam(store);

    renderQuickOpen({ initialTab: 'files' }, store);

    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true });

    expect(screen.getByRole('tab', { name: /Team/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens on Team with Cmd+Shift+D only when the workspace has a team', async () => {
    const withoutTeamStore = createStore();
    withoutTeamStore.set(activeWorkspacePathAtom, WORKSPACE);
    const { unmount } = renderKeyboardHandler(withoutTeamStore);

    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true });
    expect(openUnifiedQuickOpenMock).not.toHaveBeenCalled();
    unmount();

    const withTeamStore = createStore();
    withTeamStore.set(activeWorkspacePathAtom, WORKSPACE);
    activateTeam(withTeamStore);
    renderKeyboardHandler(withTeamStore);

    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true });

    expect(openUnifiedQuickOpenMock).toHaveBeenCalledWith(
      expect.objectContaining({ initialTab: 'team' }),
    );
  });

  it('does not replay a rejected Team menu request when team availability changes', async () => {
    const store = createStore();
    store.set(activeWorkspacePathAtom, WORKSPACE);

    renderKeyboardHandler(store);

    act(() => {
      store.set(openNavigationDialogRequestAtom, {
        version: 1,
        dialogId: 'team-quick-open',
      });
    });
    expect(openUnifiedQuickOpenMock).not.toHaveBeenCalled();

    act(() => {
      activateTeam(store);
    });
    expect(openUnifiedQuickOpenMock).not.toHaveBeenCalled();

    act(() => {
      store.set(openNavigationDialogRequestAtom, {
        version: 2,
        dialogId: 'team-quick-open',
      });
    });

    await waitFor(() => {
      expect(openUnifiedQuickOpenMock).toHaveBeenCalledWith(
        expect.objectContaining({ initialTab: 'team' }),
      );
    });
  });
});
