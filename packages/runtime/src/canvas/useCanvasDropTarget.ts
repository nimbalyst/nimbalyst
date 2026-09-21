/**
 * Dropping a file or shared document from the host's tree onto the board.
 *
 * The card lands under the pointer rather than at the viewport centre: a drag
 * *is* a placement, and dropping three documents in a row only to find them
 * stacked in the middle of the board is worse than not accepting the drag at
 * all.
 *
 * `dropActive` is the highlight, and it is compared against the surface itself
 * on leave -- the event fires when the pointer crosses into a child too, so an
 * unguarded handler flickers the highlight off every time the drag passes over
 * a card.
 */
import {
  useCallback,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react';
import type { useReactFlow } from '@xyflow/react';

import type { CanvasAnyNode, CanvasDocument } from './CanvasDocument';
import { getCanvasCallbacks } from './canvasCallbacks';
import { createReferenceCanvasNode } from './canvasFlowMapping';

export interface CanvasDropTarget {
  /** True while a droppable drag is over the board. */
  dropActive: boolean;
  onDragOver(event: ReactDragEvent): void;
  onDragLeave(event: ReactDragEvent): void;
  onDrop(event: ReactDragEvent): void;
}

export function useCanvasDropTarget(options: {
  flow: ReturnType<typeof useReactFlow>;
  documentRef: { readonly current: CanvasDocument };
  readOnly: boolean;
  /** Places the node on the board and selects it. */
  place(node: CanvasAnyNode): void;
}): CanvasDropTarget {
  const { flow, documentRef, readOnly, place } = options;
  const dropSource = getCanvasCallbacks().dropSource;
  const [dropActive, setDropActive] = useState(false);

  const onDragOver = useCallback(
    (event: ReactDragEvent) => {
      if (readOnly || !dropSource?.accepts([...event.dataTransfer.types])) return;
      event.preventDefault();
      // The collab tree drags with `effectAllowed: 'copyMove'` so it can also
      // reorder into folders; a board never moves the source, it references it.
      event.dataTransfer.dropEffect = 'copy';
      setDropActive(true);
    },
    [dropSource, readOnly]
  );

  const onDragLeave = useCallback((event: ReactDragEvent) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropActive(false);
  }, []);

  const onDrop = useCallback(
    (event: ReactDragEvent) => {
      setDropActive(false);
      if (readOnly || !dropSource?.accepts([...event.dataTransfer.types])) return;
      event.preventDefault();
      const pick = dropSource.read(event.dataTransfer);
      if (!pick) return;
      const at = flow.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      place(
        createReferenceCanvasNode(
          documentRef.current,
          pick.reference,
          at,
          pick.label
        )
      );
    },
    [documentRef, dropSource, flow, place, readOnly]
  );

  return { dropActive, onDragOver, onDragLeave, onDrop };
}
