import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { initTrackerPanelLayout, sharedTrackerSavedViewsAtom } from '../../atoms/trackers';
import { initTrackerSyncListeners } from '../trackerSyncListeners';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import type { TrackerRecord } from '@nimbalyst/tracker-core';
import { mergeLocalWikiRecords } from '../../../services/localWikiTrackerRecords';
import {
  createDefaultViewDefinition,
  serializeSharedSavedView,
} from '../../../components/TrackerMode/trackerSavedViews';

const mockApplyMarkdownToWarmEntry = vi.hoisted(() => vi.fn(async () => 'acknowledged' as const));

vi.mock('../../../services/BodyDocCache', () => ({
  getBodyDocCache: () => ({
    applyMarkdownToWarmEntry: mockApplyMarkdownToWarmEntry,
  }),
}));

/**
 * NIM-668 / GitHub #441: the Trackers panel must refetch when the user switches
 * projects in the sidebar rail. The listener captures the startup workspace and
 * never resubscribed, so a project switch left the panel pinned to the old
 * project's items. The fix subscribes to activeWorkspacePathAtom and refetches.
 */
describe('initTrackerSyncListeners project switch (NIM-668)', () => {
  let cleanup: (() => void) | undefined;
  let invoke: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;
  let handlers: Record<string, (payload: any) => void>;

  beforeEach(() => {
    store.set(activeWorkspacePathAtom, '/ws/A');
    handlers = {};
    send = vi.fn();
    mockApplyMarkdownToWarmEntry.mockClear();

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
        send,
        on: vi.fn((channel: string, callback: (payload: any) => void) => {
          handlers[channel] = callback;
          return () => {};
        }),
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

  it('drops the previous project\'s Local wiki items on a switch', async () => {
    const wikiItem = { id: 'wiki-a', primaryType: 'competitor', typeTags: ['competitor'], source: 'local-wiki', archived: false,
      syncStatus: 'local', system: { workspace: '/ws/A', createdAt: 'x', updatedAt: 'x' }, fields: { title: 'Acme' } } as TrackerRecord;
    cleanup = initTrackerSyncListeners();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('document-service:tracker-items-list');
    });
    mergeLocalWikiRecords('/ws/A', [wikiItem]);
    expect(store.get(trackerItemsMapAtom).has('wiki-a')).toBe(true);

    store.set(activeWorkspacePathAtom, '/ws/B');
    expect(store.get(trackerItemsMapAtom).has('wiki-a')).toBe(false);
    await vi.waitFor(() => {
      expect(invoke.mock.calls.filter(([channel]) => channel === 'document-service:tracker-items-list').length).toBe(2);
    });
    await Promise.resolve();
    expect(store.get(trackerItemsMapAtom).has('wiki-a')).toBe(false);
    mergeLocalWikiRecords('/ws/A', []);
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

  /**
   * NIM-3731: App's `initTrackerPanelLayout` effect and this listener's startup
   * snapshot both own the shared-view atom. The effect clears it synchronously
   * and then reloads only the LOCAL views from workspace state, so when the
   * snapshot's IPC round trips beat React's commit of `workspacePath`, the clear
   * lands last and every team-shared view disappears from the sidebar until an
   * unrelated share/unshare event happens to refill it.
   */
  it('keeps shared views loaded when the layout init runs after the snapshot', async () => {
    cleanup = initTrackerSyncListeners();
    await vi.waitFor(() => {
      expect(store.get(sharedTrackerSavedViewsAtom).map(view => view.id)).toEqual(['view-a']);
    });

    await initTrackerPanelLayout('/ws/A');

    await vi.waitFor(() => {
      expect(store.get(sharedTrackerSavedViewsAtom).map(view => view.id)).toEqual(['view-a']);
    });
  });

  it('routes an agent body write through the open editor provider before acknowledging it', async () => {
    cleanup = initTrackerSyncListeners();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('document-service:tracker-items-list');
      expect(handlers['tracker-body:apply-markdown']).toBeTypeOf('function');
    });

    handlers['tracker-body:apply-markdown']({
      workspacePath: '/ws/A',
      itemId: 'bug-open',
      markdown: 'body written by agent',
      responseChannel: 'tracker-body:apply-markdown-result:test',
      expiresAt: Date.now() + 5_000,
    });

    expect(mockApplyMarkdownToWarmEntry).toHaveBeenCalledWith(
      'bug-open',
      'body written by agent',
      '/ws/A',
    );
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        'tracker-body:apply-markdown-result:test',
        { applied: true, acknowledged: true },
      );
    });
  });

  /**
   * Main sends to a window that has the workspace open, which is not always the
   * ACTIVE one. When the handler screened on the active workspace instead, main
   * considered the window a match, the renderer refused, and the write was
   * demoted to the headless peer even though this window held the open editor.
   */
  it('serves an item from a non-active project the window also has open', async () => {
    cleanup = initTrackerSyncListeners();
    await vi.waitFor(() => {
      expect(handlers['tracker-body:apply-markdown']).toBeTypeOf('function');
    });

    handlers['tracker-body:apply-markdown']({
      workspacePath: '/ws/B',
      itemId: 'bug-open',
      markdown: 'body written by agent',
      responseChannel: 'tracker-body:apply-markdown-result:test',
      expiresAt: Date.now() + 5_000,
    });

    expect(mockApplyMarkdownToWarmEntry).toHaveBeenCalledWith(
      'bug-open',
      'body written by agent',
      '/ws/B',
    );
  });

  /**
   * Main deletes the plan's markdown body from disk when this window answers
   * `applied`. A replica mutated without a `docUpdateAck` is exactly the state
   * where that file is the last copy, so the two facts are reported separately
   * and the answer for an unacknowledged write is not a bare `applied: true`.
   */
  it('reports an unacknowledged write as applied-but-not-acknowledged', async () => {
    mockApplyMarkdownToWarmEntry.mockResolvedValueOnce('unacknowledged' as any);
    cleanup = initTrackerSyncListeners();
    await vi.waitFor(() => {
      expect(handlers['tracker-body:apply-markdown']).toBeTypeOf('function');
    });

    handlers['tracker-body:apply-markdown']({
      workspacePath: '/ws/A',
      itemId: 'bug-open',
      markdown: 'body written by agent',
      responseChannel: 'tracker-body:apply-markdown-result:unacked',
      expiresAt: Date.now() + 5_000,
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        'tracker-body:apply-markdown-result:unacked',
        { applied: true, acknowledged: false },
      );
    });
  });

  /**
   * Past main's deadline the headless fallback is already running. Applying
   * anyway lands the body twice -- two replicas each computing `clear + insert`
   * against a different view of the room merge into two copies.
   */
  it('refuses an apply that arrives after the main-process deadline', async () => {
    cleanup = initTrackerSyncListeners();
    await vi.waitFor(() => {
      expect(handlers['tracker-body:apply-markdown']).toBeTypeOf('function');
    });

    handlers['tracker-body:apply-markdown']({
      workspacePath: '/ws/A',
      itemId: 'bug-open',
      markdown: 'body written by agent',
      responseChannel: 'tracker-body:apply-markdown-result:late',
      expiresAt: Date.now() - 1,
    });

    expect(mockApplyMarkdownToWarmEntry).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        'tracker-body:apply-markdown-result:late',
        { applied: false, acknowledged: false },
      );
    });
  });
});
