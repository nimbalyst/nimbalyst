import type { NormalizedSelectionRange, TrimmedRows } from '../types';

export interface LogicalRowSelection {
  /** Ordered logical row indexes. This is deliberately not representable as a contiguous range. */
  readonly logicalRows: readonly number[];
}

export interface RowIndexMappingConfig {
  /** Total logical rows, including pinned header rows. */
  rowCount: number;
  /** Pinned rows at the start of the logical row space. RevoGrid never trims these rows. */
  headerRowCount?: number;
  /** Physical rgRow indexes hidden by RevoGrid. */
  trimmedRows?: TrimmedRows;
}

export interface RowIndexMapping {
  /** Every visible row represented by its logical row index, in display order. */
  readonly logicalRows: readonly number[];
  visibleToLogical(visibleRow: number): number | undefined;
  logicalToVisible(logicalRow: number): number | undefined;
  expandVisibleRange(startVisibleRow: number, endVisibleRow: number): LogicalRowSelection;
  expandLogicalRange(startLogicalRow: number, endLogicalRow: number): LogicalRowSelection;
}

function normalizedIndex(value: number): number | undefined {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function createRowIndexMapping({
  rowCount,
  headerRowCount = 0,
  trimmedRows = {},
}: RowIndexMappingConfig): RowIndexMapping {
  const safeRowCount = Math.max(0, Math.floor(rowCount));
  const safeHeaderRowCount = Math.min(safeRowCount, Math.max(0, Math.floor(headerRowCount)));
  const logicalRows: number[] = [];
  const visibleByLogical = new Map<number, number>();

  for (let logicalRow = 0; logicalRow < safeRowCount; logicalRow += 1) {
    const physicalRow = logicalRow - safeHeaderRowCount;
    if (physicalRow >= 0 && trimmedRows[physicalRow] === true) continue;
    visibleByLogical.set(logicalRow, logicalRows.length);
    logicalRows.push(logicalRow);
  }

  const expandVisibleRange = (startVisibleRow: number, endVisibleRow: number): LogicalRowSelection => {
    const start = normalizedIndex(startVisibleRow);
    const end = normalizedIndex(endVisibleRow);
    if (start === undefined || end === undefined) return { logicalRows: [] };
    const first = Math.min(start, end);
    const last = Math.max(start, end);
    return { logicalRows: logicalRows.slice(first, last + 1) };
  };

  return {
    logicalRows,
    visibleToLogical(visibleRow) {
      const index = normalizedIndex(visibleRow);
      return index === undefined ? undefined : logicalRows[index];
    },
    logicalToVisible(logicalRow) {
      const index = normalizedIndex(logicalRow);
      return index === undefined ? undefined : visibleByLogical.get(index);
    },
    expandVisibleRange,
    expandLogicalRange(startLogicalRow, endLogicalRow) {
      const start = visibleByLogical.get(startLogicalRow);
      const end = visibleByLogical.get(endLogicalRow);
      if (start === undefined || end === undefined) return { logicalRows: [] };
      return expandVisibleRange(start, end);
    },
  };
}

export function visibleToLogical(mapping: RowIndexMapping, visibleRow: number): number | undefined {
  return mapping.visibleToLogical(visibleRow);
}

export function logicalToVisible(mapping: RowIndexMapping, logicalRow: number): number | undefined {
  return mapping.logicalToVisible(logicalRow);
}

/**
 * Logical row for a RevoGrid-reported row index.
 *
 * RevoGrid addresses body rows by *visible* position and restarts numbering per
 * section, so a `data-rgrow` or event row index has to be shifted past the
 * pinned header rows and then mapped through the filtered view. Reconstructing
 * it arithmetically (`gridRow + headerRowCount`) is only correct while nothing
 * is filtered; with the first body row hidden it names the row the user cannot
 * see, which is how "Delete Row" once deleted a hidden row.
 *
 * Pinned header rows are never trimmed, so their visible index is already
 * logical -- the same conversion covers both sections. An index past the end of
 * the mapping falls back to itself, so a momentarily stale mapping degrades to
 * the unfiltered behaviour rather than to a wrong row.
 */
export function logicalRowForGridRow(
  mapping: RowIndexMapping,
  gridRowIndex: number,
  isPinned: boolean,
  headerRowCount: number,
): number {
  const visibleRow = isPinned ? gridRowIndex : gridRowIndex + headerRowCount;
  return mapping.visibleToLogical(visibleRow) ?? visibleRow;
}

export function logicalRowsForSelection(
  mapping: RowIndexMapping,
  selection: Pick<NormalizedSelectionRange, 'startRow' | 'endRow'>,
): LogicalRowSelection {
  return mapping.expandLogicalRange(selection.startRow, selection.endRow);
}

export function logicalRowsForPaste(
  mapping: RowIndexMapping,
  targetLogicalRow: number,
  pasteRowCount: number,
  totalLogicalRows: number,
): LogicalRowSelection {
  if (pasteRowCount <= 0) return { logicalRows: [] };
  const targetVisibleRow = mapping.logicalToVisible(targetLogicalRow);
  const visibleRows = targetVisibleRow === undefined
    ? []
    : mapping.logicalRows.slice(targetVisibleRow, targetVisibleRow + pasteRowCount);
  const logicalRows = [...visibleRows];
  let appendedLogicalRow = Math.max(totalLogicalRows, targetLogicalRow);

  while (logicalRows.length < pasteRowCount) {
    logicalRows.push(appendedLogicalRow);
    appendedLogicalRow += 1;
  }

  return { logicalRows };
}
