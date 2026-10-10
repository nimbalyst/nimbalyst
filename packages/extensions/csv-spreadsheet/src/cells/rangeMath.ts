/**
 * Rectangle arithmetic on range-keyed metadata (`cellStyles`, `cellFormats`,
 * `validation`, `wrap`): overlap, subtraction, and removing a selection from a
 * record while keeping the uncovered remainder of every entry it cut.
 */

import type { NormalizedSelectionRange } from '../types';
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

export function contains(outer: NormalizedSelectionRange, inner: NormalizedSelectionRange): boolean {
  return inner.startRow >= outer.startRow && inner.endRow <= outer.endRow
    && inner.startCol >= outer.startCol && inner.endCol <= outer.endCol;
}

export function overlaps(a: NormalizedSelectionRange, b: NormalizedSelectionRange): boolean {
  return a.startRow <= b.endRow && b.startRow <= a.endRow && a.startCol <= b.endCol && b.startCol <= a.endCol;
}

export function intersection(a: NormalizedSelectionRange, b: NormalizedSelectionRange): NormalizedSelectionRange | null {
  if (!overlaps(a, b)) return null;
  return {
    startRow: Math.max(a.startRow, b.startRow),
    endRow: Math.min(a.endRow, b.endRow),
    startCol: Math.max(a.startCol, b.startCol),
    endCol: Math.min(a.endCol, b.endCol),
  };
}

/** `outer` minus `hole`, as up to four rectangles. */
export function subtractRange(outer: NormalizedSelectionRange, hole: NormalizedSelectionRange): NormalizedSelectionRange[] {
  const pieces: NormalizedSelectionRange[] = [];
  const top = Math.max(outer.startRow, hole.startRow);
  const bottom = Math.min(outer.endRow, hole.endRow);
  if (hole.startRow > outer.startRow) pieces.push({ ...outer, endRow: Math.min(outer.endRow, hole.startRow - 1) });
  if (hole.endRow < outer.endRow) pieces.push({ ...outer, startRow: Math.max(outer.startRow, hole.endRow + 1) });
  if (top <= bottom) {
    if (hole.startCol > outer.startCol) pieces.push({ startRow: top, endRow: bottom, startCol: outer.startCol, endCol: Math.min(outer.endCol, hole.startCol - 1) });
    if (hole.endCol < outer.endCol) pieces.push({ startRow: top, endRow: bottom, startCol: Math.max(outer.startCol, hole.endCol + 1), endCol: outer.endCol });
  }
  return pieces;
}

/** Other spellings of a range's key (`B2:A1`, `A1:A1`); every parser normalizes them. */
function aliasKeys(bounds: RangeBounds): string[] {
  const cell = (row: number, col: number) => `${columnIndexToLetter(col)}${row + 1}`;
  const start = cell(bounds.startRow, bounds.startCol);
  const end = cell(bounds.endRow, bounds.endCol);
  const lowerLeft = cell(bounds.endRow, bounds.startCol);
  const upperRight = cell(bounds.startRow, bounds.endCol);
  return [...new Set([`${start}:${end}`, `${end}:${start}`, `${lowerLeft}:${upperRight}`, `${upperRight}:${lowerLeft}`])];
}

/**
 * Builds a range-keyed record in precedence order (later entries win where
 * ranges overlap) as entries are put one at a time.
 *
 * A put to a key already present takes the later position. For a wholesale
 * field (formats, validation) the later value replaces the earlier one. For a
 * `layered` field (styles, borders: a later entry's set properties win and its
 * unset ones fall through) the two merge per property, except for a property
 * some entry between them also sets over that range: moving the earlier value
 * past it would flip which one wins, so that property stays at the earlier
 * position under an alias spelling of the key.
 */
export class RangeRecordBuilder<T> {
  private readonly entries: { key: string; bounds: RangeBounds | null; value: T }[] = [];
  private readonly keys = new Set<string>();

  constructor(private readonly layered = false) {}

  put(key: string, value: T): void {
    const bounds = parseRangeKey(key);
    if (!this.keys.has(key)) {
      this.keys.add(key);
      this.entries.push({ key, bounds, value });
      return;
    }
    const index = this.entries.findIndex((entry) => entry.key === key);
    const [existing] = this.entries.splice(index, 1);
    if (!this.layered || !isObject(existing.value) || !isObject(value)) {
      this.entries.push({ key, bounds, value });
      return;
    }
    const later = this.entries.slice(index);
    const conflicted = bounds
      ? Object.keys(existing.value).filter((property) => !(property in value)
        && later.some((entry) => entry.bounds && overlaps(entry.bounds, bounds) && isObject(entry.value) && property in entry.value))
      : [];
    const alias = conflicted.length > 0 && bounds
      ? aliasKeys(bounds).find((candidate) => !this.keys.has(candidate) && candidate !== key)
      : undefined;
    const moved: Record<string, unknown> = { ...existing.value };
    if (alias) {
      const kept: Record<string, unknown> = {};
      for (const property of conflicted) {
        kept[property] = moved[property];
        delete moved[property];
      }
      this.keys.add(alias);
      this.entries.splice(index, 0, { key: alias, bounds, value: kept as T });
    }
    this.entries.push({ key, bounds, value: { ...moved, ...value } as T });
  }

  toRecord(): Record<string, T> {
    const record: Record<string, T> = {};
    for (const entry of this.entries) record[entry.key] = entry.value;
    return record;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rewrite every entry that overlaps `range`, in place. `inside` gives the
 * value the overlapped part keeps (null drops it); the uncovered part keeps the
 * original value. Entries that do not overlap are untouched, so precedence
 * between entries is preserved. A key two pieces land on resolves as
 * `RangeRecordBuilder` does, per property when `layered`.
 */
export function rewriteWithin<T>(
  record: Readonly<Record<string, T>>,
  range: NormalizedSelectionRange,
  inside: (value: T) => T | null,
  layered = false,
): Record<string, T> {
  const builder = new RangeRecordBuilder<T>(layered);
  const put = (key: string, value: T) => builder.put(key, value);
  for (const [key, value] of Object.entries(record)) {
    const bounds = parseRangeKey(key);
    const overlap = bounds ? intersection(bounds, range) : null;
    if (!bounds || !overlap) { put(key, value); continue; }
    const kept = inside(value);
    if (kept !== null && sameJson(kept, value)) { put(key, value); continue; }
    for (const piece of subtractRange(bounds, range)) put(rangeKeyOf(piece), value);
    if (kept !== null) put(rangeKeyOf(overlap), kept);
  }
  return builder.toRecord();
}

/** Remove `range` from a range-keyed record, keeping the rest of every entry it cut. */
export function removeRange<T>(record: Readonly<Record<string, T>>, range: NormalizedSelectionRange): Record<string, T> {
  return rewriteWithin(record, range, () => null);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
