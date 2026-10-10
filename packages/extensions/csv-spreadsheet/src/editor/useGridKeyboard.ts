/**
 * The grid key controller, in front of RevoGrid.
 *
 * RevoGrid handles keys from a document-level listener. A capture-phase
 * listener on the grid container sees every keystroke aimed at the grid first
 * (including the open cell editor, which renders inside it), asks the pure
 * controller (`keyboard/gridKeyController.ts`) what it means, carries out the
 * effects, and stops the event when the controller owns it so RevoGrid never
 * acts on it too. Keys the controller leaves alone fall through unchanged.
 *
 * The controller works in visible rows (so navigation skips filtered rows); the
 * selection refs are logical. Conversions happen here, at the boundary.
 */

import { useEffect, useRef, useState } from 'react';
import {
  handleGridKey,
  mapKeyStateRows,
  resolveSheetShortcut,
  selectionRange,
  todayIso,
  type CellRange,
  type GridKeyEffect,
  type GridKeyState,
  type GridView,
  type SheetShortcut,
} from '../keyboard';
import { presetFormat, setCellFormat, toggleStyle, type NumberFormatPreset } from '../format/formatActions';
import { columnIndexToLetter } from '../utils/csvParser';
import type { NormalizedSelectionRange } from '../types';
import type { EditorCore } from './editorCore';
import type { RowView } from './useRowView';
import type { Selection } from './useSelection';
import { pinnedRowCount } from '../sheetMeta/formatting';
import { rejectEntry } from './rejectEntry';

const ROW_HEIGHT = 24;
const isMac = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

/** Cmd+Shift+4/5/1 format the selected cells, not their columns, as in Sheets. */
const NUMBER_FORMATS: Partial<Record<SheetShortcut, NumberFormatPreset>> = {
  formatCurrency: 'currency',
  formatPercent: 'percent',
  formatNumber: 'number',
};
const TEXT_STYLES: Partial<Record<SheetShortcut, 'bold' | 'italic' | 'underline'>> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
};

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
}

export function useGridKeyboard(
  core: EditorCore,
  rowView: Pick<RowView, 'toVisibleRow' | 'toLogicalRow'>,
  selection: Pick<Selection, 'selectFromKeyboard' | 'selectAll'>,
  { enabled, displayColumnCount }: {
    /** The tab is active and the grid is rendered (the loading tree has no container). */
    enabled: boolean;
    displayColumnCount: number;
  },
) {
  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false);
  /** The cell the Cmd+K link dialog is open on. */
  const [linkTarget, setLinkTarget] = useState<{ row: number; col: number } | null>(null);
  /** Set by Cmd+Shift+V; the paste event that follows reads it. */
  const pasteValuesOnlyRef = useRef(false);
  const latest = useRef({ rowView, selection, displayColumnCount });
  latest.current = { rowView, selection, displayColumnCount };

  useEffect(() => {
    const container = core.gridContainerRef.current;
    if (!enabled || !container) return;
    const platform = { isMac: isMac() };

    const modelAt = (logicalRow: number): Record<string, unknown> | undefined => {
      const grid = core.revoGridRef.current as unknown as { source?: Record<string, unknown>[]; pinnedTopSource?: Record<string, unknown>[] } | null;
      const pinned = grid?.pinnedTopSource ?? [];
      return logicalRow < pinned.length ? pinned[logicalRow] : grid?.source?.[logicalRow - pinned.length];
    };

    const buildView = (): GridView => {
      const { toLogicalRow } = latest.current.rowView;
      const mapping = core.rowSpaceRef.current;
      const meta = core.spreadsheetMetaRef.current.getMetadata();
      const isEmpty = (row: number, col: number) => {
        const value = modelAt(toLogicalRow(row))?.[columnIndexToLetter(col)];
        return value === undefined || value === null || value === '';
      };
      return {
        rowCount: Math.max(1, mapping.logicalRows.length),
        colCount: latest.current.displayColumnCount,
        headerRowCount: pinnedRowCount(meta),
        isColHidden: (col) => meta.hiddenCols.includes(col),
        frozenColCount: meta.frozenColumnCount,
        pageRows: Math.max(1, Math.floor(container.clientHeight / (ROW_HEIGHT * core.zoomRef.current)) - pinnedRowCount(meta) - 2),
        isEmpty,
        lastDataCell: () => {
          let lastRow = 0;
          let lastCol = 0;
          mapping.logicalRows.forEach((logical, visible) => {
            const model = modelAt(logical);
            if (!model) return;
            for (let col = 0; col < meta.columnCount; col += 1) {
              const value = model[columnIndexToLetter(col)];
              if (value !== undefined && value !== null && value !== '') {
                lastRow = visible;
                lastCol = Math.max(lastCol, col);
              }
            }
          });
          return { row: lastRow, col: lastCol };
        },
      };
    };

    const toLogicalRange = (range: CellRange): NormalizedSelectionRange => {
      const { toLogicalRow } = latest.current.rowView;
      return { startRow: toLogicalRow(range.startRow), endRow: toLogicalRow(range.endRow), startCol: range.startCol, endCol: range.endCol };
    };

    // The open editor, if it belongs to the edit in progress. RevoGrid can build
    // the editor for an edit the keyboard already committed past (a fast typed
    // run); that one starts from the cell's old value, so committing it would
    // write the old value back and the typed text would go nowhere.
    const currentEditor = () => {
      const editor = core.activeEditorRef.current;
      return editor && (editor.editSession === null || editor.editSession === core.editSessionRef.current) ? editor : null;
    };

    const runShortcut = (shortcut: SheetShortcut, editing: boolean): boolean => {
      const gridOps = core.gridOpsRef.current;
      const range = core.selectionRangeRef.current;
      const locked = core.editingLockedRef.current;
      if (shortcut === 'pasteValues') {
        pasteValuesOnlyRef.current = true;
        setTimeout(() => { pasteValuesOnlyRef.current = false; }, 1000);
        return false;
      }
      if (shortcut === 'showShortcuts') {
        setShortcutSheetOpen(true);
        return true;
      }
      // In the cell editor, history belongs to the text field.
      if (shortcut === 'undo' || shortcut === 'redo') {
        if (editing) return false;
        if (!locked) void (shortcut === 'undo' ? gridOps?.executor.undo() : gridOps?.executor.redo());
        return true;
      }
      if (shortcut === 'insertLink') {
        const cell = core.selectedCellRef.current;
        if (editing) return false;
        if (cell && !locked) setLinkTarget({ row: cell.row, col: cell.col });
        return true;
      }
      if (shortcut === 'insertDate') {
        const cell = core.selectedCellRef.current;
        if (locked) return true;
        if (editing) currentEditor()?.insertText(todayIso());
        else if (cell) void gridOps?.executor.execute({ type: 'setCells', cells: [{ row: cell.row, col: cell.col, value: todayIso() }] });
        return true;
      }
      if (!gridOps || !range || locked) return true;
      const style = TEXT_STYLES[shortcut];
      if (style) {
        const active = core.selectedCellRef.current ?? { row: range.startRow, col: range.startCol };
        void gridOps.setMeta((meta) => toggleStyle(meta, range, active, style));
        return true;
      }
      const preset = NUMBER_FORMATS[shortcut];
      if (preset) void gridOps.setMeta((meta) => setCellFormat(meta, range, presetFormat(preset)));
      return true;
    };

    // Closing the cell editor removes the focused textarea and focus falls to
    // <body>, where the next keystroke would never reach this listener.
    const refocusGrid = () => setTimeout(() => {
      if (!container.contains(document.activeElement)) container.focus({ preventScroll: true });
    }, 0);

    const runEffect = (effect: GridKeyEffect, state: GridKeyState, previous: GridKeyState) => {
      const gridOps = core.gridOpsRef.current;
      const editor = currentEditor();
      const locked = core.editingLockedRef.current;
      if (['beginEdit', 'commitEdit', 'cancelEdit', 'fillSelection'].includes(effect.type)) {
        core.editSessionRef.current += 1;
      }
      switch (effect.type) {
        case 'commitEdit': {
          const pending = core.pendingEditTextRef.current;
          core.pendingEditTextRef.current = null;
          if (editor) {
            editor.commit(true);
            refocusGrid();
          } else if (pending !== null && !locked) {
            // Committed before the editor even mounted: write what was typed.
            const row = latest.current.rowView.toLogicalRow(previous.active.row);
            const cells = [{ row, col: previous.active.col, value: pending }];
            if (!rejectEntry(core, cells)) void gridOps?.executor.execute({ type: 'setCells', cells });
          }
          return;
        }
        case 'cancelEdit': editor?.cancel(); refocusGrid(); return;
        case 'insertNewline': editor?.insertText('\n'); return;
        case 'beginEdit': {
          // Open the editor at the controller's active cell ourselves rather
          // than letting RevoGrid open it at its own focus, which lags a key
          // behind right after a commit moved the selection. Typing starts it
          // with the typed text; F2/Enter on the existing value.
          if (locked) return;
          core.pendingEditTextRef.current = effect.initialText ?? null;
          core.openingEditSessionRef.current = core.editSessionRef.current;
          const grid = core.revoGridRef.current;
          const headerRowCount = grid?.pinnedTopSource?.length ?? pinnedRowCount(core.spreadsheetMetaRef.current.getMetadata());
          const visible = state.active.row;
          void grid?.setCellEdit(
            visible < headerRowCount ? visible : visible - headerRowCount,
            columnIndexToLetter(state.active.col),
            visible < headerRowCount ? 'rowPinStart' : 'rgRow',
          );
          return;
        }
        case 'fillSelection': {
          const value = editor?.getValue() ?? '';
          editor?.cancel();
          refocusGrid();
          const origin = { row: latest.current.rowView.toLogicalRow(state.active.row), col: state.active.col };
          if (!locked) void gridOps?.fillValue(toLogicalRange(effect.range), value, origin);
          return;
        }
        case 'clearRange': if (!locked) void gridOps?.clearCells(toLogicalRange(effect.range)); return;
        case 'fillDown': if (!locked) void gridOps?.fillCopy(toLogicalRange(effect.range), 'down'); return;
        case 'fillRight': if (!locked) void gridOps?.fillCopy(toLogicalRange(effect.range), 'right'); return;
        case 'scrollIntoView': return; // selectFromKeyboard scrolls.
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      const { toVisibleRow, toLogicalRow } = latest.current.rowView;
      const logicalState = core.keyStateRef.current;
      const editing = logicalState.mode !== 'none' || (!!core.activeEditorRef.current && isTextField(event.target));

      // Keys typed while the editor is opening belong to it, not to whichever
      // element still has focus.
      const printable = event.key.length === 1 && !event.metaKey && !event.ctrlKey;
      if (logicalState.mode === 'enter' && printable) {
        const editor = currentEditor();
        if (!editor) {
          core.pendingEditTextRef.current = (core.pendingEditTextRef.current ?? '') + event.key;
        } else if (document.activeElement !== editor.editInput) {
          editor.insertText(event.key);
        } else {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const shortcut = resolveSheetShortcut(event, platform);
      if (shortcut) {
        if (runShortcut(shortcut, editing)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      const primary = platform.isMac ? event.metaKey : event.ctrlKey;
      if (primary && !event.altKey && ['c', 'x', 'v'].includes(event.key.toLowerCase())) {
        // Let the native copy/cut/paste event happen; keep RevoGrid's own
        // clipboard handling (and its internal paste) out of it.
        if (!editing) event.stopPropagation();
        return;
      }

      const state = mapKeyStateRows({ ...logicalState, mode: editing ? (logicalState.mode === 'none' ? 'edit' : logicalState.mode) : 'none' }, toVisibleRow);
      const result = handleGridKey(state, event, buildView(), platform);
      if (!result.handled) return;

      const typing = result.effects.some((effect) => effect.type === 'beginEdit' && effect.initialText !== undefined);
      if (typing && core.editingLockedRef.current) return;
      event.preventDefault();
      event.stopPropagation();

      if (primary && event.key.toLowerCase() === 'a') {
        latest.current.selection.selectAll();
        return;
      }
      for (const effect of result.effects) runEffect(effect, result.state, state);
      const next = mapKeyStateRows(result.state, toLogicalRow);
      const moved = JSON.stringify(selectionRange(next)) !== JSON.stringify(selectionRange(logicalState))
        || next.active.row !== logicalState.active.row || next.active.col !== logicalState.active.col;
      if (!moved) {
        core.keyStateRef.current = next;
        return;
      }
      // A commit closes the editor first; focus can only move once it has.
      // Show the state as it is when the timer fires, not `next`: a fast typed
      // run may have opened the next edit by then, and writing `next` back
      // would drop its mode to 'none' so the Enter that follows navigates
      // instead of committing what was typed.
      const committing = result.effects.some((effect) => effect.type === 'commitEdit');
      if (committing) {
        core.keyStateRef.current = next;
        setTimeout(() => latest.current.selection.selectFromKeyboard(core.keyStateRef.current), 0);
      } else {
        latest.current.selection.selectFromKeyboard(next);
      }
    };

    // RevoGrid selects on mousedown without moving DOM focus, so a click on a
    // cell while another panel (the chat input) has focus left every following
    // keystroke going there. A pointer press in the grid takes keyboard focus.
    const onPointerDown = () => {
      if (!container.contains(document.activeElement)) {
        setTimeout(() => {
          if (!container.contains(document.activeElement)) container.focus({ preventScroll: true });
        }, 0);
      }
    };

    container.addEventListener('keydown', onKeyDown, true);
    container.addEventListener('mousedown', onPointerDown, true);
    return () => {
      container.removeEventListener('keydown', onKeyDown, true);
      container.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [enabled, core]);

  return { shortcutSheetOpen, setShortcutSheetOpen, linkTarget, setLinkTarget, pasteValuesOnlyRef };
}
