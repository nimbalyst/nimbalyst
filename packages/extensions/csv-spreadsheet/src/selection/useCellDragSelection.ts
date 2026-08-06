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
import {
  autoScrollDelta,
  clampPointToBounds,
  measureCellArea,
  scrollGridBy,
  type Bounds,
  type Point,
} from './autoScroll';

/** Pointer travel before we treat a press as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 3;

interface DragState {
  anchor: { row: number; col: number };
  anchorPoint: Point;
  last: { row: number; col: number };
  sections: GridSections;
  /**
   * The visible cell region, measured once at drag start. Fixed geometry for
   * the life of the drag -- scrolling moves the cells through it, not it.
   */
  bounds: Bounds | null;
  /** Latest pointer position, so the autoscroll loop can re-probe it. */
  point: Point;
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
  const autoScrollFrameRef = useRef<number | null>(null);

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

  /**
   * Extend the selection to whatever cell the current pointer position names.
   * A pointer outside the cell area is pulled back onto the nearest edge first,
   * so an overshooting drag selects the last visible row/column instead of
   * stalling -- and, once the autoscroll loop starts moving the grid under it,
   * keeps picking up rows and columns as they come into view.
   */
  const extendToPointer = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    const probe = drag.bounds ? clampPointToBounds(drag.point, drag.bounds) : drag.point;
    extendTo(nearestCellFromPoint(drag.sections, probe, drag.anchorPoint, drag.last));
  }, [extendTo]);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current === null) return;
    cancelAnimationFrame(autoScrollFrameRef.current);
    autoScrollFrameRef.current = null;
  }, []);

  /**
   * One autoscroll frame: extend to where the pointer now points (the grid has
   * moved since the last frame), then scroll further if it is still outside.
   * Extending before scrolling gives RevoGrid a frame to render the rows the
   * previous scroll brought in.
   */
  const autoScrollStep = useCallback(() => {
    autoScrollFrameRef.current = null;

    const drag = dragRef.current;
    const grid = gridRef.current;
    if (!drag || !drag.active || !drag.bounds || !grid) return;

    const delta = autoScrollDelta(drag.point, drag.bounds);
    if (delta.x === 0 && delta.y === 0) return;

    extendToPointer();
    scrollGridBy(grid, delta);
    autoScrollFrameRef.current = requestAnimationFrame(autoScrollStep);
  }, [gridRef, extendToPointer]);

  const startAutoScroll = useCallback(() => {
    const drag = dragRef.current;
    if (!drag?.bounds || autoScrollFrameRef.current !== null) return;
    const delta = autoScrollDelta(drag.point, drag.bounds);
    if (delta.x === 0 && delta.y === 0) return;
    autoScrollFrameRef.current = requestAnimationFrame(autoScrollStep);
  }, [autoScrollStep]);

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
      const point = { clientX: event.clientX, clientY: event.clientY };

      dragRef.current = {
        anchor,
        anchorPoint: point,
        last: cell,
        sections,
        bounds: measureCellArea(grid),
        point,
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

      drag.point = { clientX: event.clientX, clientY: event.clientY };
      extendToPointer();
      startAutoScroll();
    },
    [extendToPointer, startAutoScroll, suppressGridRangeRef]
  );

  const handlePointerUp = useCallback(() => {
    stopAutoScroll();
    const drag = dragRef.current;
    if (!drag) return;
    // Keep the anchor for a subsequent shift+click, but stop tracking motion.
    drag.active = false;
    // Release on the next tick so the grid's own mouseup-driven setrange (which
    // carries the clamped range) is still ignored.
    setTimeout(() => {
      suppressGridRangeRef.current = false;
    }, 0);
  }, [stopAutoScroll, suppressGridRangeRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;

    container.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);

    return () => {
      container.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerUp);
      // A drag interrupted by unmount would otherwise leave the loop running.
      stopAutoScroll();
    };
  }, [
    containerRef,
    enabled,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    stopAutoScroll,
  ]);
}
