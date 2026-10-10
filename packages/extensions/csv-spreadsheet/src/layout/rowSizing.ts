/**
 * Row heights and column auto-fit, as pure functions of text, widths and a
 * text measurer.
 *
 * A row's height is, in order: the height the user set (`rowHeights`), else
 * the height its wrapped cells need, else the default. RevoGrid takes sizes
 * per section and by *visible* index (`rowDefinitions`), so the logical sizes
 * are mapped through the current row mapping every time trimming changes.
 */

export const DEFAULT_ROW_HEIGHT = 24;
export const WRAP_LINE_HEIGHT = 16;
/** Vertical padding of a wrapped cell (see `.csv-cell-wrap`). */
export const WRAP_PADDING = 8;
/** Horizontal padding of every cell (see revogrid-theme.css). */
export const CELL_PADDING_X = 16;
export const MIN_COLUMN_WIDTH = 40;
export const MAX_AUTO_COLUMN_WIDTH = 600;

export type MeasureText = (text: string) => number;

/** Lines `text` takes when word-wrapped into `width` pixels. Explicit line breaks always break. */
export function wrapLineCount(text: string, width: number, measure: MeasureText): number {
  if (width <= 0) return Math.max(1, text.split('\n').length);
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    lines += 1;
    let line = 0;
    for (const word of paragraph.split(/(\s+)/)) {
      if (word === '') continue;
      const w = measure(word);
      if (line + w <= width || line === 0) {
        // A word wider than the cell breaks anywhere (`overflow-wrap: anywhere`).
        if (line === 0 && w > width && !/^\s+$/.test(word)) {
          const extra = Math.ceil(w / width) - 1;
          lines += extra;
          line = w - extra * width;
        } else {
          line += w;
        }
        continue;
      }
      if (/^\s+$/.test(word)) continue;
      lines += 1;
      line = w > width ? w % width : w;
      if (w > width) lines += Math.ceil(w / width) - 1;
    }
  }
  return Math.max(1, lines);
}

/** Height a wrapped cell needs for `text` in a column `columnWidth` wide. */
export function wrappedCellHeight(text: string, columnWidth: number, measure: MeasureText): number {
  if (text === '') return DEFAULT_ROW_HEIGHT;
  const lines = wrapLineCount(text, columnWidth - CELL_PADDING_X, measure);
  return Math.max(DEFAULT_ROW_HEIGHT, lines * WRAP_LINE_HEIGHT + WRAP_PADDING);
}

/** Width that fits every text in a column, within sensible bounds. */
export function autoFitWidth(texts: Iterable<string>, measure: MeasureText): number {
  let widest = 0;
  for (const text of texts) {
    for (const line of text.split('\n')) widest = Math.max(widest, measure(line));
  }
  return Math.round(Math.min(MAX_AUTO_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, widest + CELL_PADDING_X + 4)));
}

export interface RowDefinition {
  type: 'rgRow' | 'rowPinStart';
  index: number;
  size: number;
}

/**
 * RevoGrid row definitions for logical row heights. Pinned rows are their own
 * section indexed from 0; body rows are indexed by visible position, so a
 * hidden or filtered row's height is simply not emitted.
 */
export function rowDefinitionsFor(
  heights: ReadonlyMap<number, number>,
  pinnedRowCount: number,
  logicalToVisible: (logical: number) => number | undefined,
): RowDefinition[] {
  const definitions: RowDefinition[] = [];
  for (const [row, size] of heights) {
    if (size === DEFAULT_ROW_HEIGHT) continue;
    if (row < pinnedRowCount) {
      definitions.push({ type: 'rowPinStart', index: row, size });
      continue;
    }
    const visible = logicalToVisible(row);
    if (visible === undefined) continue;
    definitions.push({ type: 'rgRow', index: visible - pinnedRowCount, size });
  }
  return definitions.sort((a, b) => (a.type === b.type ? a.index - b.index : a.type === 'rowPinStart' ? -1 : 1));
}

/**
 * The height of every row that is not the default: explicit heights win, then
 * the tallest wrapped cell. `wrappedCells` yields each wrapped cell's row, text
 * and column width.
 */
export function rowHeightsFor(
  explicit: Readonly<Record<number, number>>,
  wrappedCells: Iterable<{ row: number; text: string; width: number }>,
  measure: MeasureText,
): Map<number, number> {
  const heights = new Map<number, number>();
  for (const { row, text, width } of wrappedCells) {
    if (explicit[row] !== undefined) continue;
    const height = wrappedCellHeight(text, width, measure);
    if (height > (heights.get(row) ?? DEFAULT_ROW_HEIGHT)) heights.set(row, height);
  }
  for (const [row, height] of Object.entries(explicit)) heights.set(Number(row), height);
  return heights;
}

/** A canvas-backed measurer for the grid font; falls back to a fixed advance without canvas (tests). */
export function createTextMeasurer(font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'): MeasureText {
  let context: CanvasRenderingContext2D | null = null;
  try {
    // jsdom has no canvas and reports every getContext call as an error.
    const jsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
    context = typeof document !== 'undefined' && !jsdom ? document.createElement('canvas').getContext('2d') : null;
  } catch {
    context = null;
  }
  if (!context) return (text) => text.length * 7;
  context.font = font;
  const cache = new Map<string, number>();
  return (text) => {
    let width = cache.get(text);
    if (width === undefined) {
      width = context!.measureText(text).width;
      if (cache.size > 5000) cache.clear();
      cache.set(text, width);
    }
    return width;
  };
}
