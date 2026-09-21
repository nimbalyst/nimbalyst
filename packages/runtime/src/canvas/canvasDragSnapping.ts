/**
 * Rewriting a drag frame to its magnetically snapped position.
 *
 * Pure: React Flow's change batch and the board in, a possibly-rewritten batch
 * and the guides to paint out. Lifted from CanvasSurface so the decisions below
 * can be read -- and eventually tested -- without a mounted flow.
 *
 * **One card at a time on purpose.** A multi-card drag has no single rectangle
 * to align, and React Flow's own grid snap already keeps the group tidy. The
 * incoming position is grid-snapped by React Flow, so an alignment match here
 * is a deliberate override of the grid.
 *
 * **The change that *ends* the drag (`dragging: false`) has to be snapped
 * too.** React Flow re-emits the raw gridded position when the pointer comes
 * up, so skipping it would silently undo the snap the moment the user let go --
 * the card would sit aligned for the whole drag and then jump back to the grid.
 * Guides are still cleared on that change, because the gesture is over.
 *
 * **`guides: null` means "this batch says nothing about the drag".** Every
 * frame of a drag also delivers a second batch carrying no position at all,
 * once the edited document round-trips back into React Flow, and reading that
 * as "no drag" wiped the guides before they could ever paint -- the snap worked
 * and the board stayed blank.
 */
import type { NodeChange } from '@xyflow/react';

import type { CanvasDocument } from './CanvasDocument';
import {
  CANVAS_SNAP_THRESHOLD_PX,
  snapCanvasDrag,
  type CanvasGuide,
} from './canvasSnapping';

const NO_GUIDES: readonly CanvasGuide[] = [];

export interface CanvasDragCancellation {
  changes: readonly NodeChange[];
  /** Whether the gesture is still running and still cancelled. */
  stillCancelled: boolean;
}

/**
 * Drop the position frames of a drag the user cancelled with Escape.
 *
 * Clearing the held-geometry overlay is not enough on its own. React Flow owns
 * the pointer capture, so the gesture runs to the end of the button press and
 * still delivers its final `dragging: false` frame -- and *that* frame is the
 * one the commit path folds into the document. Cancellation therefore has to
 * survive until the gesture ends: every position change is dropped, so nothing
 * is written, and the painted board stays derived from the document, which is
 * what makes the cards snap back to where they started.
 *
 * Selection, dimension, and removal changes pass through untouched: Escape
 * cancelled a *move*, not everything else that happened to arrive with it.
 */
export function applyCanvasDragCancellation(
  changes: readonly NodeChange[],
  cancelled: boolean
): CanvasDragCancellation {
  if (!cancelled) return { changes, stillCancelled: false };
  const ends = changes.some(
    (change) => change.type === 'position' && change.dragging === false
  );
  const kept = changes.filter((change) => change.type !== 'position');
  return {
    changes: kept.length === changes.length ? changes : kept,
    stillCancelled: !ends,
  };
}

export interface CanvasDragSnapResult {
  changes: readonly NodeChange[];
  /** Guides to paint, or null to leave whatever is painted alone. */
  guides: readonly CanvasGuide[] | null;
}

export function snapCanvasDragChanges(
  changes: readonly NodeChange[],
  base: CanvasDocument,
  options: { enabled: boolean; zoom: number }
): CanvasDragSnapResult {
  const dragging = changes.filter(
    (change): change is Extract<NodeChange, { type: 'position' }> =>
      change.type === 'position' &&
      change.dragging !== undefined &&
      change.position !== undefined
  );
  if (dragging.length === 0) return { changes, guides: null };
  if (!options.enabled || dragging.length !== 1) {
    return { changes, guides: NO_GUIDES };
  }

  const change = dragging[0];
  const nodes = base.nodes ?? [];
  const moving = nodes.find((node) => node.id === change.id);
  if (!moving || !change.position) return { changes, guides: NO_GUIDES };

  const snapped = snapCanvasDrag(
    {
      x: change.position.x,
      y: change.position.y,
      width: moving.width,
      height: moving.height,
    },
    nodes
      .filter((node) => node.id !== moving.id)
      .map((node) => ({
        id: node.id,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      })),
    // Screen pixels, so the pull feels the same at every zoom.
    CANVAS_SNAP_THRESHOLD_PX / Math.max(options.zoom, 0.01)
  );
  const guides = change.dragging === true ? snapped.guides : NO_GUIDES;
  if (snapped.x === change.position.x && snapped.y === change.position.y) {
    return { changes, guides };
  }
  return {
    changes: changes.map((entry) =>
      entry === change
        ? { ...entry, position: { x: snapped.x, y: snapped.y } }
        : entry
    ),
    guides,
  };
}
