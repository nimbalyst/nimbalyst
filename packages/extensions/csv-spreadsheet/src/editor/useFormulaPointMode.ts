/**
 * Formula point mode controller.
 *
 * Armed when an edit surface -- the formula bar input or the in-cell editor --
 * holds focus and its text starts with `=`. A press on a data cell then asks
 * `beginPointSession` whether the caret is at a point target; if so the press
 * is swallowed (see `useCellDragSelection` point mode) and the picked cell or
 * dragged range is written at the caret. If not, the press is left alone and
 * behaves as it always has (commit and move). The real selection never moves
 * while pointing.
 *
 * It also tracks which surface is active and its text/caret, which drives the
 * reference outlines and the in-cell editor's assist popover, and handles F4
 * in the in-cell editor (the formula bar handles its own).
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { NormalizedSelectionRange } from '../types';
import type { SectionAwareGrid } from '../selection/crossSectionSelection';
import { useCellDragSelection } from '../selection/useCellDragSelection';
import { applyPointPick, beginPointSession, type PointSession } from '../formula/pointMode';
import {
  CELL_EDITOR_SELECTOR,
  cycleAbsoluteIn,
  isFormulaEditElement,
  useEditSnapshot,
  writeEditText,
  type EditSnapshot,
  type FormulaEditElement,
} from '../formula/editSurface';
import type { EditorCore } from './editorCore';
import { pinnedRowCount } from '../sheetMeta/formatting';

export interface FormulaPointMode {
  /** The focused formula surface, or null. */
  surface: FormulaEditElement | null;
  snapshot: EditSnapshot | null;
}

/**
 * A rendered grid cell's logical position, from its `data-rgrow`/`data-rgcol`
 * and the section (`type` / `col-type`) of the `revogr-data` it sits in.
 * Null for the row-number gutter and anything that is not a cell.
 */
export function logicalCellOfElement(
  cell: Element,
  core: Pick<EditorCore, 'rowSpaceRef' | 'spreadsheetMetaRef'>,
): { row: number; col: number } | null {
  const data = cell.closest('revogr-data');
  const colType = data?.getAttribute('col-type');
  if (!data || colType === 'rowHeaders') return null;
  const y = Number(cell.getAttribute('data-rgrow'));
  const x = Number(cell.getAttribute('data-rgcol'));
  if (!Number.isInteger(y) || !Number.isInteger(x)) return null;
  const metadata = core.spreadsheetMetaRef.current.getMetadata();
  const { frozenColumnCount } = metadata;
  // The scrolling section starts after every pinned row: headers and frozen data rows.
  const visibleRow = data.getAttribute('type') === 'rowPinStart' ? y : y + pinnedRowCount(metadata);
  return {
    row: core.rowSpaceRef.current.visibleToLogical(visibleRow) ?? visibleRow,
    col: colType === 'colPinStart' ? x : x + frozenColumnCount,
  };
}

export function useFormulaPointMode(core: EditorCore, enabled: boolean): FormulaPointMode {
  const [surface, setSurface] = useState<FormulaEditElement | null>(null);
  const snapshot = useEditSnapshot(surface);
  const sessionRef = useRef<{ element: FormulaEditElement; session: PointSession } | null>(null);

  // Track the focused surface from the editor root: the in-cell textarea is
  // created by RevoGrid, so delegation is the only hook into it.
  useEffect(() => {
    const root = core.editorRef.current;
    if (!enabled || !root) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Element | null;
      if (isFormulaEditElement(target)) setSurface(target);
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Element | null;
      setSurface((current) => (current === event.target && !isFormulaEditElement(next) ? null : current));
    };
    // F4 in the in-cell editor. Capture on the root runs ahead of the grid key
    // controller, which listens in capture on the grid container.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F4' || event.isComposing) return;
      const target = event.target as Element | null;
      if (!(target instanceof HTMLTextAreaElement) || !target.matches(CELL_EDITOR_SELECTOR)) return;
      if (cycleAbsoluteIn(target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const active = document.activeElement;
    if (root.contains(active) && isFormulaEditElement(active)) setSurface(active);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('keydown', onKeyDown, true);
    return () => {
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('keydown', onKeyDown, true);
      setSurface(null);
    };
  }, [core, enabled]);

  const beginPoint = useCallback((): boolean => {
    sessionRef.current = null;
    const element = document.activeElement;
    if (!isFormulaEditElement(element) || element.readOnly || element.disabled) return false;
    if (core.editingLockedRef.current) return false;
    const session = beginPointSession(element.value, element.selectionStart ?? element.value.length, element.selectionEnd ?? undefined);
    if (!session) return false;
    sessionRef.current = { element, session };
    return true;
  }, [core]);

  // Picks arrive in visible rows; references name logical (A1) rows.
  const onPointPick = useCallback((range: NormalizedSelectionRange) => {
    const current = sessionRef.current;
    if (!current?.element.isConnected) return;
    const rows = core.rowSpaceRef.current;
    const startRow = rows.visibleToLogical(range.startRow) ?? range.startRow;
    const endRow = rows.visibleToLogical(range.endRow) ?? range.endRow;
    writeEditText(current.element, applyPointPick(current.session, { ...range, startRow, endRow }));
  }, [core]);

  useCellDragSelection({
    containerRef: core.gridContainerRef as RefObject<HTMLElement | null>,
    gridRef: core.revoGridRef as RefObject<SectionAwareGrid | null>,
    enabled,
    mode: 'point',
    beginPoint,
    onPointPick,
  });

  return { surface, snapshot };
}
