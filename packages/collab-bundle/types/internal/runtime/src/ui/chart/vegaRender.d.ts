/**
 * The Vega half of a chart: validate a Vega-Lite spec, then draw it. This
 * module pulls in vega, vega-lite and vega-embed, so `VegaChart` imports it
 * dynamically the first time a chart mounts -- a page without a chart never
 * loads it.
 *
 * Expressions run through `vega-interpreter` (`ast: true`), never Vega's
 * default `new Function` evaluator: the web console's CSP has no
 * `'unsafe-eval'`, and one code path for every host is simpler than two.
 *
 * A chart is page content anyone with edit access can write, so the view is
 * built from app-owned options only and is sealed off from the network:
 *   - `usermeta` is dropped before embedding; vega-embed would otherwise merge
 *     `usermeta.embedOptions` over ours (turning `ast` off, loading a config URL).
 *   - The loader refuses every URL, so data must be inline and image marks and
 *     `href` links resolve to nothing.
 *   - Tooltips render as escaped text, never images or markup.
 * `compileChart` rejects the same vectors up front so the block can say why.
 */
import type { VegaLiteSpec } from './chartSpec';
export interface VegaValidation {
    /** Vega-Lite's own spec, compiled to Vega; absent when `error` is set. */
    vegaSpec?: Record<string, unknown>;
    error?: string;
    warnings: string[];
}
/**
 * Vega-Lite drops many mistakes with a console warning and draws an empty
 * chart. Compiling up front surfaces the error and the warnings so the block
 * can say what is wrong.
 */
export declare function validateVegaLite(spec: VegaLiteSpec, config?: Record<string, unknown>): VegaValidation;
export interface VegaChartHandle {
    /** Sets the drawing width; for specs whose width follows the container. */
    setWidth(width: number): void;
    finalize(): void;
}
/**
 * vega-tooltip's `formatTooltip`: its return value is set as innerHTML, so
 * everything is escaped here, and the `image` key (which vega-tooltip would
 * turn into an <img>) is dropped.
 */
export declare function formatChartTooltip(value: unknown): string;
export declare function renderVegaChart(container: HTMLElement, vegaSpec: Record<string, unknown>, options: {
    dark: boolean;
}): Promise<VegaChartHandle>;
