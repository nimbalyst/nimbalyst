/**
 * The board's two arrowhead markers, defined once per surface.
 *
 * SVG markers are referenced by id from every edge path, so they have to exist
 * in the document before any edge paints -- but they are pure definitions and
 * render nothing themselves. They live in a zero-sized `<svg>` at the top of
 * the surface rather than inside React Flow's own SVG layer, which React Flow
 * re-creates as the graph changes.
 *
 * `orient="auto-start-reverse"` on the end marker is what lets the same path
 * definition serve both directions; the start marker is a mirrored copy because
 * `refX` has to differ.
 */
import type { ReactElement } from 'react';

import {
  CANVAS_EDGE_ARROW_MARKER,
  CANVAS_EDGE_ARROW_START_MARKER,
} from './CanvasEdgeView';

export function CanvasEdgeMarkers(): ReactElement {
  return (
    <svg className="canvas-surface__markers" width={0} height={0} aria-hidden>
      <defs>
        <marker
          id={CANVAS_EDGE_ARROW_MARKER}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--nim-text-faint)" />
        </marker>
        <marker
          id={CANVAS_EDGE_ARROW_START_MARKER}
          viewBox="0 0 10 10"
          refX="2"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M 10 0 L 0 5 L 10 10 z" fill="var(--nim-text-faint)" />
        </marker>
      </defs>
    </svg>
  );
}
