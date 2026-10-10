/**
 * The 2x2 drawing, shared by the static fenced block and the query view.
 * Drawn at its frame's real pixel size so text stays at a fixed size (a
 * scaled viewBox blew labels up on wide pages). The frame fills its
 * container's width and takes `height`. Label placement lives in
 * `quadrantLayout.ts`. Colors come from `--nim-*` variables so it follows
 * the theme.
 */
import { type JSX, type MutableRefObject } from 'react';
import type { QuadrantLabels, QuadrantPoint } from '../../core/quadrantModel';
export declare const DEFAULT_QUADRANT_HEIGHT = 360;
export interface QuadrantChartProps extends QuadrantLabels {
    points: readonly QuadrantPoint[];
    /** Drawing height in px; the width follows the container. */
    height?: number;
    /** The sized frame, for a container that measures it. */
    frameRef?: MutableRefObject<HTMLDivElement | null>;
    /** Opens an item's page when a query point is clicked. */
    onOpenPoint?: (id: string) => void;
}
export declare function QuadrantChart({ points, xLabel, yLabel, quadrants, height: frameHeight, frameRef, onOpenPoint, }: QuadrantChartProps): JSX.Element;
