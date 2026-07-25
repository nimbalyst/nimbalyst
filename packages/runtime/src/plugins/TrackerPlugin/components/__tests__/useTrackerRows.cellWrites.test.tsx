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
});
