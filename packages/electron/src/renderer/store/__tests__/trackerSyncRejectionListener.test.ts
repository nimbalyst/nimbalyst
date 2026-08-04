/**
 * Tests the `tracker-sync:mutation-rejected` routing in trackerSyncListeners:
 * banner-worthy codes land in `trackerSyncRejectionAtom`, bug codes
 * (`forbidden`/`malformed`) stay off the banner. `custodyUnavailable` is the
 * current server-managed rejection (server could not load the team DEK);
 * `staleKeyEpoch`/`rotationLocked` are legacy codes retained for old-server
 * compatibility.
 */
import { atom } from 'jotai';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';

vi.mock('@nimbalyst/runtime', () => ({
  replaceAllTrackerItemsAtom: atom(null, () => {}),
  upsertTrackerItemAtom: atom(null, () => {}),
  removeTrackerItemAtom: atom(null, () => {}),
  trackerDataLoadedAtom: atom(false),
}));
vi.mock('@nimbalyst/runtime/core/TrackerRecord', () => ({
  trackerItemToRecord: (item: unknown) => item,
}));
vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models', () => ({
  globalRegistry: new Map(),
  isRelationshipField: () => false,
}));
vi.mock('../atoms/openProjects', () => ({
  activeWorkspacePathAtom: atom<string | null>(null),
}));
vi.mock('../atoms/trackerNavigation', () => ({
  loadTrackerNavigationAtom: atom(null, async () => {}),
}));
vi.mock('../atoms/trackers', () => ({
  initTrackerPanelLayout: async () => {},
  loadSharedTrackerViewsAtom: atom(null, async () => {}),
}));

import { trackerSyncRejectionAtom } from '../atoms/trackerSync';

type EventHandler = (...args: any[]) => void;

let handlers: Map<string, EventHandler>;
let cleanup: (() => void) | null = null;

function makeApi() {
  return {
    on: vi.fn((channel: string, handler: EventHandler) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    }),
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'document-service:tracker-items-list') return [];
      return {};
    }),
    send: vi.fn(),
  };
}

const WS = '/ws/tracker-rejections';

beforeEach(async () => {
  handlers = new Map();
  vi.stubGlobal('window', { electronAPI: makeApi() });
  store.set(trackerSyncRejectionAtom, {
    staleKeyEpoch: null,
    rotationLocked: null,
    custodyUnavailable: null,
  });
  const mod = await import('../listeners/trackerSyncListeners');
  cleanup = mod.initTrackerSyncListeners();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

function fireRejection(payload: Record<string, unknown>) {
  const handler = handlers.get('tracker-sync:mutation-rejected');
  if (!handler) throw new Error('tracker-sync:mutation-rejected handler not registered');
  handler(payload);
}

describe('tracker-sync:mutation-rejected routing', () => {
  it('surfaces custodyUnavailable rejections in the banner atom', () => {
    fireRejection({
      workspacePath: WS,
      itemId: 'item-1',
      code: 'custodyUnavailable',
      message: 'team DEK unavailable',
    });

    const state = store.get(trackerSyncRejectionAtom);
    expect(state.custodyUnavailable).toMatchObject({
      workspacePath: WS,
      code: 'custodyUnavailable',
      itemId: 'item-1',
      message: 'team DEK unavailable',
    });
  });

  it('still surfaces the legacy staleKeyEpoch and rotationLocked codes', () => {
    fireRejection({ workspacePath: WS, itemId: 'item-2', code: 'staleKeyEpoch' });
    fireRejection({ workspacePath: WS, itemId: 'item-3', code: 'rotationLocked' });

    const state = store.get(trackerSyncRejectionAtom);
    expect(state.staleKeyEpoch?.itemId).toBe('item-2');
    expect(state.rotationLocked?.itemId).toBe('item-3');
  });

  it('keeps forbidden/malformed off the banner atom', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fireRejection({ workspacePath: WS, itemId: 'item-4', code: 'forbidden' });
      fireRejection({ workspacePath: WS, itemId: 'item-5', code: 'malformed' });

      const state = store.get(trackerSyncRejectionAtom);
      expect(state.custodyUnavailable).toBeNull();
      expect(state.staleKeyEpoch).toBeNull();
      expect(state.rotationLocked).toBeNull();
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });
});
