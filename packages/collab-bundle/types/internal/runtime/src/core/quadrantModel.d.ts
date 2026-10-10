/**
 * The 2x2's data and layout, shared by the static fenced block and the
 * query view (a type's items placed by two number fields). Pure: no React,
 * no DOM, so the headless node graph can import the fence parser through it.
 */
export interface QuadrantPoint {
    /** Item id for a query point, `pin:<n>` for a pinned extra point. */
    id: string;
    label: string;
    x: number;
    y: number;
    /** Drawn highlighted: the point the page is about (e.g. us among competitors). */
    pinned: boolean;
}
/** An extra point placed by hand on top of a query 2x2. */
export interface QuadrantPin {
    label: string;
    x: number;
    y: number;
}
export interface QuadrantLabels {
    /** Low-to-high caption under the x axis. */
    xLabel?: string;
    /** Low-to-high caption beside the y axis. */
    yLabel?: string;
    /** Top-left, top-right, bottom-left, bottom-right. */
    quadrants?: readonly string[];
}
export interface QuadrantRange {
    min: number;
    max: number;
}
/**
 * The axis span: [0, 1] when every value fits (scores usually do), otherwise
 * the data's own span widened to include 0 and 1 so a mixed scale still reads.
 */
export declare function quadrantRange(values: readonly number[]): QuadrantRange;
/** 0..1 position of `value` within `range`, clamped. */
export declare function quadrantFraction(value: number, range: QuadrantRange): number;
/** A number from a field value (numbers, numeric strings), or null. */
export declare function quadrantNumber(value: unknown): number | null;
