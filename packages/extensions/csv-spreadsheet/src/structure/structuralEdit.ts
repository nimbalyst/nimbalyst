/**
 * Structural edits (row/column insert, delete, move) and how they map indices.
 *
 * Coordinate space: the sheet's A1 space, zero-based. Row 0 is A1's row, which
 * is the first row of the file *including header rows*; this is also the index
 * into `SpreadsheetData.rows` and what `gridOperations` `addRow`/`deleteRow`
 * take. Never pass a data-row index (one that skips header rows).
 *
 * - `insert*`: `count` new rows/columns are inserted before index `at`.
 * - `delete*`: indices `at .. at + count - 1` are removed.
 * - `move*`: the block `at .. at + count - 1` is cut out and re-inserted so
 *   its first index ends up at `to` in the resulting sheet. Under this
 *   convention the inverse of `move{at, count, to}` is `move{at: to, count, to: at}`.
 */

export type StructuralEdit =
  | { type: 'insertRows'; at: number; count: number }
  | { type: 'deleteRows'; at: number; count: number }
  | { type: 'moveRows'; at: number; count: number; to: number }
  | { type: 'insertCols'; at: number; count: number }
  | { type: 'deleteCols'; at: number; count: number }
  | { type: 'moveCols'; at: number; count: number; to: number };

export type EditAxis = 'row' | 'col';

export function editAxis(edit: StructuralEdit): EditAxis {
  return edit.type.endsWith('Rows') ? 'row' : 'col';
}

/** The edit that undoes `edit`. */
export function invertStructuralEdit(edit: StructuralEdit): StructuralEdit {
  switch (edit.type) {
    case 'insertRows': return { type: 'deleteRows', at: edit.at, count: edit.count };
    case 'deleteRows': return { type: 'insertRows', at: edit.at, count: edit.count };
    case 'insertCols': return { type: 'deleteCols', at: edit.at, count: edit.count };
    case 'deleteCols': return { type: 'insertCols', at: edit.at, count: edit.count };
    case 'moveRows': return { type: 'moveRows', at: edit.to, count: edit.count, to: edit.at };
    case 'moveCols': return { type: 'moveCols', at: edit.to, count: edit.count, to: edit.at };
  }
}

/** Where index `i` on the edit's axis ends up, or null if it was deleted. */
export function mapIndex(i: number, edit: StructuralEdit): number | null {
  const { at, count } = edit;
  switch (edit.type) {
    case 'insertRows':
    case 'insertCols':
      return i >= at ? i + count : i;
    case 'deleteRows':
    case 'deleteCols':
      if (i < at) return i;
      return i >= at + count ? i - count : null;
    case 'moveRows':
    case 'moveCols': {
      if (i >= at && i < at + count) return edit.to + (i - at);
      const withoutBlock = i < at ? i : i - count;
      return withoutBlock >= edit.to ? withoutBlock + count : withoutBlock;
    }
  }
}

/** Inclusive index interval. */
export interface Interval {
  start: number;
  end: number;
}

/**
 * Where an interval of a *reference* ends up, or null if nothing survives.
 *
 * Matches Sheets: inserting inside the interval grows it, inserting at its
 * start shifts it, deleting part of it shrinks it, deleting all of it is a
 * `#REF!`. For moves each endpoint follows its own cell and the result is
 * re-normalized, so a reference stays a single rectangle.
 */
export function mapReferenceInterval(interval: Interval, edit: StructuralEdit): Interval | null {
  const { start, end } = interval;
  switch (edit.type) {
    case 'insertRows':
    case 'insertCols':
      return { start: mapIndex(start, edit)!, end: mapIndex(end, edit)! };
    case 'deleteRows':
    case 'deleteCols': {
      const lastDeleted = edit.at + edit.count - 1;
      const newStart = start < edit.at ? start : start > lastDeleted ? start - edit.count : edit.at;
      const newEnd = end > lastDeleted ? end - edit.count : end < edit.at ? end : edit.at - 1;
      return newStart <= newEnd ? { start: newStart, end: newEnd } : null;
    }
    case 'moveRows':
    case 'moveCols': {
      const a = mapIndex(start, edit)!;
      const b = mapIndex(end, edit)!;
      return { start: Math.min(a, b), end: Math.max(a, b) };
    }
  }
}

/**
 * Where the *cells* of an interval end up, as contiguous pieces in order.
 *
 * Unlike `mapReferenceInterval`, this follows every cell: moving rows out of
 * the middle of a styled block splits the block, and moving rows into it does
 * not pick up the style. Used for formatting, which belongs to cells rather
 * than to a reference's endpoints. Inserts inside the interval still grow it,
 * so a styled table stays continuous when a row is added in the middle.
 */
export function mapCellInterval(interval: Interval, edit: StructuralEdit): Interval[] {
  if (edit.type !== 'moveRows' && edit.type !== 'moveCols') {
    const mapped = mapReferenceInterval(interval, edit);
    return mapped ? [mapped] : [];
  }

  // A move is a constant shift between these source breakpoints, so map each
  // segment of the interval by its endpoints.
  const breakpoints = [edit.at, edit.at + edit.count, edit.to, edit.to + edit.count]
    .filter((point) => point > interval.start && point <= interval.end)
    .sort((x, y) => x - y);
  const pieces: Interval[] = [];
  let segmentStart = interval.start;
  for (const point of [...new Set(breakpoints), interval.end + 1]) {
    pieces.push({ start: mapIndex(segmentStart, edit)!, end: mapIndex(point - 1, edit)! });
    segmentStart = point;
  }

  pieces.sort((x, y) => x.start - y.start);
  const merged: Interval[] = [];
  for (const piece of pieces) {
    const last = merged.at(-1);
    if (last && piece.start === last.end + 1) last.end = piece.end;
    else merged.push({ ...piece });
  }
  return merged;
}

/**
 * New size of a leading block (header rows, frozen columns) of `size` indices.
 *
 * Inserting strictly inside the block grows it; inserting at its boundary
 * (`at === size`) adds after it, matching `gridOperations.addRow`, which puts a
 * row at `headerRowCount` into the data section. Deleting shrinks it by the
 * overlap. Moves leave the count alone: the block is "the first N rows", and a
 * move reorders rows without changing how many are frozen.
 */
export function mapLeadingCount(size: number, edit: StructuralEdit): number {
  if (size <= 0) return size;
  switch (edit.type) {
    case 'insertRows':
    case 'insertCols':
      return edit.at < size ? size + edit.count : size;
    case 'deleteRows':
    case 'deleteCols': {
      const overlap = Math.max(0, Math.min(size, edit.at + edit.count) - edit.at);
      return size - overlap;
    }
    case 'moveRows':
    case 'moveCols':
      return size;
  }
}
