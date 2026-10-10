/**
 * Keep the key controller's state in step with selections made any other way
 * (clicks, drags, find, undo), and move it between the two row spaces.
 *
 * The editor stores selections in logical rows; the controller navigates in
 * visible rows so arrows and data jumps skip rows a filter hides.
 */

import type { CellCoord, CellRange, EditMode, GridKeyState } from './types';

/**
 * Controller state for a selection made outside the controller. The cell is
 * the anchor (where the gesture started, which is where typing goes); the focus
 * is the range corner opposite it. A Tab run never survives a pointer gesture.
 */
export function keyStateFromSelection(cell: CellCoord, range: CellRange | null, mode: EditMode): GridKeyState {
  const r = range ?? { startRow: cell.row, endRow: cell.row, startCol: cell.col, endCol: cell.col };
  const focus = {
    row: cell.row === r.startRow ? r.endRow : r.startRow,
    col: cell.col === r.startCol ? r.endCol : r.startCol,
  };
  return { active: cell, anchor: cell, focus, mode, tabRunStartCol: null };
}

/** The same state with every row passed through `mapRow` (visible <-> logical). */
export function mapKeyStateRows(state: GridKeyState, mapRow: (row: number) => number): GridKeyState {
  const map = (cell: CellCoord) => ({ row: mapRow(cell.row), col: cell.col });
  return { ...state, active: map(state.active), anchor: map(state.anchor), focus: map(state.focus) };
}
