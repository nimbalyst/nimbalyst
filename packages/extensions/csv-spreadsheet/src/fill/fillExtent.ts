/**
 * Double-click on the fill handle: how far down to fill.
 *
 * As in Sheets, the fill runs as far as the neighboring column's data does:
 * the column to the left of the selection, or to the right when the left one
 * has nothing directly below the selection. It stops above the first row where
 * any filled column already holds a value, so a double-click never overwrites.
 */

import type { NormalizedSelectionRange } from '../types';
import { cellAt, type SheetState } from '../commands/sheetState';

/** The last row to fill down to, or null when there is nothing to fill. */
export function fillDownEndRow(state: SheetState, source: NormalizedSelectionRange): number | null {
  const below = source.endRow + 1;
  const hasValue = (row: number, col: number) => col >= 0 && cellAt(state, row, col) !== '';
  const neighbor = [source.startCol - 1, source.endCol + 1].find((col) => hasValue(below, col));
  if (neighbor === undefined) return null;

  let end = source.endRow;
  for (let row = below; row < state.rows.length && hasValue(row, neighbor); row += 1) {
    let occupied = false;
    for (let col = source.startCol; col <= source.endCol && !occupied; col += 1) occupied = hasValue(row, col);
    if (occupied) break;
    end = row;
  }
  return end > source.endRow ? end : null;
}
