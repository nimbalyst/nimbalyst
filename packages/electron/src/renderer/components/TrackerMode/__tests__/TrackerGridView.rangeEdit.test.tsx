// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const {
  handleItemUpdate,
  useRealRows,
  gridProps,
  getFocused,
  setCellEdit,
  getColumnStore,
  columnStoreState,
  gridListeners,
  dispatchGridEvent,
  gridElement,
} = vi.hoisted(() => ({
  handleItemUpdate: vi.fn(async () => undefined),
  // The undo tests need the hook's real history; every other test keeps the
  // cheap stub so a write assertion stays one mock call away.
  useRealRows: { current: false },
  gridProps: { current: null as Record<string, any> | null },
  getFocused: vi.fn(async () => ({
    cell: { x: 0, y: 0 },
    column: { prop: 'title' },
    rowType: 'rgRow',
  })),
  setCellEdit: vi.fn(async () => undefined),
  getColumnStore: vi.fn(),
  columnStoreState: {
    current: {
      source: [] as Array<{ prop: string }>,
      items: [] as number[],
    },
  },
  gridListeners: new Map<string, Set<(event: { detail: unknown; preventDefault: () => void }) => void>>(),
  dispatchGridEvent: (type: string, detail: unknown) => {
    const event = { detail, preventDefault: vi.fn() };
    for (const listener of gridListeners.get(type) ?? []) listener(event);
    return event;
  },
  gridElement: {} as Record<string, any>,
}));

vi.mock('@revolist/react-datagrid', async () => {
  const React = await import('react');
  return {
    RevoGrid: React.forwardRef((_props: Record<string, any>, ref) => {
      gridProps.current = _props;
      Object.assign(gridElement, {
        getFocused,
        setCellEdit,
        getColumnStore,
        componentOnReady: vi.fn(async () => gridElement),
        addEventListener: (
          type: string,
          listener: (event: { detail: unknown; preventDefault: () => void }) => void,
        ) => {
          const listeners = gridListeners.get(type) ?? new Set();
          listeners.add(listener);
          gridListeners.set(type, listeners);
        },
        removeEventListener: (
          type: string,
          listener: (event: { detail: unknown; preventDefault: () => void }) => void,
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
    useTrackerRows: (options: Parameters<typeof actual.useTrackerRows>[0]) => useRealRows.current
      ? actual.useTrackerRows(options)
      : ({
        handleItemUpdate: handleItemUpdate,
        runUndoable: <T,>(_label: string, fn: () => Promise<T>) => fn(),
        recordUndoEntry: vi.fn(),
        captureUndoGeneration: () => 0,
        undo: vi.fn(async () => null),
        redo: vi.fn(async () => null),
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
      } as unknown as ReturnType<typeof actual.useTrackerRows>),
  };
});

vi.mock('posthog-js/react', () => ({ usePostHog: () => null }));

import { TrackerGridView } from '../TrackerGridView';
import { commitOnNavigationKeys } from '../grid/trackerGridEditors';

function record(id = 'bug-1', status = 'to-do'): TrackerRecord {
  return {
    id,
    primaryType: 'bug',
    typeTags: ['bug'],
    issueKey: 'NIM-1',
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/ws',
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    },
    fields: { title: 'Old title', status },
  } as TrackerRecord;
}

describe('TrackerGridView range edits', () => {
  beforeAll(() => loadBuiltinTrackers());

  beforeEach(() => {
    handleItemUpdate.mockClear();
    getFocused.mockClear();
    setCellEdit.mockClear();
    gridProps.current = null;
    gridListeners.clear();
  });

  it('commits every changed cell in a row as one item update', async () => {
    const item = record();
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[item]}
        columnConfig={{
          visibleColumns: ['title', 'status'],
          columnWidths: {},
          groupBy: null,
        }}
      />,
    );

    act(() => {
      dispatchGridEvent('afteredit', {
        data: {
          0: { title: 'New title', status: 'in-progress' },
        },
      });
    });

    await waitFor(() => {
      expect(handleItemUpdate).toHaveBeenCalledTimes(1);
    });
    expect(handleItemUpdate).toHaveBeenCalledWith(expect.objectContaining({
      id: item.id,
      fields: item.fields,
    }), {
      title: 'New title',
      status: 'in-progress',
    });
  });

  it('cancels drag-to-clone without disarming the range paste that shares afteredit', async () => {
    const item = record();
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[item]}
        columnConfig={{
          visibleColumns: ['title', 'status'],
          columnWidths: {},
          groupBy: null,
        }}
      />,
    );

    const autofill = dispatchGridEvent('beforeautofill', {
      newRange: { x: 0, y: 0, x1: 0, y1: 3 },
      oldRange: { x: 0, y: 0, x1: 0, y1: 0 },
    });
    expect(autofill.preventDefault).toHaveBeenCalled();

    // Paste reaches `afteredit` via `rangeeditapply`, never `selectionchangeinit`,
    // so the autofill guard must leave this range write intact.
    act(() => {
      dispatchGridEvent('afteredit', {
        data: { 0: { status: 'in-progress' } },
      });
    });

    await waitFor(() => expect(handleItemUpdate).toHaveBeenCalledTimes(1));
    expect(handleItemUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: item.id }),
      { status: 'in-progress' },
    );
  });
});

describe('TrackerGridView undo', () => {
  const updateTrackerItem = vi.fn().mockResolvedValue({ success: true });

  beforeAll(() => loadBuiltinTrackers());

  beforeEach(() => {
    // The real hook owns the history these tests are about, so the assertions
    // move down to the IPC write itself.
    useRealRows.current = true;
    updateTrackerItem.mockClear();
    (window as any).electronAPI = { documentService: { updateTrackerItem } };
    gridListeners.clear();
  });

  afterEach(() => {
    useRealRows.current = false;
    delete (window as any).electronAPI;
  });

  function renderGrid(items: TrackerRecord[]) {
    return render(
      <TrackerGridView
        filterType="bug"
        overrideItems={items}
        preserveItemOrder
        columnConfig={{ visibleColumns: ['title', 'status'], columnWidths: {}, groupBy: null }}
      />,
    );
  }

  function regrid(rerender: (ui: React.ReactElement) => void, items: TrackerRecord[]) {
    act(() => rerender(
      <TrackerGridView
        filterType="bug"
        overrideItems={items}
        preserveItemOrder
        columnConfig={{ visibleColumns: ['title', 'status'], columnWidths: {}, groupBy: null }}
      />,
    ));
  }

  function pressUndo(shift = false) {
    fireEvent.keyDown(screen.getByTestId('mock-revogrid'), { key: 'z', metaKey: true, shiftKey: shift });
  }

  function statusWrites() {
    return updateTrackerItem.mock.calls.map(([call]) => [call.itemId, call.updates.status]);
  }

  it('reverts a whole range paste on one Cmd+Z and reapplies it on Cmd+Shift+Z', async () => {
    const pasted = [record('bug-1', 'in-progress'), record('bug-2', 'in-progress')];
    const { rerender } = renderGrid([record('bug-1'), record('bug-2')]);

    act(() => {
      dispatchGridEvent('afteredit', {
        data: { 0: { status: 'in-progress' }, 1: { status: 'in-progress' } },
      });
    });
    await waitFor(() => expect(updateTrackerItem).toHaveBeenCalledTimes(2));

    regrid(rerender, pasted);
    updateTrackerItem.mockClear();
    pressUndo();

    // Both rows revert from the single entry the paste recorded; a second Cmd+Z
    // has nothing left to consume.
    await waitFor(() => expect(updateTrackerItem).toHaveBeenCalledTimes(2));
    expect(statusWrites()).toEqual([['bug-1', 'to-do'], ['bug-2', 'to-do']]);
    pressUndo();
    await waitFor(() => expect(updateTrackerItem).toHaveBeenCalledTimes(2));

    regrid(rerender, [record('bug-1'), record('bug-2')]);
    updateTrackerItem.mockClear();
    pressUndo(true);

    await waitFor(() => expect(updateTrackerItem).toHaveBeenCalledTimes(2));
    expect(statusWrites()).toEqual([['bug-1', 'in-progress'], ['bug-2', 'in-progress']]);
  });

  it('leaves Cmd+Z to the cell editor while one is focused', async () => {
    const { rerender } = renderGrid([record('bug-1')]);

    act(() => {
      dispatchGridEvent('afteredit', { rowIndex: 0, prop: 'status', val: 'in-progress' });
    });
    await waitFor(() => expect(updateTrackerItem).toHaveBeenCalledTimes(1));

    regrid(rerender, [record('bug-1', 'in-progress')]);
    updateTrackerItem.mockClear();

    const editor = document.createElement('input');
    editor.className = 'tracker-grid-editor-input';
    screen.getByTestId('mock-revogrid').appendChild(editor);
    fireEvent.keyDown(editor, { key: 'z', metaKey: true });

    // Native text undo owns the keystroke inside an editor.
    await Promise.resolve();
    expect(updateTrackerItem).not.toHaveBeenCalled();

    pressUndo();
    await waitFor(() => expect(statusWrites()).toEqual([['bug-1', 'to-do']]));
  });
});

describe('TrackerGridView column layout', () => {
  beforeAll(() => loadBuiltinTrackers());

  beforeEach(() => {
    gridProps.current = null;
    gridListeners.clear();
    columnStoreState.current = { source: [], items: [] };
    delete gridElement.columns;
    delete gridElement.source;
    getColumnStore.mockImplementation(async () => ({
      get: (key: 'source' | 'items') => columnStoreState.current[key],
    }));
  });

  it('configures the grid without row numbers or a view-local toolbar', () => {
    const onColumnConfigChange = vi.fn();
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[record()]}
        columnConfig={{
          visibleColumns: ['title', 'status'],
          columnWidths: {},
          groupBy: null,
        }}
        onColumnConfigChange={onColumnConfigChange}
      />,
    );

    expect(gridProps.current?.canMoveColumns).toBe(true);
    expect(gridProps.current?.rowHeaders).toBeUndefined();
    expect(screen.queryByTestId('tracker-grid-toolbar')).toBeNull();
    expect(screen.queryByTestId('tracker-grid-columns-button')).toBeNull();
  });

  it('persists widths emitted by RevoGrid', () => {
    const onColumnConfigChange = vi.fn();
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[record()]}
        columnConfig={{
          visibleColumns: ['title', 'status'],
          columnWidths: {},
          groupBy: null,
        }}
        onColumnConfigChange={onColumnConfigChange}
      />,
    );

    act(() => {
      dispatchGridEvent('aftercolumnresize', {
        0: { prop: 'title', size: 360 },
        1: { prop: 'status', size: 150 },
      });
    });

    expect(onColumnConfigChange).toHaveBeenCalledWith({
      visibleColumns: ['title', 'status'],
      columnWidths: { title: 360, status: 150 },
      groupBy: null,
    });
  });

  it('hydrates columns and rows onto the mounted custom element', async () => {
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[record()]}
        columnConfig={{
          visibleColumns: ['title', 'status'],
          columnWidths: {},
          groupBy: null,
        }}
      />,
    );

    await waitFor(() => {
      expect(gridElement.columns).toEqual(expect.arrayContaining([
        expect.objectContaining({ prop: 'title', name: 'Title' }),
        expect.objectContaining({ prop: 'status', name: 'Status' }),
      ]));
      expect(gridElement.source).toHaveLength(1);
    });
  });

  it('persists the visual order after a header drag', async () => {
    const onColumnConfigChange = vi.fn();
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[record()]}
        columnConfig={{
          visibleColumns: ['title', 'status'],
          columnWidths: {},
          groupBy: null,
        }}
        onColumnConfigChange={onColumnConfigChange}
      />,
    );

    columnStoreState.current = {
      source: [{ prop: 'title' }, { prop: 'status' }],
      items: [1, 0],
    };
    act(() => dispatchGridEvent('columndragend', undefined));

    await waitFor(() => {
      expect(onColumnConfigChange).toHaveBeenCalledWith({
        visibleColumns: ['status', 'title'],
        columnWidths: {},
        groupBy: null,
      });
    });
  });

  it('uses the counted value menu for a column header filter', async () => {
    const onColumnFiltersChange = vi.fn();
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[record()]}
        columnConfig={{
          visibleColumns: ['title', 'status'],
          columnWidths: {},
          groupBy: null,
        }}
        columnFilters={{ combinator: 'and', clauses: [] }}
        onColumnFiltersChange={onColumnFiltersChange}
        filterFields={[{
          id: 'status',
          label: 'Status',
          type: 'select',
          options: [
            { value: 'to-do', label: 'To do', count: 1, color: '#64748b' },
            { value: 'done', label: 'Done', count: 0, color: '#22c55e' },
          ],
        }]}
      />,
    );

    await waitFor(() => expect(gridElement.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ prop: 'status', columnTemplate: expect.any(Function) }),
    ])));
    const status = (gridElement.columns as Array<Record<string, any>>)
      .find(column => column.prop === 'status')!;
    const h = (tag: string, props: Record<string, unknown>, children: unknown) => ({
      tag,
      props,
      children,
    });
    const header = status.columnTemplate(h);
    const filterButton = header.children[1].children.at(-1);
    const target = document.createElement('span');
    Object.defineProperty(target, 'getBoundingClientRect', {
      value: () => new DOMRect(100, 40, 18, 18),
    });

    act(() => {
      filterButton.props.onClick({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        currentTarget: target,
        clientX: 100,
        clientY: 40,
      });
    });

    screen.getByTestId('tracker-column-filter-value-submenu');
    screen.getByText('1 issue');
    screen.getByText('1 option not matching any issues');
    fireEvent.click(screen.getByTestId('tracker-column-filter-option-to-do'));

    expect(onColumnFiltersChange).toHaveBeenCalledWith({
      combinator: 'and',
      clauses: [{ field: 'status', op: '=', value: 'to-do' }],
    });
  });

  it('routes RevoGrid header sorting through the shared view sort callback', async () => {
    const onSortChange = vi.fn();
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[record()]}
        sortBy="status"
        sortDirection="desc"
        onSortChange={onSortChange}
        columnConfig={{
          visibleColumns: ['title', 'status'],
          columnWidths: {},
          groupBy: null,
        }}
      />,
    );

    await waitFor(() => expect(gridElement.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ prop: 'status', sortable: true }),
    ])));
    const status = (gridElement.columns as Array<Record<string, any>>)
      .find(column => column.prop === 'status')!;

    expect(status.sortable).toBe(true);
    act(() => {
      dispatchGridEvent('beforesorting', {
        column: status,
        order: 'asc',
        additive: false,
      });
    });

    expect(onSortChange).toHaveBeenCalledWith('status', 'asc');
  });
});

describe('TrackerGridView double-click', () => {
  beforeAll(() => loadBuiltinTrackers());

  beforeEach(() => {
    getFocused.mockClear();
    gridProps.current = null;
    gridListeners.clear();
  });

  /** RevoGrid renders its own cells; stand in for one on the focused row. */
  function doubleClickCell(): void {
    const cell = document.createElement('div');
    cell.setAttribute('data-rgrow', '0');
    screen.getByTestId('mock-revogrid').appendChild(cell);
    fireEvent.doubleClick(cell);
  }

  function renderGrid(onOpenDocument: () => void) {
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[record()]}
        columnConfig={{
          visibleColumns: ['key', 'title', 'status'],
          columnWidths: {},
          groupBy: null,
        }}
        onOpenDocument={onOpenDocument}
      />,
    );
  }

  it('leaves an editable cell to RevoGrid instead of opening the item', async () => {
    const onOpenDocument = vi.fn();
    renderGrid(onOpenDocument);

    doubleClickCell();

    await waitFor(() => expect(getFocused).toHaveBeenCalled());
    expect(onOpenDocument).not.toHaveBeenCalled();
  });

  it('opens the item from a readonly cell', async () => {
    const onOpenDocument = vi.fn();
    renderGrid(onOpenDocument);
    getFocused.mockResolvedValueOnce({
      cell: { x: 0, y: 0 },
      column: { prop: 'key' },
      rowType: 'rgRow',
    });

    doubleClickCell();

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('bug-1'));
  });
});

describe('TrackerGridView keyboard contract', () => {
  beforeAll(() => loadBuiltinTrackers());

  beforeEach(() => {
    handleItemUpdate.mockClear();
    getFocused.mockClear();
    setCellEdit.mockClear();
    gridProps.current = null;
    gridListeners.clear();
  });

  it('navigates with the grid without opening details, then opens the focused row with Enter', async () => {
    const onItemSelect = vi.fn();
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[record()]}
        onItemSelect={onItemSelect}
      />,
    );

    fireEvent.keyDown(screen.getByTestId('mock-revogrid'), {
      key: 'ArrowDown',
      code: 'ArrowDown',
    });
    act(() => {
      dispatchGridEvent('afterfocus', { rowIndex: 0 });
    });
    expect(onItemSelect).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId('mock-revogrid'), {
      key: 'Enter',
      code: 'Enter',
    });
    await waitFor(() => {
      expect(onItemSelect).toHaveBeenCalledWith('bug-1');
    });
  });

  it('keeps an open detail panel synchronized with keyboard row focus', () => {
    const onItemSelect = vi.fn();
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[record()]}
        selectedItemId="other-item"
        onItemSelect={onItemSelect}
      />,
    );

    fireEvent.keyDown(screen.getByTestId('mock-revogrid'), {
      key: 'ArrowDown',
      code: 'ArrowDown',
    });
    act(() => {
      dispatchGridEvent('afterfocus', { rowIndex: 0 });
    });

    expect(onItemSelect).toHaveBeenCalledWith('bug-1');
  });

  it('starts editing with F2 and closes details with Escape', async () => {
    const onDetailClose = vi.fn();
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[record()]}
        selectedItemId="bug-1"
        onDetailClose={onDetailClose}
      />,
    );
    const grid = screen.getByTestId('mock-revogrid');

    fireEvent.keyDown(grid, { key: 'F2', code: 'F2' });
    await waitFor(() => {
      expect(setCellEdit).toHaveBeenCalledWith(0, 'title', 'rgRow');
    });

    fireEvent.keyDown(grid, { key: 'Escape', code: 'Escape' });
    expect(onDetailClose).toHaveBeenCalledTimes(1);
  });

  it('opens details when mouse focus lands on a row after keyboard navigation', () => {
    const onItemSelect = vi.fn();
    render(
      <TrackerGridView
        filterType="bug"
        overrideItems={[record()]}
        onItemSelect={onItemSelect}
      />,
    );

    const grid = screen.getByTestId('mock-revogrid');
    fireEvent.keyDown(grid, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.pointerDown(grid);
    act(() => {
      dispatchGridEvent('afterfocus', { rowIndex: 0 });
    });

    expect(onItemSelect).toHaveBeenCalledWith('bug-1');
  });
});

describe('tracker grid editor navigation', () => {
  function keyEvent(key: string) {
    return {
      key,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;
  }

  it('commits Enter downward and leaves arrow keys inside the editor', () => {
    const save = vi.fn();
    const close = vi.fn();
    const enter = keyEvent('Enter');

    commitOnNavigationKeys(enter, () => 'changed', save, close);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith('changed', false);

    save.mockClear();
    commitOnNavigationKeys(keyEvent('ArrowLeft'), () => 'changed', save, close);
    expect(save).not.toHaveBeenCalled();
  });

  it('commits Tab for RevoGrid to move horizontally and Escape cancels', () => {
    const save = vi.fn();
    const close = vi.fn();

    commitOnNavigationKeys(keyEvent('Tab'), () => 'changed', save, close);
    expect(save).toHaveBeenCalledWith('changed', true);

    const escape = keyEvent('Escape');
    commitOnNavigationKeys(escape, () => 'changed', save, close);
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(escape.stopPropagation).toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(false);
  });
});
