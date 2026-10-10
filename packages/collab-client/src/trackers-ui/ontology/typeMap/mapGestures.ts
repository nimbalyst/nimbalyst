import type { View } from './useMapViewport';

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;

type Point = { x: number; y: number };
interface GestureViewport {
  getView: () => View;
  setView: (view: View) => void;
  setDragged: (dragged: boolean) => void;
  stopAnimation: () => void;
  zoomAt: (factor: number, x: number, y: number) => void;
}

/** Native listeners keep trackpad and touch gestures out of React's render path. */
export function bindMapGestures(canvas: HTMLDivElement, viewport: GestureViewport): () => void {
  const pointers = new Map<number, Point>();
  let start: { center: Point; distance: number; view: View } | null = null;
  let dragging = false;
  const excluded = (target: EventTarget | null) => target instanceof Element && target.closest('.type-map-minimap, .type-map-hud');
  const position = (event: PointerEvent | WheelEvent): Point => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const geometry = () => {
    const [a, b] = [...pointers.values()];
    if (!a) return null;
    return {
      center: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a,
      distance: b ? Math.hypot(b.x - a.x, b.y - a.y) : 0,
    };
  };
  const rebase = () => {
    const current = geometry();
    start = current ? { ...current, view: { ...viewport.getView() } } : null;
  };
  const beginDrag = () => {
    dragging = true;
    viewport.setDragged(true);
    canvas.setAttribute('data-dragging', 'true');
    for (const id of pointers.keys()) canvas.setPointerCapture(id);
  };
  const onWheel = (event: WheelEvent) => {
    if (excluded(event.target)) return;
    event.preventDefault();
    viewport.stopAnimation();
    // Chromium reports trackpad pinches as ctrl+wheel; ordinary two-finger
    // scrolling supplies both axes. Normalize line/page wheels to CSS pixels.
    const dx = event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientWidth : 1);
    const dy = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
    if (event.ctrlKey) {
      const point = position(event);
      viewport.zoomAt(Math.exp(-dy * 0.01), point.x, point.y);
    } else {
      const view = viewport.getView();
      viewport.setView({ ...view, x: view.x - dx, y: view.y - dy });
    }
    rebase();
  };
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 || excluded(event.target) || pointers.size >= 2) return;
    viewport.stopAnimation();
    if (!pointers.size) {
      dragging = false;
      viewport.setDragged(false);
    }
    pointers.set(event.pointerId, position(event));
    rebase();
    // A second contact is a gesture even before it moves, never a type click.
    if (pointers.size === 2) beginDrag();
  };
  const onMove = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId) || !start) return;
    pointers.set(event.pointerId, position(event));
    const current = geometry()!;
    const dx = current.center.x - start.center.x;
    const dy = current.center.y - start.center.y;
    if (!dragging && Math.abs(dx) + Math.abs(dy) <= 3) return;
    if (!dragging) beginDrag();
    const factor = start.distance > 0 && current.distance > 0 ? current.distance / start.distance : 1;
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, start.view.k * factor));
    viewport.setView({
      k,
      x: current.center.x - (start.center.x - start.view.x) * k / start.view.k,
      y: current.center.y - (start.center.y - start.view.y) * k / start.view.k,
    });
  };
  const onUp = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    rebase();
    if (!pointers.size) canvas.removeAttribute('data-dragging');
    // Keep click suppression until the next pointerdown, including delayed
    // touch clicks and the interval between lifting the first and last finger.
  };
  const onLostCapture = (event: PointerEvent) => {
    // Touch starts with implicit capture on the hit node. Transferring that
    // capture to the canvas bubbles a loss from the node, not an ended gesture.
    if (event.target === canvas && !canvas.hasPointerCapture(event.pointerId)) onUp(event);
  };
  const clear = () => {
    const ids = [...pointers.keys()];
    pointers.clear();
    start = null;
    for (const id of ids) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    canvas.removeAttribute('data-dragging');
  };
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('lostpointercapture', onLostCapture);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('blur', clear);
  return () => {
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('lostpointercapture', onLostCapture);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('blur', clear);
    clear();
  };
}
