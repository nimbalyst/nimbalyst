// @vitest-environment node
/**
 * `terminal:reveal` from main: the window showing that project opens the
 * terminal panel on the requested tab and closes the extension bottom panel
 * that asked; a window on another project does nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atom } from 'jotai';

vi.mock('../../atoms/openProjects', () => ({ activeWorkspacePathAtom: atom<string | null>(null) }));

import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { activeExtensionBottomPanelAtom } from '../../atoms/extensionPanels';
import {
  activeTerminalIdAtom,
  terminalListAtom,
  terminalPanelVisibleAtom,
} from '../../atoms/terminals';
import { initTerminalRevealListeners, revealOwnedTerminal } from '../terminalRevealListeners';

let reveal: (request: unknown) => void;
let cleanup: () => void;
const getWorkspaceState = vi.fn();

beforeEach(() => {
  getWorkspaceState.mockReset();
  getWorkspaceState.mockResolvedValue({
    terminals: {
      shell: { id: 'shell', title: 'zsh' },
      run: { id: 'run', title: 'Web dev server', kind: 'command', owner: { extensionId: 'com.nimbalyst.run', key: 'web' } },
    },
    tabOrder: ['shell', 'run'],
    activeTerminalId: 'shell',
  });
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      on: (channel: string, cb: (request: unknown) => void) => {
        if (channel === 'terminal:reveal') reveal = cb;
        return () => {};
      },
      terminal: { getWorkspaceState, setPanelVisible: vi.fn() },
    },
  };
  store.set(activeWorkspacePathAtom, '/a');
  store.set(terminalListAtom, []);
  store.set(activeTerminalIdAtom, undefined);
  store.set(terminalPanelVisibleAtom, false);
  store.set(activeExtensionBottomPanelAtom, 'com.nimbalyst.run.runs');
  cleanup = initTerminalRevealListeners();
});

afterEach(() => {
  cleanup();
  delete (globalThis as { window?: unknown }).window;
});

describe('terminal reveal listener', () => {
  it('opens the terminal panel on the requested tab and closes the extension bottom panel', async () => {
    reveal({ workspacePath: '/a', terminalId: 'run' });
    await vi.waitFor(() => expect(store.get(terminalPanelVisibleAtom)).toBe(true));
    expect(store.get(activeTerminalIdAtom)).toBe('run');
    expect(store.get(terminalListAtom).map((t) => t.id)).toEqual(['shell', 'run']);
    expect(store.get(activeExtensionBottomPanelAtom)).toBeNull();
  });

  it('ignores a reveal for a project this window is not showing', async () => {
    reveal({ workspacePath: '/b', terminalId: 'run' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getWorkspaceState).not.toHaveBeenCalled();
    expect(store.get(terminalPanelVisibleAtom)).toBe(false);
    expect(store.get(activeExtensionBottomPanelAtom)).toBe('com.nimbalyst.run.runs');
  });

  // A transcript's "Show logs" link knows the run target, not the terminal id
  // of its current tab (each start replaces the tab).
  it('reveals the tab an extension owns under a key, and reports when there is none', async () => {
    await expect(revealOwnedTerminal({ workspacePath: '/a', extensionId: 'com.nimbalyst.run', key: 'web' })).resolves.toBe(true);
    expect(store.get(activeTerminalIdAtom)).toBe('run');
    expect(store.get(terminalPanelVisibleAtom)).toBe(true);

    store.set(terminalPanelVisibleAtom, false);
    await expect(revealOwnedTerminal({ workspacePath: '/a', extensionId: 'com.nimbalyst.run', key: 'worker' })).resolves.toBe(false);
    await expect(revealOwnedTerminal({ workspacePath: '/a', extensionId: 'other.extension', key: 'web' })).resolves.toBe(false);
    expect(store.get(terminalPanelVisibleAtom)).toBe(false);
  });
});
