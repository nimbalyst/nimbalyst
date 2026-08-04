// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const { gridProps, gridElement, gridListeners, dispatchGridEvent } = vi.hoisted(() => ({
  gridProps: { current: null as Record<string, any> | null },
  gridElement: {} as Record<string, any>,
  gridListeners: new Map<string, Set<(event: { detail: any; preventDefault: () => void }) => void>>(),
  dispatchGridEvent: (type: string, detail: any) => {
    const event = { detail, preventDefault: vi.fn() };
    for (const listener of gridListeners.get(type) ?? []) listener(event);
    return event;
  },
}));

vi.mock('@revolist/react-datagrid', async () => {
  const React = await import('react');
  return {
    RevoGrid: React.forwardRef((props: Record<string, any>, ref) => {
      gridProps.current = props;
      Object.assign(gridElement, {
        componentOnReady: vi.fn(async () => gridElement),
        addEventListener: (
          type: string,
          listener: (event: { detail: any; preventDefault: () => void }) => void,
        ) => {
          const listeners = gridListeners.get(type) ?? new Set();
          listeners.add(listener);
          gridListeners.set(type, listeners);
        },
        removeEventListener: (
          type: string,
          listener: (event: { detail: any; preventDefault: () => void }) => void,
        ) => {
          gridListeners.get(type)?.delete(listener);
        },
      });
      React.useImperativeHandle(ref, () => gridElement);
      return <div data-testid="mock-revogrid" />;
    }),
  };
});

vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nimbalyst/runtime/plugins/TrackerPlugin')>();
  return {
    ...actual,
    // Only the edit path is under test here; the rest of the hook's surface is
    // stubbed so the grid's context menu renders closed.
    useTrackerRows: () => ({
      handleItemUpdate: vi.fn(),
      isItemEditable: () => true,
      containerRef: { current: null },
      selectedIds: new Set<string>(),
      setSelectedIds: vi.fn(),
      contextAnchor: null,
      contextRefs: { setFloating: vi.fn(), setReference: vi.fn() },
      contextFloatingStyles: {},
      openContextMenuForIds: vi.fn(),
      closeContextMenu: vi.fn(),
      handleBulkStatusUpdate: vi.fn(),
      handleBulkPriorityUpdate: vi.fn(),
      handleAddSelectionToCollection: vi.fn(),
      statusOptionsForBulk: [],
    }),
  };
});

import { TrackerGridView } from '../TrackerGridView';

function record(id: string, status: string): TrackerRecord {
  return {
    id,
    primaryType: 'bug',
    typeTags: ['bug'],
    issueKey: id.toUpperCase(),
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/ws',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    },
    fields: { title: id, status, priority: 'medium' },
  };
}

describe('TrackerGridView grouping', () => {
  beforeAll(() => loadBuiltinTrackers());

  beforeEach(() => {
    gridProps.current = null;
    gridListeners.clear();
  });

  it('passes the Display Options grouping field and readable labels to RevoGrid', async () => {
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[
          record('bug-1', 'in-progress'),
          record('bug-2', 'done'),
        ]}
        columnConfig={{
          visibleColumns: ['title', 'status', 'priority'],
          columnWidths: {},
          groupBy: 'status',
        }}
      />,
    );

    await waitFor(() => expect(gridProps.current).not.toBeNull());
    expect(gridProps.current?.grouping).toEqual({
      props: ['__trackerGroupLabel'],
      expandedAll: true,
    });
    expect(gridProps.current?.source.map((row: Record<string, unknown>) => row.__trackerGroupLabel))
      .toEqual(['In Progress', 'Done']);
  });
});

describe('TrackerGridView sorting', () => {
  beforeAll(() => loadBuiltinTrackers());

  beforeEach(() => {
    gridProps.current = null;
    gridListeners.clear();
  });

  it('uses RevoGrid header sorting while synchronizing the shared view state', async () => {
    const onSortChange = vi.fn();
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[
          record('bug-1', 'in-progress'),
          record('bug-2', 'done'),
        ]}
        sortBy="status"
        sortDirection="desc"
        onSortChange={onSortChange}
        columnConfig={{
          visibleColumns: ['title', 'status', 'priority'],
          columnWidths: {},
          groupBy: null,
        }}
      />,
    );

    await waitFor(() => expect(gridElement.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ prop: 'status', sortable: true }),
    ])));
    const statusColumn = gridElement.columns.find(
      (column: Record<string, unknown>) => column.prop === 'status',
    );

    expect(statusColumn.sortable).toBe(true);
    expect(gridProps.current?.sorting).toEqual({
      columns: [{ prop: 'status', order: 'desc' }],
    });

    let sortEvent: ReturnType<typeof dispatchGridEvent>;
    act(() => {
      sortEvent = dispatchGridEvent('beforesorting', {
        column: statusColumn,
        order: 'asc',
        additive: false,
      });
    });

    expect(sortEvent!.preventDefault).toHaveBeenCalledOnce();
    expect(onSortChange).toHaveBeenCalledWith('status', 'asc');
  });
});
