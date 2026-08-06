// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TrackerRecord } from '../../../../core/TrackerRecord';
import { globalRegistry, type TrackerDataModel } from '../../models';
import { useTrackerRows } from '../useTrackerRows';

vi.mock('posthog-js/react', () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

const customType = 'cellWriteSpec';

function registerCustomType(): void {
  const model: TrackerDataModel = {
    type: customType,
    displayName: 'Spec',
    displayNamePlural: 'Specs',
    icon: 'assignment',
    color: '#000000',
    modes: { inline: true, fullDocument: false },
    idPrefix: 'spc',
    idFormat: 'ulid',
    fields: [
      { name: 'title', type: 'string', required: true },
      { name: 'points', type: 'number' },
      { name: 'labels', type: 'multiselect' },
      { name: 'done', type: 'boolean' },
    ],
    roles: { title: 'title' },
  };
  globalRegistry.register(model);
}

/**
 * A write the test resolves by hand. Every race covered below only exists while
 * a durable write is in flight, which an auto-resolving mock never reproduces.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function makeRecord(id: string): TrackerRecord {
  return {
    id,
    primaryType: customType,
    typeTags: [customType],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/workspace',
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    },
    fields: { title: `Item ${id}` },
  };
}

describe('useTrackerRows cell writes', () => {
  afterEach(() => {
    globalRegistry.unregister(customType);
    delete (window as any).electronAPI;
    vi.unstubAllGlobals();
  });

  it('writes non-string cell values without stringifying them', async () => {
    registerCustomType();
    const updateTrackerItem = vi.fn().mockResolvedValue({ success: true });
    (window as any).electronAPI = { documentService: { updateTrackerItem } };

    const item = makeRecord('item-1');
    const { result } = renderHook(() => useTrackerRows({ items: [item], activeTypeFilter: customType }));

    await act(async () => {
      await result.current.handleFieldUpdate(item, 'points', 8);
    });
    expect(updateTrackerItem).toHaveBeenCalledWith({
      itemId: 'item-1',
      updates: { points: 8 },
      syncMode: 'local',
    });

    await act(async () => {
      await result.current.handleFieldUpdate(item, 'labels', ['ui', 'sync']);
    });
    expect(updateTrackerItem).toHaveBeenLastCalledWith({
      itemId: 'item-1',
      updates: { labels: ['ui', 'sync'] },
      syncMode: 'local',
    });

    await act(async () => {
      await result.current.handleFieldUpdate(item, 'done', false);
    });
    expect(updateTrackerItem).toHaveBeenLastCalledWith({
      itemId: 'item-1',
      updates: { done: false },
      syncMode: 'local',
    });
  });

  it('commits a multi-field edit as a single write', async () => {
    registerCustomType();
    const updateTrackerItem = vi.fn().mockResolvedValue({ success: true });
    (window as any).electronAPI = { documentService: { updateTrackerItem } };

    const item = makeRecord('item-1');
    const { result } = renderHook(() => useTrackerRows({ items: [item], activeTypeFilter: customType }));

    await act(async () => {
      await result.current.handleItemUpdate(item, { title: 'Renamed', points: 3 });
    });

    expect(updateTrackerItem).toHaveBeenCalledTimes(1);
    expect(updateTrackerItem).toHaveBeenCalledWith({
      itemId: 'item-1',
      updates: { title: 'Renamed', points: 3 },
      syncMode: 'local',
    });
  });

  it('skips the write entirely when there are no changed fields', async () => {
    registerCustomType();
    const updateTrackerItem = vi.fn().mockResolvedValue({ success: true });
    (window as any).electronAPI = { documentService: { updateTrackerItem } };

    const item = makeRecord('item-1');
    const { result } = renderHook(() => useTrackerRows({ items: [item], activeTypeFilter: customType }));

    await act(async () => {
      await result.current.handleItemUpdate(item, {});
    });

    expect(updateTrackerItem).not.toHaveBeenCalled();
  });

  it('applies a bulk field update across every selected item', async () => {
    registerCustomType();
    const updateTrackerItem = vi.fn().mockResolvedValue({ success: true });
    (window as any).electronAPI = { documentService: { updateTrackerItem } };

    const items = [makeRecord('item-1'), makeRecord('item-2'), makeRecord('item-3')];
    const { result } = renderHook(() => useTrackerRows({ items, activeTypeFilter: customType }));

    await act(async () => {
      await result.current.handleBulkFieldUpdate(items, 'labels', ['triage']);
    });

    expect(updateTrackerItem).toHaveBeenCalledTimes(3);
    expect(updateTrackerItem.mock.calls.map(c => c[0].itemId).sort()).toEqual(['item-1', 'item-2', 'item-3']);
    for (const call of updateTrackerItem.mock.calls) {
      expect(call[0].updates).toEqual({ labels: ['triage'] });
    }
  });

  it('routes document-backed items through the in-file write path', async () => {
    registerCustomType();
    const updateTrackerItem = vi.fn().mockResolvedValue({ success: true });
    const updateTrackerItemInFile = vi.fn().mockResolvedValue({ success: true });
    (window as any).electronAPI = { documentService: { updateTrackerItem, updateTrackerItemInFile } };

    const item: TrackerRecord = {
      ...makeRecord('item-1'),
      source: 'frontmatter',
      system: { ...makeRecord('item-1').system, documentPath: 'design/thing.md' },
    };
    const { result } = renderHook(() => useTrackerRows({ items: [item], activeTypeFilter: customType }));

    await act(async () => {
      await result.current.handleFieldUpdate(item, 'points', 5);
    });

    expect(updateTrackerItemInFile).toHaveBeenCalledWith({ itemId: 'item-1', updates: { points: 5 } });
    expect(updateTrackerItem).not.toHaveBeenCalled();
  });

  it('replays entries whose record is no longer in the rendered list', async () => {
    registerCustomType();
    const updateTrackerItem = vi.fn().mockResolvedValue({ success: true });
    (window as any).electronAPI = { documentService: { updateTrackerItem } };
    const onArchiveItems = vi.fn().mockResolvedValue(undefined);
    // A collection lives outside the active type filter, so its undo has to
    // reach it through the resolver rather than the rendered list.
    const collection = { ...makeRecord('collection-1'), fields: { title: 'Milestone', members: ['a'] } };

    const item = makeRecord('item-1');
    const { result, rerender } = renderHook(
      ({ items }: { items: TrackerRecord[] }) => useTrackerRows({
        items,
        activeTypeFilter: customType,
        onArchiveItems,
        resolveRecordById: id => (id === collection.id ? collection : undefined),
      }),
      { initialProps: { items: [item] } },
    );

    await act(async () => {
      await result.current.handleItemUpdate(collection, { members: ['a', 'b'] });
    });
    act(() => result.current.recordUndoEntry({
      label: 'Archive 1 item',
      changes: [{ kind: 'archive', itemId: 'item-1', previousArchived: false, nextArchived: true }],
    }));
    // A slow archive whose history was cleared mid-flight (the user switched
    // tracker type) carries a stale generation and must be dropped -- otherwise
    // Cmd+Z in the new view unarchives rows from the old one. If it landed, it
    // would be the entry the first undo below consumes.
    act(() => result.current.recordUndoEntry({
      label: 'Archive 4 items',
      changes: [{ kind: 'archive', itemId: 'item-9', previousArchived: false, nextArchived: true }],
    }, result.current.captureUndoGeneration() - 1));
    // Archiving drops the row out of the loaded set -- the expected consequence
    // of the very change being undone, not evidence that anything drifted.
    act(() => rerender({ items: [] }));
    collection.fields = { title: 'Milestone', members: ['a', 'b'] };
    updateTrackerItem.mockClear();

    let undoResult: Awaited<ReturnType<typeof result.current.undo>> = null;
    await act(async () => {
      undoResult = await result.current.undo();
    });
    // `record: false` marks the call as a replay so the grid's archive recorder
    // does not push the inverse straight back onto the stack.
    expect(onArchiveItems).toHaveBeenCalledWith(['item-1'], false, { record: false });
    expect(undoResult).toEqual({ label: 'Archive 1 item', applied: 1, skipped: 0 });

    await act(async () => {
      undoResult = await result.current.undo();
    });
    expect(undoResult).toEqual({ label: 'Edit Members', applied: 1, skipped: 0 });
    expect(updateTrackerItem).toHaveBeenCalledWith({
      itemId: 'collection-1',
      updates: { members: ['a'] },
      syncMode: 'local',
    });
  });

  it('batches inverse writes, skips drift per change, and consumes stale entries', async () => {
    registerCustomType();
    const updateTrackerItem = vi.fn().mockResolvedValue({ success: true });
    (window as any).electronAPI = { documentService: { updateTrackerItem } };

    const initialItems = [
      { ...makeRecord('item-1'), fields: { title: 'One', labels: [{ itemId: 'old' }] } },
      { ...makeRecord('item-2'), fields: { title: 'Two', points: 1 } },
      { ...makeRecord('item-3'), fields: { title: 'Three' } },
    ];
    const { result, rerender } = renderHook(
      ({ items }: { items: TrackerRecord[] }) => useTrackerRows({
        items,
        activeTypeFilter: customType,
      }),
      { initialProps: { items: initialItems } },
    );

    await act(async () => {
      await result.current.runUndoable('Paste 3 cells', async () => {
        await Promise.all([
          result.current.handleItemUpdate(initialItems[0], { labels: [{ itemId: 'new' }] }),
          result.current.handleItemUpdate(initialItems[1], { points: 2 }),
          result.current.handleItemUpdate(initialItems[2], { title: 'Three edited' }),
        ]);
      });
    });

    expect(updateTrackerItem).toHaveBeenCalledTimes(3);

    // Item 1 is structurally equal despite using a fresh object. Item 2 drifted
    // after the paste and must be skipped without blocking item 1 or item 3.
    act(() => rerender({
      items: [
        { ...initialItems[0], fields: { title: 'One', labels: [{ itemId: 'new' }] } },
        { ...initialItems[1], fields: { title: 'Two', points: 99 } },
        { ...initialItems[2], fields: { title: 'Three edited' } },
      ],
    }));
    updateTrackerItem.mockClear();

    let undoResult: Awaited<ReturnType<typeof result.current.undo>> = null;
    await act(async () => {
      undoResult = await result.current.undo();
    });

    expect(undoResult).toEqual({ label: 'Paste 3 cells', applied: 2, skipped: 1 });
    expect(updateTrackerItem).toHaveBeenCalledTimes(2);
    expect(updateTrackerItem).toHaveBeenCalledWith({
      itemId: 'item-1',
      updates: { labels: [{ itemId: 'old' }] },
      syncMode: 'local',
    });
    expect(updateTrackerItem).toHaveBeenCalledWith({
      itemId: 'item-3',
      updates: { title: 'Three' },
      syncMode: 'local',
    });

    // The entry is consumed whole -- a second undo has nothing left to write.
    await act(async () => {
      expect(await result.current.undo()).toBeNull();
    });
    expect(updateTrackerItem).toHaveBeenCalledTimes(2);

    const afterUndoItems = [
      initialItems[0],
      { ...initialItems[1], fields: { title: 'Two', points: 99 } },
      initialItems[2],
    ];
    act(() => rerender({ items: afterUndoItems }));
    await act(async () => {
      await result.current.handleItemUpdate(afterUndoItems[2], { title: 'Three again' });
    });
    act(() => rerender({
      items: [
        afterUndoItems[0],
        afterUndoItems[1],
        { ...afterUndoItems[2], fields: { title: 'Changed elsewhere' } },
      ],
    }));
    updateTrackerItem.mockClear();

    await act(async () => {
      undoResult = await result.current.undo();
    });

    expect(undoResult).toEqual({ label: 'Edit Title', applied: 0, skipped: 1 });
    expect(updateTrackerItem).not.toHaveBeenCalled();
    // An entirely stale entry is still consumed, so the stack does not trap the
    // user on a Cmd+Z that can never write anything.
    await act(async () => {
      expect(await result.current.undo()).toBeNull();
    });
    expect(updateTrackerItem).not.toHaveBeenCalled();
  });

  it('drops a second undo pressed mid-replay instead of consuming its entry', async () => {
    registerCustomType();
    const updateTrackerItem = vi.fn().mockResolvedValue({ success: true });
    (window as any).electronAPI = { documentService: { updateTrackerItem } };

    const at = (points: number) => [{ ...makeRecord('item-1'), fields: { title: 'One', points } }];
    const { result, rerender } = renderHook(
      ({ items }: { items: TrackerRecord[] }) => useTrackerRows({ items, activeTypeFilter: customType }),
      { initialProps: { items: at(1) } },
    );

    // Two edits to the same cell: 1 -> 2, then 2 -> 3.
    await act(async () => {
      await result.current.handleItemUpdate(at(1)[0], { points: 2 });
    });
    act(() => rerender({ items: at(2) }));
    await act(async () => {
      await result.current.handleItemUpdate(at(2)[0], { points: 3 });
    });
    act(() => rerender({ items: at(3) }));
    updateTrackerItem.mockClear();

    const pending = deferred<{ success: boolean }>();
    updateTrackerItem.mockImplementationOnce(() => pending.promise);

    // Cmd+Z twice in a row. The first is still awaiting its write, and the
    // record the second would read still says 3 -- it would skip its own change
    // as drift and consume the entry, stranding the cell at 2 forever.
    const firstUndo = result.current.undo();
    expect(await result.current.undo()).toBeNull();
    expect(updateTrackerItem).toHaveBeenCalledTimes(1);

    pending.resolve({ success: true });
    await act(async () => {
      expect(await firstUndo).toEqual({ label: 'Edit Points', applied: 1, skipped: 0 });
    });

    // The dropped press cost nothing: its entry is still there once the record
    // catches up, so pressing again finishes the job.
    act(() => rerender({ items: at(2) }));
    updateTrackerItem.mockClear();
    await act(async () => {
      expect(await result.current.undo()).toEqual({ label: 'Edit Points', applied: 1, skipped: 0 });
    });
    expect(updateTrackerItem).toHaveBeenCalledWith({
      itemId: 'item-1',
      updates: { points: 1 },
      syncMode: 'local',
    });
  });

  it('records an edit that lands during a replay and skips a replay the main process rejects', async () => {
    registerCustomType();
    const updateTrackerItem = vi.fn().mockResolvedValue({ success: true });
    (window as any).electronAPI = { documentService: { updateTrackerItem } };

    const one = (points: number) => ({ ...makeRecord('item-1'), fields: { title: 'One', points } });
    const two = (points: number) => ({ ...makeRecord('item-2'), fields: { title: 'Two', points } });
    const { result, rerender } = renderHook(
      ({ items }: { items: TrackerRecord[] }) => useTrackerRows({ items, activeTypeFilter: customType }),
      { initialProps: { items: [one(1), two(1)] } },
    );

    await act(async () => {
      await result.current.handleItemUpdate(one(1), { points: 2 });
    });
    act(() => rerender({ items: [one(2), two(1)] }));
    updateTrackerItem.mockClear();

    // Only the replay's own write hangs; the user's edit beside it resolves.
    const replayWrite = deferred<{ success: boolean }>();
    updateTrackerItem.mockImplementationOnce(() => replayWrite.promise);

    // Undo item-1 while the user edits item-2. The edit must keep its inverse:
    // it is a user action that merely overlapped a replay, not part of one.
    const undoing = result.current.undo();
    await act(async () => {
      await result.current.handleItemUpdate(two(1), { points: 7 });
    });
    replayWrite.resolve({ success: true });
    await act(async () => { await undoing; });

    act(() => rerender({ items: [one(1), two(7)] }));
    updateTrackerItem.mockClear();
    await act(async () => {
      expect(await result.current.undo()).toEqual({ label: 'Edit Points', applied: 1, skipped: 0 });
    });
    expect(updateTrackerItem).toHaveBeenCalledWith({
      itemId: 'item-2',
      updates: { points: 1 },
      syncMode: 'local',
    });

    // A rejected write is not an applied change, however it resolves: the IPC
    // reports failure in its payload rather than throwing.
    act(() => rerender({ items: [one(1), two(1)] }));
    await act(async () => {
      await result.current.handleItemUpdate(one(1), { points: 9 });
    });
    act(() => rerender({ items: [one(9), two(1)] }));
    updateTrackerItem.mockImplementation(() => Promise.resolve({ success: false, error: 'locked' }));
    await act(async () => {
      expect(await result.current.undo()).toEqual({ label: 'Edit Points', applied: 0, skipped: 1 });
    });
  });

  it('folds repeated writes to one cell into a single reversible change', async () => {
    registerCustomType();
    const updateTrackerItem = vi.fn().mockResolvedValue({ success: true });
    (window as any).electronAPI = { documentService: { updateTrackerItem } };

    const one = (points: number) => ({ ...makeRecord('item-1'), fields: { title: 'One', points } });
    const { result, rerender } = renderHook(
      ({ items }: { items: TrackerRecord[] }) => useTrackerRows({ items, activeTypeFilter: customType }),
      { initialProps: { items: [one(1)] } },
    );

    // A slow paste sets the cell 1 -> 2; the user retypes it 2 -> 3 before the
    // batch closes, so both changes join the same entry.
    const gate = deferred<void>();
    let paste!: Promise<void>;
    await act(async () => {
      paste = result.current.runUndoable('Paste 1 cell', async () => {
        await result.current.handleItemUpdate(one(1), { points: 2 });
        await gate.promise;
      });
      await result.current.handleItemUpdate(one(2), { points: 3 });
      gate.resolve();
      await paste;
    });

    act(() => rerender({ items: [one(3)] }));
    updateTrackerItem.mockClear();

    // Folded to 1 -> 3, so undo restores 1. Unfolded it would skip `1 -> 2` as
    // drift, apply `3 -> 2`, and leave the cell at a value nobody asked for.
    await act(async () => {
      expect(await result.current.undo()).toEqual({ label: 'Paste 1 cell', applied: 1, skipped: 0 });
    });
    expect(updateTrackerItem).toHaveBeenCalledTimes(1);
    expect(updateTrackerItem).toHaveBeenCalledWith({
      itemId: 'item-1',
      updates: { points: 1 },
      syncMode: 'local',
    });
  });
});
