// @vitest-environment jsdom
/**
 * The RevoGrid table replaced the hand-rolled one as the `table` view mode, so
 * it has to carry that view's bulk row actions. Selection lives in RevoGrid's
 * cell range, which these cover: a right-click inside the range acts on every
 * row in it, and a right-click outside it acts on the clicked row alone.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const { selectedRange, gridElement } = vi.hoisted(() => ({
  selectedRange: { current: null as { y: number; y1: number } | null },
  gridElement: {} as Record<string, any>,
}));

vi.mock('@revolist/react-datagrid', async () => {
  const React = await import('react');
  return {
    RevoGrid: React.forwardRef((props: Record<string, any>, ref) => {
      Object.assign(gridElement, {
        getSelectedRange: async () => selectedRange.current,
        getFocused: async () => null,
        componentOnReady: async () => gridElement,
        addEventListener: () => {},
        removeEventListener: () => {},
      });
      React.useImperativeHandle(ref, () => gridElement);
      // Stand-in for RevoGrid's rendered cells: only `data-rgrow` matters here.
      return (
        <div data-testid="mock-revogrid">
          {(props.source ?? []).map((_row: unknown, index: number) => (
            <div key={index} data-rgrow={String(index)} data-testid={`mock-row-${index}`}>
              row {index}
            </div>
          ))}
        </div>
      );
    }),
  };
});

import { TrackerGridView } from '../TrackerGridView';

function record(id: string): TrackerRecord {
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
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    },
    fields: { title: `Title ${id}`, status: 'to-do' },
  } as TrackerRecord;
}

const ITEMS = [record('bug-1'), record('bug-2')];

function renderGrid(overrides: Record<string, unknown> = {}) {
  return render(
    <TrackerGridView
      filterType="bug"
      overrideItems={ITEMS}
      columnConfig={{ visibleColumns: ['title', 'status'], columnWidths: {}, groupBy: null }}
      {...overrides}
    />,
  );
}

/** Right-click a mock row; the handler resolves the selection asynchronously. */
function rightClickRow(index: number): void {
  fireEvent.contextMenu(screen.getByTestId(`mock-row-${index}`), {
    clientX: 40,
    clientY: 60,
  });
}

describe('TrackerGridView row context menu', () => {
  beforeAll(() => loadBuiltinTrackers());

  beforeEach(() => {
    selectedRange.current = null;
    (window as any).electronAPI = { documentService: { updateTrackerItem: vi.fn() } };
  });

  it('acts on the clicked row when the click lands outside the selected range', async () => {
    const onArchiveItems = vi.fn();
    renderGrid({ onArchiveItems });

    selectedRange.current = { y: 0, y1: 0 };
    rightClickRow(1);

    await waitFor(() => screen.getByTestId('tracker-row-context-menu'));
    screen.getByText('1 item selected');

    fireEvent.click(screen.getByTestId('tracker-row-context-archive'));
    expect(onArchiveItems).toHaveBeenCalledWith(['bug-2'], true);
  });

  it('acts on every row of the selected range when the click lands inside it', async () => {
    const onDeleteItems = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderGrid({ onDeleteItems });

    selectedRange.current = { y: 0, y1: 1 };
    rightClickRow(1);

    await waitFor(() => screen.getByText('2 items selected'));

    fireEvent.click(screen.getByTestId('tracker-row-context-delete'));
    expect(onDeleteItems).toHaveBeenCalledWith(['bug-1', 'bug-2']);
    confirmSpy.mockRestore();
  });

  it('offers the deep link only for a single-row selection', async () => {
    const onCopyDeepLink = vi.fn();
    renderGrid({ onCopyDeepLink });

    selectedRange.current = { y: 0, y1: 1 };
    rightClickRow(0);
    await waitFor(() => screen.getByText('2 items selected'));
    expect(screen.queryByTestId('tracker-row-context-copy-link')).toBeNull();

    selectedRange.current = null;
    rightClickRow(0);
    await waitFor(() => screen.getByText('1 item selected'));
    fireEvent.click(screen.getByTestId('tracker-row-context-copy-link'));
    expect(onCopyDeepLink).toHaveBeenCalledWith('bug-1');
  });

  it('ignores a right-click that is not over a row', async () => {
    renderGrid({ onDeleteItems: vi.fn() });

    // Inside the grid canvas but below no row -- e.g. the empty space under the
    // last row, where a menu of bulk actions would have nothing to act on.
    fireEvent.contextMenu(screen.getByTestId('mock-revogrid'), { clientX: 5, clientY: 5 });

    await Promise.resolve();
    expect(screen.queryByTestId('tracker-row-context-menu')).toBeNull();
  });
});

describe('TrackerGridView favorites', () => {
  beforeAll(() => loadBuiltinTrackers());

  it('renders a star in the title cell that toggles without focusing the row', async () => {
    const onToggleFavorite = vi.fn();
    const onItemSelect = vi.fn();
    renderGrid({
      onToggleFavorite,
      onItemSelect,
      favoriteItemIds: new Set(['bug-1']),
    });

    await waitFor(() => expect(gridElement.columns).toBeTruthy());
    const title = (gridElement.columns as Array<Record<string, any>>)
      .find(column => column.prop === 'title')!;

    const h = (tag: string, props: Record<string, unknown>, children: unknown) => ({
      tag,
      props,
      children,
    });
    const cell = title.cellTemplate(h, {
      model: { __trackerItemId: 'bug-1', title: 'Title bug-1' },
    });
    const star = cell.children[0];
    expect(star.props.class).toContain('is-favorite');

    const stop = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    star.props.onPointerDown(stop);
    expect(stop.stopPropagation).toHaveBeenCalled();

    star.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(onToggleFavorite).toHaveBeenCalledWith('bug-1');
  });

  it('omits the star but keeps the title action when favorites are unsupported', async () => {
    renderGrid({});

    await waitFor(() => expect(gridElement.columns).toBeTruthy());
    const title = (gridElement.columns as Array<Record<string, any>>)
      .find(column => column.prop === 'title')!;
    const h = (tag: string, props: Record<string, unknown>, children: unknown) => ({
      tag,
      props,
      children,
    });
    const cell = title.cellTemplate(h, {
      model: { __trackerItemId: 'bug-1', title: 'Title bug-1' },
    });

    expect(cell.props.class).toBe('tracker-grid-cell-title');
    expect(cell.children[0].props.class).toBe('tracker-grid-cell-text');
    expect(cell.children[1].props.class).toContain('tracker-grid-cell-menu-title');
  });
});
