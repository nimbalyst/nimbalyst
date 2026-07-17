// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import {
  pendingCollabDocumentAtom,
  sharedDocumentsAtom,
  workspaceHasTeamAtom,
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

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: () => null,
  ProviderIcon: () => null,
}));

vi.mock('posthog-js/react', () => ({
  usePostHog: () => undefined,
}));

function setupElectronApiMock() {
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
          path: '/Users/ghinkle/sources/crystal',
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
    throw new Error(`Unexpected invoke channel: ${channel}`);
  });

  const getRecentWorkspaces = vi.fn().mockResolvedValue([
    {
      path: '/Users/ghinkle/sources/should-not-be-used',
      name: 'heavy-handler',
      lastOpened: 999,
    },
  ]);

  const getOpenWorkspaces = vi.fn().mockResolvedValue(['/Users/ghinkle/sources/crystal']);

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
        listUserPrompts: vi.fn().mockResolvedValue({ success: true, prompts: [] }),
      },
      getRecentWorkspaceFiles: vi.fn().mockResolvedValue([]),
      buildQuickOpenCache: vi.fn().mockResolvedValue(undefined),
      searchWorkspaceFileNames: vi.fn().mockResolvedValue([]),
      searchWorkspaceFileContent: vi.fn().mockResolvedValue([]),
      semanticSearch: {
        isAvailable: vi.fn().mockResolvedValue(false),
      },
    },
  });

  return { invoke, getRecentWorkspaces, getOpenWorkspaces, appSettings };
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
    const { UnifiedQuickOpen } = await import('../UnifiedQuickOpen');
    const store = createStore();

    render(
      <JotaiProvider store={store}>
        <UnifiedQuickOpen
          isOpen={true}
          onClose={vi.fn()}
          workspacePath="/Users/ghinkle/sources/crystal"
          initialTab="projects"
          onFileSelect={vi.fn()}
          onSessionSelect={vi.fn()}
          onPromptSelect={vi.fn()}
        />
      </JotaiProvider>
    );

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('get-recent-workspaces');
    });

    expect(window.electronAPI.workspaceManager.getOpenWorkspaces).toHaveBeenCalled();
    expect(window.electronAPI.workspaceManager.getRecentWorkspaces).not.toHaveBeenCalled();
    expect(await screen.findByText('crystal')).toBeTruthy();
  });

  it('does not filter hidden projects while typing in the Files tab', async () => {
    const { UnifiedQuickOpen } = await import('../UnifiedQuickOpen');
    const store = createStore();

    render(
      <JotaiProvider store={store}>
        <UnifiedQuickOpen
          isOpen={true}
          onClose={vi.fn()}
          workspacePath="/Users/ghinkle/sources/crystal"
          initialTab="files"
          onFileSelect={vi.fn()}
          onSessionSelect={vi.fn()}
          onPromptSelect={vi.fn()}
        />
      </JotaiProvider>
    );

    await screen.findByText('crystal');
    await screen.findByText('aurora');

    fireEvent.change(screen.getByTestId('unified-quick-open-search'), {
      target: { value: 'crystal' },
    });

    await waitFor(() => {
      expect(window.electronAPI.searchWorkspaceFileNames).toHaveBeenCalledWith(
        '/Users/ghinkle/sources/crystal',
        'crystal',
        undefined,
      );
    });

    expect(screen.getByText('aurora')).toBeTruthy();
  });

  it('finds a shared file in the Files tab and opens it collaboratively', async () => {
    const { UnifiedQuickOpen } = await import('../UnifiedQuickOpen');
    const store = createStore();
    const onClose = vi.fn();
    const onFileSelect = vi.fn();
    store.set(activeWorkspacePathAtom, '/Users/ghinkle/sources/crystal');
    store.set(workspaceHasTeamAtom, true);
    store.set(sharedDocumentsAtom, [
      {
        documentId: 'doc-roadmap',
        title: 'Planning/Product Roadmap',
        documentType: 'markdown',
        createdBy: 'user-1',
        createdAt: 100,
        updatedAt: 200,
      },
    ]);

    render(
      <JotaiProvider store={store}>
        <UnifiedQuickOpen
          isOpen={true}
          onClose={onClose}
          workspacePath="/Users/ghinkle/sources/crystal"
          initialTab="files"
          onFileSelect={onFileSelect}
          onSessionSelect={vi.fn()}
          onPromptSelect={vi.fn()}
        />
      </JotaiProvider>
    );

    fireEvent.change(screen.getByTestId('unified-quick-open-search'), {
      target: { value: 'roadmap' },
    });

    const sharedResult = await screen.findByTestId('shared-file-quick-open-doc-roadmap');
    expect(sharedResult.textContent).toContain('Product Roadmap');
    expect(sharedResult.textContent).toContain('Shared');

    fireEvent.click(sharedResult);

    expect(onFileSelect).not.toHaveBeenCalled();
    expect(store.get(pendingCollabDocumentAtom)).toEqual({
      documentId: 'doc-roadmap',
      documentType: 'markdown',
    });
    expect(store.get(windowModeAtom)).toBe('collab');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('passes the file mask to file-name search before result truncation', async () => {
    const { UnifiedQuickOpen } = await import('../UnifiedQuickOpen');
    const store = createStore();

    render(
      <JotaiProvider store={store}>
        <UnifiedQuickOpen
          isOpen={true}
          onClose={vi.fn()}
          workspacePath="/Users/ghinkle/sources/crystal"
          initialTab="files"
          onFileSelect={vi.fn()}
          onSessionSelect={vi.fn()}
          onPromptSelect={vi.fn()}
        />
      </JotaiProvider>
    );

    fireEvent.click(screen.getByTitle('Mask'));
    fireEvent.change(screen.getByPlaceholderText('*.ts,*.tsx'), {
      target: { value: '*.md' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText('*.ts,*.tsx'), {
      key: 'Enter',
      code: 'Enter',
    });

    fireEvent.change(screen.getByTestId('unified-quick-open-search'), {
      target: { value: 'tracker' },
    });

    await waitFor(() => {
      expect(window.electronAPI.searchWorkspaceFileNames).toHaveBeenCalledWith(
        '/Users/ghinkle/sources/crystal',
        'tracker',
        { fileMask: '*.md' },
      );
    });
  });

  it('remembers the selected file mask across dialog remounts', async () => {
    const { appSettings } = setupElectronApiMock();
    const { UnifiedQuickOpen } = await import('../UnifiedQuickOpen');
    const firstStore = createStore();

    const { unmount } = render(
      <JotaiProvider store={firstStore}>
        <UnifiedQuickOpen
          isOpen={true}
          onClose={vi.fn()}
          workspacePath="/Users/ghinkle/sources/crystal"
          initialTab="files"
          onFileSelect={vi.fn()}
          onSessionSelect={vi.fn()}
          onPromptSelect={vi.fn()}
        />
      </JotaiProvider>
    );

    fireEvent.click(screen.getByTitle('Mask'));
    fireEvent.click(screen.getByText('Markdown'));

    await waitFor(() => {
      expect(appSettings.get('unifiedQuickOpen.selectedFileMask')).toBe('*.md,*.mdx');
    });

    unmount();

    render(
      <JotaiProvider store={createStore()}>
        <UnifiedQuickOpen
          isOpen={true}
          onClose={vi.fn()}
          workspacePath="/Users/ghinkle/sources/crystal"
          initialTab="files"
          onFileSelect={vi.fn()}
          onSessionSelect={vi.fn()}
          onPromptSelect={vi.fn()}
        />
      </JotaiProvider>
    );

    await waitFor(() => {
      expect(screen.getByTitle('Mask: Markdown')).toBeTruthy();
    });
  });

  it('opens the tracker type picker with Ctrl+T', async () => {
    const { UnifiedQuickOpen } = await import('../UnifiedQuickOpen');

    render(
      <JotaiProvider store={createStore()}>
        <UnifiedQuickOpen
          isOpen={true}
          onClose={vi.fn()}
          workspacePath="/Users/ghinkle/sources/crystal"
          initialTab="files"
          onFileSelect={vi.fn()}
          onSessionSelect={vi.fn()}
          onPromptSelect={vi.fn()}
        />
      </JotaiProvider>
    );

    fireEvent.keyDown(window, {
      key: 't',
      code: 'KeyT',
      ctrlKey: true,
    });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Trackers/ }).getAttribute('aria-selected')).toBe('true');
      expect(screen.getByPlaceholderText('custom-type')).toBeTruthy();
    });
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
    const { UnifiedQuickOpen } = await import('../UnifiedQuickOpen');
    const withoutTeamStore = createStore();
    withoutTeamStore.set(activeWorkspacePathAtom, '/Users/ghinkle/sources/crystal');

    const { unmount } = render(
      <JotaiProvider store={withoutTeamStore}>
        <UnifiedQuickOpen
          isOpen={true}
          onClose={vi.fn()}
          workspacePath="/Users/ghinkle/sources/crystal"
          onFileSelect={vi.fn()}
          onSessionSelect={vi.fn()}
          onPromptSelect={vi.fn()}
        />
      </JotaiProvider>
    );

    expect(screen.queryByRole('tab', { name: /Team/ })).toBeNull();
    unmount();

    const withTeamStore = createStore();
    withTeamStore.set(activeWorkspacePathAtom, '/Users/ghinkle/sources/crystal');
    withTeamStore.set(workspaceHasTeamAtom, true);
    withTeamStore.set(sharedDocumentsAtom, [
      {
        documentId: 'doc-roadmap',
        title: 'Planning/Product Roadmap',
        documentType: 'markdown',
        createdBy: 'user-1',
        createdAt: 100,
        updatedAt: 200,
      },
    ]);

    render(
      <JotaiProvider store={withTeamStore}>
        <UnifiedQuickOpen
          isOpen={true}
          onClose={vi.fn()}
          workspacePath="/Users/ghinkle/sources/crystal"
          initialTab="team"
          onFileSelect={vi.fn()}
          onSessionSelect={vi.fn()}
          onPromptSelect={vi.fn()}
        />
      </JotaiProvider>
    );

    expect(await screen.findByRole('tab', { name: /Team/ })).toBeTruthy();
    expect(screen.getByText('Product Roadmap')).toBeTruthy();
  });

  it('filters by display name and excludes locked documents', async () => {
    const { UnifiedQuickOpen } = await import('../UnifiedQuickOpen');
    const store = createStore();
    store.set(activeWorkspacePathAtom, '/Users/ghinkle/sources/crystal');
    store.set(workspaceHasTeamAtom, true);
    store.set(sharedDocumentsAtom, [
      {
        documentId: 'doc-roadmap',
        title: 'Planning/Product Roadmap',
        documentType: 'markdown',
        createdBy: 'user-1',
        createdAt: 100,
        updatedAt: 300,
      },
      {
        documentId: 'doc-retro',
        title: 'Planning/Team Retrospective',
        documentType: 'markdown',
        createdBy: 'user-1',
        createdAt: 100,
        updatedAt: 200,
      },
      {
        documentId: 'doc-locked',
        title: 'Planning/Locked Strategy',
        documentType: 'markdown',
        createdBy: 'user-1',
        createdAt: 100,
        updatedAt: 400,
        decryptFailed: true,
      },
    ]);

    render(
      <JotaiProvider store={store}>
        <UnifiedQuickOpen
          isOpen={true}
          onClose={vi.fn()}
          workspacePath="/Users/ghinkle/sources/crystal"
          initialTab="team"
          onFileSelect={vi.fn()}
          onSessionSelect={vi.fn()}
          onPromptSelect={vi.fn()}
        />
      </JotaiProvider>
    );

    expect(screen.getByText('Product Roadmap')).toBeTruthy();
    expect(screen.getByText('Team Retrospective')).toBeTruthy();
    expect(screen.queryByText('Locked Strategy')).toBeNull();

    fireEvent.change(screen.getByTestId('unified-quick-open-search'), {
      target: { value: 'roadmap' },
    });

    expect(screen.getByText('Product Roadmap')).toBeTruthy();
    expect(screen.queryByText('Team Retrospective')).toBeNull();
  });

  it('routes selection through the pending shared-document atom and collab mode', async () => {
    const { UnifiedQuickOpen } = await import('../UnifiedQuickOpen');
    const store = createStore();
    const onClose = vi.fn();
    store.set(activeWorkspacePathAtom, '/Users/ghinkle/sources/crystal');
    store.set(workspaceHasTeamAtom, true);
    store.set(sharedDocumentsAtom, [
      {
        documentId: 'doc-canvas',
        title: 'Design/Launch Canvas',
        documentType: 'excalidraw',
        createdBy: 'user-1',
        createdAt: 100,
        updatedAt: 200,
      },
    ]);

    render(
      <JotaiProvider store={store}>
        <UnifiedQuickOpen
          isOpen={true}
          onClose={onClose}
          workspacePath="/Users/ghinkle/sources/crystal"
          initialTab="team"
          onFileSelect={vi.fn()}
          onSessionSelect={vi.fn()}
          onPromptSelect={vi.fn()}
        />
      </JotaiProvider>
    );

    fireEvent.click(screen.getByText('Launch Canvas'));

    expect(store.get(pendingCollabDocumentAtom)).toEqual({
      documentId: 'doc-canvas',
      documentType: 'excalidraw',
    });
    expect(store.get(windowModeAtom)).toBe('collab');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('jumps to the Team tab with Cmd+Shift+D while the palette is open', async () => {
    const { UnifiedQuickOpen } = await import('../UnifiedQuickOpen');
    const store = createStore();
    store.set(activeWorkspacePathAtom, '/Users/ghinkle/sources/crystal');
    store.set(workspaceHasTeamAtom, true);

    render(
      <JotaiProvider store={store}>
        <UnifiedQuickOpen
          isOpen={true}
          onClose={vi.fn()}
          workspacePath="/Users/ghinkle/sources/crystal"
          initialTab="files"
          onFileSelect={vi.fn()}
          onSessionSelect={vi.fn()}
          onPromptSelect={vi.fn()}
        />
      </JotaiProvider>
    );

    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true });

    expect(screen.getByRole('tab', { name: /Team/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens on Team with Cmd+Shift+D only when the workspace has a team', async () => {
    const { NavigationDialogKeyboardHandler } = await import('../NavigationDialogKeyboardHandler');
    const handlerProps = {
      workspaceMode: true,
      workspacePath: '/Users/ghinkle/sources/crystal',
      currentFilePath: null,
      onFileSelect: vi.fn(),
      onSessionSelect: vi.fn(),
      onPromptSelect: vi.fn(),
      documentContext: {},
    };

    const withoutTeamStore = createStore();
    withoutTeamStore.set(activeWorkspacePathAtom, '/Users/ghinkle/sources/crystal');
    const { unmount } = render(
      <JotaiProvider store={withoutTeamStore}>
        <NavigationDialogKeyboardHandler {...handlerProps} />
      </JotaiProvider>
    );

    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true });
    expect(openUnifiedQuickOpenMock).not.toHaveBeenCalled();
    unmount();

    const withTeamStore = createStore();
    withTeamStore.set(activeWorkspacePathAtom, '/Users/ghinkle/sources/crystal');
    withTeamStore.set(workspaceHasTeamAtom, true);
    render(
      <JotaiProvider store={withTeamStore}>
        <NavigationDialogKeyboardHandler {...handlerProps} />
      </JotaiProvider>
    );

    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true });

    expect(openUnifiedQuickOpenMock).toHaveBeenCalledWith(
      expect.objectContaining({ initialTab: 'team' }),
    );
  });

  it('does not replay a rejected Team menu request when team availability changes', async () => {
    const { NavigationDialogKeyboardHandler } = await import('../NavigationDialogKeyboardHandler');
    const store = createStore();
    store.set(activeWorkspacePathAtom, '/Users/ghinkle/sources/crystal');

    render(
      <JotaiProvider store={store}>
        <NavigationDialogKeyboardHandler
          workspaceMode={true}
          workspacePath="/Users/ghinkle/sources/crystal"
          currentFilePath={null}
          onFileSelect={vi.fn()}
          onSessionSelect={vi.fn()}
          onPromptSelect={vi.fn()}
          documentContext={{}}
        />
      </JotaiProvider>
    );

    act(() => {
      store.set(openNavigationDialogRequestAtom, {
        version: 1,
        dialogId: 'team-quick-open',
      });
    });
    expect(openUnifiedQuickOpenMock).not.toHaveBeenCalled();

    act(() => {
      store.set(workspaceHasTeamAtom, true);
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
