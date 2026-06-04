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
  const invoke = vi.fn().mockImplementation(async (channel: string) => {
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

  return { invoke, getRecentWorkspaces, getOpenWorkspaces };
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
      );
    });

    expect(screen.getByText('aurora')).toBeTruthy();
  });
});
