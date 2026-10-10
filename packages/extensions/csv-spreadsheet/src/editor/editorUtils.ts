/** Small pure helpers shared by the SpreadsheetEditor feature hooks. */

import type { NormalizedSelectionRange } from '../types';
import type { CsvMetaSnapshot } from '../collab/metaBinding';
import type { SpreadsheetMetadata } from '../hooks/useSpreadsheetMetadata';
import { columnIndexToLetter } from '../utils/csvParser';
import { pickFormatting } from '../sheetMeta/formatting';

// Empty rows kept below the data so there is somewhere to type.
export const DISPLAY_BUFFER_ROWS = 20;
// Empty columns shown past the data: column definitions only, no cells in the row models.
export const DISPLAY_BUFFER_COLS = 20;

/**
 * Format a selection range as a cell reference string (e.g., "A1" or "A1:C5")
 */
export function formatSelectionRef(selection: NormalizedSelectionRange | null): string {
  if (!selection) return '';

  const startRef = `${columnIndexToLetter(selection.startCol)}${selection.startRow + 1}`;

  if (selection.startRow === selection.endRow && selection.startCol === selection.endCol) {
    return startRef;
  }

  const endRef = `${columnIndexToLetter(selection.endCol)}${selection.endRow + 1}`;
  return `${startRef}:${endRef}`;
}

/** The subset of editor metadata that syncs between collaborators. */
export function metaSnapshotOf(metadata: SpreadsheetMetadata): CsvMetaSnapshot {
  return {
    headerRowCount: metadata.headerRowCount,
    frozenColumnCount: metadata.frozenColumnCount,
    columnFormats: metadata.columnFormats,
    columnWidths: metadata.columnWidths,
    cellStyles: metadata.cellStyles,
    ...pickFormatting(metadata),
  };
}

/**
 * Which columns a format-dialog save applies to: every column in the current
 * selection when the formatted column is part of it, otherwise just that column.
 */
export function formatTargetColumns(
  selection: NormalizedSelectionRange | null,
  columnIndex: number,
): number[] {
  if (!selection || columnIndex < selection.startCol || columnIndex > selection.endCol) {
    return [columnIndex];
  }
  const targets: number[] = [];
  for (let column = selection.startCol; column <= selection.endCol; column++) {
    targets.push(column);
  }
  return targets;
}

/**
 * Normalize selection range
 */
export function normalizeRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): NormalizedSelectionRange {
  return {
    startRow: Math.min(startRow, endRow),
    startCol: Math.min(startCol, endCol),
    endRow: Math.max(startRow, endRow),
    endCol: Math.max(startCol, endCol),
  };
}
