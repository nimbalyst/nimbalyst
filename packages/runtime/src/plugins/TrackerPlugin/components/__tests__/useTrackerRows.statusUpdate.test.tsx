// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TrackerRecord } from '../../../../core/TrackerRecord';
import { globalRegistry, type TrackerDataModel } from '../../models';
import { useTrackerRows } from '../useTrackerRows';

vi.mock('posthog-js/react', () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

const customType = 'statusBulkRoleSpec';

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
      {
        name: 'phase',
        type: 'select',
        options: [
          { value: 'draft', label: 'Draft' },
          { value: 'reviewing', label: 'Reviewing' },
        ],
      },
    ],
    roles: { title: 'title', workflowStatus: 'phase' },
  };
  globalRegistry.register(model);
}

function makeRecord(): TrackerRecord {
  return {
    id: 'item-1',
    primaryType: customType,
    typeTags: [customType],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/workspace',
      createdAt: '2026-06-29T00:00:00.000Z',
      updatedAt: '2026-06-29T00:00:00.000Z',
    },
    fields: { title: 'Custom item', phase: 'draft' },
  };
}

describe('useTrackerRows bulk status update', () => {
  afterEach(() => {
    globalRegistry.unregister(customType);
    delete (window as any).electronAPI;
    vi.unstubAllGlobals();
  });

  it('writes bulk status updates to the field mapped by workflowStatus', async () => {
    registerCustomType();
    const updateTrackerItem = vi.fn().mockResolvedValue({ success: true });
    (window as any).electronAPI = {
      documentService: { updateTrackerItem },
    };

    const item = makeRecord();
    const { result } = renderHook(() => useTrackerRows({
      items: [item],
      activeTypeFilter: customType,
    }));

    await act(async () => {
      result.current.setSelectedIds(new Set([item.id]));
    });

    await act(async () => {
      await result.current.handleBulkStatusUpdate('reviewing');
    });

    expect(updateTrackerItem).toHaveBeenCalledWith({
      itemId: item.id,
      updates: { phase: 'reviewing' },
      syncMode: 'local',
    });
  });
});
