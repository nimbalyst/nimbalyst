/**
 * Cmd/Ctrl + wheel zooms about the pointer.
 *
 * `panOnScroll` hands every wheel event to React Flow's pan handler, which only
 * diverts to zoom on `ctrlKey` -- the flag macOS synthesises for a trackpad
 * pinch. Cmd is the other half of the design-tool convention and React Flow has
 * no notion of it, so the board claims the event itself.
 *
 * Capture phase on the wrapper, so it is stopped before it reaches the
 * `wheel.zoom` listener d3 installs on the pane below. `preventDefault` is what
 * keeps Cmd + wheel from zooming the whole Electron window instead.
 *
 * The delta curve is deliberately React Flow's own `wheelDelta` *without* its
 * pinch branch: `2 ^ (-deltaY * 0.002)` is the rate this board zoomed at before
 * `panOnScroll`, so the gesture moved but the feel did not. The ten-fold factor
 * that branch applies is calibrated for the near-zero deltas a pinch emits and
 * would make a scroll unusable. The arithmetic itself is
 * `zoomViewportAtPoint`, which is pure and tested.
 */
import { useEffect } from 'react';
import type { useReactFlow } from '@xyflow/react';

import { zoomViewportAtPoint } from './canvasFlowMapping';

export function useCanvasWheelZoom(
  flow: ReturnType<typeof useReactFlow>,
  surfaceRef: { readonly current: HTMLElement | null },
  limits: { minZoom: number; maxZoom: number }
): void {
  const { minZoom, maxZoom } = limits;
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const onZoomWheel = (event: WheelEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();

      const bounds = surface.getBoundingClientRect();
      const next = zoomViewportAtPoint(
        flow.getViewport(),
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        { deltaY: event.deltaY, deltaMode: event.deltaMode },
        { minZoom, maxZoom }
      );
      if (next !== null) void flow.setViewport(next);
    };

    surface.addEventListener('wheel', onZoomWheel, {
      capture: true,
      passive: false,
    });
    return () =>
      surface.removeEventListener('wheel', onZoomWheel, { capture: true });
  }, [flow, maxZoom, minZoom, surfaceRef]);
}
