// @vitest-environment jsdom
/**
 * GitHub #1818: switching projects in the project rail.
 *
 * The terminal list is shared by the whole window. After a switch to another
 * project, the list still holds the old project's terminals until the new
 * project's list arrives from the main process. In that gap the bottom panel
 * used to hand the old terminals to the new project's path. Each one then
 * rebuilt its (expensive) terminal engine and asked the main process to start
 * the old terminal inside the wrong project, only to be removed a moment later.
 *
 * These tests check that a terminal is only ever shown for the project it
 * belongs to.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { Provider, atom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';

const shown = vi.hoisted(() => ({
  panels: [] as { terminalId: string; workspacePath: string }[],
}));

vi.mock('posthog-js/react', () => ({ usePostHog: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('../../Terminal/TerminalPanel', () => ({
  TerminalPanel: (props: { terminalId: string; workspacePath: string }) => {
    shown.panels.push({ terminalId: props.terminalId, workspacePath: props.workspacePath });
    return null;
  },
}));
vi.mock('../TerminalTab', () => ({ TerminalTab: () => null }));
vi.mock('../../../store/atoms/sessions', () => {
  const selected = atom(null);
  const worktreeId = atom(null);
  return {
    selectedWorkstreamAtom: () => selected,
    sessionWorktreeIdAtom: () => worktreeId,
  };
});

import { TerminalBottomPanel } from '../TerminalBottomPanel';
import {
  activeTerminalIdAtom,
  loadTerminals,
  terminalListAtom,
  terminalListWorkspaceAtom,
  terminalPanelStateAtomFamily,
  terminalPanelVisibleAtom,
  openTerminalPanelAtom,
  loadTerminalPanelState,
} from '../../../store/atoms/terminals';
import { activeWorkspacePathAtom } from '../../../store/atoms/openProjects';

function terminalInstance(id: string, cwd: string) {
  return {
    id,
    title: id,
    shellName: 'zsh',
    shellPath: '/bin/zsh',
    cwd,
    createdAt: 0,
    lastActiveAt: 0,
  };
}

let pendingLoads: Record<string, (state: unknown) => void>;

function workspaceState(ids: string[], cwd: string) {
  return {
    terminals: Object.fromEntries(ids.map((id) => [id, terminalInstance(id, cwd)])),
    tabOrder: ids,
    activeTerminalId: ids[0],
  };
}

function ui(workspacePath: string) {
  return (
    <Provider store={store}>
      <TerminalBottomPanel workspacePath={workspacePath} />
    </Provider>
  );
}

beforeEach(() => {
  shown.panels = [];
  pendingLoads = {};
  store.set(terminalListAtom, []);
  store.set(terminalListWorkspaceAtom, undefined);
  store.set(activeTerminalIdAtom, undefined);
  for (const workspacePath of ['/proj-a', '/proj-b']) {
    store.set(terminalPanelStateAtomFamily(workspacePath), { visible: true, height: 300, hydrated: true });
  }

  (window as unknown as { electronAPI: unknown }).electronAPI = {
    on: vi.fn(() => () => {}),
    terminal: {
      // Each project's list stays pending until the test resolves it.
      getWorkspaceState: vi.fn(
        (workspacePath: string) =>
          new Promise((resolve) => {
            pendingLoads[workspacePath] = resolve;
          })
      ),
      setPanelVisible: vi.fn(),
      getPanelState: vi.fn(async () => ({ panelVisible: false, panelHeight: 300 })),
    },
  };
});

afterEach(() => {
  cleanup();
});

async function deliver(workspacePath: string, ids: string[]) {
  await act(async () => {
    pendingLoads[workspacePath](workspaceState(ids, workspacePath));
  });
}

describe('TerminalBottomPanel across a project switch', () => {
  it('does not hand the old project terminals to the new project while its list loads', async () => {
    const view = render(ui('/proj-a'));
    await deliver('/proj-a', ['a1', 'a2']);
    expect(shown.panels).toContainEqual({ terminalId: 'a1', workspacePath: '/proj-a' });

    // Switch to project B. B's list has not arrived yet.
    shown.panels = [];
    view.rerender(ui('/proj-b'));

    expect(shown.panels.filter((p) => p.workspacePath === '/proj-b')).toEqual([]);
  });

  it('shows only the new project terminals once its list arrives', async () => {
    const view = render(ui('/proj-a'));
    await deliver('/proj-a', ['a1', 'a2']);

    shown.panels = [];
    view.rerender(ui('/proj-b'));
    await deliver('/proj-b', ['b1']);

    expect(shown.panels).toContainEqual({ terminalId: 'b1', workspacePath: '/proj-b' });
    expect(shown.panels.filter((p) => p.terminalId.startsWith('a'))).toEqual([]);
  });
});

describe('loadTerminals when answers arrive out of order', () => {
  // GitHub #1818: an older project's answer that arrives after a newer project's
  // answer used to overwrite it, so the new project showed no terminals.
  it('ignores an older project answer that arrives after a newer one', async () => {
    const loadA = loadTerminals('/proj-a');
    const loadB = loadTerminals('/proj-b');

    pendingLoads['/proj-b'](workspaceState(['b1'], '/proj-b'));
    await loadB;
    pendingLoads['/proj-a'](workspaceState(['a1', 'a2'], '/proj-a'));
    await loadA;

    expect(store.get(terminalListWorkspaceAtom)).toBe('/proj-b');
    expect(store.get(terminalListAtom).map((t) => t.id)).toEqual(['b1']);
    expect(store.get(activeTerminalIdAtom)).toBe('b1');
  });
});

describe('terminal panel visibility in a multi-project window', () => {
  beforeEach(() => {
    for (const workspacePath of ['/proj-a', '/proj-b']) {
      terminalPanelStateAtomFamily.remove(workspacePath);
    }
  });

  it('keeps the terminal panel open in one project without opening it in another', async () => {
    const api = (window as unknown as { electronAPI: { terminal: { setPanelVisible: ReturnType<typeof vi.fn> } } }).electronAPI;
    act(() => store.set(activeWorkspacePathAtom, '/proj-a'));
    await act(() => loadTerminalPanelState('/proj-a'));
    const view = render(ui('/proj-a'));
    act(() => store.set(openTerminalPanelAtom));
    expect(api.terminal.setPanelVisible).toHaveBeenCalledWith('/proj-a', true);

    act(() => store.set(activeWorkspacePathAtom, '/proj-b'));
    view.rerender(ui('/proj-b'));
    await act(() => loadTerminalPanelState('/proj-b'));
    expect(api.terminal.setPanelVisible).not.toHaveBeenCalledWith('/proj-b', true);
    expect(store.get(terminalPanelVisibleAtom)).toBe(false);

    act(() => store.set(activeWorkspacePathAtom, '/proj-a'));
    view.rerender(ui('/proj-a'));
    await act(() => loadTerminalPanelState('/proj-a'));
    expect(store.get(terminalPanelVisibleAtom)).toBe(true);
  });
});
