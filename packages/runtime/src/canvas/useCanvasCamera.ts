/**
 * Everything that moves the board's camera, in one place.
 *
 * The zoom widget, the keyboard map, and the context menu all want the same six
 * motions, and every one of them has to do the same two unobvious things:
 * anchor the scale change at the middle of the *surface* rather than at the
 * origin, and cancel any in-flight activation first.
 *
 * **Why the token bump.** Activation animates the viewport and then, on
 * arrival, makes a card hot. A user who reaches for "fit all" while a card is
 * still flying in has said they want to look somewhere else; without the bump
 * the activation lands afterwards, drags the board back, and hands the keyboard
 * to a card the user had already left behind. `activationToken` is the surface's
 * existing "the user changed their mind" counter -- see `activate`.
 *
 * The arithmetic itself is `zoomViewportToScale`, which is pure and lives with
 * the rest of the viewport maths.
 */
import { useCallback, useMemo } from 'react';
import type { useReactFlow } from '@xyflow/react';

import type { CanvasDocument, CanvasViewport } from './CanvasDocument';
import {
  readCanvasViewport,
  zoomViewportToScale,
} from './canvasFlowMapping';
import type { CanvasCameraCommands } from './useCanvasCommands';

type CanvasFlow = ReturnType<typeof useReactFlow>;

export interface CanvasCameraOptions {
  flow: CanvasFlow;
  surfaceRef: { readonly current: HTMLElement | null };
  /** The surface's activation counter, bumped before every motion. */
  activationToken: { current: number };
  selectedIds: ReadonlySet<string>;
  documentRef: { readonly current: CanvasDocument };
  /** The live document, so "is there a saved view" stays reactive. */
  document: CanvasDocument;
  minZoom: number;
  maxZoom: number;
  durationMs: number;
}

export function useCanvasCamera({
  flow,
  surfaceRef,
  activationToken,
  selectedIds,
  documentRef,
  document,
  minZoom,
  maxZoom,
  durationMs,
}: CanvasCameraOptions): {
  camera: CanvasCameraCommands;
  savedHomeView: CanvasViewport | null;
} {
  const zoomTo = useCallback(
    (scale: number) => {
      activationToken.current += 1;
      const bounds = surfaceRef.current?.getBoundingClientRect();
      const next = zoomViewportToScale(
        flow.getViewport(),
        bounds ? { x: bounds.width / 2, y: bounds.height / 2 } : { x: 0, y: 0 },
        scale,
        { minZoom, maxZoom }
      );
      if (next !== null) void flow.setViewport(next, { duration: durationMs });
    },
    [activationToken, durationMs, flow, maxZoom, minZoom, surfaceRef]
  );

  const zoomIn = useCallback(() => {
    activationToken.current += 1;
    void flow.zoomIn({ duration: durationMs });
  }, [activationToken, durationMs, flow]);

  const zoomOut = useCallback(() => {
    activationToken.current += 1;
    void flow.zoomOut({ duration: durationMs });
  }, [activationToken, durationMs, flow]);

  const fitAll = useCallback(() => {
    activationToken.current += 1;
    void flow.fitView({ padding: 0.2, maxZoom: 1, duration: durationMs });
  }, [activationToken, durationMs, flow]);

  /** Fit what is selected; with nothing selected this is "fit the board". */
  const fitSelection = useCallback(() => {
    const chosen = [...selectedIds].filter((id) =>
      (documentRef.current.nodes ?? []).some((node) => node.id === id)
    );
    if (chosen.length === 0) {
      fitAll();
      return;
    }
    activationToken.current += 1;
    void flow.fitView({
      nodes: chosen.map((id) => ({ id })),
      padding: 0.3,
      duration: durationMs,
    });
  }, [activationToken, documentRef, durationMs, fitAll, flow, selectedIds]);

  const savedView = useCallback(() => {
    const home = readCanvasViewport(documentRef.current);
    if (!home) return;
    activationToken.current += 1;
    void flow.setViewport(home, { duration: durationMs });
  }, [activationToken, documentRef, durationMs, flow]);

  const camera = useMemo<CanvasCameraCommands>(
    () => ({ fitAll, fitSelection, zoomIn, zoomOut, zoomTo, savedView }),
    [fitAll, fitSelection, savedView, zoomIn, zoomOut, zoomTo]
  );

  const savedHomeView = useMemo(() => readCanvasViewport(document), [document]);

  return { camera, savedHomeView };
}
