/**
 * Paste planning: where a clipboard matrix lands and what each cell receives.
 *
 * Sheets rules: when the selection is an exact multiple of the copied block in
 * both directions, the block is tiled across it; otherwise it is written once
 * from the selection's top-left. The plan reports how far the sheet has to grow
 * so the host can add rows/columns in the same undoable command.
 */

import type { CellCoord, CellRange } from '../keyboard/types';
import type { CellMatrix } from './tsv';

/** Rewrites relative refs in `formula` for a move of `dRow` rows / `dCol` columns. */
export type AdjustFormula = (formula: string, dRow: number, dCol: number) => string;

export interface PasteSource {
  /** Cell contents to write; formulas start with `=`. */
  readonly values: CellMatrix;
  /**
   * Sheet position the block was copied from (internal pastes only). Required
   * for formula adjustment; external pastes have no origin and are written as-is.
   */
  readonly origin?: CellCoord;
}

export interface PasteTarget {
  readonly selection: CellRange;
  readonly rowCount: number;
  readonly colCount: number;
  /** Hard limits; cells beyond them are dropped and `clipped` is set. */
  readonly maxRows?: number;
  readonly maxCols?: number;
}

export interface PastePlan {
  /** Destination rectangle actually written. */
  readonly range: CellRange;
  /** Values for `range`, row-major, formulas already adjusted. */
  readonly values: CellMatrix;
  readonly tiled: boolean;
  /** Rows / columns to append before writing. */
  readonly growRows: number;
  readonly growCols: number;
  readonly clipped: boolean;
}

export function planPaste(
  source: PasteSource,
  target: PasteTarget,
  adjustFormula?: AdjustFormula,
): PastePlan | null {
  const srcRows = source.values.length;
  const srcCols = source.values.reduce((max, row) => Math.max(max, row.length), 0);
  if (srcRows === 0 || srcCols === 0) return null;

  const sel = target.selection;
  const selRows = sel.endRow - sel.startRow + 1;
  const selCols = sel.endCol - sel.startCol + 1;
  const tiled =
    (selRows > srcRows || selCols > srcCols) && selRows % srcRows === 0 && selCols % srcCols === 0;

  let rows = tiled ? selRows : srcRows;
  let cols = tiled ? selCols : srcCols;
  let clipped = false;
  if (target.maxRows !== undefined && sel.startRow + rows > target.maxRows) {
    rows = Math.max(0, target.maxRows - sel.startRow);
    clipped = true;
  }
  if (target.maxCols !== undefined && sel.startCol + cols > target.maxCols) {
    cols = Math.max(0, target.maxCols - sel.startCol);
    clipped = true;
  }
  if (rows === 0 || cols === 0) return null;

  const values: CellMatrix = [];
  for (let r = 0; r < rows; r++) {
    const out: string[] = [];
    const sr = r % srcRows;
    for (let c = 0; c < cols; c++) {
      const sc = c % srcCols;
      let value = source.values[sr][sc] ?? '';
      if (adjustFormula && source.origin && value.startsWith('=')) {
        const dRow = sel.startRow + r - (source.origin.row + sr);
        const dCol = sel.startCol + c - (source.origin.col + sc);
        if (dRow !== 0 || dCol !== 0) value = adjustFormula(value, dRow, dCol);
      }
      out.push(value);
    }
    values.push(out);
  }

  const range: CellRange = {
    startRow: sel.startRow,
    startCol: sel.startCol,
    endRow: sel.startRow + rows - 1,
    endCol: sel.startCol + cols - 1,
  };
  return {
    range,
    values,
    tiled,
    growRows: Math.max(0, range.endRow + 1 - target.rowCount),
    growCols: Math.max(0, range.endCol + 1 - target.colCount),
    clipped,
  };
}
