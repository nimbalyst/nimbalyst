/**
 * Pixel layout for the 2x2: where the plot sits, how the axis captions wrap,
 * and which side of its dot each point label goes on so labels stay inside
 * the chart and off each other. Pure; text width comes from `measure`.
 */
import { type QuadrantLabels, type QuadrantPoint } from '../../core/quadrantModel';
export type MeasureText = (text: string, fontSize: number, bold?: boolean) => number;
export declare const QUADRANT_FONT = 14;
export declare const QUADRANT_PINNED_FONT = 15;
/** Line height, and the drop from a label box's top to its text baseline. */
export declare const QUADRANT_LINE: number;
export declare const QUADRANT_BASELINE: number;
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface PlacedLabel {
    point: QuadrantPoint;
    cx: number;
    cy: number;
    /** Text anchor point and alignment. */
    tx: number;
    ty: number;
    anchor: 'start' | 'middle' | 'end';
    text: string;
    /** A line from the dot to a label that had to sit away from it. */
    leader?: {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
    };
}
export interface QuadrantLayout {
    plot: Rect;
    xLines: string[];
    yLines: string[];
    corners: {
        text: string;
        x: number;
        y: number;
        anchor: 'start' | 'end';
    }[];
    points: PlacedLabel[];
}
/** Rough width when no canvas is available (tests, headless). */
export declare const estimateTextWidth: MeasureText;
/** Cuts `text` with an ellipsis until it fits `max`. */
export declare function fitText(text: string, max: number, fontSize: number, measure: MeasureText, bold?: boolean): string;
/** One line if it fits, else two lines split at the most balanced space, each cut to fit. */
export declare function wrapCaption(text: string, max: number, fontSize: number, measure: MeasureText): string[];
export declare function layoutQuadrant(width: number, height: number, points: readonly QuadrantPoint[], labels: QuadrantLabels, measure?: MeasureText): QuadrantLayout;
