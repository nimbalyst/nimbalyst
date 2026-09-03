// @vitest-environment node
import { createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activeWorkspacePathAtom,
  openProjectsAtom,
} from '../../atoms/openProjects';
import { initWorkspaceActivationListeners } from '../workspaceActivationListeners';

const PROJECT_A = '/Users/dev/project-a';
const PROJECT_B = '/Users/dev/project-b';

function openProject(path: string) {
  return { path, name: path.split('/').pop()!, openedAt: 0 };
}

function installWindow() {
  let listener: ((data: unknown) => void) | undefined;
  const invoke = vi.fn().mockResolvedValue({ success: true });
  const unsubscribe = vi.fn();

  (globalThis as any).window = {
    electronAPI: {
      invoke,
      on: vi.fn((channel: string, handler: (data: unknown) => void) => {
        expect(channel).toBe('workspace:activate-project');
        listener = handler;
        return unsubscribe;
      }),
    },
  };

  // The handler returns synchronously but its work is async; flush the
  // microtasks the register round trip queues before asserting.
  return {
    invoke,
    unsubscribe,
    async activate(data: unknown) {
      listener?.(data);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('initWorkspaceActivationListeners', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    delete (globalThis as any).window;
  });

  it('switches a window that moved off the requested project back to it', async () => {
    // The reporter's sequence: this window was created for Project-A, the user
    // switched it to Project-B, and main has now routed an open-Project-A
    // request back to this window.
    const store = createStore();
    store.set(openProjectsAtom, [openProject(PROJECT_A), openProject(PROJECT_B)]);
    store.set(activeWorkspacePathAtom, PROJECT_B);

    const { invoke, activate } = installWindow();
    initWorkspaceActivationListeners(store);

    await activate({ workspacePath: PROJECT_A });

    expect(store.get(activeWorkspacePathAtom)).toBe(PROJECT_A);
    // Already in the rail, so no re-registration round trip.
    expect(invoke).not.toHaveBeenCalled();
  });

  it('registers with main before activating a project the rail has dropped', async () => {
    const store = createStore();
    store.set(openProjectsAtom, [openProject(PROJECT_B)]);
    store.set(activeWorkspacePathAtom, PROJECT_B);

    const calls: string[] = [];
    const { invoke, activate } = installWindow();
    invoke.mockImplementation(async () => {
      calls.push('register');
      return { success: true };
    });
    store.sub(activeWorkspacePathAtom, () => calls.push('activate'));

    initWorkspaceActivationListeners(store);
    await activate({ workspacePath: PROJECT_A });

    expect(invoke).toHaveBeenCalledWith('workspace:register-additional', {
      workspacePath: PROJECT_A,
    });
    // Order matters: main rejects `workspace:set-active` for an unregistered path.
    expect(calls).toEqual(['register', 'activate']);
    expect(store.get(activeWorkspacePathAtom)).toBe(PROJECT_A);
    expect(store.get(openProjectsAtom).map((p) => p.path)).toContain(PROJECT_A);
  });

  it('leaves the rail alone when main refuses the registration', async () => {
    const store = createStore();
    store.set(openProjectsAtom, [openProject(PROJECT_B)]);
    store.set(activeWorkspacePathAtom, PROJECT_B);

    const { invoke, activate } = installWindow();
    invoke.mockResolvedValue({ success: false, error: 'gone' });

    initWorkspaceActivationListeners(store);
    await activate({ workspacePath: PROJECT_A });

    expect(store.get(activeWorkspacePathAtom)).toBe(PROJECT_B);
    expect(store.get(openProjectsAtom).map((p) => p.path)).not.toContain(PROJECT_A);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('ignores an empty payload and a project that is already visible', async () => {
    const store = createStore();
    store.set(openProjectsAtom, [openProject(PROJECT_A)]);
    store.set(activeWorkspacePathAtom, PROJECT_A);

    const { invoke, activate } = installWindow();
    initWorkspaceActivationListeners(store);

    await activate(undefined);
    await activate({});
    await activate({ workspacePath: PROJECT_A });

    expect(invoke).not.toHaveBeenCalled();
    expect(store.get(activeWorkspacePathAtom)).toBe(PROJECT_A);
  });

  it('unsubscribes through the closure electronAPI.on returned', () => {
    const { unsubscribe } = installWindow();
    initWorkspaceActivationListeners(createStore())();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
