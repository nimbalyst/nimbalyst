/**
 * Drag autoscroll.
 *
 * When a drag-selection runs past the edge of the visible cells the grid has to
 * scroll toward the pointer, otherwise you can only ever select what already
 * happens to be on screen. RevoGrid's own autofill drag doesn't do this, and we
 * own the drag anyway (see crossSectionSelection.ts), so we own the scrolling
 * too.
 *
 * The decision -- "given a pointer and the visible cell area, how far should the
 * grid scroll this frame?" -- is pure, so it is tested without a live grid. The
 * two DOM adapters at the bottom are the only part that needs one.
 */

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  clientX: number;
  clientY: number;
}

export interface ScrollDelta {
  x: number;
  y: number;
}

/** Slowest and fastest autoscroll, in CSS pixels per animation frame. */
const MIN_SPEED_PX = 2;
const MAX_SPEED_PX = 28;
/** Overshoot past the edge at which the scroll reaches MAX_SPEED_PX. */
const MAX_SPEED_AT_PX = 160;
/**
 * Keep a clamped probe point a hair inside the edge -- `elementFromPoint` on the
 * exact boundary can land on the neighbouring element instead of the cell.
 */
const EDGE_INSET_PX = 1;

/** Scroll speed for a given overshoot: ramps linearly, then saturates. */
function speedFor(overshoot: number): number {
  const ramp = Math.min(overshoot, MAX_SPEED_AT_PX) / MAX_SPEED_AT_PX;
  return MIN_SPEED_PX + ramp * (MAX_SPEED_PX - MIN_SPEED_PX);
}

function axisDelta(position: number, min: number, max: number): number {
  if (position < min) return -speedFor(min - position);
  if (position > max) return speedFor(position - max);
  return 0;
}

/**
 * How far to scroll this frame. Zero on an axis the pointer is still inside,
 * so a caller can stop its loop as soon as both axes read zero.
 */
export function autoScrollDelta(point: Point, bounds: Bounds): ScrollDelta {
  return {
    x: axisDelta(point.clientX, bounds.left, bounds.right),
    y: axisDelta(point.clientY, bounds.top, bounds.bottom),
  };
}

/**
 * Pull a pointer that has left the cell area back onto its nearest edge, so the
 * hit-test resolves to the last visible row/column rather than to nothing.
 */
export function clampPointToBounds(point: Point, bounds: Bounds): Point {
  return {
    clientX: Math.min(
      Math.max(point.clientX, bounds.left + EDGE_INSET_PX),
      bounds.right - EDGE_INSET_PX
    ),
    clientY: Math.min(
      Math.max(point.clientY, bounds.top + EDGE_INSET_PX),
      bounds.bottom - EDGE_INSET_PX
    ),
  };
}

/* ------------------------------------------------------------------------- */
/* Live-grid adapters                                                         */
/* ------------------------------------------------------------------------- */

/** The scrollable body section -- the only one that scrolls on both axes. */
function bodySection(grid: Element): HTMLElement | null {
  return grid.querySelector('.viewports > revogr-viewport-scroll.rgCol');
}

/**
 * The region in which a point can actually hit a cell: the union of the cell
 * canvases, each clipped to its own scroll section. Clipping matters because a
 * canvas is as tall and wide as the whole sheet, not as the visible window.
 *
 * Excludes the row-number gutter and the column-header strip (neither carries a
 * `revogr-data` this query matches), and naturally covers the pinned header row
 * and the frozen columns, which are addressable.
 */
export function measureCellArea(grid: Element): Bounds | null {
  let area: Bounds | null = null;

  for (const data of Array.from(grid.querySelectorAll('revogr-data:not([col-type="rowHeaders"])'))) {
    const section = data.closest('revogr-viewport-scroll');
    if (!section) continue;

    const cells = data.getBoundingClientRect();
    const visible = section.getBoundingClientRect();
    const box: Bounds = {
      left: Math.max(cells.left, visible.left),
      top: Math.max(cells.top, visible.top),
      right: Math.min(cells.right, visible.right),
      bottom: Math.min(cells.bottom, visible.bottom),
    };
    // An empty section (e.g. rowPinEnd with no rows) clips to nothing.
    if (box.right <= box.left || box.bottom <= box.top) continue;

    area = area
      ? {
          left: Math.min(area.left, box.left),
          top: Math.min(area.top, box.top),
          right: Math.max(area.right, box.right),
          bottom: Math.max(area.bottom, box.bottom),
        }
      : box;
  }

  return area;
}

/**
 * Scroll the grid by a delta. Only the body section is driven; RevoGrid's
 * scrolling service mirrors the result into the frozen columns, the pinned rows
 * and the row-number gutter.
 */
export function scrollGridBy(grid: Element, delta: ScrollDelta): void {
  const body = bodySection(grid);
  if (!body) return;

  if (delta.x !== 0) body.scrollLeft += delta.x;

  const vertical = body.querySelector<HTMLElement>('.vertical-inner');
  if (delta.y !== 0 && vertical) vertical.scrollTop += delta.y;
}
