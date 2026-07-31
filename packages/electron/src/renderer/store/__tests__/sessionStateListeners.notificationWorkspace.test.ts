/**
 * Regression tests for notification-click routing across projects.
 *
 * In the multi-project rail one window hosts several projects, and the click
 * used to select the notified session inside whichever project was visible —
 * landing on a session id that does not exist there, and persisting that
 * selection into the wrong project's workspace state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  resetSessionListInit,
  selectedWorkstreamAtom,
  sessionListWorkspaceAtom,
  sessionRegistryAtom,
} from '../atoms/sessions';
import {
  activeWorkspacePathAtom,
  multiProjectModeAtom,
  openProjectsAtom,
} from '../atoms/openProjects';
import { initWorkstreamState } from '../atoms/workstreamState';

type EventHandler = (...args: any[]) => void;

const VISIBLE_WS = '/ws/visible-project';
const NOTIFIED_WS = '/ws/notified-project';
const NOTIFIED_SESSION = 'session-in-notified-project';

let handlers: Map<string, EventHandler>;
let cleanup: (() => void) | null = null;

function makeApi() {
  return {
    on: vi.fn((channel: string, handler: EventHandler) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    }),
    invoke: vi.fn(async (channel: string, arg?: unknown) => {
      if (channel === 'sessions:list') {
        // Only the notified project has the session; this mirrors the real
        // registry, which is replaced wholesale on every workspace switch.
        const sessions = arg === NOTIFIED_WS
          ? [{
              id: NOTIFIED_SESSION,
              title: 'Notified session',
              createdAt: 1,
              updatedAt: 1,
              provider: 'claude-code',
              sessionType: 'session',
              parentSessionId: null,
            }]
          : [];
        return { success: true, sessions };
      }
      return { success: true };
    }),
    send: vi.fn(),
    sessionState: {
      subscribe: vi.fn().mockResolvedValue({ success: true }),
      unsubscribe: vi.fn().mockResolvedValue({ success: true }),
      getTrackedSessionIds: vi.fn().mockResolvedValue({ success: true, sessionIds: [] }),
      getRunningSessionIds: vi.fn().mockResolvedValue({ success: true, sessionIds: [] }),
      onStateChange: vi.fn((handler: EventHandler) => {
        handlers.set('ai-session-state:event', handler);
        return () => handlers.delete('ai-session-state:event');
      }),
    },
  };
}

function clickNotification(data: { sessionId: string; workspacePath?: string }): void {
  const handler = handlers.get('notification-clicked');
  expect(handler).toBeTypeOf('function');
  handler!(data);
}

beforeEach(async () => {
  handlers = new Map();
  resetSessionListInit();
  store.set(sessionRegistryAtom, new Map());
  store.set(selectedWorkstreamAtom(VISIBLE_WS), null);
  store.set(selectedWorkstreamAtom(NOTIFIED_WS), null);
  store.set(sessionListWorkspaceAtom, VISIBLE_WS);
  store.set(activeWorkspacePathAtom, VISIBLE_WS);
  // AgentMode points the workstream module at the mounted project; model that
  // so the fallback paths do not depend on a previous test having done it.
  initWorkstreamState(VISIBLE_WS);
  store.set(multiProjectModeAtom, true);
  store.set(openProjectsAtom, [
    { path: VISIBLE_WS, name: 'visible', openedAt: 1 },
    { path: NOTIFIED_WS, name: 'notified', openedAt: 2 },
  ]);

  vi.stubGlobal('window', { electronAPI: makeApi() });
  const mod = await import('../sessionStateListeners');
  cleanup = mod.initSessionStateListeners();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  resetSessionListInit();
  vi.unstubAllGlobals();
});

describe('notification click across projects', () => {
  it('activates the notified project instead of staying on the visible one', async () => {
    clickNotification({ sessionId: NOTIFIED_SESSION, workspacePath: NOTIFIED_WS });

    await vi.waitFor(() => {
      expect(store.get(activeWorkspacePathAtom)).toBe(NOTIFIED_WS);
    });
  });

  it('selects the session in the notified project', async () => {
    clickNotification({ sessionId: NOTIFIED_SESSION, workspacePath: NOTIFIED_WS });

    await vi.waitFor(() => {
      expect(store.get(selectedWorkstreamAtom(NOTIFIED_WS))).toEqual({
        type: 'session',
        id: NOTIFIED_SESSION,
      });
    });
  });

  it('never writes the foreign session id into the visible project', async () => {
    clickNotification({ sessionId: NOTIFIED_SESSION, workspacePath: NOTIFIED_WS });

    await vi.waitFor(() => {
      expect(store.get(selectedWorkstreamAtom(NOTIFIED_WS))).not.toBeNull();
    });
    expect(store.get(selectedWorkstreamAtom(VISIBLE_WS))).toBeNull();
  });

  it('does not switch projects when the notification targets the visible one', async () => {
    store.set(sessionRegistryAtom, new Map([[
      'local-session',
      {
        id: 'local-session',
        title: 'Local',
        provider: 'claude-code',
        sessionType: 'session',
        workspaceId: VISIBLE_WS,
        worktreeId: null,
        parentSessionId: null,
        childCount: 0,
        uncommittedCount: 0,
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        isArchived: false,
        isPinned: false,
      },
    ]]) as never);

    clickNotification({ sessionId: 'local-session', workspacePath: VISIBLE_WS });

    await vi.waitFor(() => {
      expect(store.get(selectedWorkstreamAtom(VISIBLE_WS))).toEqual({
        type: 'session',
        id: 'local-session',
      });
    });
    expect(store.get(activeWorkspacePathAtom)).toBe(VISIBLE_WS);
  });

  it('falls back to the visible project when the payload carries no path', async () => {
    clickNotification({ sessionId: 'legacy-session', workspacePath: '' });

    await vi.waitFor(() => {
      expect(store.get(selectedWorkstreamAtom(VISIBLE_WS))).toEqual({
        type: 'session',
        id: 'legacy-session',
      });
    });
    expect(store.get(activeWorkspacePathAtom)).toBe(VISIBLE_WS);
  });

  it('falls back to the visible project when the target is not open in this window', async () => {
    store.set(openProjectsAtom, [{ path: VISIBLE_WS, name: 'visible', openedAt: 1 }]);

    clickNotification({ sessionId: NOTIFIED_SESSION, workspacePath: NOTIFIED_WS });

    await vi.waitFor(() => {
      expect(store.get(selectedWorkstreamAtom(VISIBLE_WS))).not.toBeNull();
    });
    expect(store.get(activeWorkspacePathAtom)).toBe(VISIBLE_WS);
    expect(store.get(selectedWorkstreamAtom(NOTIFIED_WS))).toBeNull();
  });
});
