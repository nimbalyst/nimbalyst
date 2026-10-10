/**
 * Context menu item builders for the three right-click targets: a cell, a row
 * header, and a column header. Pure functions of the sheet state they are
 * given, so a menu's behavior can be tested without rendering the grid.
 */

import type { ColumnFormat, CellStyle, NormalizedSelectionRange } from '../types';
import type { ContextMenuItem } from '../components/ContextMenu';
import type { GridOperations } from '../utils/gridOperations';
import type { UseSpreadsheetMetadataResult } from '../hooks/useSpreadsheetMetadata';
import { columnIndexToLetter } from '../utils/csvParser';
import { getColumnTypeName } from '../utils/formatters';
import type { CellPosition } from './editorCore';
import { hideCols, hideRows, unhideCols, unhideRows } from '../format/formatActions';

export interface ContextMenuDeps {
  gridOps: GridOperations | null;
  meta: Pick<UseSpreadsheetMetadataResult, 'setSortConfig'>;
  headerRowCount: number;
  updateSelection: (cell: CellPosition | null, range: NormalizedSelectionRange | null) => unknown;
  openCellFormat: () => void;
  openColumnFormat: (columnIndex: number) => void;
  applyCellStyle: (change: CellStyle) => void;
  applyDetectedColumnType: (columnIndex: number) => void;
  /** The current selection, so hide/unhide act on the selected block containing the clicked header. */
  selectionRange?: NormalizedSelectionRange | null;
  hiddenRows?: readonly number[];
  hiddenCols?: readonly number[];
}

/** The span a header action applies to: the selected rows/columns when the click is inside them. */
function headerSpan(index: number, range: NormalizedSelectionRange | null | undefined, axis: 'row' | 'col'): [number, number] {
  if (!range) return [index, index];
  const [start, end] = axis === 'row' ? [range.startRow, range.endRow] : [range.startCol, range.endCol];
  return index >= start && index <= end ? [start, end] : [index, index];
}

function hideItems(index: number, deps: ContextMenuDeps, axis: 'row' | 'col'): ContextMenuItem[] {
  const [start, end] = headerSpan(index, deps.selectionRange, axis);
  const name = (i: number) => (axis === 'row' ? String(i + 1) : columnIndexToLetter(i));
  const noun = axis === 'row' ? 'Row' : 'Column';
  const label = start === end ? `Hide ${noun} ${name(start)}` : `Hide ${noun}s ${name(start)}-${name(end)}`;
  const hidden = (axis === 'row' ? deps.hiddenRows : deps.hiddenCols) ?? [];
  // A hidden block next to the clicked header, or inside the selection, is what "unhide" reveals.
  // The whole contiguous hidden block is revealed, not just its first row.
  const isHidden = new Set(hidden);
  let unhideStart = Math.max(0, start - 1);
  let unhideEnd = end + 1;
  while (unhideStart > 0 && isHidden.has(unhideStart - 1)) unhideStart -= 1;
  while (isHidden.has(unhideEnd + 1)) unhideEnd += 1;
  const nearby = hidden.some((i) => i >= unhideStart && i <= unhideEnd);
  const items: ContextMenuItem[] = [{
    label,
    action: () => void deps.gridOps?.setMeta((meta) => (axis === 'row' ? hideRows(meta, start, end) : hideCols(meta, start, end))),
  }];
  if (hidden.length > 0) {
    items.push({
      label: nearby ? `Unhide ${noun}s` : `Unhide All ${noun}s`,
      action: () => void deps.gridOps?.setMeta((meta) => (axis === 'row'
        ? unhideRows(meta, nearby ? unhideStart : 0, nearby ? unhideEnd : Number.MAX_SAFE_INTEGER)
        : unhideCols(meta, nearby ? unhideStart : 0, nearby ? unhideEnd : Number.MAX_SAFE_INTEGER))),
    });
  }
  return items;
}

const SEPARATOR: ContextMenuItem = { label: '', action: () => {}, separator: true };

/**
 * Row and column inserts/deletes are single structural commands: the header
 * row count, frozen columns, formats and formula refs are rewritten in the
 * same step as the grid, so the menu never adjusts metadata itself. (Doing it
 * here raced the asynchronous grid read: deleting the header row deleted the
 * first body row instead.)
 */
function insertRow(deps: ContextMenuDeps, rowIndex: number): void {
  void deps.gridOps?.addRow(rowIndex);
}

function deleteRow(deps: ContextMenuDeps, rowIndex: number): void {
  void deps.gridOps?.deleteRow(rowIndex);
  deps.updateSelection(null, null);
}

function setFrozenColumns(deps: ContextMenuDeps, count: number): void {
  void deps.gridOps?.setMeta((meta) => ({ frozenColumnCount: Math.max(0, Math.min(count, meta.columnCount)) }));
}

export function buildCellMenuItems(
  cell: CellPosition | null,
  range: NormalizedSelectionRange | null,
  deps: ContextMenuDeps,
): ContextMenuItem[] {
  const hasSelection = !!cell;
  const { gridOps } = deps;
  const cellCount = range
    ? (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1)
    : 0;
  const hasMultipleSelected = cellCount > 1;

  return [
    {
      label: hasMultipleSelected ? `Cut (${cellCount} cells)` : 'Cut',
      action: () => {
        if (range && gridOps) gridOps.cutSelection(range);
      },
      disabled: !hasSelection,
    },
    {
      label: hasMultipleSelected ? `Copy (${cellCount} cells)` : 'Copy',
      action: () => {
        if (range && gridOps) gridOps.copySelection(range);
      },
      disabled: !hasSelection,
    },
    {
      label: 'Paste',
      action: () => {
        const target = range ?? (cell && { startRow: cell.row, endRow: cell.row, startCol: cell.col, endCol: cell.col });
        if (target && gridOps) void gridOps.paste(target).catch(() => {});
      },
      disabled: !hasSelection,
    },
    {
      label: hasMultipleSelected ? `Clear (${cellCount} cells)` : 'Clear',
      action: () => {
        if (range && gridOps) gridOps.clearCells(range);
      },
      disabled: !hasSelection,
    },
    SEPARATOR,
    // Styling is presentation only, so it is safe on a formula or a date --
    // neither of these touches the cell's value.
    {
      label: hasMultipleSelected ? `Format Cells (${cellCount})...` : 'Format Cells...',
      action: deps.openCellFormat,
      disabled: !hasSelection,
    },
    {
      label: 'Clear formatting',
      action: () => deps.applyCellStyle({
        bold: false, italic: false, underline: false, strikethrough: false,
        textColor: 'default', fillColor: 'default',
      }),
      disabled: !hasSelection,
    },
    SEPARATOR,
    {
      label: 'Insert Row Above',
      action: () => {
        if (cell && gridOps) insertRow(deps, cell.row);
      },
      disabled: !hasSelection,
    },
    {
      label: 'Insert Row Below',
      action: () => {
        if (cell && gridOps) insertRow(deps, cell.row + 1);
      },
      disabled: !hasSelection,
    },
    {
      label: 'Delete Row',
      action: () => {
        if (cell && gridOps) deleteRow(deps, cell.row);
      },
      disabled: !hasSelection,
    },
    SEPARATOR,
    {
      label: 'Insert Column Left',
      action: () => {
        if (cell && gridOps) gridOps.addColumn(cell.col);
      },
      disabled: !hasSelection,
    },
    {
      label: 'Insert Column Right',
      action: () => {
        if (cell && gridOps) gridOps.addColumn(cell.col + 1);
      },
      disabled: !hasSelection,
    },
    {
      label: 'Delete Column',
      action: () => {
        if (cell && gridOps) {
          gridOps.deleteColumn(cell.col);
          deps.updateSelection(null, null);
        }
      },
      disabled: !hasSelection,
    },
  ];
}

export function buildRowHeaderMenuItems(rowIndex: number, deps: ContextMenuDeps): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  const { gridOps, headerRowCount } = deps;

  // Header pinning is available again now that selection spans the pinned
  // boundary (see selection/crossSectionSelection.ts).
  const isCurrentlyHeader = rowIndex < headerRowCount;
  const isTopRowOrAdjacentToHeader = rowIndex === 0 || rowIndex === headerRowCount;

  const setHeaderCount = (count: number) => gridOps?.updateHeaderRowCount(count);

  if (isCurrentlyHeader) {
    if (rowIndex === headerRowCount - 1) {
      items.push({
        label: 'Remove Header Row',
        action: () => setHeaderCount(headerRowCount - 1),
      });
    }
    if (headerRowCount > 1) {
      items.push({
        label: 'Remove All Header Rows',
        action: () => setHeaderCount(0),
      });
    }
  } else if (isTopRowOrAdjacentToHeader) {
    items.push({
      label: 'Set as Header Row',
      action: () => setHeaderCount(rowIndex + 1),
    });
  } else {
    items.push({
      label: `Set Rows 1-${rowIndex + 1} as Headers`,
      action: () => setHeaderCount(rowIndex + 1),
    });
  }

  items.push(SEPARATOR);
  items.push({ label: 'Insert Row Above', action: () => insertRow(deps, rowIndex) });
  items.push({ label: 'Insert Row Below', action: () => insertRow(deps, rowIndex + 1) });
  items.push({ label: 'Delete Row', action: () => deleteRow(deps, rowIndex) });
  items.push(SEPARATOR, ...hideItems(rowIndex, deps, 'row'));

  return items;
}

export function buildColumnHeaderMenuItems(
  colIndex: number,
  { frozenColumnCount, columnFormats }: {
    frozenColumnCount: number;
    columnFormats: Record<number, ColumnFormat>;
  },
  deps: ContextMenuDeps,
): ContextMenuItem[] {
  const colLetter = columnIndexToLetter(colIndex);
  const currentFrozenCount = frozenColumnCount;
  const currentFormat = columnFormats[colIndex];
  const formatTypeName = currentFormat ? getColumnTypeName(currentFormat.type) : 'Text';
  const { gridOps, meta } = deps;

  const items: ContextMenuItem[] = [
    {
      label: `Format Column (${formatTypeName})...`,
      action: () => deps.openColumnFormat(colIndex),
    },
    {
      label: 'Detect Column Type',
      action: () => deps.applyDetectedColumnType(colIndex),
    },
    SEPARATOR,
    {
      label: `Sort ${colLetter} A -> Z`,
      action: () => {
        gridOps?.sortByColumn(colIndex, 'asc');
        meta.setSortConfig({ columnIndex: colIndex, direction: 'asc' });
      },
    },
    {
      label: `Sort ${colLetter} Z -> A`,
      action: () => {
        gridOps?.sortByColumn(colIndex, 'desc');
        meta.setSortConfig({ columnIndex: colIndex, direction: 'desc' });
      },
    },
    SEPARATOR,
  ];

  // Freeze is available again now that selection spans the frozen boundary
  // (see selection/crossSectionSelection.ts).
  const isCurrentlyFrozen = colIndex < currentFrozenCount;
  const isAtFrozenBoundary = colIndex === currentFrozenCount;

  if (isCurrentlyFrozen) {
    if (colIndex === currentFrozenCount - 1) {
      items.push({
        label: 'Unfreeze Column',
        action: () => setFrozenColumns(deps, currentFrozenCount - 1),
      });
    }
    if (currentFrozenCount > 1) {
      items.push({
        label: 'Unfreeze All Columns',
        action: () => setFrozenColumns(deps, 0),
      });
    }
  } else if (isAtFrozenBoundary) {
    items.push({
      label: 'Freeze Column',
      action: () => setFrozenColumns(deps, colIndex + 1),
    });
  } else {
    items.push({
      label: `Freeze Columns A-${colLetter}`,
      action: () => setFrozenColumns(deps, colIndex + 1),
    });
  }

  items.push(SEPARATOR);

  items.push({
    label: 'Insert Column Left',
    action: () => gridOps?.addColumn(colIndex),
  });
  items.push({
    label: 'Insert Column Right',
    action: () => gridOps?.addColumn(colIndex + 1),
  });
  items.push({
    label: 'Delete Column',
    action: () => {
      gridOps?.deleteColumn(colIndex);
      deps.updateSelection(null, null);
    },
  });
  items.push(SEPARATOR, ...hideItems(colIndex, deps, 'col'));

  return items;
}
