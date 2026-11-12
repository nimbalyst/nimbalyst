// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createStore } from 'jotai';
import {
  activeWorkspacePathAtom,
  allowUnlimitedProjectsAtom,
  multiProjectModeAtom,
  openProjectsAtom,
  type OpenProject,
} from '../../atoms/openProjects';
import { openFolderAsProject, removeProjectFromRail, switchToProject } from '../railProjects';

function project(path: string): OpenProject {
  return { path, name: path.split('/').pop() ?? path, openedAt: 0 };
}

describe('switchToProject', () => {
  let jotaiStore: ReturnType<typeof createStore>;
  let invoke: ReturnType<typeof vi.fn>;
  let openWorkspace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    jotaiStore = createStore();
    jotaiStore.set(allowUnlimitedProjectsAtom, false);
    jotaiStore.set(openProjectsAtom, [project('/ws/a')]);
    jotaiStore.set(activeWorkspacePathAtom, '/ws/a');
    invoke = vi.fn().mockResolvedValue({ success: true });
    openWorkspace = vi.fn().mockResolvedValue({ success: true });
    (globalThis as any).window = { electronAPI: { invoke, workspaceManager: { openWorkspace } } };
  });

  it('adds a project not open anywhere to this window rail in multi-project mode', async () => {
    jotaiStore.set(multiProjectModeAtom, true);

    expect(await switchToProject(jotaiStore, '/ws/b', false)).toBe('added');

    expect(invoke).toHaveBeenCalledWith('workspace:register-additional', { workspacePath: '/ws/b' });
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(jotaiStore.get(openProjectsAtom).map(p => p.path)).toEqual(['/ws/a', '/ws/b']);
    expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/b');
  });

  it('switches in place to a project already in this rail without registering it again', async () => {
    jotaiStore.set(multiProjectModeAtom, true);
    jotaiStore.set(openProjectsAtom, [project('/ws/a'), project('/ws/b')]);

    expect(await switchToProject(jotaiStore, '/ws/b', true)).toBe('added');

    expect(invoke).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/b');
  });

  it('focuses the other window when the project is open elsewhere', async () => {
    jotaiStore.set(multiProjectModeAtom, true);

    expect(await switchToProject(jotaiStore, '/ws/b', true)).toBe('opened-window');

    expect(openWorkspace).toHaveBeenCalledWith('/ws/b');
    expect(jotaiStore.get(openProjectsAtom)).toHaveLength(1);
  });

  it('reports the cap without registering when the rail is full', async () => {
    jotaiStore.set(multiProjectModeAtom, true);
    jotaiStore.set(openProjectsAtom, Array.from({ length: 8 }, (_, i) => project(`/ws/${i}`)));

    expect(await switchToProject(jotaiStore, '/ws/new', false)).toBe('at-cap');

    expect(invoke).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it('opens through main in single-project mode', async () => {
    expect(await switchToProject(jotaiStore, '/ws/b', false)).toBe('opened-window');

    expect(openWorkspace).toHaveBeenCalledWith('/ws/b');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('removeProjectFromRail', () => {
  let jotaiStore: ReturnType<typeof createStore>;
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    jotaiStore = createStore();
    invoke = vi.fn().mockResolvedValue({ success: true });
    (globalThis as any).window = { electronAPI: { invoke } };
  });

  it('activates a neighbour and keeps the window when other projects remain', async () => {
    jotaiStore.set(openProjectsAtom, [project('/ws/a'), project('/ws/b')]);
    jotaiStore.set(activeWorkspacePathAtom, '/ws/b');

    await removeProjectFromRail(jotaiStore, '/ws/b');

    expect(jotaiStore.get(openProjectsAtom).map(p => p.path)).toEqual(['/ws/a']);
    expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/a');
    expect(invoke).toHaveBeenCalledWith('workspace:unregister-additional', { workspacePath: '/ws/b' });
    expect(invoke).not.toHaveBeenCalledWith('workspace:close-rail-window');
  });

  it('closes the window when the last project leaves', async () => {
    jotaiStore.set(openProjectsAtom, [project('/ws/a')]);

    await removeProjectFromRail(jotaiStore, '/ws/a');

    expect(invoke).toHaveBeenCalledWith('workspace:close-rail-window');
  });
});

describe('openFolderAsProject', () => {
  let jotaiStore: ReturnType<typeof createStore>;
  let invoke: ReturnType<typeof vi.fn>;
  let openWorkspace: ReturnType<typeof vi.fn>;
  let openPaths: string[];

  beforeEach(() => {
    jotaiStore = createStore();
    jotaiStore.set(allowUnlimitedProjectsAtom, false);
    jotaiStore.set(multiProjectModeAtom, true);
    jotaiStore.set(openProjectsAtom, [project('/ws/a')]);
    openPaths = ['/ws/a'];
    invoke = vi.fn(async (channel: string) => channel === 'dialog-show-open-dialog'
      ? { canceled: false, filePaths: ['/ws/picked'] }
      : { success: true });
    openWorkspace = vi.fn().mockResolvedValue({ success: true });
    (globalThis as any).window = { electronAPI: { invoke, workspaceManager: { openWorkspace, getOpenWorkspaces: async () => openPaths } } };
  });

  it('adds a picked folder to this rail when no window has it', async () => {
    expect(await openFolderAsProject(jotaiStore)).toBe('added');

    expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/picked');
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it('focuses the window that already has the picked folder', async () => {
    openPaths = ['/ws/a', '/ws/picked'];

    expect(await openFolderAsProject(jotaiStore)).toBe('opened-window');

    expect(openWorkspace).toHaveBeenCalledWith('/ws/picked');
  });

  it('does nothing when the picker is cancelled', async () => {
    invoke.mockResolvedValueOnce({ canceled: true, filePaths: [] });

    expect(await openFolderAsProject(jotaiStore)).toBeNull();

    expect(openWorkspace).not.toHaveBeenCalled();
    expect(jotaiStore.get(openProjectsAtom)).toHaveLength(1);
  });
});
