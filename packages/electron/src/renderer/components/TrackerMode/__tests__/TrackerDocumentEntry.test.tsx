// @vitest-environment jsdom
/**
 * Entry gestures into the focused document view (plan: tracker-document-mode,
 * checkboxes 16 and 17): double-clicking a row opens the item as a document,
 * and the row context menu offers the same thing for one selected row.
 *
 * The RevoGrid table stands in for the row surfaces here -- it shares
 * `TrackerRowContextMenu` with the list view, and its `data-rgrow` row
 * resolution is the fiddliest of the four.
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

describe('document-view entry gestures', () => {
  beforeAll(() => loadBuiltinTrackers());

  beforeEach(() => {
    selectedRange.current = null;
    (window as any).electronAPI = { documentService: { updateTrackerItem: vi.fn() } };
  });

  it('opens the document on a row double-click', async () => {
    const onOpenDocument = vi.fn();
    renderGrid({ onOpenDocument });

    fireEvent.doubleClick(screen.getByTestId('mock-row-1'));

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('bug-2'));
  });

  it('ignores a double-click that is not over a row', async () => {
    const onOpenDocument = vi.fn();
    renderGrid({ onOpenDocument });

    fireEvent.doubleClick(screen.getByTestId('mock-revogrid'));

    await Promise.resolve();
    expect(onOpenDocument).not.toHaveBeenCalled();
  });

  it('offers "Open document" in the row context menu for a single row', async () => {
    const onOpenDocument = vi.fn();
    renderGrid({ onOpenDocument });

    // A multi-row selection has no single document to open.
    selectedRange.current = { y: 0, y1: 1 };
    fireEvent.contextMenu(screen.getByTestId('mock-row-0'), { clientX: 40, clientY: 60 });
    await waitFor(() => screen.getByText('2 items selected'));
    expect(screen.queryByTestId('tracker-row-context-open-document')).toBeNull();

    selectedRange.current = null;
    fireEvent.contextMenu(screen.getByTestId('mock-row-1'), { clientX: 40, clientY: 60 });
    await waitFor(() => screen.getByText('1 item selected'));

    fireEvent.click(screen.getByTestId('tracker-row-context-open-document'));
    expect(onOpenDocument).toHaveBeenCalledWith('bug-2');
  });

  it('leaves the row surface untouched when the host offers no document view', async () => {
    renderGrid({ onCopyDeepLink: vi.fn() });

    selectedRange.current = null;
    fireEvent.contextMenu(screen.getByTestId('mock-row-0'), { clientX: 40, clientY: 60 });
    await waitFor(() => screen.getByText('1 item selected'));
    expect(screen.queryByTestId('tracker-row-context-open-document')).toBeNull();
  });
});
