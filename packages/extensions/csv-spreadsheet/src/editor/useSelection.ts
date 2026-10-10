/**
 * Selection: the logical selection refs, formula bar and AI context publishing,
 * RevoGrid focus/range events, our own cross-section drag, and programmatic
 * selections (select-all, whole rows and columns) painted across every
 * viewport section.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { RevoGridCustomEvent } from '@revolist/react-datagrid';
import type { EditorHost } from '@nimbalyst/extension-sdk';
import type { NormalizedSelectionRange } from '../types';
import { columnIndexToLetter, columnLetterToIndex } from '../utils/csvParser';
import { isFormula } from '../utils/formulaEngine';
import { snapRowsToVisible } from '../filter/visibleRange';
import { useGridKeyOriginGuard } from '../editors/gridKeyOrigin';
import { buildSpreadsheetSelectionContextItem } from '../selectionContext';
import { keyStateFromSelection, type GridKeyState } from '../keyboard';
import type { RevoGridElement } from '../revogrid-types';
import { useCellDragSelection } from '../selection/useCellDragSelection';
import {
  gridBounds,
  paintCrossSectionRange,
  resolveGridSections,
  toAbsoluteColumn,
  type SectionAwareGrid,
} from '../selection/crossSectionSelection';
import type { CellPosition, EditorCore } from './editorCore';
import type { RowView } from './useRowView';
import { formatSelectionRef, normalizeRange } from './editorUtils';
import { readGridSources } from '../commands/gridCommandExecutor';
import { pinnedRowCount } from '../sheetMeta/formatting';

export function useSelection(
  host: EditorHost,
  core: EditorCore,
  rowView: RowView,
  {
    publishLocalSelection,
    frozenColumnCount,
    dragEnabled,
  }: {
    publishLocalSelection: (cell: CellPosition | null) => void;
    frozenColumnCount: number;
    /** Gate on the grid actually being rendered, not just on the tab being active. */
    dragEnabled: boolean;
  },
) {
  const {
    hostRef, gridOpsRef, selectedCellRef, selectionRangeRef, formulaBarRef, skipFocusHandlerRef,
    suppressGridRangeRef, editorRef, gridContainerRef, revoGridRef, rowSpaceRef,
  } = core;
  const { translateRowIndex, toLogicalRow, toVisibleRow } = rowView;
  const [hasRangeSelection, setHasRangeSelection] = useState(false);
  const selectionContextPublishVersionRef = useRef(0);
  const lastPublishedSelectionContextRef = useRef<string | null>(null);

  const publishSelectionContext = useCallback(async (range: NormalizedSelectionRange | null) => {
    const publishVersion = ++selectionContextPublishVersionRef.current;

    if (!range) {
      if (lastPublishedSelectionContextRef.current !== null) {
        lastPublishedSelectionContextRef.current = null;
        hostRef.current.setEditorContextItems(null);
      }
      return;
    }

    let rows: Record<string, unknown>[] = [];
    const gridOps = gridOpsRef.current;
    if (gridOps) {
      try {
        const { pinnedTop, source } = await gridOps.getData();
        rows = [...pinnedTop, ...source];
      } catch {
        // The range label remains useful if RevoGrid is unavailable mid-unmount.
      }
    }

    if (publishVersion !== selectionContextPublishVersionRef.current) return;

    const item = buildSpreadsheetSelectionContextItem(range, rows);
    const signature = JSON.stringify(item);
    if (signature === lastPublishedSelectionContextRef.current) return;

    lastPublishedSelectionContextRef.current = signature;
    hostRef.current.setEditorContextItems([item]);
  }, []);

  useEffect(() => () => {
    selectionContextPublishVersionRef.current += 1;
    lastPublishedSelectionContextRef.current = null;
    host.setEditorContextItems(null);
  }, [host]);

  /**
   * Update selection refs and formula bar
   */
  const updateSelection = useCallback(async (
    cell: { row: number; col: number } | null,
    range: NormalizedSelectionRange | null,
    /** False when the keyboard set the controller state itself (anchor, Tab run). */
    syncKeyState = true,
  ) => {
    selectedCellRef.current = cell;
    selectionRangeRef.current = range;
    if (cell && syncKeyState) {
      core.pendingEditTextRef.current = null;
      core.keyStateRef.current = keyStateFromSelection(cell, range, core.keyStateRef.current.mode);
    }
    // Only the find bar's "In selection" needs this as state; React bails out
    // when the boolean is unchanged, so a drag doesn't re-render per cell.
    setHasRangeSelection(
      !!range && (range.startRow !== range.endRow || range.startCol !== range.endCol)
    );
    void publishSelectionContext(range);
    publishLocalSelection(cell);
    for (const listener of core.selectionListeners) listener();

    if (cell && formulaBarRef.current) {
      // Read value from RevoGrid
      const gridOps = gridOpsRef.current;
      if (gridOps) {
        const value = await gridOps.getCellRawValue(cell.row, cell.col);
        const cellRef = range ? formatSelectionRef(range) : '';
        formulaBarRef.current.update(cellRef, value, isFormula(value));
      }
    } else if (formulaBarRef.current) {
      formulaBarRef.current.update('', '', false);
    }
  }, [publishSelectionContext, publishLocalSelection]);

  // Handle cell focus (selection)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleFocusCell = useCallback(
    (event: RevoGridCustomEvent<any>) => {
      // Skip if we're doing programmatic selection (e.g., select-all) or if our
      // own drag is mid-flight and owns the range.
      if (skipFocusHandlerRef.current || suppressGridRangeRef.current) return;
      if (!event.detail) return;
      const { rowIndex, colIndex, type, rowType, column } = event.detail;

      // `afterfocus` names the row section `rowType`; only the earlier
      // `beforecellfocus` calls it `type`. Reading the wrong one leaves
      // `isPinned` undefined, which shifts every pinned-row click down a row.
      const isPinned = (rowType ?? type) === 'rowPinStart';
      const actualRowIndex = translateRowIndex(rowIndex, isPinned);
      // `column.prop` is the sheet-wide column letter, so it survives the frozen
      // boundary that `colIndex` (section-local) does not.
      const actualColIndex = column?.prop
        ? columnLetterToIndex(String(column.prop))
        : toAbsoluteColumn(event.target as Element | null, colIndex, frozenColumnCount);

      const newCell = { row: actualRowIndex, col: actualColIndex };
      updateSelection(
        newCell,
        normalizeRange(actualRowIndex, actualColIndex, actualRowIndex, actualColIndex)
      );
    },
    [translateRowIndex, updateSelection, frozenColumnCount]
  );

  // Handle range selection
  const handleSetRange = useCallback(
    (event: RevoGridCustomEvent<{
      type: string;
      area?: { x: number; y: number; x1: number; y1: number };
      x?: number; y?: number; x1?: number; y1?: number;
    } | null>) => {
      if (!event.detail) return;
      if (suppressGridRangeRef.current) return;

      const x = event.detail.area?.x ?? event.detail.x;
      const y = event.detail.area?.y ?? event.detail.y;
      const x1 = event.detail.area?.x1 ?? event.detail.x1;
      const y1 = event.detail.area?.y1 ?? event.detail.y1;

      if (x === undefined || y === undefined || x1 === undefined || y1 === undefined) return;

      const isPinned = event.detail.type === 'rowPinStart';
      const actualY = translateRowIndex(y, isPinned);
      const actualY1 = translateRowIndex(y1, isPinned);
      // The payload carries no column section, but the overlay that emitted it
      // is the event target and knows which one it is.
      const section = event.target as Element | null;
      const actualX = toAbsoluteColumn(section, x, frozenColumnCount);
      const actualX1 = toAbsoluteColumn(section, x1, frozenColumnCount);

      const newRange = normalizeRange(actualY, actualX, actualY1, actualX1);
      updateSelection({ row: actualY, col: actualX }, newRange);
    },
    [translateRowIndex, updateSelection, frozenColumnCount]
  );

  // RevoGrid's document-level keydown listener acts on keys typed anywhere in
  // the app while a cell is focused -- typing into quick open opened the cell
  // editor and stole the caret. Decline the keys that did not start in here.
  useGridKeyOriginGuard(editorRef);

  // Own cell drag-selection so ranges can cross the frozen/pinned boundaries
  // that RevoGrid's built-in drag is clamped to.
  useCellDragSelection({
    containerRef: gridContainerRef,
    gridRef: revoGridRef as RefObject<SectionAwareGrid | null>,
    // Gate on the grid actually being rendered, not just on the tab being
    // active -- the loading tree has no container to bind to.
    enabled: dragEnabled,
    // The drag hit-tests and paints in visible rows; the selection it reports
    // has to cross back into logical space.
    onSelectionChange: useCallback((cell, range) => updateSelection(
      cell && { ...cell, row: toLogicalRow(cell.row) },
      range && { ...range, startRow: toLogicalRow(range.startRow), endRow: toLogicalRow(range.endRow) },
    ), [updateSelection, toLogicalRow]),
    suppressGridRangeRef,
    getActiveCell: useCallback(() => {
      const cell = selectedCellRef.current;
      return cell && { row: toVisibleRow(cell.row), col: cell.col };
    }, [toVisibleRow]),
  });

  /**
   * Paint a logical range across every viewport section it touches and adopt it
   * as the selection. Replaces per-section `setCellsFocus` calls, which could
   * only ever address one section and silently painted nothing when a range
   * straddled a boundary.
   */
  const paintLogicalRange = useCallback(
    async (range: NormalizedSelectionRange, focus?: { row: number; col: number }) => {
      const grid = revoGridRef.current as SectionAwareGrid | null;
      if (!grid) return;
      const sections = await resolveGridSections(grid);
      if (!sections) return;
      // Endpoints can name a filtered-out row (select-all, a column header, a
      // find hit); narrow onto visible rows before either space sees them.
      const snapped = snapRowsToVisible(rowSpaceRef.current, range.startRow, range.endRow);
      if (!snapped) return;
      const logicalRange = { ...range, ...snapped };
      // The stores address visible rows; the range here is logical.
      await paintCrossSectionRange(grid, sections, {
        ...logicalRange,
        startRow: toVisibleRow(logicalRange.startRow),
        endRow: toVisibleRow(logicalRange.endRow),
      });
      void updateSelection(
        focus ?? { row: logicalRange.startRow, col: logicalRange.startCol },
        logicalRange,
      );
    },
    [updateSelection, toVisibleRow]
  );

  /** Full row/column extent of the grid, for header-click selections. */
  const getGridExtent = useCallback(async () => {
    const grid = revoGridRef.current as SectionAwareGrid | null;
    if (!grid) return null;
    const sections = await resolveGridSections(grid);
    if (!sections) return null;
    // `gridBounds` counts the rows the sections hold, i.e. visible ones.
    const { lastRow, lastCol } = gridBounds(sections);
    return { lastRow: toLogicalRow(lastRow), lastCol };
  }, [toLogicalRow]);

  // Select all cells (from 0,0 to last cell with data)
  const selectAll = useCallback(() => {
    const grid = revoGridRef.current;
    if (!grid) return;

    // Skip focus handler to prevent it from resetting our selection
    skipFocusHandlerRef.current = true;

    // Find actual data bounds asynchronously
    (async () => {
      try {
        const { source, pinnedTop } = await readGridSources(grid);

        const pinnedRows = (pinnedTop as Record<string, unknown>[]) ?? [];
        const dataRows = (source as Record<string, unknown>[]) ?? [];
        const allRows = [...pinnedRows, ...dataRows];

        // Find last column with actual data
        let lastColWithData = 0;
        for (const row of allRows) {
          for (const [key, value] of Object.entries(row)) {
            if (key === '_rowClass') continue;
            if (value !== undefined && value !== null && value !== '') {
              const colIndex = columnLetterToIndex(key);
              if (colIndex > lastColWithData) {
                lastColWithData = colIndex;
              }
            }
          }
        }

        // Find last row with actual data (not empty buffer rows)
        const isRowEmpty = (row: Record<string, unknown>): boolean => {
          for (let c = 0; c <= lastColWithData; c++) {
            const colKey = columnIndexToLetter(c);
            const value = row[colKey];
            if (value !== undefined && value !== null && value !== '') {
              return false;
            }
          }
          return true;
        };

        // Find last non-empty data row
        let lastDataRowIndex = -1;
        for (let r = dataRows.length - 1; r >= 0; r--) {
          if (!isRowEmpty(dataRows[r])) {
            lastDataRowIndex = r;
            break;
          }
        }

        // Calculate total rows (pinned + data rows with content)
        const pinnedRowCount = pinnedRows.length;
        const lastRow = Math.max(0, pinnedRowCount + lastDataRowIndex);

        const selection = normalizeRange(0, 0, lastRow, lastColWithData);

        // Paint across every section so the highlight covers pinned header rows
        // and frozen columns as well as the body.
        await paintLogicalRange(selection, { row: 0, col: 0 });
      } finally {
        // Re-enable focus handler after a short delay to allow RevoGrid events to settle
        setTimeout(() => {
          skipFocusHandlerRef.current = false;
        }, 100);
      }
    })();
  }, [paintLogicalRange]);

  // Selection helpers
  const selectColumn = useCallback((colIndex: number) => {
    void (async () => {
      const extent = await getGridExtent();
      if (!extent) return;
      await paintLogicalRange(normalizeRange(0, colIndex, extent.lastRow, colIndex));
    })();
  }, [getGridExtent, paintLogicalRange]);

  const selectColumnRange = useCallback((startCol: number, endCol: number) => {
    void (async () => {
      const extent = await getGridExtent();
      if (!extent) return;
      const minCol = Math.min(startCol, endCol);
      const maxCol = Math.max(startCol, endCol);
      await paintLogicalRange(normalizeRange(0, minCol, extent.lastRow, maxCol));
    })();
  }, [getGridExtent, paintLogicalRange]);

  const selectRow = useCallback((rowIndex: number) => {
    void (async () => {
      const extent = await getGridExtent();
      if (!extent) return;
      await paintLogicalRange(normalizeRange(rowIndex, 0, rowIndex, extent.lastCol));
    })();
  }, [getGridExtent, paintLogicalRange]);

  const selectRowRange = useCallback((startRow: number, endRow: number) => {
    void (async () => {
      const extent = await getGridExtent();
      if (!extent) return;
      const minRow = Math.min(startRow, endRow);
      const maxRow = Math.max(startRow, endRow);
      await paintLogicalRange(normalizeRange(minRow, 0, maxRow, extent.lastCol));
    })();
  }, [getGridExtent, paintLogicalRange]);

  /**
   * Show a selection the key controller produced: RevoGrid's focus goes to the
   * active cell (that is where its editor opens and what it scrolls to), the
   * range is painted across every section, and the far corner is scrolled into
   * view when extending. The refs update before anything is awaited, so the
   * next keystroke already sees this selection.
   */
  const selectFromKeyboard = useCallback((state: GridKeyState) => {
    const range = normalizeRange(state.anchor.row, state.anchor.col, state.focus.row, state.focus.col);
    core.keyStateRef.current = state;
    void updateSelection(state.active, range, false);
    const grid = revoGridRef.current as (SectionAwareGrid & RevoGridElement) | null;
    if (!grid) return;
    const container = gridContainerRef.current;
    if (container && !container.contains(document.activeElement)) container.focus({ preventScroll: true });
    const { frozenColumnCount: frozen } = core.spreadsheetMetaRef.current.getMetadata();
    // The pinned section holds the header rows and any frozen rows.
    const headerRowCount = grid.pinnedTopSource?.length ?? pinnedRowCount(core.spreadsheetMetaRef.current.getMetadata());
    const local = (cell: { row: number; col: number }) => {
      const visible = toVisibleRow(cell.row);
      return {
        rowType: visible < headerRowCount ? 'rowPinStart' : 'rgRow',
        y: visible < headerRowCount ? visible : visible - headerRowCount,
        colType: cell.col < frozen ? 'colPinStart' : 'rgCol',
        x: cell.col < frozen ? cell.col : cell.col - frozen,
      } as const;
    };
    // RevoGrid answers our own focus/range writes with afterfocus/setrange
    // events that would collapse the selection back to one cell.
    skipFocusHandlerRef.current = true;
    suppressGridRangeRef.current = true;
    void (async () => {
      try {
        const active = local(state.active);
        await grid.setCellsFocus({ x: active.x, y: active.y }, { x: active.x, y: active.y }, active.colType, active.rowType);
        const sections = await resolveGridSections(grid);
        if (sections) {
          await paintCrossSectionRange(grid, sections, {
            ...range, startRow: toVisibleRow(range.startRow), endRow: toVisibleRow(range.endRow),
          });
        }
        const far = local(state.focus);
        const rendered = container?.querySelector(
          `revogr-data[type="${far.rowType}"] [data-rgrow="${far.y}"][data-rgcol="${far.x}"]`,
        );
        if (!rendered && far.rowType === 'rgRow') await grid.scrollToRow(far.y);
        if (!rendered && far.colType === 'rgCol') await grid.scrollToColumnIndex(far.x);
      } finally {
        setTimeout(() => {
          skipFocusHandlerRef.current = false;
          suppressGridRangeRef.current = false;
        }, 50);
      }
    })();
  }, [updateSelection, toVisibleRow]);

  // Undo/redo and paste put the selection back on what they changed.
  core.restoreSelectionRef.current = (selection) => {
    if (selection.range) void paintLogicalRange(selection.range, selection.cell ?? undefined);
    else void updateSelection(selection.cell, null);
  };

  return {
    hasRangeSelection,
    updateSelection,
    selectFromKeyboard,
    publishSelectionContext,
    handleFocusCell,
    handleSetRange,
    paintLogicalRange,
    selectAll,
    selectColumn,
    selectColumnRange,
    selectRow,
    selectRowRange,
  };
}

export type Selection = ReturnType<typeof useSelection>;
