/**
 * Cell and range styling.
 *
 * Styles are stored keyed by A1 range (`B2`, `A1:C10`) rather than per cell,
 * for two reasons: the metadata lives on one line of the CSV, so styling a
 * whole column has to cost one entry rather than ten thousand; and an A1 key is
 * legible to a human reading the file or a `git diff`.
 *
 * Ranges may overlap. Later entries win, which is what makes "select a block
 * and make it bold" behave — the new entry layers over whatever was underneath
 * instead of having to rewrite it.
 */

import type { CellStyle, CellStyleRanges, NormalizedSelectionRange } from '../types';
import { parseRangeKey, rangeKeyOf, rewriteWithin, type RangeBounds } from './rangeMath';

export { parseRangeKey, rangeKeyOf, type RangeBounds };

function contains(bounds: RangeBounds, row: number, col: number): boolean {
  return row >= bounds.startRow && row <= bounds.endRow
    && col >= bounds.startCol && col <= bounds.endCol;
}

/** True when the style carries nothing worth persisting. */
export function isEmptyStyle(style: CellStyle): boolean {
  return !style.bold && !style.italic && !style.underline && !style.strikethrough
    && (style.textColor === undefined || style.textColor === 'default')
    && (style.fillColor === undefined || style.fillColor === 'default')
    && style.align === undefined && style.verticalAlign === undefined;
}

/** True for a raw `#rrggbb` picker color, as opposed to a named swatch. */
export function isHexColor(color: string | undefined): color is `#${string}` {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);
}

/** Layer `next` over `base`, dropping keys reset to their neutral value. */
export function mergeStyles(base: CellStyle, next: CellStyle): CellStyle {
  const merged: CellStyle = { ...base, ...next };
  for (const key of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
    if (merged[key] === false) delete merged[key];
  }
  if (merged.textColor === 'default') delete merged.textColor;
  if (merged.fillColor === 'default') delete merged.fillColor;
  return merged;
}

/**
 * Resolved styling for painted cells.
 *
 * Ranges are scanned rather than expanded to per-cell entries — expanding a
 * whole-column style would allocate an entry per row. Lookups memoize, so a
 * repaint costs one scan per distinct cell rather than one per paint.
 */
export class CellStyleIndex {
  private readonly entries: { bounds: RangeBounds; style: CellStyle }[] = [];
  private readonly cache = new Map<string, CellStyle | null>();

  constructor(ranges: CellStyleRanges | undefined) {
    for (const [key, style] of Object.entries(ranges ?? {})) {
      const bounds = parseRangeKey(key);
      if (bounds) this.entries.push({ bounds, style });
    }
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** The merged style at a logical cell, or null when nothing applies. */
  styleAt(row: number, col: number): CellStyle | null {
    if (this.entries.length === 0) return null;
    const cacheKey = `${row}:${col}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    let resolved: CellStyle | null = null;
    for (const entry of this.entries) {
      if (!contains(entry.bounds, row, col)) continue;
      resolved = resolved === null ? { ...entry.style } : mergeStyles(resolved, entry.style);
    }
    this.cache.set(cacheKey, resolved);
    return resolved;
  }
}

/** A style value with its "unset" spellings (`false`, `'default'`) folded to undefined. */
function neutral(value: CellStyle[keyof CellStyle]): CellStyle[keyof CellStyle] {
  return value === false || value === 'default' ? undefined : value;
}

/**
 * Apply a style change across a selection.
 *
 * When the selection matches an existing key exactly, the change merges into
 * that entry instead of stacking another one — otherwise toggling bold on and
 * off repeatedly would grow the metadata without bound. An entry left with
 * nothing set is removed.
 *
 * Any other entry that sets a changed property to something else inside the
 * selection gives that property up there (it is split around the selection),
 * so the change is what the cells show whichever entry comes later: bold off
 * on a cell under a later bold range really turns it off.
 */
export function applyStyleToRange(
  ranges: CellStyleRanges,
  selection: NormalizedSelectionRange,
  change: CellStyle,
): CellStyleRanges {
  const key = rangeKeyOf(selection);
  const changed = Object.keys(change) as (keyof CellStyle)[];
  const next: CellStyleRanges = rewriteWithin(ranges, selection, (style) => {
    const kept: CellStyle = { ...style };
    for (const name of changed) {
      if (kept[name] !== undefined && neutral(kept[name]) !== neutral(change[name])) delete kept[name];
    }
    return isEmptyStyle(kept) ? null : kept;
  }, true);
  const merged = mergeStyles(next[key] ?? {}, change);

  if (isEmptyStyle(merged)) {
    delete next[key];
  } else {
    next[key] = merged;
  }
  return next;
}

const COLOR_CLASS_PREFIX = { text: 'csv-text', fill: 'csv-fill' } as const;

/** CSS class names for a resolved style, for `cellProperties`. */
export function styleClassNames(style: CellStyle): string[] {
  const classes: string[] = [];
  if (style.bold) classes.push('csv-cell-bold');
  if (style.italic) classes.push('csv-cell-italic');
  if (style.underline) classes.push('csv-cell-underline');
  if (style.strikethrough) classes.push('csv-cell-strike');
  if (style.textColor && style.textColor !== 'default' && !isHexColor(style.textColor)) {
    classes.push(`${COLOR_CLASS_PREFIX.text}-${style.textColor}`);
  }
  if (style.fillColor && style.fillColor !== 'default' && !isHexColor(style.fillColor)) {
    classes.push(`${COLOR_CLASS_PREFIX.fill}-${style.fillColor}`);
  }
  if (isHexColor(style.textColor)) classes.push('csv-text-custom');
  if (isHexColor(style.fillColor)) classes.push('csv-fill-custom');
  if (style.align) classes.push(`cell-align-${style.align}`);
  if (style.verticalAlign) classes.push(`cell-valign-${style.verticalAlign}`);
  return classes;
}

/**
 * Inline CSS for the parts of a style a class cannot carry (picker hex colors).
 * Set as custom properties that the `csv-text-custom` / `csv-fill-custom`
 * classes read, because the cell text color is an `!important` theme rule an
 * inline `color` would lose to.
 */
export function styleInlineCss(style: CellStyle): Record<string, string> | null {
  const css: Record<string, string> = {};
  if (isHexColor(style.textColor)) css['--csv-text-color'] = style.textColor;
  if (isHexColor(style.fillColor)) css['--csv-fill-color'] = style.fillColor;
  return Object.keys(css).length > 0 ? css : null;
}
