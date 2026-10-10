/**
 * A Vega config built from the `--nim-*` theme variables, read when a chart
 * mounts and again when the theme changes, so charts follow every theme
 * (including custom ones) rather than a light/dark guess.
 */

/** Series colors; the same families the transcript charts use. */
const LIGHT_SERIES = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];
const DARK_SERIES = ['#818cf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#f472b6', '#22d3ee', '#fb923c'];

export interface ChartThemeColors {
  text: string;
  muted: string;
  faint: string;
  border: string;
  background: string;
  dark: boolean;
  font: string;
}

function relativeLuminance(color: string): number | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(color.trim());
  let channels: number[];
  if (hex) {
    const value = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  } else if (rgb) {
    channels = [rgb[1], rgb[2], rgb[3]].map(Number);
  } else {
    return null;
  }
  const [r, g, b] = channels.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Reads the theme variables off `element` (they cascade from the app root). */
export function readChartThemeColors(element: Element): ChartThemeColors {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const background = read('--nim-bg', '#ffffff');
  const luminance = relativeLuminance(background);
  return {
    text: read('--nim-text', '#1f2937'),
    muted: read('--nim-text-muted', '#6b7280'),
    faint: read('--nim-text-faint', '#9ca3af'),
    border: read('--nim-border', '#e5e7eb'),
    background,
    dark: luminance !== null ? luminance < 0.4 : false,
    font: style.fontFamily || 'system-ui, sans-serif',
  };
}

export function buildVegaConfig(colors: ChartThemeColors): Record<string, unknown> {
  const series = colors.dark ? DARK_SERIES : LIGHT_SERIES;
  // Styled like the transcript's charts: a dashed grid, muted axes.
  const axis = {
    domainColor: colors.muted,
    gridColor: colors.border,
    gridDash: [3, 3],
    tickColor: colors.muted,
    labelColor: colors.muted,
    titleColor: colors.muted,
    labelFont: colors.font,
    titleFont: colors.font,
    labelFontSize: 12,
    titleFontSize: 12,
    titleFontWeight: 500,
  };
  return {
    background: 'transparent',
    font: colors.font,
    view: { stroke: null },
    title: { color: colors.text, font: colors.font, fontSize: 13, fontWeight: 600, anchor: 'start', offset: 10 },
    axis,
    // Horizontal labels that drop alternates rather than collide.
    axisX: { grid: false, labelAngle: 0, labelOverlap: true, labelSeparation: 8 },
    legend: {
      labelColor: colors.muted,
      titleColor: colors.muted,
      labelFont: colors.font,
      titleFont: colors.font,
      labelFontSize: 11,
      symbolType: 'circle',
      orient: 'bottom',
      direction: 'horizontal',
    },
    range: { category: series },
    mark: { color: series[0] },
    arc: { stroke: colors.background, strokeWidth: 1 },
    line: { strokeWidth: 2 },
    point: { size: 30 },
  };
}
