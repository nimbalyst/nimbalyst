import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { trackerItemsArrayAtom } from '@nimbalyst/runtime';
import type { TrackerItem, TrackerItemChangeEvent } from '@nimbalyst/runtime';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { initTrackerSyncListeners } from '../trackerSyncListeners';

/**
 * NIM-346 (critical) / NIM-794: cross-project tracker isolation.
 *
 * A tracker change event carrying an item from a *different* workspace must never
 * land in this window's tracker atoms. The main-process broadcast is already
 * scoped per-window, but the renderer keeps a defensive workspace filter
 * (`belongsToThisWorkspace`) so a stray event from a buggy code path can't leak
 * a foreign item into the panel. This is the H1 exit-criteria regression test
 * ("items in project X never surface in project Y").
 *
 * Companion to trackerSyncListeners.projectSwitch.test.ts (NIM-668, refetch on
 * switch); this one asserts the isolation filter itself.
 */
describe('trackerSyncListeners cross-project isolation (NIM-346 / NIM-794)', () => {
  let cleanup: (() => void) | undefined;
  let changeHandler: ((change: TrackerItemChangeEvent) => void) | undefined;

  function makeItem(id: string, workspace: string | undefined): TrackerItem {
    return {
      id,
      type: 'bug',
      typeTags: ['bug'],
      title: `Item ${id}`,
      status: 'open',
      workspace: workspace as string,
      archived: false,
      source: 'native',
      syncStatus: 'synced',
    } as TrackerItem;
  }

  beforeEach(() => {
    changeHandler = undefined;
    store.set(activeWorkspacePathAtom, '/ws/A');

    const invoke = vi.fn(async (channel: string) => {
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
        on: vi.fn((channel: string, cb: (...args: unknown[]) => void) => {
          if (channel === 'document-service:tracker-items-changed') {
            changeHandler = cb as (change: TrackerItemChangeEvent) => void;
          }
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
  });

  it('drops added items from a foreign workspace and keeps local ones', async () => {
    cleanup = initTrackerSyncListeners();

    // Wait until the change handler is registered (post get-initial-state chain).
    await vi.waitFor(() => {
      expect(changeHandler).toBeTypeOf('function');
    });

    changeHandler!({
      added: [
        makeItem('local_1', '/ws/A'),
        makeItem('foreign_1', '/ws/B'),
      ],
    } as TrackerItemChangeEvent);

    const ids = store.get(trackerItemsArrayAtom).map((r) => r.id);
    expect(ids).toContain('local_1');
    expect(ids).not.toContain('foreign_1');
  });

  it('drops updated items from a foreign workspace', async () => {
    cleanup = initTrackerSyncListeners();
    await vi.waitFor(() => {
      expect(changeHandler).toBeTypeOf('function');
    });

    changeHandler!({
      updated: [makeItem('foreign_2', '/ws/B')],
    } as TrackerItemChangeEvent);

    const ids = store.get(trackerItemsArrayAtom).map((r) => r.id);
    expect(ids).not.toContain('foreign_2');
  });

  it('passes through items with no workspace field (legacy / frontmatter)', async () => {
    cleanup = initTrackerSyncListeners();
    await vi.waitFor(() => {
      expect(changeHandler).toBeTypeOf('function');
    });

    changeHandler!({
      added: [makeItem('legacy_1', undefined)],
    } as TrackerItemChangeEvent);

    const ids = store.get(trackerItemsArrayAtom).map((r) => r.id);
    expect(ids).toContain('legacy_1');
  });
});
