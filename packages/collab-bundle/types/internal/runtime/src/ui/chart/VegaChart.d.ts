/**
 * Draws a Vega-Lite spec, themed from the `--nim-*` variables. Vega itself
 * (`./vegaRender`) loads on the first mount, so a page with no chart never
 * pays for it. A spec that does not compile shows its error in place of the
 * chart rather than an empty frame.
 *
 * Shared by the ```chart block and the "Chart: <Type>" placed view.
 */
import { type JSX } from 'react';
import type { VegaLiteSpec } from './chartSpec';
export declare const DEFAULT_CHART_HEIGHT = 260;
export interface VegaChartProps {
    spec: VegaLiteSpec;
    height?: number;
    className?: string;
}
export declare function VegaChart({ spec, height, className }: VegaChartProps): JSX.Element;
export default VegaChart;
