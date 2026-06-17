// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';

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
