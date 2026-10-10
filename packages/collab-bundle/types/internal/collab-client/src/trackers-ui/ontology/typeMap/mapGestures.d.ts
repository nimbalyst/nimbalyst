import type { View } from './useMapViewport';
export declare const MIN_ZOOM = 0.2;
export declare const MAX_ZOOM = 3;
interface GestureViewport {
    getView: () => View;
    setView: (view: View) => void;
    setDragged: (dragged: boolean) => void;
    stopAnimation: () => void;
    zoomAt: (factor: number, x: number, y: number) => void;
}
/** Native listeners keep trackpad and touch gestures out of React's render path. */
export declare function bindMapGestures(canvas: HTMLDivElement, viewport: GestureViewport): () => void;
export {};
