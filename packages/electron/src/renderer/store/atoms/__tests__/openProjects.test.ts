// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from 'jotai';
import {
  openProjectsAtom,
  activeWorkspacePathAtom,
  activeOpenProjectAtom,
  addOpenProjectAtom,
  closeOpenProjectAtom,
  isOpenProjectsAtCapAtom,
  attachWorkspaceSwitchCleanup,
  resolveInitialOpenProjectsState,
  selectProjectsToRegister,
  mergeOpenProjects,
  initOpenProjects,
  teardownOpenProjects,
  MAX_OPEN_PROJECTS,
  type OpenProject,
} from '../openProjects';
import { store } from '@nimbalyst/runtime/store';
import { activeSessionIdAtom, selectedWorkstreamAtom } from '../sessions';

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
    it('adds a new project, activates it, and reports "added"', () => {
      const outcome = jotaiStore.set(addOpenProjectAtom, project('/ws/a'));

      expect(outcome).toBe('added');
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

    it('dedups when path is already open, just activates it, and reports "already-open"', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/a'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/b'));
      const outcome = jotaiStore.set(addOpenProjectAtom, project('/ws/a'));

      expect(outcome).toBe('already-open');
      const open = jotaiStore.get(openProjectsAtom);
      expect(open).toHaveLength(2);
      expect(open.map((p) => p.path)).toEqual(['/ws/a', '/ws/b']);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/a');
    });

    it('rejects new projects beyond the cap, reports "at-cap", and leaves active unchanged', () => {
      for (let i = 0; i < MAX_OPEN_PROJECTS; i++) {
        jotaiStore.set(addOpenProjectAtom, project(`/ws/${i}`));
      }
      expect(jotaiStore.get(openProjectsAtom)).toHaveLength(MAX_OPEN_PROJECTS);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe(`/ws/${MAX_OPEN_PROJECTS - 1}`);

      const outcome = jotaiStore.set(addOpenProjectAtom, project('/ws/overflow'));

      expect(outcome).toBe('at-cap');
      expect(jotaiStore.get(openProjectsAtom)).toHaveLength(MAX_OPEN_PROJECTS);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe(`/ws/${MAX_OPEN_PROJECTS - 1}`);
    });

    // Regression coverage for defect (A) in the single-window-multi-project
    // contract: a non-activating add must never flip the visible project,
    // on either the newly-added or the already-open branch.
    it('activate: false appends a new project without touching the active path', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/primary'));
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/primary');

      const outcome = jotaiStore.set(addOpenProjectAtom, project('/ws/sibling'), { activate: false });

      expect(outcome).toBe('added');
      expect(jotaiStore.get(openProjectsAtom).map((p) => p.path)).toEqual(['/ws/primary', '/ws/sibling']);
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/primary');
    });

    it('activate: false on an already-open project still does not touch the active path', () => {
      jotaiStore.set(addOpenProjectAtom, project('/ws/primary'));
      jotaiStore.set(addOpenProjectAtom, project('/ws/sibling'), { activate: false });
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/primary');

      const outcome = jotaiStore.set(addOpenProjectAtom, project('/ws/sibling'), { activate: false });

      expect(outcome).toBe('already-open');
      expect(jotaiStore.get(activeWorkspacePathAtom)).toBe('/ws/primary');
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

    it('uses persisted state on launch when restore previous projects is enabled', () => {
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
        paths: ['/ws/a', '/ws/b'],
        activePath: '/ws/b',
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

    it('reserves a slot for the primary workspace when restore would fill the rail', () => {
      // A full persisted set that does NOT contain the window's own project.
      // Without the reservation the primary seed is refused at the cap and the
      // window renders without its own project.
      const persistedPaths = Array.from(
        { length: MAX_OPEN_PROJECTS },
        (_, i) => `/ws/restored-${i}`,
      );

      const result = resolveInitialOpenProjectsState({
        persistedPaths,
        persistedActivePath: `/ws/restored-${MAX_OPEN_PROJECTS - 1}`,
        restorePreviousProjects: true,
        windowState: {
          mode: 'workspace',
          workspacePath: '/ws/primary',
          activeWorkspacePath: '/ws/primary',
          openProjectPaths: ['/ws/primary'],
        },
      });

      expect(result.paths).toHaveLength(MAX_OPEN_PROJECTS - 1);
      expect(result.paths).not.toContain(`/ws/restored-${MAX_OPEN_PROJECTS - 1}`);
      // The dropped path was also the persisted active one, so the active
      // selection must fall back into the surviving set rather than dangle.
      expect(result.paths).toContain(result.activePath!);
    });

    it('does not reserve a slot when the primary is already in the restored set', () => {
      const persistedPaths = [
        '/ws/primary',
        ...Array.from({ length: MAX_OPEN_PROJECTS - 1 }, (_, i) => `/ws/restored-${i}`),
      ];

      const result = resolveInitialOpenProjectsState({
        persistedPaths,
        persistedActivePath: '/ws/primary',
        restorePreviousProjects: true,
        windowState: {
          mode: 'workspace',
          workspacePath: '/ws/primary',
          activeWorkspacePath: '/ws/primary',
          openProjectPaths: ['/ws/primary'],
        },
      });

      expect(result.paths).toHaveLength(MAX_OPEN_PROJECTS);
      expect(result.paths).toContain('/ws/primary');
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

  describe('mergeOpenProjects', () => {
    it('returns base unchanged when concurrent has no extra paths', () => {
      const base = [project('/ws/a'), project('/ws/b')];
      expect(mergeOpenProjects(base, [project('/ws/a')])).toBe(base);
    });

    it('appends concurrent-only paths after base, in their existing order', () => {
      const base = [project('/ws/a')];
      const concurrent = [project('/ws/a'), project('/ws/c'), project('/ws/b')];

      expect(mergeOpenProjects(base, concurrent).map((p) => p.path)).toEqual([
        '/ws/a',
        '/ws/c',
        '/ws/b',
      ]);
    });

    it('base wins for a path both sides know about', () => {
      const base = [{ path: '/ws/a', name: 'from-base', openedAt: 1 }];
      const concurrent = [{ path: '/ws/a', name: 'from-concurrent', openedAt: 2 }];

      expect(mergeOpenProjects(base, concurrent)).toEqual(base);
    });
  });

  // Regression coverage for the `initOpenProjects` overwrite race: App.tsx's
  // `loadInitialState` effect (`addOpenProject` for the window's own primary)
  // and the `rail:add-project` listener (restore-seeded siblings) are
  // independent, unawaited writers to `openProjectsAtom` that can append
  // before `initOpenProjects`'s own IPC round trips resolve. Uses the real
  // `@nimbalyst/runtime/store` singleton -- `initOpenProjects` is hardcoded
  // to it, not to a `createStore()` instance.
  describe('initOpenProjects', () => {
    afterEach(() => {
      teardownOpenProjects();
      store.set(openProjectsAtom, []);
      store.set(activeWorkspacePathAtom, null);
      delete (globalThis as any).window;
    });

    it('merges a concurrently-appended project instead of dropping it on overwrite', async () => {
      let resolveRegisterAdditional!: (value: { success: boolean }) => void;
      (globalThis as any).window = {
        electronAPI: {
          invoke: vi.fn((channel: string) => {
            switch (channel) {
              case 'app:get-multi-project-mode':
                return Promise.resolve(false);
              case 'app:get-restore-previous-projects':
                return Promise.resolve(false);
              case 'app:get-open-projects':
                return Promise.resolve([]);
              case 'app:get-active-project-path':
                return Promise.resolve(null);
              case 'workspace:register-additional':
                // Never resolves before the assertion below reads
                // `openProjectsAtom` -- simulates the concurrent writer
                // (loadInitialState / rail:add-project) landing while
                // `initOpenProjects` is still awaiting main.
                return new Promise((resolve) => {
                  resolveRegisterAdditional = resolve;
                });
              default:
                return Promise.resolve(undefined);
            }
          }),
          getInitialState: vi.fn(() =>
            Promise.resolve({
              mode: 'workspace',
              workspacePath: '/ws/primary',
              activeWorkspacePath: '/ws/primary',
              openProjectPaths: ['/ws/primary', '/ws/sibling'],
            }),
          ),
          send: vi.fn(),
        },
      };

      const initPromise = initOpenProjects();

      // Wait for the module's own IPC round trips to reach the
      // `workspace:register-additional` await.
      await vi.waitFor(() => {
        expect(resolveRegisterAdditional).toBeDefined();
      });

      // The eager merge (before the registration await) already painted
      // the computed initial set -- the rail is not blank while
      // registration is in flight.
      expect(store.get(openProjectsAtom).map((p) => p.path)).toEqual(['/ws/primary', '/ws/sibling']);

      // Simulate the concurrent writer (loadInitialState's `addOpenProject`
      // for the primary, or the `rail:add-project` listener for a seeded
      // sibling) appending a project via the real `addOpenProjectAtom` path
      // -- same as production -- while `initOpenProjects` is still awaiting
      // main.
      store.set(
        addOpenProjectAtom,
        { path: '/ws/concurrent', name: 'concurrent', openedAt: 2 },
        { activate: false },
      );

      resolveRegisterAdditional({ success: true });
      await initPromise;

      const paths = store.get(openProjectsAtom).map((p) => p.path);
      // The computed initial set (primary + sibling from openProjectPaths)
      // is present, AND the concurrently-appended path survived the second
      // (post-registration) merge instead of being wiped out by an
      // overwrite.
      expect(paths).toContain('/ws/primary');
      expect(paths).toContain('/ws/sibling');
      expect(paths).toContain('/ws/concurrent');
    });
  });
});
