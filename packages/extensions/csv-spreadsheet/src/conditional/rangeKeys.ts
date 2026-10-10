/**
 * A1 range keys shared by conditional formats and data validation.
 *
 * Keys use the same shape and coordinate space as `cellStyles`: `B2` or
 * `A1:C10`, 1-based in text, zero-based once parsed, and counted from the first
 * row of the file *including header rows* (see `structure/structuralEdit.ts`).
 */

import type { NormalizedSelectionRange } from '../types';
import { parseRangeKey, rangeKeyOf, type RangeBounds } from '../cells/cellStyles';
import { RangeRecordBuilder } from '../cells/rangeMath';
import { editAxis, mapCellInterval, type StructuralEdit } from '../structure/structuralEdit';

export type { RangeBounds };

/** Stable map key for a cell in evaluator output. */
export function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

export function rangeContains(bounds: RangeBounds, row: number, col: number): boolean {
  return row >= bounds.startRow && row <= bounds.endRow
    && col >= bounds.startCol && col <= bounds.endCol;
}

/** Overlap of two ranges, or null when they are disjoint. */
export function intersectRanges(a: RangeBounds, b: NormalizedSelectionRange): RangeBounds | null {
  const startRow = Math.max(a.startRow, b.startRow);
  const endRow = Math.min(a.endRow, b.endRow);
  const startCol = Math.max(a.startCol, b.startCol);
  const endCol = Math.min(a.endCol, b.endCol);
  return startRow <= endRow && startCol <= endCol ? { startRow, startCol, endRow, endCol } : null;
}

/**
 * Where the cells of one range key end up after `edit`, as zero or more keys.
 *
 * Follows cells, like `cellStyles`: a range grows when rows are inserted inside
 * it, shrinks when part of it is deleted, disappears when all of it is, and
 * splits when a move carries part of it away. A key that does not parse is
 * returned unchanged so a hand-edited file never loses data.
 */
export function shiftRangeKey(key: string, edit: StructuralEdit): string[] {
  const bounds = parseRangeKey(key);
  if (!bounds) return [key];
  if (editAxis(edit) === 'row') {
    return mapCellInterval({ start: bounds.startRow, end: bounds.endRow }, edit).map((piece) =>
      rangeKeyOf({ ...bounds, startRow: piece.start, endRow: piece.end }));
  }
  return mapCellInterval({ start: bounds.startCol, end: bounds.endCol }, edit).map((piece) =>
    rangeKeyOf({ ...bounds, startCol: piece.start, endCol: piece.end }));
}

/** Shift a list of range keys, dropping duplicates and keeping first-seen order. */
export function shiftRangeKeys(keys: readonly string[], edit: StructuralEdit): string[] {
  const next = new Set<string>();
  for (const key of keys) {
    for (const shifted of shiftRangeKey(key, edit)) next.add(shifted);
  }
  return [...next];
}

/**
 * Shift a record keyed by range (validation rules, cell formats, borders,
 * styles). Entry order is preserved because later entries win; two entries
 * landing on the same key resolve as `RangeRecordBuilder` does, per property
 * when `layered`.
 */
export function shiftRangeRecord<T>(record: Readonly<Record<string, T>>, edit: StructuralEdit, layered = false): Record<string, T> {
  const next = new RangeRecordBuilder<T>(layered);
  for (const [key, value] of Object.entries(record)) {
    for (const shifted of shiftRangeKey(key, edit)) next.put(shifted, value);
  }
  return next.toRecord();
}

export { parseRangeKey, rangeKeyOf };
