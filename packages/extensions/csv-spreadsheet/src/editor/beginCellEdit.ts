/**
 * Open the cell editor at the active cell with `text` in it, the way typing
 * does (the key controller's `beginEdit` effect): the text goes through
 * `pendingEditTextRef`, which the next editor starts with, and the edit
 * session is bumped so a stale editor cannot claim it.
 */

import { columnIndexToLetter } from '../utils/csvParser';
import type { EditorCore } from './editorCore';

export function beginCellEdit(core: EditorCore, toVisibleRow: (logical: number) => number, text: string): boolean {
  const cell = core.selectedCellRef.current;
  const grid = core.revoGridRef.current;
  if (!cell || !grid || core.editingLockedRef.current) return false;
  core.editSessionRef.current += 1;
  core.pendingEditTextRef.current = text;
  core.openingEditSessionRef.current = core.editSessionRef.current;
  core.keyStateRef.current = { ...core.keyStateRef.current, mode: 'enter' };
  const pinned = grid.pinnedTopSource?.length ?? core.spreadsheetMetaRef.current.getMetadata().headerRowCount;
  const visible = toVisibleRow(cell.row);
  void grid.setCellEdit(
    visible < pinned ? visible : visible - pinned,
    columnIndexToLetter(cell.col),
    visible < pinned ? 'rowPinStart' : 'rgRow',
  );
  return true;
}
