export { MIN_ZOOM, MAX_ZOOM } from './mapGestures';
export interface View {
    k: number;
    x: number;
    y: number;
}
export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}
/** Below 0.3 nothing is readable; below 1 only major pills; 1.3 and up, types list their properties. */
export declare function zoomTier(k: number): 'tiny' | 'fit' | 'mid' | 'near';
export declare function fitView(bounds: {
    width: number;
    height: number;
}, viewport: {
    width: number;
    height: number;
}, pad?: number): View;
export interface MapViewport {
    canvasRef: React.RefObject<HTMLDivElement | null>;
    svgRef: React.RefObject<SVGSVGElement | null>;
    sceneRef: React.RefObject<SVGGElement | null>;
    percentRef: React.RefObject<HTMLSpanElement | null>;
    miniViewRef: React.RefObject<SVGRectElement | null>;
    zoomBy: (factor: number) => void;
    fit: (animate?: boolean) => void;
    /** Center a box at zoom `k` (default: keep the current zoom, at least 1). */
    focus: (box: Box, k?: number) => void;
    /** Center a map point, keeping the zoom. */
    centerOn: (x: number, y: number) => void;
    panBy: (dx: number, dy: number) => void;
    /** True while (or just after) a drag moved the map: a click then is not a selection. */
    dragged: () => boolean;
    /** Re-applies the current view (after the minimap reopens). */
    refresh: () => void;
}
export declare function useMapViewport(bounds: {
    width: number;
    height: number;
} | null): MapViewport;
