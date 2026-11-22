// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { useSessionSelectionFallback } from '../../../hooks/useSessionSelectionFallback';
import { store } from '@nimbalyst/runtime/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initAgentModeLayout } from '../agentMode';
import { activeWorkspacePathAtom, multiProjectModeAtom, openProjectsAtom } from '../openProjects';
import { selectedWorkstreamAtom } from '../sessions';
import { initWorkstreamState, workstreamStatesLoadedAtom } from '../workstreamState';
import { navigateToNotificationSession } from '../../actions/sessionNotificationNavigation';
import { initTrayListeners } from '../../listeners/trayListeners';
import { openSessionInTabActionAtom } from '../../actions/sessionHistoryActions';

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
  Object.assign(window, {
    electronAPI: {
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
        if (channel === 'sessions:list') {
          const ids = sessionsByProject[args[0] as string] ?? [];
          return {
            success: true,
            sessions: ids.map((id) => ({ id, title: id, createdAt: 0, updatedAt: 0 })),
          };
        }
        if (channel === 'sessions:get') {
          const owner = Object.keys(sessionsByProject)
            .find((project) => sessionsByProject[project].includes(args[0] as string));
          return { success: true, session: owner ? { id: args[0], workspacePath: owner } : null };
        }
        if (channel === 'workspace:get-state') return getState(args[0] as string);
        return { success: true };
      }),
      on: vi.fn(() => () => {}),
    },
  });
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
    store.set(multiProjectModeAtom, true);
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
    cleanup();
    vi.useRealTimers();
    delete (window as any).electronAPI;
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

  it('restores the saved session when the automatic fallback timer fires during a delayed read', async () => {
    vi.useFakeTimers();
    store.set(activeWorkspacePathAtom, PROJECT_A);
    store.set(selectedWorkstreamAtom(PROJECT_A), null);
    const restore = heldRestore('session-a-old');
    installWindow({}, () => restore.persisted);
    const done = initAgentModeLayout(PROJECT_A, { setActive: false });
    const select = vi.fn((id: string) => {
      store.set(selectedWorkstreamAtom(PROJECT_A), { type: 'session', id });
    });
    renderHook(() => useSessionSelectionFallback(PROJECT_A, null, 'session-a-first', select));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    await act(async () => { restore.answer(); await done; });
    expect(store.get(selectedWorkstreamAtom(PROJECT_A))).toEqual({ type: 'session', id: 'session-a-old' });
    expect(select).not.toHaveBeenCalled();
  });


  it.each(['empty', 'failed'])('selects the first session after a %s restore finishes', async (result) => {
    vi.useFakeTimers();
    store.set(activeWorkspacePathAtom, PROJECT_A);
    store.set(selectedWorkstreamAtom(PROJECT_A), null);
    let finish!: () => void;
    const persisted = new Promise((resolve, reject) => {
      finish = () => result === 'failed' ? reject(new Error('read failed')) : resolve({});
    });
    installWindow({}, () => persisted);
    const done = initAgentModeLayout(PROJECT_A, { setActive: false });
    const select = vi.fn();
    renderHook(() => useSessionSelectionFallback(PROJECT_A, null, 'session-a-first', select));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(select).not.toHaveBeenCalled();
    await act(async () => { finish(); await done; });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(select).toHaveBeenCalledExactlyOnceWith('session-a-first');
    if (result === 'failed') {
      expect(errorSpy).toHaveBeenCalledWith('[agentMode] Failed to load layout:', expect.any(Error));
    } else {
      expect(errorSpy).not.toHaveBeenCalled();
    }
  });

  it('waits for overlapping restores and preserves a deliberate click while they are pending', async () => {
    vi.useFakeTimers();
    store.set(activeWorkspacePathAtom, PROJECT_A);
    store.set(selectedWorkstreamAtom(PROJECT_A), null);
    let finishEmpty!: () => void;
    const empty = new Promise(resolve => { finishEmpty = () => resolve({}); });
    const saved = heldRestore('session-a-old');
    let reads = 0;
    installWindow({}, () => ++reads === 1 ? empty : saved.persisted);
    const first = initAgentModeLayout(PROJECT_A, { setActive: false });
    const second = initAgentModeLayout(PROJECT_A, { setActive: false });
    const select = vi.fn();
    renderHook(() => useSessionSelectionFallback(PROJECT_A, null, 'session-a-first', select));
    await act(async () => { finishEmpty(); await first; });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(select).not.toHaveBeenCalled();
    await act(async () => {
      store.set(selectedWorkstreamAtom(PROJECT_A), { type: 'session', id: 'clicked-session' });
      saved.answer();
      await second;
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(store.get(selectedWorkstreamAtom(PROJECT_A))).toEqual({ type: 'session', id: 'clicked-session' });
    expect(select).not.toHaveBeenCalled();
  });

  // Main routes a menu bar click to the window whose rail holds the project,
  // which may be showing another rail project.
  it('opens a menu bar session in its own rail project, not the active one', async () => {
    installWindow({ [PROJECT_A]: ['session-a'], [PROJECT_B]: ['session-b'] }, async () => ({}));
    store.set(selectedWorkstreamAtom(PROJECT_B), { type: 'session', id: 'session-b' });
    const handlers = new Map<string, (data: unknown) => unknown>();
    (window as any).electronAPI.on = vi.fn((channel: string, handler: (data: unknown) => unknown) => {
      handlers.set(channel, handler);
      return () => {};
    });
    const stop = initTrayListeners();
    try {
      await handlers.get('tray:navigate-to-session')!({ sessionId: 'session-a', workspacePath: PROJECT_A });
      await vi.waitFor(() => expect(store.get(activeWorkspacePathAtom)).toBe(PROJECT_A));
      await vi.waitFor(() =>
        expect(store.get(selectedWorkstreamAtom(PROJECT_A))).toEqual({ type: 'session', id: 'session-a' }));
      expect(store.get(selectedWorkstreamAtom(PROJECT_B))).toEqual({ type: 'session', id: 'session-b' });
    } finally {
      stop();
    }
  });

  // The user clicks project B in the rail while the notification for session-a
  // is still loading project A's session list.
  it('drops a notification navigation when the user switches projects before it lands', async () => {
    // A cold window: the navigation waits for the persisted workstream states.
    store.set(workstreamStatesLoadedAtom, false);
    const restore = heldRestore('session-a-old');
    let stateRequested = false;
    installWindow(
      { [PROJECT_A]: ['session-a'], [PROJECT_B]: ['session-b'] },
      (workspacePath) => {
        if (workspacePath !== PROJECT_A) return Promise.resolve({});
        stateRequested = true;
        return restore.persisted;
      },
    );
    store.set(selectedWorkstreamAtom(PROJECT_B), { type: 'session', id: 'session-b' });

    const navigation = navigateToNotificationSession({
      sessionId: 'session-a', workspacePath: PROJECT_A, sourceLabel: 'Session A',
    });
    await vi.waitFor(() => expect(stateRequested).toBe(true));
    expect(store.get(activeWorkspacePathAtom)).toBe(PROJECT_A);
    store.set(activeWorkspacePathAtom, PROJECT_B);
    restore.answer();

    expect(await navigation).toBe(false);
    expect(store.get(activeWorkspacePathAtom)).toBe(PROJECT_B);
    expect(store.get(selectedWorkstreamAtom(PROJECT_B))).toEqual({ type: 'session', id: 'session-b' });
  });

  // With the rail off this window renders only project B. Switching it to A
  // would point main and every workspace-scoped operation at A while B stays
  // on screen, so A's window opens the session instead.
  it('with the rail off, hands a session from another project to that project\'s window', async () => {
    store.set(multiProjectModeAtom, false);
    installWindow({ [PROJECT_A]: ['session-a'], [PROJECT_B]: ['session-b'] }, async () => ({}));
    store.set(selectedWorkstreamAtom(PROJECT_B), { type: 'session', id: 'session-b' });
    const invoke = (window as any).electronAPI.invoke;

    await store.set(openSessionInTabActionAtom, 'session-a');

    expect(invoke).toHaveBeenCalledWith('notifications:navigate-to-session', {
      sessionId: 'session-a', workspacePath: PROJECT_A, sourceLabel: '',
    });
    expect(invoke).not.toHaveBeenCalledWith('workspace:register-additional', expect.anything());
    expect(store.get(activeWorkspacePathAtom)).toBe(PROJECT_B);
    expect(store.get(selectedWorkstreamAtom(PROJECT_A))).toEqual({ type: 'session', id: 'session-a-old' });
    expect(store.get(selectedWorkstreamAtom(PROJECT_B))).toEqual({ type: 'session', id: 'session-b' });
  });

  // The user switches projects while the session list for the click is loading.
  it('does not select a session under a project the user switched to mid-open', async () => {
    installWindow({ [PROJECT_A]: ['session-a'], [PROJECT_B]: ['session-b'] }, async () => ({}));
    store.set(selectedWorkstreamAtom(PROJECT_B), { type: 'session', id: 'session-b' });
    const invoke = (window as any).electronAPI.invoke;
    const answer = invoke.getMockImplementation();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let listing = false;
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'sessions:list' && args[0] === PROJECT_B && !listing) { listing = true; await held; }
      return answer(channel, ...args);
    });

    const opening = store.set(openSessionInTabActionAtom, 'session-b');
    await vi.waitFor(() => expect(listing).toBe(true));
    store.set(activeWorkspacePathAtom, PROJECT_A);
    release();
    await opening;

    expect(store.get(selectedWorkstreamAtom(PROJECT_A))).toEqual({ type: 'session', id: 'session-a-old' });
  });

  // A session chip, a comment's agent link, or a quick-open pick names only a
  // session id; the session can belong to another rail project.
  it('opens a session id from another rail project in that project, not under the active one', async () => {
    installWindow({ [PROJECT_A]: ['session-a'], [PROJECT_B]: ['session-b'] }, async () => ({}));
    store.set(selectedWorkstreamAtom(PROJECT_B), { type: 'session', id: 'session-b' });

    await store.set(openSessionInTabActionAtom, 'session-a');

    expect(store.get(activeWorkspacePathAtom)).toBe(PROJECT_A);
    expect(store.get(selectedWorkstreamAtom(PROJECT_A))).toEqual({ type: 'session', id: 'session-a' });
    expect(store.get(selectedWorkstreamAtom(PROJECT_B))).toEqual({ type: 'session', id: 'session-b' });
  });

});
