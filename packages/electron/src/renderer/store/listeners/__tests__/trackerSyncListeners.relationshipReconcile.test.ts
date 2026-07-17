import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { trackerItemsMapAtom } from '@nimbalyst/runtime';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { initTrackerSyncListeners } from '../trackerSyncListeners';

/**
 * NIM-1305: a relationship-bearing `tracker-items-changed` event can arrive as a
 * partial/out-of-order burst (inverse propagation), and the granular
 * last-write-wins upsert has no reconciliation, so the detail panel could stick
 * on stale `No links`. The listener now schedules a debounced reload from the
 * authoritative read model whenever a relationship-bearing change lands.
 */
describe('initTrackerSyncListeners relationship reconcile (NIM-1305)', () => {
  let cleanup: (() => void) | undefined;
  let invoke: ReturnType<typeof vi.fn>;
  let handlers: Record<string, (payload: any) => void>;
  let listModel: any;

  const FEATURE = {
    type: 'feature',
    displayName: 'Feature',
    displayNamePlural: 'Features',
    icon: 'label',
    color: '#888',
    modes: { inline: true, fullDocument: false },
    idPrefix: 'FEAT',
    idFormat: 'ulid' as const,
    fields: [
      { name: 'title', type: 'string' as const },
      {
        name: 'parentModule', type: 'relationship' as const, relationshipTypeKey: 'child-of',
        multiValue: false, inverseFieldId: 'features', inverseRelationshipTypeKey: 'parent-of',
      },
    ],
  };

  beforeEach(() => {
    globalRegistry.register(FEATURE as any);
    store.set(trackerItemsMapAtom, new Map());
    store.set(activeWorkspacePathAtom, '/ws/A');

    // The read model the reconcile will reload from. Defaults to empty; tests
    // override `listModel` to return the authoritative (correct) items.
    listModel = [];
    handlers = {};
    invoke = vi.fn(async (channel: string) => {
      if (channel === 'get-initial-state') return { mode: 'workspace', workspacePath: '/ws/A' };
      if (channel === 'document-service:tracker-items-list') return listModel;
      return undefined;
    });

    vi.stubGlobal('window', {
      electronAPI: {
        invoke,
        send: vi.fn(),
        on: vi.fn((channel: string, cb: (payload: any) => void) => {
          handlers[channel] = cb;
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
    store.set(trackerItemsMapAtom, new Map());
  });

  async function startAndSettleInitialLoad() {
    cleanup = initTrackerSyncListeners();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('document-service:tracker-items-list');
    });
    return invoke.mock.calls.filter(([c]) => c === 'document-service:tracker-items-list').length;
  }

  it('reloads from the read model after a relationship-bearing change', async () => {
    const before = await startAndSettleInitialLoad();

    handlers['document-service:tracker-items-changed']({
      added: [],
      updated: [{ id: 'feature-1', type: 'feature', title: 'Agent Mode', customFields: { parentModule: [{ itemId: 'module-1' }] } }],
      removed: [],
      timestamp: new Date(),
    });

    await vi.waitFor(() => {
      const after = invoke.mock.calls.filter(([c]) => c === 'document-service:tracker-items-list').length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('reloads for a relationship-shaped change on a not-yet-registered type', async () => {
    const before = await startAndSettleInitialLoad();

    // Custom types register asynchronously; an inverse-propagation burst can land
    // before the schema is known. The value-shape fallback must still reconcile.
    handlers['document-service:tracker-items-changed']({
      added: [],
      updated: [{ id: 'x-1', type: 'unregisteredType', title: 'X', customFields: { blockedBy: [{ itemId: 'y-1' }] } }],
      removed: [],
      timestamp: new Date(),
    });

    await vi.waitFor(() => {
      const after = invoke.mock.calls.filter(([c]) => c === 'document-service:tracker-items-list').length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('does not reload for a plain custom field on a not-yet-registered type', async () => {
    const before = await startAndSettleInitialLoad();

    handlers['document-service:tracker-items-changed']({
      added: [],
      updated: [{ id: 'x-1', type: 'unregisteredType', title: 'X', customFields: { note: 'hello', count: 3 } }],
      removed: [],
      timestamp: new Date(),
    });

    await new Promise((r) => setTimeout(r, 450));
    const after = invoke.mock.calls.filter(([c]) => c === 'document-service:tracker-items-list').length;
    expect(after).toBe(before);
  });

  it('does not reload for a non-relationship change', async () => {
    const before = await startAndSettleInitialLoad();

    handlers['document-service:tracker-items-changed']({
      added: [],
      updated: [{ id: 'feature-1', type: 'feature', title: 'Renamed', status: 'in-progress' }],
      removed: [],
      timestamp: new Date(),
    });

    // Give the debounce window time to (not) fire.
    await new Promise((r) => setTimeout(r, 450));
    const after = invoke.mock.calls.filter(([c]) => c === 'document-service:tracker-items-list').length;
    expect(after).toBe(before);
  });

  it('a stale partial event cannot leave the relationship field empty', async () => {
    await startAndSettleInitialLoad();

    // Authoritative read model holds the relationship value.
    listModel = [{ id: 'feature-1', type: 'feature', title: 'Agent Mode', customFields: { parentModule: [{ itemId: 'module-1' }] } }];

    // A late/stale event clobbers the granular map with an empty relationship.
    handlers['document-service:tracker-items-changed']({
      added: [],
      updated: [{ id: 'feature-1', type: 'feature', title: 'Agent Mode', customFields: { parentModule: [] } }],
      removed: [],
      timestamp: new Date(),
    });

    // After the debounced reconcile, the map reflects the authoritative value.
    await vi.waitFor(() => {
      const rec = store.get(trackerItemsMapAtom).get('feature-1');
      const parentModule = rec?.fields?.parentModule as Array<{ itemId: string }> | undefined;
      expect(parentModule?.map((p) => p.itemId)).toEqual(['module-1']);
    });
  });
});
