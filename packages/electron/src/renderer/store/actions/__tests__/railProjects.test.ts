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
import { switchToProject } from '../railProjects';

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
