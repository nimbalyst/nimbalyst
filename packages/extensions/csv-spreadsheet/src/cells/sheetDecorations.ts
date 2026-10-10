/**
 * Per-cell lookups for what the Phase 3 metadata paints: the effective number
 * format (a cell format over the column's), wrap, borders and the validation
 * rule. Built once per metadata change; every lookup memoizes per cell, so a
 * repaint costs one scan per distinct cell rather than one per paint, the same
 * contract as `CellStyleIndex`.
 *
 * Coordinates are logical sheet rows (header rows included), never RevoGrid's
 * visible row index.
 */

import type { CellColor, ColumnFormat, HexColor } from '../types';
import type { ValidationRule, ValidationRules } from '../validation/types';
import { findValidationRule } from '../validation/validate';
import { parseRangeKey, type RangeBounds } from './cellStyles';
import type { BorderSide, RangeBorders } from '../sheetMeta/formatting';

/** Range-keyed values where the later entry wins outright. */
export class RangeIndex<T> {
  private readonly entries: { bounds: RangeBounds; value: T }[] = [];
  private readonly cache = new Map<string, T | null>();

  constructor(record: Readonly<Record<string, T>> | undefined) {
    for (const [key, value] of Object.entries(record ?? {})) {
      const bounds = parseRangeKey(key);
      if (bounds) this.entries.push({ bounds, value });
    }
    this.entries.reverse();
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  at(row: number, col: number): T | null {
    if (this.entries.length === 0) return null;
    const key = `${row}:${col}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const hit = this.entries.find(({ bounds }) => row >= bounds.startRow && row <= bounds.endRow
      && col >= bounds.startCol && col <= bounds.endCol);
    const value = hit ? hit.value : null;
    this.cache.set(key, value);
    return value;
  }
}

export type BorderEdge = 'top' | 'bottom' | 'left' | 'right';

const LINE_CSS: Record<BorderSide['style'], string> = {
  thin: '1px solid',
  medium: '2px solid',
  thick: '3px solid',
  dashed: '1px dashed',
  dotted: '1px dotted',
  double: '3px double',
};

const NAMED_BORDER_COLORS: Record<Exclude<CellColor, 'default'>, string> = {
  red: 'var(--nim-error)',
  orange: 'var(--nim-warning, #d98324)',
  yellow: '#b58900',
  green: 'var(--nim-success, #2ea043)',
  blue: 'var(--nim-primary)',
  purple: '#8957e5',
  gray: 'var(--nim-text-muted)',
};

export function borderColorCss(color: CellColor | HexColor | undefined): string {
  if (!color || color === 'default') return 'var(--nim-text)';
  if (color.startsWith('#')) return color;
  return NAMED_BORDER_COLORS[color as Exclude<CellColor, 'default'>] ?? 'var(--nim-text)';
}

/**
 * The border on each edge of one cell. A range's outer sides land on the cells
 * along its perimeter; inner sides are drawn on the top / left edge of every
 * cell after the first row / column, so an inner line is drawn once, not twice.
 * Later entries win per edge, and `null` clears an edge.
 */
export function resolveCellBorders(
  entries: readonly { bounds: RangeBounds; borders: RangeBorders }[],
  row: number,
  col: number,
): Partial<Record<BorderEdge, BorderSide>> {
  const edges: Partial<Record<BorderEdge, BorderSide | null>> = {};
  for (const { bounds, borders } of entries) {
    if (row < bounds.startRow || row > bounds.endRow || col < bounds.startCol || col > bounds.endCol) continue;
    const set = (edge: BorderEdge, side: BorderSide | null | undefined) => {
      if (side !== undefined) edges[edge] = side;
    };
    set('top', row === bounds.startRow ? borders.top : borders.innerHorizontal);
    if (row === bounds.endRow) set('bottom', borders.bottom);
    set('left', col === bounds.startCol ? borders.left : borders.innerVertical);
    if (col === bounds.endCol) set('right', borders.right);
  }
  const resolved: Partial<Record<BorderEdge, BorderSide>> = {};
  for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
    const side = edges[edge];
    if (side) resolved[edge] = side;
  }
  return resolved;
}

/** Inline CSS for a cell's borders, or null when it has none. */
export function bordersCss(edges: Partial<Record<BorderEdge, BorderSide>>): Record<string, string> | null {
  const css: Record<string, string> = {};
  for (const [edge, side] of Object.entries(edges) as [BorderEdge, BorderSide][]) {
    css[`border-${edge}`] = `${LINE_CSS[side.style] ?? LINE_CSS.thin} ${borderColorCss(side.color)}`;
  }
  return Object.keys(css).length > 0 ? css : null;
}

export interface DecorationSource {
  columnFormats: Readonly<Record<number, ColumnFormat>>;
  cellFormats: Readonly<Record<string, ColumnFormat>>;
  wrap: readonly string[];
  borders: Readonly<Record<string, RangeBorders>>;
  validation: ValidationRules;
}

export class SheetDecorations {
  private readonly cellFormats: RangeIndex<ColumnFormat>;
  private readonly wrapIndex: RangeIndex<true>;
  private readonly borderEntries: { bounds: RangeBounds; borders: RangeBorders }[] = [];
  private readonly borderCache = new Map<string, Record<string, string> | null>();

  constructor(private readonly source: DecorationSource) {
    this.cellFormats = new RangeIndex(source.cellFormats);
    this.wrapIndex = new RangeIndex(Object.fromEntries(source.wrap.map((key) => [key, true as const])));
    for (const [key, borders] of Object.entries(source.borders)) {
      const bounds = parseRangeKey(key);
      if (bounds) this.borderEntries.push({ bounds, borders });
    }
  }

  /** The format a cell displays with: its own, else its column's. */
  formatAt(row: number, col: number): ColumnFormat | undefined {
    return this.cellFormats.at(row, col) ?? this.source.columnFormats[col];
  }

  /** True when any cell in the column carries a format of its own. */
  get hasCellFormats(): boolean {
    return !this.cellFormats.isEmpty;
  }

  wraps(row: number, col: number): boolean {
    return this.wrapIndex.at(row, col) === true;
  }

  get hasWrap(): boolean {
    return !this.wrapIndex.isEmpty;
  }

  borderCssAt(row: number, col: number): Record<string, string> | null {
    if (this.borderEntries.length === 0) return null;
    const key = `${row}:${col}`;
    const cached = this.borderCache.get(key);
    if (cached !== undefined) return cached;
    const css = bordersCss(resolveCellBorders(this.borderEntries, row, col));
    this.borderCache.set(key, css);
    return css;
  }

  validationAt(row: number, col: number): ValidationRule | null {
    return findValidationRule(this.source.validation, row, col)?.rule ?? null;
  }
}
