/**
 * Formatting actions bound to the current selection: what the toolbar, the
 * menus and the status bar call. Each one is a metadata command built against
 * the state it applies to (`format/formatActions.ts`), so it is one undo step
 * and publishes to collab like any other edit.
 */

import { useMemo } from 'react';
import type { NormalizedSelectionRange } from '../types';
import type { SheetMeta } from '../commands/sheetState';
import type { EditorCore } from './editorCore';

export type SelectionPatch = (
  meta: SheetMeta,
  range: NormalizedSelectionRange,
  active: { row: number; col: number },
) => Partial<SheetMeta>;

export function useFormatActions(core: EditorCore) {
  return useMemo(() => {
    /**
     * Toolbar and menu clicks keep focus off the grid, and a format that
     * re-renders the focused cell (hiding its column) drops focus to <body>,
     * where Cmd+S and the grid's keys no longer reach the editor. Hand focus
     * back once the command has painted.
     */
    const refocusNow = () => {
      const container = core.gridContainerRef.current;
      if (container && !container.contains(document.activeElement)) container.focus({ preventScroll: true });
    };
    // The command resolves before React re-renders the columns and RevoGrid
    // replaces the cells, which is when a focused cell can disappear.
    const refocus = () => {
      refocusNow();
      requestAnimationFrame(() => requestAnimationFrame(refocusNow));
      setTimeout(refocusNow, 150);
    };
    const target = () => {
      const range = core.selectionRangeRef.current;
      if (!range) return null;
      const active = core.selectedCellRef.current ?? { row: range.startRow, col: range.startCol };
      return { range, active };
    };
    return {
      target,
      /** Apply a selection patch; a no-op without a selection or while editing is locked. */
      apply(patch: SelectionPatch): void {
        const selected = target();
        const gridOps = core.gridOpsRef.current;
        if (!selected || !gridOps || core.editingLockedRef.current) return;
        void gridOps.setMeta((meta) => patch(meta, selected.range, selected.active)).then(refocus);
      },
      /** Apply a patch that does not depend on the selection (freeze, unhide all). */
      applyMeta(patch: (meta: SheetMeta) => Partial<SheetMeta>): void {
        const gridOps = core.gridOpsRef.current;
        if (!gridOps || core.editingLockedRef.current) return;
        void gridOps.setMeta(patch).then(refocus);
      },
    };
  }, [core]);
}

export type FormatActions = ReturnType<typeof useFormatActions>;
