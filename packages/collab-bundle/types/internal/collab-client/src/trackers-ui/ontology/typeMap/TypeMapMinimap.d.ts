import type { TypeMapType } from '../ontologyLabelMap';
import type { MapLayout } from './typeMapLayout';
export interface TypeMapMinimapProps {
    layout: MapLayout;
    types: ReadonlyMap<string, TypeMapType>;
    zoneTone: ReadonlyMap<string, number>;
    viewRef: React.RefObject<SVGRectElement | null>;
    onJump: (x: number, y: number) => void;
    /** Redraws the outline after the minimap reopens. */
    onShown: () => void;
}
export declare const TypeMapMinimap: import("react").NamedExoticComponent<TypeMapMinimapProps>;
