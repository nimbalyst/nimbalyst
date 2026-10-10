/**
 * Writes that start in the grid itself or the formula bar.
 *
 * RevoGrid would apply a committed cell edit, a range edit (its own paste or
 * multi-cell clear) and a fill-handle drag to its store directly. Each of those
 * `before*` events is cancelable, so the grid's write is cancelled and the same
 * change runs as a command instead: one undo step, formulas recalculated,
 * published to collaborators. The fill handle continues series (`fillSeries`)
 * rather than repeating values; double-clicking it fills down (`fillDown`).
 *
 * Event coordinates are section-local: rows are visible rows within the pinned
 * or body section, columns are within the frozen or scrolling section.
 */

import { useCallback, useEffect } from 'react';
import type { RevoGridCustomEvent, ColumnRegular } from '@revolist/react-datagrid';
import type { LocalPresenceTracker } from '../collab/localPresence';
import type { CellWrite } from '../commands/sheetState';
import type { NormalizedSelectionRange } from '../types';
import { columnLetterToIndex } from '../utils/csvParser';
import type { EditorCore } from './editorCore';
import type { RowView } from './useRowView';
import type { Selection } from './useSelection';
import { rejectEntry } from './rejectEntry';

interface SectionRange {
  x: number;
  y: number;
  x1: number;
  y1: number;
}

export function useGridEditEvents(
  core: EditorCore,
  { translateRowIndex }: Pick<RowView, 'translateRowIndex'>,
  { updateSelection, publishSelectionContext }: Pick<Selection, 'updateSelection' | 'publishSelectionContext'>,
  { localPresence, schedulePresenceRepaint }: {
    localPresence: LocalPresenceTracker;
    schedulePresenceRepaint: () => void;
  },
  enabled: boolean,
) {
  const { collabBindingRef, gridOpsRef, selectedCellRef, selectionRangeRef, collabActiveRef, editingLockedRef } = core;

  const refreshSelection = useCallback(() => {
    void updateSelection(selectedCellRef.current, selectionRangeRef.current, false);
  }, [updateSelection]);

  const toLogicalRange = useCallback((range: SectionRange, rowType: unknown, colType: unknown): NormalizedSelectionRange => {
    const pinned = rowType === 'rowPinStart';
    const offset = colType === 'colPinStart' ? 0 : core.spreadsheetMetaRef.current.getMetadata().frozenColumnCount;
    return {
      startRow: translateRowIndex(Math.min(range.y, range.y1), pinned),
      endRow: translateRowIndex(Math.max(range.y, range.y1), pinned),
      startCol: Math.min(range.x, range.x1) + offset,
      endCol: Math.max(range.x, range.x1) + offset,
    };
  }, [translateRowIndex]);

  // A committed cell edit. `prop` is the sheet-wide column letter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleBeforeEdit = useCallback((event: RevoGridCustomEvent<any>) => {
    event.preventDefault();
    const detail = event.detail;
    const gridOps = gridOpsRef.current;
    if (!detail || !gridOps || editingLockedRef.current) return;
    const row = translateRowIndex(detail.rowIndex, detail.type === 'rowPinStart');
    const col = columnLetterToIndex(String(detail.prop));
    const value = String(detail.val ?? '');
    if (rejectEntry(core, [{ row, col, value }])) return;
    void gridOps.executor
      .execute({ type: 'setCells', cells: [{ row, col, value }] })
      .then(refreshSelection)
      .catch((error) => console.error('[CSV] Failed to apply cell edit:', error));
    // Edit committed: keep the selection box, drop the editing flag. The
    // editor's own disconnect covers the closes that never commit.
    const patch = localPresence.endEdit();
    if (patch) collabBindingRef.current?.setLocalAwareness(patch);
  }, [translateRowIndex, refreshSelection, localPresence]);

  // RevoGrid's own range writes (its paste path, a multi-cell clear).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleBeforeRangeEdit = useCallback((event: RevoGridCustomEvent<any>) => {
    event.preventDefault();
    const detail = event.detail;
    const gridOps = gridOpsRef.current;
    if (!detail?.data || !gridOps || editingLockedRef.current) return;
    const pinned = detail.type === 'rowPinStart';
    const cells: CellWrite[] = [];
    for (const [rowIndex, values] of Object.entries(detail.data as Record<string, Record<string, unknown>>)) {
      const row = translateRowIndex(Number(rowIndex), pinned);
      for (const [prop, value] of Object.entries(values)) {
        if (/^[A-Z]+$/.test(prop)) cells.push({ row, col: columnLetterToIndex(prop), value: String(value ?? '') });
      }
    }
    void gridOps.executor.execute({ type: 'setCells', cells }).then(refreshSelection);
  }, [translateRowIndex, refreshSelection]);

  // The fill handle: series instead of RevoGrid's repeat.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleBeforeAutofill = useCallback((event: RevoGridCustomEvent<any>) => {
    event.preventDefault();
    const detail = event.detail;
    const gridOps = gridOpsRef.current;
    if (!detail?.newRange || !detail.oldRange || !gridOps || editingLockedRef.current) return;
    const source = toLogicalRange(detail.oldRange, detail.type, detail.colType);
    const target = toLogicalRange(detail.newRange, detail.type, detail.colType);
    void gridOps.fillSeries(source, target).then(refreshSelection);
  }, [toLogicalRange, refreshSelection]);

  // Double-click on the fill handle: fill down as far as the neighboring
  // column has data. Captured so RevoGrid does not open an editor under it.
  useEffect(() => {
    const container = core.gridContainerRef.current;
    if (!enabled || !container) return;
    const onDoubleClick = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest?.('.autofill-handle')) return;
      event.preventDefault();
      event.stopPropagation();
      const gridOps = gridOpsRef.current;
      const cell = selectedCellRef.current;
      const source = selectionRangeRef.current
        ?? (cell ? { startRow: cell.row, endRow: cell.row, startCol: cell.col, endCol: cell.col } : null);
      if (!gridOps || !source || editingLockedRef.current) return;
      void gridOps.fillDown(source).then(refreshSelection);
    };
    container.addEventListener('dblclick', onDoubleClick, true);
    return () => container.removeEventListener('dblclick', onDoubleClick, true);
  }, [enabled, core, refreshSelection]);

  // Edit start: a double-click opens edit mode (arrows move the caret), and
  // collaborators see an "editing" indicator on the selected cell.
  const handleBeforeEditStart = useCallback(() => {
    const keyState = core.keyStateRef.current;
    if (keyState.mode === 'none') core.keyStateRef.current = { ...keyState, mode: 'edit' };
    if (!collabActiveRef.current) return;
    const { patch } = localPresence.beginEdit(selectedCellRef.current ?? null);
    collabBindingRef.current?.setLocalAwareness(patch);
  }, [localPresence]);

  // Column resize: the grid already shows the new width; the command persists
  // it and makes it undoable.
  const handleColumnResize = useCallback(
    (event: RevoGridCustomEvent<{ [index: number]: ColumnRegular }>) => {
      if (!event.detail) return;
      const resized: Record<number, number> = {};
      for (const [indexStr, column] of Object.entries(event.detail)) {
        const columnIndex = parseInt(indexStr, 10);
        // Stored unzoomed, so a width set at 150% is the same column at 100%.
        if (!isNaN(columnIndex) && column.size !== undefined) resized[columnIndex] = Math.round(column.size / core.zoomRef.current);
      }
      void gridOpsRef.current?.setMeta((meta) => ({ columnWidths: { ...meta.columnWidths, ...resized } }));
      // Column geometry changed -- presence markers must re-measure.
      schedulePresenceRepaint();
    },
    [schedulePresenceRepaint]
  );

  // Formula bar input
  const handleFormulaChange = useCallback(
    async (value: string) => {
      if (editingLockedRef.current) return;
      const cell = selectedCellRef.current;
      const gridOps = gridOpsRef.current;
      if (cell && gridOps) {
        if (rejectEntry(core, [{ row: cell.row, col: cell.col, value }])) return;
        await gridOps.executor.execute({ type: 'setCells', cells: [{ row: cell.row, col: cell.col, value }] });
        void publishSelectionContext(selectionRangeRef.current);
      }
    },
    [publishSelectionContext]
  );

  return {
    handleBeforeEdit,
    handleBeforeRangeEdit,
    handleBeforeAutofill,
    handleBeforeEditStart,
    handleColumnResize,
    handleFormulaChange,
  };
}
