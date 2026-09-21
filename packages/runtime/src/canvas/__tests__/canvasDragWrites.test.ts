// @vitest-environment node
/**
 * What one drag costs the durable write path.
 *
 * Every `update` a canvas Y.Doc emits under a local origin becomes an outbox row
 * and a renderer-to-main IPC call: `LocalDocumentReplica`'s update handler
 * appends one entry per event, and `ElectronLocalReplicaStore.appendLocalUpdate`
 * is one `documentSync.replicaAppendLocal` invoke each. Counting update events
 * here is therefore counting those, and a drag used to produce one per pointer
 * frame -- sixty a second, of which fifty-nine were positions the card had
 * already left by the time they were persisted.
 *
 * The number is the point of this file, so it is asserted both ways: the
 * frame-per-write shape is reproduced alongside the gesture-boundary one, and a
 * regression that quietly reinstates the first will show up as the two numbers
 * converging rather than as a vaguer failure. The other two assertions are the
 * things the saving is not allowed to cost -- undo granularity, and a teammate's
 * concurrent edit surviving the commit.
 */
import { describe, expect, it } from 'vitest';

import { applyCanvasDragCancellation } from '../canvasDragSnapping';
import type { NodeChange } from '@xyflow/react';
import * as Y from 'yjs';

import { CanvasBinding } from '../canvasBinding';
import { canvasCollabCodec, getCanvasYNodes } from '../canvasCollabCodec';
import type { CanvasDocument } from '../CanvasDocument';
import {
  EMPTY_CANVAS_GEOMETRY,
  applyCanvasNodeChanges,
  stepCanvasGesture,
  type CanvasNodeGeometry,
} from '../canvasFlowMapping';

const BOARD = JSON.stringify({
  nodes: [
    {
      id: 'card-prd',
      type: 'text',
      text: 'pricing',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
    },
    {
      id: 'card-notes',
      type: 'text',
      text: 'notes',
      x: 600,
      y: 400,
      width: 200,
      height: 120,
    },
  ],
  edges: [],
});

const DRAG_FRAMES = 60;

/** The frames React Flow emits for one drag, ending with `dragging: false`. */
function dragChanges(nodeId: string): NodeChange[][] {
  const frames: NodeChange[][] = [];
  for (let frame = 1; frame <= DRAG_FRAMES; frame += 1) {
    frames.push([
      {
        id: nodeId,
        type: 'position',
        position: { x: frame * 20, y: frame * 10 },
        dragging: true,
      },
    ]);
  }
  frames.push([
    {
      id: nodeId,
      type: 'position',
      position: { x: DRAG_FRAMES * 20, y: DRAG_FRAMES * 10 },
      dragging: false,
    },
  ]);
  return frames;
}

const RESIZE_FRAMES = 30;

/**
 * The frames `NodeResizer` emits for one resize, ending with `resizing: false`.
 *
 * Note what the closing frame is *not*: it carries no `setAttributes`, so
 * `applyCanvasNodeChanges` folds nothing out of it on its own. The committed
 * size comes from the held overlay the transient frames built, which is the
 * whole reason this is asserted rather than assumed.
 */
function resizeChanges(nodeId: string): NodeChange[][] {
  const frames: NodeChange[][] = [];
  const sizeAt = (frame: number) => ({
    width: 200 + frame * 10,
    height: 120 + frame * 6,
  });
  for (let frame = 1; frame <= RESIZE_FRAMES; frame += 1) {
    frames.push([
      {
        id: nodeId,
        type: 'dimensions',
        dimensions: sizeAt(frame),
        resizing: true,
      },
    ]);
  }
  frames.push([
    {
      id: nodeId,
      type: 'dimensions',
      dimensions: sizeAt(RESIZE_FRAMES),
      resizing: false,
    },
  ]);
  return frames;
}

interface Harness {
  binding: CanvasBinding;
  yDoc: Y.Doc;
  /** One per local Y.Doc update: one outbox row, one IPC call. */
  durableWrites(): number;
  rendered(): CanvasDocument;
  destroy(): void;
}

function harness(options: { undo?: boolean } = {}): Harness {
  const yDoc = new Y.Doc();
  canvasCollabCodec.seedFromFile(yDoc, BOARD);
  let rendered: CanvasDocument = {} as CanvasDocument;
  let writes = 0;
  const binding = new CanvasBinding(yDoc, {
    enableUndoManager: options.undo === true,
    onDocumentChange: (next) => {
      rendered = next;
    },
  });
  // Attached after the seed so hydration is not counted as a user edit, exactly
  // as `LocalDocumentReplica` skips its own hydration origin.
  yDoc.on('update', () => {
    writes += 1;
  });
  return {
    binding,
    yDoc,
    durableWrites: () => writes,
    rendered: () => rendered,
    destroy: () => {
      binding.destroy();
      yDoc.destroy();
    },
  };
}

/**
 * The surface's handler, minus React.
 *
 * `stepCanvasGesture` is the same function `onNodesChange` calls, deliberately:
 * a harness that re-derived the fold-or-hold decision here would keep passing
 * while the surface quietly went back to writing every frame.
 */
function runFrames(
  test: Harness,
  frames: readonly NodeChange[][],
  onFrame?: (frame: number) => void
): ReadonlyMap<string, CanvasNodeGeometry> {
  let held: ReadonlyMap<string, CanvasNodeGeometry> = EMPTY_CANVAS_GEOMETRY;
  frames.forEach((changes, frame) => {
    onFrame?.(frame);
    const document = test.rendered();
    const step = stepCanvasGesture(document, held, changes);
    if (step.commit) test.binding.applyLocalDocument(document, step.commit);
    held = step.held;
  });
  return held;
}

function runDrag(
  test: Harness,
  onFrame?: (frame: number) => void
): ReadonlyMap<string, CanvasNodeGeometry> {
  return runFrames(test, dragChanges('card-prd'), onFrame);
}

function positionOf(document: CanvasDocument, id: string) {
  const node = (document.nodes ?? []).find((entry) => entry.id === id);
  return node === undefined ? null : { x: node.x, y: node.y };
}

function sizeOf(document: CanvasDocument, id: string) {
  const node = (document.nodes ?? []).find((entry) => entry.id === id);
  return node === undefined
    ? null
    : { width: node.width, height: node.height };
}

describe('drag write amplification', () => {
  it('spends one durable write on a drag instead of one per frame', () => {
    const gestureBoundary = harness();
    const overlay = runDrag(gestureBoundary);

    expect(gestureBoundary.durableWrites()).toBe(1);
    expect(positionOf(gestureBoundary.rendered(), 'card-prd')).toEqual({
      x: 1200,
      y: 600,
    });
    // Nothing is left held once the pointer is up; the card is where the
    // document says it is, not where an overlay is still claiming.
    expect(overlay.size).toBe(0);
    gestureBoundary.destroy();

    // The shape this replaced: every frame folded straight into the Y.Doc.
    const perFrame = harness();
    for (const changes of dragChanges('card-prd')) {
      const document = perFrame.rendered();
      perFrame.binding.applyLocalDocument(
        document,
        applyCanvasNodeChanges(document, changes)
      );
    }
    // One per moved frame. The closing frame repeats the last position, so it
    // was the only one of the sixty-one that did not cost anything.
    expect(perFrame.durableWrites()).toBe(DRAG_FRAMES);
    expect(positionOf(perFrame.rendered(), 'card-prd')).toEqual({
      x: 1200,
      y: 600,
    });
    perFrame.destroy();
  });

  /**
   * A resize is a gesture too, and it reaches the document by a different route
   * than a drag does.
   *
   * `applyCanvasNodeChanges` deliberately ignores any `dimensions` change that
   * is neither `resizing: true` nor `setAttributes` -- React Flow re-reports
   * every node's measured box after every render, and honouring that would mark
   * a board dirty with nobody having touched it. The consequence is that the
   * frame which *ends* a resize contributes nothing on its own: the size that
   * gets written is the one the held overlay accumulated. Get that wrong and a
   * resize looks fine on screen for as long as the overlay survives, then
   * snaps back to the old box on the next document round-trip.
   *
   * The reason this is worth a test at all: until the click model split select
   * from activate, the handles were hidden the instant a card was clicked, so
   * this path had no way to run.
   */
  it('commits a resize once, at the gesture boundary', () => {
    const test = harness();
    const overlay = runFrames(test, resizeChanges('card-prd'));

    expect(test.durableWrites()).toBe(1);
    expect(sizeOf(test.rendered(), 'card-prd')).toEqual({
      width: 200 + RESIZE_FRAMES * 10,
      height: 120 + RESIZE_FRAMES * 6,
    });
    // Resizing from a corner moves the origin too; nothing here should have.
    expect(positionOf(test.rendered(), 'card-prd')).toEqual({ x: 0, y: 0 });
    expect(overlay.size).toBe(0);
    test.destroy();
  });

  /**
   * The way the per-frame write comes back if you are not looking for it.
   *
   * React Flow reports every node's measured box after every render, so a drag
   * is interleaved with `dimensions` batches that carry no gesture at all.
   * Folding one of those against the *held* frames rather than against the
   * document makes it look like an ordinary edit that happens to move a card --
   * and writes the in-progress position, once per interleaved batch.
   */
  it('does not commit the held position on an interleaved measurement', () => {
    const test = harness();
    const measurement: NodeChange[] = [
      {
        id: 'card-notes',
        type: 'dimensions',
        dimensions: { width: 200, height: 120 },
      },
    ];
    const frames = dragChanges('card-prd');
    const interleaved = frames.flatMap((changes, index) =>
      index > 0 && index < frames.length - 1
        ? [changes, measurement]
        : [changes]
    );

    runFrames(test, interleaved);
    expect(test.durableWrites()).toBe(1);
    expect(positionOf(test.rendered(), 'card-prd')).toEqual({
      x: 1200,
      y: 600,
    });
    test.destroy();
  });

  it('keeps one drag as one undo step', () => {
    const test = harness({ undo: true });
    runDrag(test);

    expect(test.binding.undoManager?.undoStack).toHaveLength(1);
    expect(test.binding.undo()).toBe(true);
    expect(positionOf(test.rendered(), 'card-prd')).toEqual({ x: 0, y: 0 });
    test.destroy();
  });

  /**
   * The reason the held state is geometry and not a whole document.
   *
   * A teammate's edit lands in the middle of the drag. Holding the board that
   * was rendered when the pointer went down and committing *that* at the end
   * would carry the pre-edit text back over theirs -- a silent revert, and one
   * nobody would connect to having dragged a card.
   */
  it('does not revert a teammate’s edit that lands mid-drag', () => {
    const test = harness();
    runDrag(test, (frame) => {
      if (frame !== 30) return;
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(test.yDoc));
      getCanvasYNodes(remote).get('card-prd')?.set('text', 'their rewrite');
      Y.applyUpdate(test.yDoc, Y.encodeStateAsUpdate(remote), 'remote');
      remote.destroy();
    });

    const card = (test.rendered().nodes ?? []).find(
      (node) => node.id === 'card-prd'
    );
    expect(card?.text).toBe('their rewrite');
    expect({ x: card?.x, y: card?.y }).toEqual({ x: 1200, y: 600 });
    test.destroy();
  });
});

/**
 * Escape mid-drag has to survive the rest of the gesture.
 *
 * React Flow owns the pointer capture, so cancelling cannot stop the drag --
 * the frames keep arriving, including the `dragging: false` one that the commit
 * path turns into the durable write. The cancellation therefore has to hold
 * until that frame passes, and it has to hold *only* until then, or the next
 * drag is dead on arrival.
 */
describe('a cancelled drag', () => {
  const moving = (dragging: boolean) => ({
    id: 'a',
    type: 'position' as const,
    position: { x: 40, y: 40 },
    dragging,
  });

  it('passes everything through when nothing was cancelled', () => {
    const changes = [moving(true)];
    const result = applyCanvasDragCancellation(changes, false);
    expect(result.changes).toBe(changes);
    expect(result.stillCancelled).toBe(false);
  });

  it('drops the positions and stays cancelled until the gesture ends', () => {
    const midway = applyCanvasDragCancellation([moving(true)], true);
    expect(midway.changes).toEqual([]);
    expect(midway.stillCancelled).toBe(true);

    const ending = applyCanvasDragCancellation([moving(false)], true);
    expect(ending.changes).toEqual([]);
    // The very frame that would have been committed is the one that clears it.
    expect(ending.stillCancelled).toBe(false);
  });

  it('leaves selection changes alone -- Escape cancelled a move', () => {
    const select = { id: 'a', type: 'select' as const, selected: true };
    const result = applyCanvasDragCancellation([moving(true), select], true);
    expect(result.changes).toEqual([select]);
  });
});
