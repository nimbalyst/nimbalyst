import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { sharedTrackerSavedViewsAtom } from '../../atoms/trackers';
import { initTrackerSyncListeners } from '../trackerSyncListeners';
import {
  createDefaultViewDefinition,
  serializeSharedSavedView,
} from '../../../components/TrackerMode/trackerSavedViews';

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

    invoke = vi.fn(async (channel: string, workspacePath?: string) => {
      if (channel === 'get-initial-state') {
        return { mode: 'workspace', workspacePath: '/ws/A' };
      }
      if (channel === 'document-service:tracker-items-list') return [];
      if (channel === 'workspace:get-state') return {};
      if (channel === 'tracker-saved-views:list') {
        return [{
          viewId: workspacePath === '/ws/B' ? 'view-b' : 'view-a',
          payload: serializeSharedSavedView({
            id: workspacePath === '/ws/B' ? 'view-b' : 'view-a',
            name: workspacePath === '/ws/B' ? 'Project B view' : 'Project A view',
            definition: createDefaultViewDefinition(),
          }),
        }];
      }
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
    store.set(sharedTrackerSavedViewsAtom, []);
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

  it('clears and reloads shared views for the newly active workspace', async () => {
    store.set(sharedTrackerSavedViewsAtom, [{
      id: 'stale-a',
      name: 'Stale A',
      shared: true,
      definition: createDefaultViewDefinition(),
    }]);
    cleanup = initTrackerSyncListeners();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('document-service:tracker-items-list');
    });

    store.set(activeWorkspacePathAtom, '/ws/B');

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('tracker-saved-views:list', '/ws/B');
      expect(store.get(sharedTrackerSavedViewsAtom).map(view => view.id)).toEqual(['view-b']);
    });
  });
});
