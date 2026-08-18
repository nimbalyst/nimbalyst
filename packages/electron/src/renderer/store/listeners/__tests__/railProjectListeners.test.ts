// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom, openProjectsAtom, MAX_OPEN_PROJECTS } from '../../atoms/openProjects';
import { collectPendingRailSeeds, initRailProjectListeners } from '../railProjectListeners';

// Regression coverage for NIM-757 / #548 / reopened #441: registering the
// workspace with main must happen BEFORE the active path flips, or
// `workspace:set-active` rejects the still-unregistered path.
describe('railProjectListeners', () => {
  let handlers: Map<string, (data: unknown) => void>;
  let invoke: ReturnType<typeof vi.fn>;
  let cleanup: () => void;

  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store.set(openProjectsAtom, []);
    store.set(activeWorkspacePathAtom, null);

    handlers = new Map();
    invoke = vi.fn().mockResolvedValue({ success: true });
    send = vi.fn();
    (window as any).electronAPI = {
      invoke,
      send,
      on: (channel: string, callback: (data: unknown) => void) => {
        handlers.set(channel, callback);
        return () => handlers.delete(channel);
      },
    };

    cleanup = initRailProjectListeners();
  });

  afterEach(() => {
    cleanup();
    delete (window as any).electronAPI;
  });

  it('registers the workspace with main before activating it in the rail', async () => {
    let activePathDuringRegistration: string | null | undefined;
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'workspace:register-additional') {
        // The path must not be active yet -- flipping it first is exactly
        // the bug this ordering guards against.
        activePathDuringRegistration = store.get(activeWorkspacePathAtom);
      }
      return { success: true };
    });

    handlers.get('rail:add-project')?.({ workspacePath: '/ws/new' });
    await vi.waitFor(() => {
      expect(store.get(activeWorkspacePathAtom)).toBe('/ws/new');
    });

    expect(invoke).toHaveBeenCalledWith('workspace:register-additional', {
      workspacePath: '/ws/new',
    });
    expect(activePathDuringRegistration).toBeNull();
    expect(store.get(openProjectsAtom).map((p) => p.path)).toEqual(['/ws/new']);
  });

  it('does not re-register a project already in the rail', async () => {
    store.set(openProjectsAtom, [{ path: '/ws/existing', name: 'existing', openedAt: 0 }]);

    handlers.get('rail:add-project')?.({ workspacePath: '/ws/existing' });
    await vi.waitFor(() => {
      expect(store.get(activeWorkspacePathAtom)).toBe('/ws/existing');
    });

    expect(invoke).not.toHaveBeenCalledWith('workspace:register-additional', expect.anything());
  });

  it('does not activate the project when main rejects the registration', async () => {
    invoke.mockResolvedValue({ success: false, error: 'boom' });

    handlers.get('rail:add-project')?.({ workspacePath: '/ws/rejected' });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalled();
    });

    expect(store.get(activeWorkspacePathAtom)).toBeNull();
    expect(store.get(openProjectsAtom)).toEqual([]);
  });

  // Defect (A): a non-activating seed (session restore, "Merge All
  // Windows") must register and append the project without ever flipping
  // the visible project.
  it('activate: false registers and appends without touching the active path', async () => {
    store.set(openProjectsAtom, [{ path: '/ws/primary', name: 'primary', openedAt: 0 }]);
    store.set(activeWorkspacePathAtom, '/ws/primary');

    handlers.get('rail:add-project')?.({ workspacePath: '/ws/sibling', activate: false });
    await vi.waitFor(() => {
      expect(store.get(openProjectsAtom).map((p) => p.path)).toEqual(['/ws/primary', '/ws/sibling']);
    });

    expect(store.get(activeWorkspacePathAtom)).toBe('/ws/primary');
  });

  it('activate: false on an already-open project still does not touch the active path', async () => {
    store.set(openProjectsAtom, [
      { path: '/ws/primary', name: 'primary', openedAt: 0 },
      { path: '/ws/sibling', name: 'sibling', openedAt: 0 },
    ]);
    store.set(activeWorkspacePathAtom, '/ws/primary');

    handlers.get('rail:add-project')?.({ workspacePath: '/ws/sibling', activate: false });
    await vi.waitFor(() => {
      expect(invoke).not.toHaveBeenCalledWith('workspace:register-additional', expect.anything());
    });

    expect(store.get(activeWorkspacePathAtom)).toBe('/ws/primary');
  });

  // Defect (B): when a `requestId` is present, ack main back with the outcome.
  describe('rail:add-project-result ack', () => {
    it('sends an ack with outcome "added" for a new project', async () => {
      handlers.get('rail:add-project')?.({ workspacePath: '/ws/new', requestId: 'req-1' });

      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith('rail:add-project-result', {
          requestId: 'req-1',
          workspacePath: '/ws/new',
          outcome: 'added',
        });
      });
    });

    it('sends an ack with outcome "already-open" for a project already in the rail', async () => {
      store.set(openProjectsAtom, [{ path: '/ws/existing', name: 'existing', openedAt: 0 }]);

      handlers.get('rail:add-project')?.({ workspacePath: '/ws/existing', requestId: 'req-2' });

      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith('rail:add-project-result', {
          requestId: 'req-2',
          workspacePath: '/ws/existing',
          outcome: 'already-open',
        });
      });
    });

    it('sends an ack with outcome "at-cap" when the rail is full', async () => {
      store.set(
        openProjectsAtom,
        Array.from({ length: MAX_OPEN_PROJECTS }, (_, i) => ({
          path: `/ws/${i}`,
          name: `${i}`,
          openedAt: 0,
        })),
      );

      handlers.get('rail:add-project')?.({ workspacePath: '/ws/overflow', requestId: 'req-4' });

      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith('rail:add-project-result', {
          requestId: 'req-4',
          workspacePath: '/ws/overflow',
          outcome: 'at-cap',
        });
      });
    });

    it('sends no ack at all when registration fails', async () => {
      invoke.mockResolvedValue({ success: false, error: 'boom' });

      handlers.get('rail:add-project')?.({ workspacePath: '/ws/rejected', requestId: 'req-3' });
      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalled();
      });

      // Registration failure returns early with no ack at all -- main's
      // ack-waiter (`railSeeding.ts`) times out rather than receiving a
      // false signal that could be confused with 'at-cap'.
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('pending rail seeds', () => {
    it('does not collect seeds merely by registering the listener', () => {
      // Registering must not add projects. Adding re-subscribes session state
      // for that workspace, which writes workstream state and throws
      // "Cannot persist - initWorkstreamState not called" when the workspace
      // is not initialized yet -- that crashed the window into the error
      // boundary on launch. App.tsx collects explicitly, after its own
      // project is established.
      expect(invoke).not.toHaveBeenCalledWith('rail:take-pending-seeds');
    });

    it('ignores a non-array answer instead of rejecting', async () => {
      // The shared `invoke` mock answers every channel with `{ success: true }`.
      // `?? []` only guards null/undefined, so anything else reached the
      // for-of and rejected asynchronously -- which failed CI with 9 unhandled
      // rejections while every test still reported green.
      await expect(collectPendingRailSeeds()).resolves.toBeUndefined();
      expect(store.get(openProjectsAtom)).toHaveLength(0);
    });

    it('adds parked projects without stealing the active one', async () => {
      store.set(activeWorkspacePathAtom, '/ws/primary');
      invoke.mockImplementation(async (channel: string) =>
        channel === 'rail:take-pending-seeds' ? ['/ws/a', '/ws/b'] : { success: true },
      );

      await collectPendingRailSeeds();

      expect(store.get(openProjectsAtom).map((p) => p.path)).toEqual(['/ws/a', '/ws/b']);
      expect(store.get(activeWorkspacePathAtom)).toBe('/ws/primary');
    });
  });
});
