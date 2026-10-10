// @vitest-environment node
/**
 * The saved-view embed's atom-backed data source: it streams item and saved
 * view changes, reports "loaded" as connected, writes each item in its own
 * type's lane, and turns a refused write into an error.
 */
import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import { TrackerDataModelRegistry, type TrackerDataModel } from '@nimbalyst/tracker-schema';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  replaceAllTrackerItemsAtom,
  removeTrackerItemAtom,
  upsertTrackerItemAtom,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { createDefaultViewDefinition, parseSharedSavedView } from '@nimbalyst/collab-client/trackers';
import { sharedTrackerSavedViewsAtom, trackerSavedViewsAtom } from '../../../store/atoms/trackers';
import { createDesktopTrackerDataSource } from '../desktopTrackerDataSource';

function entityModel(sharing: 'personal' | 'team'): TrackerDataModel {
  return {
    type: 'entity', displayName: 'Entity', displayNamePlural: 'Entities', icon: 'category', color: '#888',
    modes: { inline: false, fullDocument: true }, idPrefix: 'ent', idFormat: 'ulid', sharing,
    fields: [{ name: 'title', type: 'string', required: true }],
  } as TrackerDataModel;
}

function item(id: string, title: string): TrackerRecord {
  return {
    id, primaryType: 'entity', typeTags: ['entity'], source: 'native', archived: false, syncStatus: 'local',
    system: { workspace: '/ws', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    fields: { title },
  } as TrackerRecord;
}

describe('createDesktopTrackerDataSource', () => {
  it('streams atom changes as item changes and writes through the IPC source', async () => {
    const store = createStore();
    const command = vi.fn(async () => ({ ok: true as const }));
    const source = createDesktopTrackerDataSource({ workspacePath: '/ws', store, writer: { command, getItemRevision: vi.fn() } });

    expect(source.status().status).toBe('connecting');
    const changes: unknown[] = [];
    source.subscribe((change) => changes.push(change));
    store.set(replaceAllTrackerItemsAtom, [item('a', 'Alpha'), item('b', 'Beta')]);
    expect(source.status().status).toBe('connected');
    expect((await source.snapshot()).items.map((entry) => entry.id)).toEqual(['a', 'b']);

    changes.length = 0;
    store.set(upsertTrackerItemAtom, item('a', 'Alpha 2'));
    store.set(removeTrackerItemAtom, 'b');
    expect(changes).toEqual([
      { type: 'items-upserted', items: [expect.objectContaining({ id: 'a', title: 'Alpha 2' })] },
      { type: 'items-removed', itemIds: ['b'] },
    ]);

    await source.command({ type: 'archive-item', itemId: 'a', archive: true });
    expect(command).toHaveBeenCalledWith({ type: 'archive-item', itemId: 'a', archive: true });
  });

  it('serves the project\'s personal and shared saved views, and streams their changes', async () => {
    const store = createStore();
    const source = createDesktopTrackerDataSource({ workspacePath: '/ws', store, writer: { command: vi.fn(), getItemRevision: vi.fn() } });
    store.set(trackerSavedViewsAtom, [{ id: 'v-mine', name: 'Mine', definition: createDefaultViewDefinition() }]);
    store.set(sharedTrackerSavedViewsAtom, [{ id: 'v-team', name: 'Team', definition: { ...createDefaultViewDefinition(), viewMode: 'table' }, shared: true }]);

    const views = (await source.snapshot()).savedViews.map(parseSharedSavedView);
    expect(views.map((view) => [view?.id, view?.name, view?.definition.viewMode])).toEqual([['v-mine', 'Mine', 'list'], ['v-team', 'Team', 'table']]);

    const changes: unknown[] = [];
    source.subscribe((change) => changes.push(change));
    store.set(trackerSavedViewsAtom, []);
    expect(changes).toEqual([{ type: 'saved-views-replaced', savedViews: [expect.objectContaining({ viewId: 'v-team' })] }]);
  });

  it('turns a write the main process refused into an error, and writes each item in its own lane', async () => {
    const store = createStore();
    const registry = new TrackerDataModelRegistry();
    registry.register(entityModel('personal'));
    store.set(replaceAllTrackerItemsAtom, [item('a', 'Alpha')]);
    const saved = { ok: true as const, result: { success: true, item: { id: 'a' } } };
    const command = vi.fn(async () => saved as { ok: true; result: unknown });
    const source = createDesktopTrackerDataSource({ workspacePath: '/ws', store, registry, writer: { command, getItemRevision: vi.fn() } });

    // A caller that assumes the team lane still writes a personal type's item personal.
    expect(await source.command({ type: 'update-item', input: { itemId: 'a', updates: { title: 'A' }, sharing: 'team' } })).toBe(saved);
    expect(command).toHaveBeenLastCalledWith({ type: 'update-item', input: { itemId: 'a', updates: { title: 'A' }, sharing: 'personal' } });

    command.mockResolvedValueOnce({ ok: true, result: { success: false, error: 'Refused by main' } });
    await expect(source.command({
      type: 'create-item', item: { id: 'h', type: 'entity', title: 'New', status: 'active', priority: 'medium', workspace: '/ws', sharing: 'team' },
    })).rejects.toThrow('Refused by main');
    expect(command).toHaveBeenLastCalledWith({ type: 'create-item', item: expect.objectContaining({ id: 'h', sharing: 'personal' }) });
  });

  it('routes a view edit batch: file-backed fields to the file, the rest in each type\'s lane', async () => {
    const store = createStore();
    const registry = new TrackerDataModelRegistry();
    registry.register(entityModel('team'));
    const fromFile = { ...item('f', 'File'), source: 'frontmatter', system: { ...item('f', 'File').system, documentPath: 'plans/f.md' } } as TrackerRecord;
    store.set(replaceAllTrackerItemsAtom, [item('a', 'Alpha'), fromFile]);
    const command = vi.fn(async () => ({ ok: true as const, result: { success: true, results: [] } }));
    const ipc = { invoke: vi.fn(async () => undefined) };
    const source = createDesktopTrackerDataSource({ workspacePath: '/ws', store, registry, ipc, writer: { command, getItemRevision: vi.fn() } });

    await source.command({ type: 'update-items', input: { entries: [
      { itemId: 'a', storeUpdates: { title: 'A' } },
      { itemId: 'f', storeUpdates: { title: 'F', kanbanSortOrder: 3 } },
    ] } });
    expect(command).toHaveBeenLastCalledWith({ type: 'update-items', input: { entries: [
      { itemId: 'a', storeUpdates: { title: 'A' }, sharing: 'team', draftByDefault: false },
      { itemId: 'f', fileUpdates: { title: 'F' }, storeUpdates: { kanbanSortOrder: 3 }, sharing: 'team', draftByDefault: false },
    ] } });
    expect(ipc.invoke).toHaveBeenCalledWith('document-service:tracker-item-reindex-relationships', { itemIds: ['a', 'f'] });

    command.mockResolvedValueOnce({ ok: true, result: { success: false, results: [{ success: false, error: 'Row refused' }] } } as never);
    await expect(source.command({ type: 'update-items', input: { entries: [{ itemId: 'a', storeUpdates: { title: 'B' } }] } }))
      .rejects.toThrow('Row refused');
  });

  it('sends a Local wiki item\'s edits and a wiki type\'s new items to the library, never to the database', async () => {
    const store = createStore();
    const registry = new TrackerDataModelRegistry();
    registry.register({ ...entityModel('personal'), storage: 'pages' } as TrackerDataModel);
    const wikiItem = { ...item('w', 'Wiki'), source: 'local-wiki', system: { ...item('w', 'Wiki').system, documentPath: '/ws/nimbalyst-local/wiki/Wiki.md' } } as TrackerRecord;
    store.set(replaceAllTrackerItemsAtom, [item('a', 'Alpha'), wikiItem]);
    const command = vi.fn(async () => ({ ok: true as const, result: { success: true, results: [] } }));
    const ipc = { invoke: vi.fn(async () => ({ ok: true, id: 'n' })) };
    const source = createDesktopTrackerDataSource({ workspacePath: '/ws', store, registry, ipc, writer: { command, getItemRevision: vi.fn() } });

    await source.command({ type: 'update-item', input: { itemId: 'w', updates: { status: 'done' } } } as never);
    expect(ipc.invoke).toHaveBeenLastCalledWith('local-wiki:tracker-command', '/ws', 'entity', { type: 'update-item', input: { itemId: 'w', updates: { status: 'done' } } });
    await source.command({ type: 'delete-item', itemId: 'w' });
    expect(ipc.invoke).toHaveBeenLastCalledWith('local-wiki:tracker-command', '/ws', 'entity', { type: 'delete-item', itemId: 'w' });
    await expect(source.command({ type: 'archive-item', itemId: 'w', archive: true })).rejects.toThrow(/Local wiki/);
    await source.command({ type: 'create-item', item: { id: 'n', type: 'entity', title: 'New', status: 'open', priority: '', workspace: '/ws' } });
    expect(ipc.invoke).toHaveBeenLastCalledWith('local-wiki:tracker-command', '/ws', 'entity', { type: 'create-item', item: { id: 'n', title: 'New', fields: { status: 'open' } } });

    await source.command({ type: 'update-items', input: { entries: [
      { itemId: 'a', storeUpdates: { title: 'A' } },
      { itemId: 'w', storeUpdates: { title: 'W' } },
    ] } });
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenLastCalledWith({ type: 'update-items', input: { entries: [
      { itemId: 'a', storeUpdates: { title: 'A' }, sharing: 'personal', draftByDefault: false },
    ] } });
  });
});
