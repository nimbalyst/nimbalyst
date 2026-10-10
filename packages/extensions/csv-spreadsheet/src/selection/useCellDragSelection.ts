/**
 * Owns cell drag-selection so a range can cross frozen/pinned boundaries.
 *
 * RevoGrid's built-in drag is clamped to the section it starts in (see the
 * header comment in crossSectionSelection.ts), so we track the pointer
 * ourselves in absolute sheet coordinates and paint the result across every
 * store the range touches.
 *
 * In `select` mode we deliberately do NOT swallow the initial mousedown:
 * RevoGrid still needs it to move focus and to start cell editing. We only take
 * over once the pointer actually moves, and we repaint after RevoGrid has
 * painted its own (clamped) range, so ours wins.
 *
 * `point` mode is the inverse, for formula point mode. When `beginPoint`
 * accepts a press, it is swallowed in the capture phase -- pointerdown,
 * mousedown (RevoGrid's overlay binds `mousedown`), and the click/dblclick
 * that follow -- so the open formula editor keeps focus and is not committed.
 * The gesture then reports picks instead of painting: the real selection
 * never moves while pointing.
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
  /**
   * The button is down on a press this instance saw. Without it a press some
   * other handler swallowed (a header, a point-mode gesture) would let the
   * kept-for-shift+click anchor resume as a drag on the next pointermove.
   */
  pressed: boolean;
}

interface CommonOptions {
  containerRef: RefObject<HTMLElement | null>;
  gridRef: RefObject<SectionAwareGrid | null>;
  /**
   * Must be false until the grid is actually mounted. The editor renders a
   * loading tree first, so binding on mount would attach to nothing and never
   * retry -- `enabled` flipping is what re-runs the listener effect.
   */
  enabled: boolean;
}

/** Moves the real selection. */
export interface SelectModeOptions extends CommonOptions {
  mode?: 'select';
  /** Called with the selection (visible rows) as the drag progresses. */
  onSelectionChange: (
    cell: { row: number; col: number } | null,
    range: NormalizedSelectionRange | null
  ) => void;
  /**
   * Set while our drag owns the selection, so the grid's own `setrange` events
   * (which carry the clamped, single-section range) can be ignored.
   */
  suppressGridRangeRef: RefObject<boolean>;
  /**
   * The active cell in visible rows. Shift+click extends from it even when the
   * keyboard (not a click) put it there.
   */
  getActiveCell?: () => { row: number; col: number } | null;
}

/** Formula point mode: reports picks, never touches the selection. See the header. */
export interface PointModeOptions extends CommonOptions {
  mode: 'point';
  /**
   * Asked synchronously on every press over a data cell; true takes the
   * gesture (and swallows the press), false leaves it to the grid.
   */
  beginPoint: () => boolean;
  /** The picked range in visible rows, on press and on every cell the drag enters. */
  onPointPick: (range: NormalizedSelectionRange) => void;
  /** The gesture ended (button released or cancelled). */
  onPointEnd?: () => void;
}

export type UseCellDragSelectionOptions = SelectModeOptions | PointModeOptions;

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

/** A press on a data cell (not a header, the row gutter or the open cell editor). */
export function isDataCellPress(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('revogr-header') || target.closest('.rowHeaders')) return false;
  if (target.closest('textarea, input')) return false;
  const cell = target.closest('[data-rgrow][data-rgcol]');
  return !!cell && !cell.closest('[col-type="rowHeaders"]');
}

function setSuppress(ref: RefObject<boolean> | undefined, value: boolean): void {
  if (ref) ref.current = value;
}

export function useCellDragSelection(options: UseCellDragSelectionOptions): void {
  const { containerRef, gridRef, enabled } = options;
  const mode = options.mode ?? 'select';
  const select = options.mode === 'point' ? null : options;
  const pointOptions = options.mode === 'point' ? options : null;
  const onSelectionChange = select?.onSelectionChange;
  const suppressGridRangeRef = select?.suppressGridRangeRef;
  const getActiveCell = select?.getActiveCell;
  const beginPoint = pointOptions?.beginPoint;
  const onPointPick = pointOptions?.onPointPick;
  const onPointEnd = pointOptions?.onPointEnd;
  const dragRef = useRef<DragState | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  /** point: a gesture is swallowing events, from the press until the click after release. */
  const pointingRef = useRef(false);
  /** point: the button is still down on the swallowed press. */
  const pointPressedRef = useRef(false);

  // The reported cell is the anchor (where the gesture started), which is the
  // active cell typing goes to -- not the range's top-left.
  const applyRange = useCallback(
    (anchor: { row: number; col: number }, range: NormalizedSelectionRange, sections: GridSections) => {
      if (mode === 'point') {
        onPointPick?.(range);
        return;
      }
      const grid = gridRef.current;
      if (!grid) return;
      void paintCrossSectionRange(grid, sections, range);
      onSelectionChange?.(anchor, range);
    },
    [mode, gridRef, onSelectionChange, onPointPick]
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
      applyRange(drag.anchor, normalize(drag.anchor, target), drag.sections);
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

      if (mode === 'point') {
        // Decide synchronously: the press has to be swallowed before RevoGrid
        // (or the browser's focus change) sees it, so it can't wait on the
        // section lookup below.
        if (!isDataCellPress(target) || !beginPoint?.()) return;
        event.preventDefault();
        event.stopPropagation();
        pointingRef.current = true;
        pointPressedRef.current = true;
      }

      const grid = gridRef.current;
      if (!grid) return;

      const sections = await resolveGridSections(grid);
      if (!sections) return;

      const cell = cellFromPoint(sections, event.clientX, event.clientY);
      if (!cell) return;

      const pointing = mode === 'point';
      const active = !pointing && event.shiftKey ? (getActiveCell?.() ?? dragRef.current?.anchor ?? null) : null;
      const shiftExtend = !!active;
      const anchor = active ?? cell;
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
        // A release that beat the section lookup ended the gesture already;
        // its pick below still lands.
        pressed: !pointing || pointPressedRef.current,
      };

      if (pointing) {
        // The click itself is a pick; a drag then rewrites it.
        applyRange(anchor, normalize(anchor, cell), sections);
      } else if (shiftExtend) {
        setSuppress(suppressGridRangeRef, true);
        applyRange(anchor, normalize(anchor, cell), sections);
      }
    },
    [enabled, mode, beginPoint, gridRef, applyRange, suppressGridRangeRef, getActiveCell]
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag?.pressed) return;
      // No button held: this is a hover, not a drag.
      if (event.buttons === 0) return;

      if (!drag.active) {
        const dx = Math.abs(event.clientX - drag.anchorPoint.clientX);
        const dy = Math.abs(event.clientY - drag.anchorPoint.clientY);
        if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX) return;
        drag.active = true;
        setSuppress(suppressGridRangeRef, true);
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
    if (mode === 'point' && pointingRef.current) {
      pointPressedRef.current = false;
      if (drag) drag.pressed = false;
      // The click that follows this release is still part of the gesture;
      // release the swallow after it has been dispatched.
      setTimeout(() => {
        pointingRef.current = false;
      }, 0);
      onPointEnd?.();
      return;
    }
    if (!drag) return;
    // Keep the anchor for a subsequent shift+click, but stop tracking motion.
    drag.active = false;
    drag.pressed = false;
    // Release on the next tick so the grid's own mouseup-driven setrange (which
    // carries the clamped range) is still ignored.
    setTimeout(() => {
      setSuppress(suppressGridRangeRef, false);
    }, 0);
  }, [mode, stopAutoScroll, suppressGridRangeRef, onPointEnd]);

  /** point: everything else the press produces belongs to the gesture, not the grid. */
  const swallowWhilePointing = useCallback((event: Event) => {
    if (!pointingRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;

    const capture = mode === 'point';
    container.addEventListener('pointerdown', handlePointerDown, capture);
    if (capture) {
      for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
        container.addEventListener(type, swallowWhilePointing, true);
      }
    }
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);

    return () => {
      container.removeEventListener('pointerdown', handlePointerDown, capture);
      if (capture) {
        for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
          container.removeEventListener(type, swallowWhilePointing, true);
        }
      }
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerUp);
      // A drag interrupted by unmount would otherwise leave the loop running.
      stopAutoScroll();
    };
  }, [
    containerRef,
    enabled,
    mode,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    swallowWhilePointing,
    stopAutoScroll,
  ]);
}
