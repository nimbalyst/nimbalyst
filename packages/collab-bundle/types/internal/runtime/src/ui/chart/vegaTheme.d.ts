/**
 * A Vega config built from the `--nim-*` theme variables, read when a chart
 * mounts and again when the theme changes, so charts follow every theme
 * (including custom ones) rather than a light/dark guess.
 */
export interface ChartThemeColors {
    text: string;
    muted: string;
    faint: string;
    border: string;
    background: string;
    dark: boolean;
    font: string;
}
/** Reads the theme variables off `element` (they cascade from the app root). */
export declare function readChartThemeColors(element: Element): ChartThemeColors;
export declare function buildVegaConfig(colors: ChartThemeColors): Record<string, unknown>;
