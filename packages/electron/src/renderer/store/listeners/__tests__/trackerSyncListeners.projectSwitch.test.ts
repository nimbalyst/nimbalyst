import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { initTrackerSyncListeners } from '../trackerSyncListeners';

/**
 * NIM-668 / GitHub #441: the Trackers panel must refetch when the user switches
 * projects in the sidebar rail. The listener captures the startup workspace and
 * never resubscribed, so a project switch left the panel pinned to the old
 * project's items. The fix subscribes to activeWorkspacePathAtom and refetches.
 */
describe('initTrackerSyncListeners project switch (NIM-668)', () => {
  let cleanup: (() => void) | undefined;
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store.set(activeWorkspacePathAtom, '/ws/A');

    invoke = vi.fn(async (channel: string) => {
      if (channel === 'get-initial-state') {
        return { mode: 'workspace', workspacePath: '/ws/A' };
      }
      if (channel === 'document-service:tracker-items-list') return [];
      return undefined;
    });

    vi.stubGlobal('window', {
      electronAPI: {
        invoke,
        send: vi.fn(),
        on: vi.fn(() => () => {}),
        off: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllGlobals();
    store.set(activeWorkspacePathAtom, null);
  });

  it('refetches tracker items when the active workspace changes', async () => {
    cleanup = initTrackerSyncListeners();

    // Initial load resolves through the get-initial-state promise chain.
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('document-service:tracker-items-list');
    });

    const listCallsBeforeSwitch = invoke.mock.calls.filter(
      ([channel]) => channel === 'document-service:tracker-items-list',
    ).length;

    // Switch projects in the rail.
    store.set(activeWorkspacePathAtom, '/ws/B');

    await vi.waitFor(() => {
      const after = invoke.mock.calls.filter(
        ([channel]) => channel === 'document-service:tracker-items-list',
      ).length;
      expect(after).toBeGreaterThan(listCallsBeforeSwitch);
    });
  });
});
