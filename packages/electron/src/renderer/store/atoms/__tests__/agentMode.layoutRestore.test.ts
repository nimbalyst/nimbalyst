// @vitest-environment node
import { store } from '@nimbalyst/runtime/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initAgentModeLayout } from '../agentMode';
import { activeWorkspacePathAtom, openProjectsAtom } from '../openProjects';
import { selectedWorkstreamAtom } from '../sessions';
import { initWorkstreamState, workstreamStatesLoadedAtom } from '../workstreamState';
import { navigateToNotificationSession } from '../../actions/sessionNotificationNavigation';

/**
 * Switching the rail to another project runs `initAgentModeLayout` for it,
 * which reads the persisted layout and selection over IPC. A notification
 * click switches the rail and selects its session while that read is still
 * in flight. Worth a test because the damage only shows on screen: the list
 * highlights the clicked session, the main view opens the old one.
 */

const PROJECT_A = '/Users/dev/project-a';
const PROJECT_B = '/Users/dev/project-b';

function openProject(path: string) {
  return { path, name: path.split('/').pop()!, openedAt: 0 };
}

/** Main process stub: `workspace:get-state` answers through `getState`, everything else succeeds. */
function installWindow(
  sessionsByProject: Record<string, string[]>,
  getState: (workspacePath: string) => Promise<unknown>,
) {
  (globalThis as any).window = {
    electronAPI: {
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
        if (channel === 'sessions:list') {
          const ids = sessionsByProject[args[0] as string] ?? [];
          return {
            success: true,
            sessions: ids.map((id) => ({ id, title: id, createdAt: 0, updatedAt: 0 })),
          };
        }
        if (channel === 'workspace:get-state') return getState(args[0] as string);
        return { success: true };
      }),
      on: vi.fn(() => () => {}),
    },
  };
}

/** Persisted state for project A whose answer the test releases by hand. */
function heldRestore(selectedId: string) {
  let answer: () => void = () => {};
  const persisted = new Promise((resolve) => {
    answer = () => resolve({
      agenticCodingWindowState: { selectedWorkstream: { type: 'session', id: selectedId } },
    });
  });
  return { persisted, answer };
}

describe('initAgentModeLayout selection restore', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.set(openProjectsAtom, [openProject(PROJECT_A), openProject(PROJECT_B)]);
    store.set(activeWorkspacePathAtom, PROJECT_B);
    initWorkstreamState(PROJECT_B);
    // A window that already shows a project has loaded its workstream states.
    // On a cold window the notification path would also wait for the held
    // `workspace:get-state` below.
    store.set(workstreamStatesLoadedAtom, true);
    store.set(selectedWorkstreamAtom(PROJECT_A), { type: 'session', id: 'session-a-old' });
  });

  afterEach(() => {
    errorSpy.mockRestore();
    delete (globalThis as any).window;
  });

  it('keeps the session a notification click opened when the rail restore answers late', async () => {
    const restore = heldRestore('session-a-old');
    installWindow(
      { [PROJECT_A]: ['session-a', 'session-a-old'], [PROJECT_B]: [] },
      (workspacePath) => (workspacePath === PROJECT_A ? restore.persisted : Promise.resolve({})),
    );
    // Stand-in for the rail effect in App.tsx, which restores the layout of
    // whichever project becomes active.
    const restores: Promise<void>[] = [];
    const stopRailEffect = store.sub(activeWorkspacePathAtom, () => {
      restores.push(initAgentModeLayout(store.get(activeWorkspacePathAtom)!));
    });

    try {
      const opened = await navigateToNotificationSession({
        sessionId: 'session-a', workspacePath: PROJECT_A, sourceLabel: 'Session A',
      });
      expect(opened).toBe(true);
      expect(store.get(activeWorkspacePathAtom)).toBe(PROJECT_A);
      expect(store.get(selectedWorkstreamAtom(PROJECT_A))).toEqual({ type: 'session', id: 'session-a' });

      restore.answer();
      await Promise.all(restores);

      expect(restores.length).toBeGreaterThan(0);
      expect(store.get(selectedWorkstreamAtom(PROJECT_A))).toEqual({ type: 'session', id: 'session-a' });
    } finally {
      stopRailEffect();
    }
  });

  it('still restores the persisted selection when nothing selected meanwhile', async () => {
    store.set(selectedWorkstreamAtom(PROJECT_A), null);
    const restore = heldRestore('session-a-old');
    installWindow({}, () => restore.persisted);

    const done = initAgentModeLayout(PROJECT_A, { setActive: false });
    restore.answer();
    await done;

    expect(store.get(selectedWorkstreamAtom(PROJECT_A))).toEqual({ type: 'session', id: 'session-a-old' });
  });
});
