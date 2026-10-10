/**
 * Data validation interactions on the grid: clicking a dropdown chip (or
 * Alt+Down on a dropdown cell) opens its option list; clicking a checkbox or
 * pressing Space on checkbox cells toggles them; a reject-mode refusal shows
 * its message at the cell. Every write is a `setCells` command.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ListOption } from '../validation/types';
import { findValidationRule } from '../validation/validate';
import { toggleCheckboxes, type Rejection } from '../validation/entry';
import { CHECKBOX_CELL_ATTRIBUTE, LIST_CELL_ATTRIBUTE } from '../cells/cellRendering';
import { columnIndexToLetter } from '../utils/csvParser';
import { findCellElement } from './cellElement';
import type { EditorCore } from './editorCore';

export interface DropdownState {
  row: number;
  col: number;
  rect: DOMRect;
  options: readonly ListOption[];
  value: string;
}

export function useValidationUi(core: EditorCore, enabled: boolean) {
  const [dropdown, setDropdown] = useState<DropdownState | null>(null);
  const [rejection, setRejection] = useState<(Rejection & { rect: DOMRect }) | null>(null);

  const rawAt = useCallback(async (row: number, col: number) => (
    (await core.gridOpsRef.current?.getCellRawValue(row, col)) ?? ''
  ), [core]);

  const openDropdown = useCallback(async (row: number, col: number) => {
    const rule = findValidationRule(core.spreadsheetMetaRef.current.getMetadata().validation, row, col)?.rule;
    const element = findCellElement(core, row, col);
    if (rule?.kind !== 'list' || !element || core.editingLockedRef.current) return false;
    setDropdown({ row, col, rect: element.getBoundingClientRect(), options: rule.options, value: (await rawAt(row, col)).trim() });
    return true;
  }, [core, rawAt]);

  const toggleCells = useCallback(async (cells: { row: number; col: number }[]) => {
    const gridOps = core.gridOpsRef.current;
    if (!gridOps || core.editingLockedRef.current) return false;
    const rules = core.spreadsheetMetaRef.current.getMetadata().validation;
    const withValues = await Promise.all(cells.map(async (cell) => ({ ...cell, value: await rawAt(cell.row, cell.col) })));
    const writes = toggleCheckboxes(rules, withValues);
    if (writes.length === 0) return false;
    await gridOps.executor.execute({ type: 'setCells', cells: writes });
    return true;
  }, [core, rawAt]);

  useEffect(() => {
    core.reportRejectionRef.current = (next) => {
      const element = findCellElement(core, next.row, next.col);
      const rect = element?.getBoundingClientRect() ?? core.gridContainerRef.current?.getBoundingClientRect();
      if (rect) setRejection({ ...next, rect });
    };
    return () => { core.reportRejectionRef.current = null; };
  }, [core]);

  useEffect(() => {
    const container = core.gridContainerRef.current;
    const root = core.editorRef.current;
    if (!enabled || !container || !root) return;

    const cellOf = (target: HTMLElement) => {
      const cell = target.closest('[data-rgrow][data-rgcol]') as HTMLElement | null;
      return cell && !cell.closest('.rowHeaders') ? cell : null;
    };

    // Clicks land after RevoGrid's mousedown has selected the cell, so the
    // selection refs already name it.
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const chip = target.closest(`[${LIST_CELL_ATTRIBUTE}]`);
      const box = target.closest(`[${CHECKBOX_CELL_ATTRIBUTE}]`);
      if (!chip && !box) return;
      if (!cellOf(target)) return;
      const cell = core.selectedCellRef.current;
      if (!cell) return;
      if (chip) void openDropdown(cell.row, cell.col);
      else void toggleCells([cell]);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || core.keyStateRef.current.mode !== 'none') return;
      const cell = core.selectedCellRef.current;
      if (!cell) return;
      const rules = core.spreadsheetMetaRef.current.getMetadata().validation;
      const rule = findValidationRule(rules, cell.row, cell.col)?.rule;
      if (event.key === 'ArrowDown' && event.altKey && rule?.kind === 'list') {
        event.preventDefault();
        event.stopPropagation();
        void openDropdown(cell.row, cell.col);
        return;
      }
      if (event.key === ' ' && !event.metaKey && !event.ctrlKey && !event.altKey && rule?.kind === 'checkbox') {
        event.preventDefault();
        event.stopPropagation();
        const range = core.selectionRangeRef.current ?? { startRow: cell.row, endRow: cell.row, startCol: cell.col, endCol: cell.col };
        const rows = core.rowSpaceRef.current.expandLogicalRange(range.startRow, range.endRow).logicalRows;
        const cells = rows.flatMap((row) => Array.from({ length: range.endCol - range.startCol + 1 }, (_, i) => ({ row, col: range.startCol + i })));
        void toggleCells(cells.length > 0 ? cells : [cell]);
      }
    };

    container.addEventListener('click', onClick);
    // On the editor root in the capture phase, so this runs before the grid
    // key controller (which would start an edit with the typed space).
    root.addEventListener('keydown', onKeyDown, true);
    return () => {
      container.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeyDown, true);
    };
  }, [enabled, core, openDropdown, toggleCells]);

  const pick = useCallback((value: string) => {
    const current = dropdown;
    setDropdown(null);
    if (!current || core.editingLockedRef.current) return;
    void core.gridOpsRef.current?.executor.execute({ type: 'setCells', cells: [{ row: current.row, col: current.col, value }] });
    core.gridContainerRef.current?.focus({ preventScroll: true });
  }, [dropdown, core]);

  return {
    dropdown,
    closeDropdown: useCallback(() => setDropdown(null), []),
    pick,
    rejection,
    closeRejection: useCallback(() => setRejection(null), []),
    /** For the e2e/devtools hook: the A1 name of the open dropdown's cell. */
    dropdownCell: dropdown ? `${columnIndexToLetter(dropdown.col)}${dropdown.row + 1}` : null,
  };
}

export type ValidationUi = ReturnType<typeof useValidationUi>;
