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
import { columnIndexToLetter, columnLetterToIndex } from '../utils/csvParser';

/** Zero-based, inclusive bounds parsed from an A1 range key. */
export interface RangeBounds {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

const A1_CELL = /^([A-Za-z]+)(\d+)$/;

function parseA1Cell(text: string): { row: number; col: number } | null {
  const match = A1_CELL.exec(text.trim());
  if (!match) return null;
  const row = parseInt(match[2], 10) - 1;
  if (row < 0) return null;
  return { row, col: columnLetterToIndex(match[1]) };
}

/** Parse `B2` or `A1:C10` into zero-based inclusive bounds. */
export function parseRangeKey(key: string): RangeBounds | null {
  const [startText, endText] = key.split(':');
  const start = parseA1Cell(startText ?? '');
  if (!start) return null;
  if (endText === undefined) {
    return { startRow: start.row, startCol: start.col, endRow: start.row, endCol: start.col };
  }
  const end = parseA1Cell(endText);
  if (!end) return null;
  return {
    startRow: Math.min(start.row, end.row),
    startCol: Math.min(start.col, end.col),
    endRow: Math.max(start.row, end.row),
    endCol: Math.max(start.col, end.col),
  };
}

/** Build the canonical A1 key for a selection. */
export function rangeKeyOf(selection: NormalizedSelectionRange): string {
  const start = `${columnIndexToLetter(selection.startCol)}${selection.startRow + 1}`;
  if (selection.startRow === selection.endRow && selection.startCol === selection.endCol) {
    return start;
  }
  return `${start}:${columnIndexToLetter(selection.endCol)}${selection.endRow + 1}`;
}

function contains(bounds: RangeBounds, row: number, col: number): boolean {
  return row >= bounds.startRow && row <= bounds.endRow
    && col >= bounds.startCol && col <= bounds.endCol;
}

/** True when the style carries nothing worth persisting. */
export function isEmptyStyle(style: CellStyle): boolean {
  return !style.bold && !style.italic && !style.underline && !style.strikethrough
    && (style.textColor === undefined || style.textColor === 'default')
    && (style.fillColor === undefined || style.fillColor === 'default')
    && style.align === undefined;
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

/**
 * Apply a style change across a selection.
 *
 * When the selection matches an existing key exactly, the change merges into
 * that entry instead of stacking another one — otherwise toggling bold on and
 * off repeatedly would grow the metadata without bound. An entry left with
 * nothing set is removed.
 */
export function applyStyleToRange(
  ranges: CellStyleRanges,
  selection: NormalizedSelectionRange,
  change: CellStyle,
): CellStyleRanges {
  const key = rangeKeyOf(selection);
  const next: CellStyleRanges = { ...ranges };
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
  if (style.textColor && style.textColor !== 'default') {
    classes.push(`${COLOR_CLASS_PREFIX.text}-${style.textColor}`);
  }
  if (style.fillColor && style.fillColor !== 'default') {
    classes.push(`${COLOR_CLASS_PREFIX.fill}-${style.fillColor}`);
  }
  if (style.align) classes.push(`cell-align-${style.align}`);
  return classes;
}
