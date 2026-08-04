/**
 * Owns cell drag-selection so a range can cross frozen/pinned boundaries.
 *
 * RevoGrid's built-in drag is clamped to the section it starts in (see the
 * header comment in crossSectionSelection.ts), so we track the pointer
 * ourselves in absolute sheet coordinates and paint the result across every
 * store the range touches.
 *
 * We deliberately do NOT swallow the initial mousedown: RevoGrid still needs it
 * to move focus and to start cell editing. We only take over once the pointer
 * actually moves, and we repaint after RevoGrid has painted its own (clamped)
 * range, so ours wins.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { NormalizedSelectionRange } from '../types';
import {
  cellFromPoint,
  nearestCellFromPoint,
  paintCrossSectionRange,
  resolveGridSections,
  type GridSections,
  type SectionAwareGrid,
} from './crossSectionSelection';

/** Pointer travel before we treat a press as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 3;

interface DragState {
  anchor: { row: number; col: number };
  anchorPoint: { clientX: number; clientY: number };
  last: { row: number; col: number };
  sections: GridSections;
  active: boolean;
}

export interface UseCellDragSelectionOptions {
  containerRef: RefObject<HTMLElement | null>;
  gridRef: RefObject<SectionAwareGrid | null>;
  /**
   * Must be false until the grid is actually mounted. The editor renders a
   * loading tree first, so binding on mount would attach to nothing and never
   * retry -- `enabled` flipping is what re-runs the listener effect.
   */
  enabled: boolean;
  /** Called with the logical selection as the drag progresses. */
  onSelectionChange: (
    cell: { row: number; col: number } | null,
    range: NormalizedSelectionRange | null
  ) => void;
  /**
   * Set while our drag owns the selection, so the grid's own `setrange` events
   * (which carry the clamped, single-section range) can be ignored.
   */
  suppressGridRangeRef: RefObject<boolean>;
}

function normalize(
  a: { row: number; col: number },
  b: { row: number; col: number }
): NormalizedSelectionRange {
  return {
    startRow: Math.min(a.row, b.row),
    startCol: Math.min(a.col, b.col),
    endRow: Math.max(a.row, b.row),
    endCol: Math.max(a.col, b.col),
  };
}

export function useCellDragSelection({
  containerRef,
  gridRef,
  enabled,
  onSelectionChange,
  suppressGridRangeRef,
}: UseCellDragSelectionOptions): void {
  const dragRef = useRef<DragState | null>(null);

  const applyRange = useCallback(
    (range: NormalizedSelectionRange, sections: GridSections) => {
      const grid = gridRef.current;
      if (!grid) return;
      void paintCrossSectionRange(grid, sections, range);
      onSelectionChange({ row: range.startRow, col: range.startCol }, range);
    },
    [gridRef, onSelectionChange]
  );

  /**
   * Extend the current selection to a cell without moving the anchor -- used by
   * shift+click as well as by drag.
   */
  const extendTo = useCallback(
    (target: { row: number; col: number }) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (target.row === drag.last.row && target.col === drag.last.col) return;
      drag.last = target;
      applyRange(normalize(drag.anchor, target), drag.sections);
    },
    [applyRange]
  );

  const handlePointerDown = useCallback(
    async (event: PointerEvent) => {
      if (!enabled || event.button !== 0) return;

      const target = event.target as HTMLElement | null;
      if (!target) return;
      // Header and row-gutter presses belong to the existing header-drag path.
      if (target.closest('revogr-header') || target.closest('.rowHeaders')) return;

      const grid = gridRef.current;
      if (!grid) return;

      const sections = await resolveGridSections(grid);
      if (!sections) return;

      const cell = cellFromPoint(sections, event.clientX, event.clientY);
      if (!cell) return;

      const shiftExtend = event.shiftKey && dragRef.current;
      const anchor = shiftExtend ? dragRef.current!.anchor : cell;

      dragRef.current = {
        anchor,
        anchorPoint: { clientX: event.clientX, clientY: event.clientY },
        last: cell,
        sections,
        // Shift+click is a completed gesture, not a pending drag.
        active: !!shiftExtend,
      };

      if (shiftExtend) {
        suppressGridRangeRef.current = true;
        applyRange(normalize(anchor, cell), sections);
      }
    },
    [enabled, gridRef, applyRange, suppressGridRangeRef]
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // No button held: this is a hover, not a drag.
      if (event.buttons === 0) return;

      if (!drag.active) {
        const dx = Math.abs(event.clientX - drag.anchorPoint.clientX);
        const dy = Math.abs(event.clientY - drag.anchorPoint.clientY);
        if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX) return;
        drag.active = true;
        suppressGridRangeRef.current = true;
      }

      const target = nearestCellFromPoint(
        drag.sections,
        { clientX: event.clientX, clientY: event.clientY },
        drag.anchorPoint,
        drag.last
      );
      extendTo(target);
    },
    [extendTo, suppressGridRangeRef]
  );

  const handlePointerUp = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    // Keep the anchor for a subsequent shift+click, but stop tracking motion.
    drag.active = false;
    // Release on the next tick so the grid's own mouseup-driven setrange (which
    // carries the clamped range) is still ignored.
    setTimeout(() => {
      suppressGridRangeRef.current = false;
    }, 0);
  }, [suppressGridRangeRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;

    container.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);

    return () => {
      container.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };
  }, [containerRef, enabled, handlePointerDown, handlePointerMove, handlePointerUp]);
}
