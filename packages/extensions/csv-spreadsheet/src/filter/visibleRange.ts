import type { RowIndexMapping } from './rowIndexMapping';

/**
 * Pull a logical row span onto rows that are actually visible.
 *
 * Selections built from something other than a click -- select-all, a column
 * header, a find hit -- name logical rows that a filter may have hidden. Handing
 * such an endpoint to `expandLogicalRange` yields an empty list, so a select-all
 * over a filtered sheet would copy nothing at all.
 *
 * The span is narrowed, never widened: the start moves down to the first
 * visible row at or after it and the end moves up to the last visible row at or
 * before it. Returns null when the span covers no visible row, which is the
 * caller's cue that there is nothing to select.
 */
export function snapRowsToVisible(
  mapping: RowIndexMapping,
  startLogicalRow: number,
  endLogicalRow: number,
): { startRow: number; endRow: number } | null {
  const first = Math.min(startLogicalRow, endLogicalRow);
  const last = Math.max(startLogicalRow, endLogicalRow);

  // `logicalRows` is ascending, so the first and last rows inside the span are
  // the ends of the visible slice it covers.
  const inSpan = mapping.logicalRows.filter((row) => row >= first && row <= last);
  if (inSpan.length === 0) return null;

  return { startRow: inSpan[0], endRow: inSpan[inSpan.length - 1] };
}
