import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import {
  openProjectsAtom,
  activeWorkspacePathAtom,
  activeOpenProjectAtom,
  addOpenProjectAtom,
  seedInitialOpenProjectAtom,
  closeOpenProjectAtom,
  isOpenProjectsAtCapAtom,
  getReplacementOpenProjectPath,
  multiProjectModeAtom,
  initOpenProjects,
  teardownOpenProjects,
  attachWorkspaceSwitchCleanup,
  resolveInitialOpenProjectsState,
  selectProjectsToRegister,
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
    it('enables project tabs by default', () => {
      expect(jotaiStore.get(multiProjectModeAtom)).toBe(true);
    });

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

  describe('seedInitialOpenProjectAtom', () => {
    it('preserves a restored active project when App startup seeds the primary afterward', () => {
      jotaiStore.set(openProjectsAtom, [project('/ws/primary'), project('/ws/restored-active')]);
      jotaiStore.set(activeWorkspacePathAtom, '/ws/restored-active');

      jotaiStore.set(seedInitialOpenProjectAtom, project('/ws/primary'));

      expect(jotaiStore.get(openProjectsAtom).map((entry) => entry.path)).toEqual([
        '/ws/primary',
        '/ws/restored-active',
      ]);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/restored-active');
    });

    it('adds and activates the primary when startup seeding wins the hydration race', () => {
      jotaiStore.set(seedInitialOpenProjectAtom, project('/ws/primary'));

      expect(jotaiStore.get(openProjectsAtom)).toEqual([project('/ws/primary')]);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/primary');
    });
  });

  describe('closeOpenProjectAtom', () => {
    it('selects the same adjacent replacement used by the main-process handoff', () => {
      expect(getReplacementOpenProjectPath(
        [project('/ws/a'), project('/ws/b'), project('/ws/c')],
        '/ws/b',
      )).toBe('/ws/c');
      expect(getReplacementOpenProjectPath(
        [project('/ws/a'), project('/ws/b')],
        '/ws/b',
      )).toBe('/ws/a');
    });

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

  describe('resolveInitialOpenProjectsState', () => {
    it('prefers the live window rail state during a renderer reload', () => {
      const result = resolveInitialOpenProjectsState({
        persistedPaths: ['/ws/a', '/ws/b'],
        persistedActivePath: '/ws/b',
        restorePreviousProjects: false,
        windowState: {
          mode: 'workspace',
          workspacePath: '/ws/a',
          activeWorkspacePath: '/ws/b',
          openProjectPaths: ['/ws/a', '/ws/b'],
        },
      });

      expect(result).toEqual({
        paths: ['/ws/a', '/ws/b'],
        activePath: '/ws/b',
      });
    });

    it('keeps a detached window isolated from the legacy global tab list', () => {
      const result = resolveInitialOpenProjectsState({
        persistedPaths: ['/ws/a', '/ws/b'],
        persistedActivePath: '/ws/b',
        restorePreviousProjects: true,
        windowState: {
          mode: 'workspace',
          workspacePath: '/ws/a',
          activeWorkspacePath: '/ws/a',
          openProjectPaths: ['/ws/a'],
        },
      });

      expect(result).toEqual({
        paths: ['/ws/a'],
        activePath: '/ws/a',
      });
    });

    it('falls back to the current window workspace when restore previous projects is off', () => {
      const result = resolveInitialOpenProjectsState({
        persistedPaths: ['/ws/a', '/ws/b'],
        persistedActivePath: '/ws/b',
        restorePreviousProjects: false,
        windowState: {
          mode: 'workspace',
          workspacePath: '/ws/a',
          activeWorkspacePath: '/ws/a',
          openProjectPaths: ['/ws/a'],
        },
      });

      expect(result).toEqual({
        paths: ['/ws/a'],
        activePath: '/ws/a',
      });
    });
  });

  describe('initOpenProjects', () => {
    beforeEach(() => {
      teardownOpenProjects();
    });

    afterEach(() => {
      teardownOpenProjects();
      vi.unstubAllGlobals();
    });

    it('shares in-flight hydration across repeated setup calls and resets on teardown', async () => {
      let resolveMode!: (mode: boolean) => void;
      const modePromise = new Promise<boolean>((resolve) => {
        resolveMode = resolve;
      });
      const invoke = vi.fn((channel: string): Promise<unknown> => {
        switch (channel) {
          case 'app:get-multi-project-mode':
            return modePromise;
          case 'app:get-restore-previous-projects':
            return Promise.resolve(false);
          case 'app:get-open-projects':
            return Promise.resolve([]);
          case 'app:get-active-project-path':
            return Promise.resolve(null);
          default:
            return Promise.resolve(undefined);
        }
      });
      const getInitialState = vi.fn().mockResolvedValue(null);
      vi.stubGlobal('window', {
        electronAPI: { invoke, getInitialState },
      });

      const firstInitialization = initOpenProjects();
      const repeatedInitialization = initOpenProjects();

      expect(repeatedInitialization).toBe(firstInitialization);
      expect(invoke).toHaveBeenCalledTimes(4);
      expect(getInitialState).toHaveBeenCalledOnce();

      let repeatedCallSettled = false;
      void repeatedInitialization.then(() => {
        repeatedCallSettled = true;
      });
      await Promise.resolve();
      expect(repeatedCallSettled).toBe(false);

      resolveMode(true);
      await firstInitialization;
      expect(repeatedCallSettled).toBe(true);

      teardownOpenProjects();
      const initializationAfterTeardown = initOpenProjects();

      expect(initializationAfterTeardown).not.toBe(firstInitialization);
      await initializationAfterTeardown;
      expect(invoke).toHaveBeenCalledTimes(8);
      expect(getInitialState).toHaveBeenCalledTimes(2);
    });
  });

  // NIM-757 (#548): restored non-primary rail projects must be registered with
  // the main process so a later rail click can rescope the (path-less) Trackers
  // panel. The primary is already registered at bootstrap.
  describe('selectProjectsToRegister', () => {
    it('returns the non-primary restored projects', () => {
      expect(selectProjectsToRegister(['/ws/a', '/ws/b', '/ws/c'], '/ws/a')).toEqual([
        '/ws/b',
        '/ws/c',
      ]);
    });

    it('returns nothing for a single-project (primary-only) rail', () => {
      expect(selectProjectsToRegister(['/ws/a'], '/ws/a')).toEqual([]);
    });

    it('dedups and registers all when the primary is unknown', () => {
      expect(selectProjectsToRegister(['/ws/a', '/ws/a', '/ws/b'], undefined)).toEqual([
        '/ws/a',
        '/ws/b',
      ]);
    });
  });
});
