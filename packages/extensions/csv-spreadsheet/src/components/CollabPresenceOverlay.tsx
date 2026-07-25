/**
 * CollabPresenceOverlay
 *
 * Draws remote collaborators' selected/editing cells on top of the RevoGrid.
 *
 * Positioning uses RevoGrid's own rendered cells rather than reimplementing
 * its coordinate math: every cell carries `data-rgRow` / `data-rgCol`, and the
 * row sections reflect `type` (`rowPinStart` for pinned headers, `rgRow` for
 * scrolling data). We query the cell element, read its `getBoundingClientRect`,
 * and translate into the grid container's local space. This handles scroll,
 * frozen columns, and virtualization for free -- a cell that scrolls out of
 * view is removed from the DOM, so the query returns null and we simply skip
 * it (v1 renders in-viewport presence only).
 *
 * We must exclude `col-type="rowHeaders"`: the frozen row-number column reuses
 * `data-rgCol="0"`, so a bare `[data-rgcol="0"]` selector would also match the
 * row-number cell (and pick it first). Restricting to the data col-types keeps
 * the match unique to the real cell.
 *
 * Repaint is driven by `repaintKey` (bumped on awareness change, scroll, and
 * resize by the parent) plus the `presences` array itself.
 *
 * The overlay is strictly `pointer-events: none` so it can never intercept a
 * click/edit on the grid underneath. Name labels therefore show on the
 * actively-editing cell only; a hover-to-reveal label for selection-only
 * presence is deferred (it would require capturing pointer events over the
 * grid, which we won't do).
 */

import { useLayoutEffect, useState } from 'react';
import { resolveCellSection, type RemotePresence } from '../collab/presence';

interface PositionedPresence {
  presence: RemotePresence;
  top: number;
  left: number;
  width: number;
  height: number;
}

interface CollabPresenceOverlayProps {
  presences: RemotePresence[];
  /** The `position: relative` container wrapping the RevoGrid. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Number of pinned header rows, for logical->section row mapping. */
  headerRowCount: number;
  /** Bumped by the parent to force a re-measure (scroll / resize / awareness). */
  repaintKey: number;
}

/** Intersect two rects; returns null if they don't overlap. */
function intersect(
  a: { top: number; left: number; right: number; bottom: number },
  b: { top: number; left: number; right: number; bottom: number },
): { top: number; left: number; right: number; bottom: number } | null {
  const top = Math.max(a.top, b.top);
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return { top, left, right, bottom };
}

export function CollabPresenceOverlay({
  presences,
  containerRef,
  headerRowCount,
  repaintKey,
}: CollabPresenceOverlayProps): React.JSX.Element | null {
  const [positioned, setPositioned] = useState<PositionedPresence[]>([]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      setPositioned([]);
      return;
    }
    const containerRect = container.getBoundingClientRect();

    const next: PositionedPresence[] = [];
    for (const presence of presences) {
      const { rowType, gridRow } = resolveCellSection(presence.cell.row, headerRowCount);
      // Exclude the row-number column (col-type="rowHeaders"), which reuses the
      // same data-rgcol indices as real data columns.
      const selector = `revogr-data[type="${rowType}"]:not([col-type="rowHeaders"]) [data-rgrow="${gridRow}"][data-rgcol="${presence.cell.col}"]`;
      const cellEl = container.querySelector(selector);
      if (!(cellEl instanceof HTMLElement)) continue; // off-screen / virtualized

      const cellRect = cellEl.getBoundingClientRect();

      // Clip to the cell's own scrollable section so a cell scrolled partway
      // under the pinned header/column-header doesn't paint over them.
      const scroller = cellEl.closest('revogr-viewport-scroll');
      const clipEl = scroller instanceof HTMLElement ? scroller : container;
      const clipRect = clipEl.getBoundingClientRect();

      const visible = intersect(
        { top: cellRect.top, left: cellRect.left, right: cellRect.right, bottom: cellRect.bottom },
        { top: clipRect.top, left: clipRect.left, right: clipRect.right, bottom: clipRect.bottom },
      );
      if (!visible) continue;

      next.push({
        presence,
        top: visible.top - containerRect.top,
        left: visible.left - containerRect.left,
        width: visible.right - visible.left,
        height: visible.bottom - visible.top,
      });
    }
    setPositioned(next);
  }, [presences, headerRowCount, repaintKey, containerRef]);

  if (positioned.length === 0) return null;

  return (
    <div className="csv-presence-overlay" aria-hidden="true">
      {positioned.map(({ presence, top, left, width, height }) => (
        <div
          key={presence.userId}
          className="csv-presence-cell"
          data-editing={presence.editing || undefined}
          style={{
            top,
            left,
            width,
            height,
            // Per-collaborator color drives border + label; kept inline
            // because it's a runtime value, not a static theme token.
            ['--csv-presence-color' as string]: presence.color,
          }}
        >
          {presence.editing && (
            <span className="csv-presence-label" style={{ backgroundColor: presence.color }}>
              {presence.name}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
