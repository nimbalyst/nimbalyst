/**
 * This client's outbound presence: cursor, viewport rectangle, and selection.
 *
 * Lifted out of CanvasSurface as one piece because these three share a rule --
 * everything here is *ephemeral*. Awareness carries no history, is dropped when
 * the client disconnects, and never reaches the outbox. A card left mid-drag by
 * a lost connection snaps back to its last committed position on every other
 * board rather than sticking where the pointer died.
 *
 * Two pieces of tuning are load-bearing and easy to undo by accident:
 *
 * **The cursor is coalesced to one frame.** A pointer move fires far faster
 * than anyone can read, and each publish is a Y awareness write that every peer
 * decodes.
 *
 * **The selection effect is keyed on the board's id *set*, not on
 * `document.nodes`.** That array's identity changes on every edit anyone makes
 * -- a teammate typing into a card, a rank moving, any frame of any gesture --
 * and re-running for those republished a selection that had not changed, so
 * ordinary document work turned into presence traffic carrying nothing. The set
 * is what this actually depends on: the only thing a node change can do to a
 * selection is take its card away.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { useReactFlow } from '@xyflow/react';

import type { CanvasDocument } from './CanvasDocument';
import type { CanvasAwarenessPatch } from './canvasBinding';
import {
  EMPTY_CANVAS_GEOMETRY,
  type CanvasNodeGeometry,
} from './canvasFlowMapping';

/** Joins node ids into a set key. A unit separator cannot occur inside one. */
const NODE_ID_SEPARATOR = '\u001f';

export interface CanvasAwarenessPublisherOptions {
  flow: ReturnType<typeof useReactFlow>;
  surfaceRef: { readonly current: HTMLElement | null };
  onAwarenessChange?: ((patch: CanvasAwarenessPatch) => void) | undefined;
  document: CanvasDocument;
  selectedIds: ReadonlySet<string>;
  /** Boxes this user is holding right now, for the unmount sweep. */
  localGeometryRef: { readonly current: ReadonlyMap<string, CanvasNodeGeometry> };
}

export interface CanvasAwarenessPublisher {
  publishMovingAwareness(
    overlay: ReadonlyMap<string, CanvasNodeGeometry>
  ): void;
  publishViewportAwareness(): void;
  onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void;
  onPointerLeave(): void;
}

export function useCanvasAwarenessPublisher({
  flow,
  surfaceRef,
  onAwarenessChange,
  document,
  selectedIds,
  localGeometryRef,
}: CanvasAwarenessPublisherOptions): CanvasAwarenessPublisher {
  const pointerFrameRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{ x: number; y: number } | null>(null);

  const publishMovingAwareness = useCallback(
    (overlay: ReadonlyMap<string, CanvasNodeGeometry>) => {
      if (!onAwarenessChange) return;
      onAwarenessChange({
        moving:
          overlay.size === 0
            ? null
            : [...overlay].map(([nodeId, geometry]) => ({
                nodeId,
                ...geometry,
              })),
      });
    },
    [onAwarenessChange]
  );

  const publishViewportAwareness = useCallback(() => {
    if (!onAwarenessChange) return;
    const bounds = surfaceRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0 || bounds.height === 0) return;
    const topLeft = flow.screenToFlowPosition({ x: bounds.left, y: bounds.top });
    const bottomRight = flow.screenToFlowPosition({
      x: bounds.right,
      y: bounds.bottom,
    });
    onAwarenessChange({
      viewport: {
        x: topLeft.x,
        y: topLeft.y,
        width: Math.max(0, bottomRight.x - topLeft.x),
        height: Math.max(0, bottomRight.y - topLeft.y),
      },
    });
  }, [flow, onAwarenessChange, surfaceRef]);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!onAwarenessChange) return;
      pendingPointerRef.current = { x: event.clientX, y: event.clientY };
      if (pointerFrameRef.current !== null) return;
      pointerFrameRef.current = requestAnimationFrame(() => {
        pointerFrameRef.current = null;
        const pointer = pendingPointerRef.current;
        pendingPointerRef.current = null;
        if (!pointer) return;
        onAwarenessChange({ cursor: flow.screenToFlowPosition(pointer) });
      });
    },
    [flow, onAwarenessChange]
  );

  const onPointerLeave = useCallback(() => {
    pendingPointerRef.current = null;
    if (pointerFrameRef.current !== null) {
      cancelAnimationFrame(pointerFrameRef.current);
      pointerFrameRef.current = null;
    }
    onAwarenessChange?.({ cursor: null });
  }, [onAwarenessChange]);

  useEffect(
    () => () => {
      if (pointerFrameRef.current !== null) {
        cancelAnimationFrame(pointerFrameRef.current);
      }
      // A board closed mid-drag must not leave a card haloed at a position
      // nobody is holding any more. The binding clears the whole field on its
      // own teardown; this covers the surface unmounting first.
      if (localGeometryRef.current.size > 0) {
        publishMovingAwareness(EMPTY_CANVAS_GEOMETRY);
      }
    },
    [localGeometryRef, publishMovingAwareness]
  );

  const nodeIdKey = useMemo(
    () =>
      (document.nodes ?? [])
        .map((node) => node.id)
        .sort()
        .join(NODE_ID_SEPARATOR),
    [document.nodes]
  );

  useEffect(() => {
    if (!onAwarenessChange) return;
    const present = new Set(
      nodeIdKey === '' ? [] : nodeIdKey.split(NODE_ID_SEPARATOR)
    );
    const selectedNodes = [...selectedIds].filter((id) => present.has(id));
    onAwarenessChange({
      selectedNodeId: selectedNodes.length === 1 ? selectedNodes[0] : null,
    });
  }, [nodeIdKey, onAwarenessChange, selectedIds]);

  return {
    publishMovingAwareness,
    publishViewportAwareness,
    onPointerMove,
    onPointerLeave,
  };
}
