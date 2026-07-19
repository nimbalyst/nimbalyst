// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  activeWorkspacePathAtom,
  openProjectsAtom,
  type OpenProject,
} from '../../store/atoms/openProjects';
import { globalSessionActivityAtom } from '../../store/atoms/sessionActivity';
import {
  applyProjectTabMutation,
  closeProjectTab,
  detachProjectTab,
  moveProjectTabToCurrentWindow,
  openProjectTab,
} from '../projectTabs';

const invoke = vi.fn();

function project(path: string): OpenProject {
  return { path, name: path.split('/').pop() || path, openedAt: 0 };
}

describe('project tab actions', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ success: true });
    store.set(openProjectsAtom, []);
    store.set(activeWorkspacePathAtom, null);
    store.set(globalSessionActivityAtom, new Map());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { invoke },
    });
  });

  it('registers and activates a normal project open as a tab', async () => {
    const result = await openProjectTab('/ws/new-project');

    expect(result).toEqual({ success: true });
    expect(invoke).toHaveBeenCalledWith(
      'workspace:register-additional',
      { workspacePath: '/ws/new-project' },
    );
    expect(store.get(openProjectsAtom).map((entry) => entry.path)).toEqual(['/ws/new-project']);
    expect(store.get(activeWorkspacePathAtom)).toBe('/ws/new-project');
  });

  it('passes the adjacent replacement when closing the active tab', async () => {
    store.set(openProjectsAtom, [project('/ws/a'), project('/ws/b'), project('/ws/c')]);
    store.set(activeWorkspacePathAtom, '/ws/b');

    const result = await closeProjectTab('/ws/b');

    expect(result).toEqual({ success: true });
    expect(invoke).toHaveBeenCalledWith('workspace:unregister-additional', {
      workspacePath: '/ws/b',
      replacementWorkspacePath: '/ws/c',
    });
    expect(store.get(activeWorkspacePathAtom)).toBe('/ws/c');
  });

  it('creates the new window before removing a detached tab from this window', async () => {
    store.set(openProjectsAtom, [project('/ws/a'), project('/ws/b')]);
    store.set(activeWorkspacePathAtom, '/ws/b');

    const result = await detachProjectTab('/ws/b', { screenX: 640, screenY: 220 });

    expect(result).toEqual({ success: true });
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'workspace:detach-project-tab',
      'workspace:unregister-additional',
    ]);
    expect(store.get(openProjectsAtom).map((entry) => entry.path)).toEqual(['/ws/a']);
  });

  it('keeps the tab visible when main rejects the close', async () => {
    store.set(openProjectsAtom, [project('/ws/a'), project('/ws/b')]);
    store.set(activeWorkspacePathAtom, '/ws/b');
    invoke.mockResolvedValueOnce({ success: false, error: 'window state changed' });

    const result = await closeProjectTab('/ws/b');

    expect(result).toEqual({ success: false, error: 'window state changed' });
    expect(store.get(openProjectsAtom).map((entry) => entry.path)).toEqual(['/ws/a', '/ws/b']);
    expect(store.get(activeWorkspacePathAtom)).toBe('/ws/b');
  });

  it('keeps a streaming project open when the user cancels close', async () => {
    store.set(openProjectsAtom, [project('/ws/a')]);
    store.set(activeWorkspacePathAtom, '/ws/a');
    store.set(globalSessionActivityAtom, new Map([
      ['/ws/a', { streaming: new Set(['session-1']), unread: new Set<string>() }],
    ]));
    vi.mocked(window.confirm).mockReturnValue(false);

    const result = await closeProjectTab('/ws/a');

    expect(result).toEqual({ success: false, error: 'cancelled' });
    expect(invoke).not.toHaveBeenCalled();
    expect(store.get(openProjectsAtom)).toHaveLength(1);
  });

  it('requests one atomic main-process move for a destination drop', async () => {
    const result = await moveProjectTabToCurrentWindow({
      version: 1,
      dragId: 'drag-1',
    });

    expect(result).toEqual({ success: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('workspace:move-project-tab', {
      dragId: 'drag-1',
    });
  });

  it('applies main-owned add and remove mutations without registration IPC', async () => {
    store.set(openProjectsAtom, [project('/ws/a')]);
    store.set(activeWorkspacePathAtom, '/ws/a');

    await applyProjectTabMutation({
      id: 'add-1',
      kind: 'add',
      workspacePath: '/ws/b',
      activate: true,
    });
    await applyProjectTabMutation({
      id: 'remove-1',
      kind: 'remove',
      workspacePath: '/ws/a',
      replacementWorkspacePath: '/ws/b',
      closeWindowWhenEmpty: false,
    });

    expect(store.get(openProjectsAtom).map((entry) => entry.path)).toEqual(['/ws/b']);
    expect(store.get(activeWorkspacePathAtom)).toBe('/ws/b');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not apply a stale replacement after the source activated another tab', async () => {
    store.set(openProjectsAtom, [project('/ws/a'), project('/ws/b'), project('/ws/c')]);
    store.set(activeWorkspacePathAtom, '/ws/c');

    await applyProjectTabMutation({
      id: 'remove-stale',
      kind: 'remove',
      workspacePath: '/ws/b',
      replacementWorkspacePath: '/ws/a',
      closeWindowWhenEmpty: false,
    });

    expect(store.get(openProjectsAtom).map((entry) => entry.path)).toEqual(['/ws/a', '/ws/c']);
    expect(store.get(activeWorkspacePathAtom)).toBe('/ws/c');
  });
});
