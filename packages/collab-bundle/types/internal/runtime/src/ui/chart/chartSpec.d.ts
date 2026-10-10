/**
 * Compiles the small chart spec (what agents write in a ```chart fence, and
 * what a "Chart: <Type>" placed view builds from items) to a Vega-Lite spec.
 *
 *   type: bar | line | area | pie | scatter
 *   title: Sessions per week          (optional)
 *   x: week                           column on the x axis (pie: the slices)
 *   y: [desktop, web]                 one column, or a list = one series each
 *   data: |                           inline CSV with a header row,
 *     week,desktop,web                or a YAML list of rows
 *     W36,120,14
 *   width: 520                        (optional) block width in px; unset fills the column
 *   height: 300                       (optional) plot height in px
 *
 * Escape hatch: `vega-lite:` holds a full Vega-Lite spec (a YAML mapping or a
 * JSON string). When that spec has no `data`, the fence's `data` rows become
 * its inline values.
 *
 * Interactivity comes with the small spec: a tooltip on every mark, hover
 * highlight, click a legend entry to fade a series, and x-axis zoom/pan on
 * line, area and scatter when x is numeric or a date.
 *
 * Pure and React-free: unit-tested in node, and shared by the editor block
 * and the placed view.
 */
export declare const CHART_TYPES: readonly ["bar", "line", "area", "pie", "scatter"];
export type ChartType = (typeof CHART_TYPES)[number];
export type ChartRow = Record<string, unknown>;
/** Field and value names the folded multi-series data uses. */
export declare const SERIES_FIELD = "series";
export declare const VALUE_FIELD = "value";
/** A Vega-Lite top-level spec; typed loosely so this module carries no vega-lite import. */
export type VegaLiteSpec = Record<string, unknown>;
export type ChartCompileResult = {
    ok: true;
    spec: VegaLiteSpec;
} | {
    ok: false;
    error: string;
};
/** The fence's `data` as rows: CSV text, or a YAML list of mappings. */
export declare function chartRows(data: unknown): {
    rows?: ChartRow[];
    error?: string;
};
export declare const MIN_CHART_WIDTH = 240;
export declare const MIN_CHART_HEIGHT = 120;
export declare const MAX_CHART_HEIGHT = 1200;
export interface ChartBlockSize {
    /** The block's width in px; unset fills the column. */
    width?: number;
    /** The plot's height in px; unset uses the renderer's default. */
    height?: number;
}
/** The block size a fence's top-level `width:` / `height:` set (dragged with the block's handles). */
export declare function chartBlockSize(definition: Readonly<Record<string, unknown>>): ChartBlockSize;
/** Compiles the text of a ```chart fence, with the block size it sets. */
export declare function compileChartSource(source: string): ChartCompileResult & {
    size: ChartBlockSize;
};
export interface ChartCompileOptions {
    /** Axis and tooltip titles for columns whose key is not meant to be read (a placed view's internal keys). */
    fieldTitles?: Readonly<Record<string, string>>;
}
/** Compiles a parsed fence body (or an equivalent object) to a Vega-Lite spec. */
export declare function compileChart(definition: Readonly<Record<string, unknown>>, options?: ChartCompileOptions): ChartCompileResult;
