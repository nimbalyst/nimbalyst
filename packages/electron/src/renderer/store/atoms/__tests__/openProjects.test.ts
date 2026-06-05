import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'jotai';
import {
  openProjectsAtom,
  activeWorkspacePathAtom,
  activeOpenProjectAtom,
  addOpenProjectAtom,
  closeOpenProjectAtom,
  isOpenProjectsAtCapAtom,
  attachWorkspaceSwitchCleanup,
  seedRailFromInitialState,
  type OpenProject,
} from '../openProjects';
import { activeSessionIdAtom, selectedWorkstreamAtom } from '../sessions';

const MAX_OPEN_PROJECTS = 8;

function project(path: string, openedAt = 0): OpenProject {
  const name = path.split('/').filter(Boolean).pop() ?? path;
  return { path, name, openedAt };
}

describe('openProjects atoms', () => {
  let jotaiStore: ReturnType<typeof createStore>;

  beforeEach(() => {
    jotaiStore = createStore();
  });

  describe('addOpenProjectAtom', () => {
    it('adds a new project and activates it', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));

      expect(jotaiStore.get(openProjectsAtom)).toEqual([project('/ws/a')]);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/a');
    });

    it('appends in order for multiple distinct projects', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/c'));

      const open = jotaiStore.get(openProjectsAtom);
      expect(open.map((p) => p.path)).toEqual(['/ws/a', '/ws/b', '/ws/c']);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/c');
    });

    it('dedups when path is already open and just activates it', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));

      const open = jotaiStore.get(openProjectsAtom);
      expect(open).toHaveLength(2);
      expect(open.map((p) => p.path)).toEqual(['/ws/a', '/ws/b']);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/a');
    });

    it('rejects new projects beyond the cap without altering active', () => {
      for (let i = 0; i < MAX_OPEN_PROJECTS; i++) {
        jotaiStore.set(addOpenProjectAtom, project(`/ws/${i}`));
      }
      expect(jotaiStore.get(openProjectsAtom)).toHaveLength(MAX_OPEN_PROJECTS);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe(`/ws/${MAX_OPEN_PROJECTS - 1}`);

      jotaiStore.set(addOpenProjectAtom, project('/ws/overflow'));

      expect(jotaiStore.get(openProjectsAtom)).toHaveLength(MAX_OPEN_PROJECTS);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe(`/ws/${MAX_OPEN_PROJECTS - 1}`);
    });
  });

  describe('closeOpenProjectAtom', () => {
    it('removes the project from the list', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));

      jotaiStore.set(closeOpenProjectAtom, '/ws/a');

      expect(jotaiStore.get(openProjectsAtom).map((p) => p.path)).toEqual(['/ws/b']);
    });

    it('promotes the next project when closing the active one', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/c'));
      jotaiStore.set(activeWorkspacePathAtom, '/ws/b');

      jotaiStore.set(closeOpenProjectAtom, '/ws/b');

      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/c');
    });

    it('falls back to the previous project when closing the last one', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/c'));
      jotaiStore.set(activeWorkspacePathAtom, '/ws/c');

      jotaiStore.set(closeOpenProjectAtom, '/ws/c');

      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/b');
    });

    it('clears active when the last open project is closed', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/only'));

      jotaiStore.set(closeOpenProjectAtom, '/ws/only');

      expect(jotaiStore.get(openProjectsAtom)).toHaveLength(0);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBeNull();
    });

    it('leaves active untouched when closing an inactive project', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));
      jotaiStore.set(activeWorkspacePathAtom, '/ws/a');

      jotaiStore.set(closeOpenProjectAtom, '/ws/b');

      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/a');
    });

    it('is a no-op when path is not in the rail', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(closeOpenProjectAtom, '/ws/missing');

      expect(jotaiStore.get(openProjectsAtom).map((p) => p.path)).toEqual(['/ws/a']);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/a');
    });
  });

  describe('derived atoms', () => {
    it('isOpenProjectsAtCapAtom flips at the cap', () => {
      expect(jotaiStore.get(isOpenProjectsAtCapAtom)).toBe(false);
      for (let i = 0; i < MAX_OPEN_PROJECTS - 1; i++) {
        jotaiStore.set(addOpenProjectAtom, project(`/ws/${i}`));
      }
      expect(jotaiStore.get(isOpenProjectsAtCapAtom)).toBe(false);

      jotaiStore.set(addOpenProjectAtom, project(`/ws/${MAX_OPEN_PROJECTS - 1}`));
      expect(jotaiStore.get(isOpenProjectsAtCapAtom)).toBe(true);
    });

    it('activeOpenProjectAtom returns null with no active path', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(activeWorkspacePathAtom, null);

      expect(jotaiStore.get(activeOpenProjectAtom)).toBeNull();
    });

    it('activeOpenProjectAtom returns the matching project for the active path', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));
      jotaiStore.set(activeWorkspacePathAtom, '/ws/b');

      expect(jotaiStore.get(activeOpenProjectAtom)?.path).toBe('/ws/b');
    });

    it('activeOpenProjectAtom returns null when active path is not in the rail', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(activeWorkspacePathAtom, '/ws/zombie');

      expect(jotaiStore.get(activeOpenProjectAtom)).toBeNull();
    });
  });

  describe('attachWorkspaceSwitchCleanup', () => {
    // Regression: prior to the multi-project rail fix, switching the rail
    // to a workspace whose `selectedWorkstreamAtom` was null left
    // `activeSessionIdAtom` pointing at the previous workspace's session.
    // The renderer then sent that stale id to `ai:sendMessage` against
    // the new workspace's path and SessionManager rejected it as
    // "Session ... not found". The subscriber synchronously rewrites
    // the global atom to the new workspace's selection (or null if no
    // selection), which closes the transient-null window AgentMode's
    // mount effect would otherwise leave open.
    it('clears activeSessionIdAtom when flipping to a workspace with no selection', () => {
      const unsub = attachWorkspaceSwitchCleanup(jotaiStore);

      jotaiStore.set(activeWorkspacePathAtom, '/ws/a');
      jotaiStore.set(activeSessionIdAtom, 'session-from-a');
      expect(jotaiStore.get(activeSessionIdAtom)).toBe('session-from-a');

      jotaiStore.set(activeWorkspacePathAtom, '/ws/b');
      expect(jotaiStore.get(activeSessionIdAtom)).toBeNull();

      unsub();
    });

    it('also clears when activeWorkspacePathAtom flips back to null', () => {
      const unsub = attachWorkspaceSwitchCleanup(jotaiStore);

      jotaiStore.set(activeWorkspacePathAtom, '/ws/a');
      jotaiStore.set(activeSessionIdAtom, 'session-from-a');

      jotaiStore.set(activeWorkspacePathAtom, null);
      expect(jotaiStore.get(activeSessionIdAtom)).toBeNull();

      unsub();
    });

    it('repopulates activeSessionIdAtom from the new workspace selection synchronously', () => {
      // Pre-seed /ws/b's selection BEFORE attaching so the subscriber sees
      // a non-empty selectedWorkstreamAtom on the flip.
      jotaiStore.set(selectedWorkstreamAtom('/ws/b'), { type: 'session', id: 'session-b-root' });

      const unsub = attachWorkspaceSwitchCleanup(jotaiStore);
      jotaiStore.set(activeWorkspacePathAtom, '/ws/a');
      jotaiStore.set(activeSessionIdAtom, 'session-from-a');

      jotaiStore.set(activeWorkspacePathAtom, '/ws/b');
      // Synchronous after the subscriber fires — no React or AgentMode
      // effect required.
      expect(jotaiStore.get(activeSessionIdAtom)).toBe('session-b-root');

      unsub();
    });

    // Note: the active-child priority branch
    // (`workstreamActiveChildAtom(selection.id) || selection.id`) is not
    // unit-tested here because writing to the workstream state requires
    // the IPC-bootstrapped `initWorkstreamState`. The branch is exercised
    // via AgentMode's existing integration coverage.

    it('stops updating once the returned unsubscribe is invoked', () => {
      const unsub = attachWorkspaceSwitchCleanup(jotaiStore);
      jotaiStore.set(activeWorkspacePathAtom, '/ws/a');
      jotaiStore.set(activeSessionIdAtom, 'session-from-a');

      unsub();
      jotaiStore.set(activeWorkspacePathAtom, '/ws/b');

      expect(jotaiStore.get(activeSessionIdAtom)).toBe('session-from-a');
    });
  });

  describe('seedRailFromInitialState', () => {
    // Regression for issue #530: a renderer reload (Cmd+R) in multi-project
    // mode collapsed the rail to the single primary project because
    // `loadInitialState` only re-seeded `workspacePath`. The main-process
    // `windowStates` map still holds every warm project across a reload, so
    // the rail must rebuild the full set from the initial-state payload.
    it('restores the primary plus every additional project after reload', () => {
      seedRailFromInitialState(jotaiStore, {
        workspacePath: '/ws/a',
        workspaceName: 'a',
        additionalWorkspacePaths: ['/ws/b', '/ws/c'],
        activeWorkspacePath: '/ws/b',
      });

      expect(jotaiStore.get(openProjectsAtom).map((p) => p.path)).toEqual([
        '/ws/a',
        '/ws/b',
        '/ws/c',
      ]);
    });

    it('restores the in-view active project, not the last one added', () => {
      seedRailFromInitialState(jotaiStore, {
        workspacePath: '/ws/a',
        additionalWorkspacePaths: ['/ws/b', '/ws/c'],
        activeWorkspacePath: '/ws/b',
      });

      // addOpenProjectAtom activates each project as it is added, so without
      // the final restore the active path would leak to '/ws/c'.
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/b');
    });

    it('falls back to the primary as active when activeWorkspacePath is absent', () => {
      seedRailFromInitialState(jotaiStore, {
        workspacePath: '/ws/a',
        additionalWorkspacePaths: ['/ws/b'],
      });

      expect(jotaiStore.get(openProjectsAtom).map((p) => p.path)).toEqual(['/ws/a', '/ws/b']);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/a');
    });

    it('seeds only the primary when there are no additional projects (cold launch)', () => {
      seedRailFromInitialState(jotaiStore, { workspacePath: '/ws/a', workspaceName: 'a' });

      expect(jotaiStore.get(openProjectsAtom).map((p) => p.path)).toEqual(['/ws/a']);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/a');
    });

    it('ignores blank and duplicate additional paths', () => {
      seedRailFromInitialState(jotaiStore, {
        workspacePath: '/ws/a',
        additionalWorkspacePaths: ['', '/ws/a', '/ws/b'],
        activeWorkspacePath: '/ws/a',
      });

      expect(jotaiStore.get(openProjectsAtom).map((p) => p.path)).toEqual(['/ws/a', '/ws/b']);
    });
  });
});
