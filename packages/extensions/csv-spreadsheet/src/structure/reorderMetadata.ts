/**
 * Row-scoped metadata rewritten for a row reorder (sorting).
 *
 * Sorting moves rows, and everything the user attached to a row's cells moves
 * with it, as in Sheets: cell formats, validation, cell styles, borders, wrap,
 * single-row conditional-format ranges, row heights and hidden rows. A range
 * that spans moved rows is cut into the runs of rows that stay adjacent after
 * the move and each run is written back as its own range, in the original
 * entry's position, so precedence against other entries is unchanged. A range
 * whose rows all stay adjacent (one that covers the whole sorted block, say)
 * comes back as one range.
 *
 * Multi-row conditional-format ranges stay where they are: a rule over a
 * column describes the area, not the rows that happen to be in it.
 *
 * Borders follow the "inner line belongs to the row below" model of
 * `resolveCellBorders`: a row that came from the middle of a bordered range
 * keeps the inner horizontal line as its top edge, and loses the line under
 * it, which belonged to the row that used to follow.
 */

import type { CellStyleRanges } from '../types';
import type { SheetMeta } from '../commands/sheetState';
import type { RangeBorders } from '../sheetMeta/formatting';
import { parseRangeKey, rangeKeyOf, type RangeBounds } from '../cells/cellStyles';
import { RangeRecordBuilder } from '../cells/rangeMath';

/** Maps an old row index to its new one. */
type RowMap = (row: number) => number;

interface Run {
  /** Rows in the original range, inclusive. */
  from: number;
  to: number;
  /** First row after the move. */
  at: number;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The range's rows grouped into runs that are still adjacent and in order after the move. */
function runsOf(bounds: RangeBounds, start: number, end: number, map: RowMap): Run[] {
  const rows: { row: number; at: number }[] = [];
  // Rows outside the block do not move, so they are one stretch each.
  if (bounds.startRow < start) rows.push({ row: bounds.startRow, at: bounds.startRow });
  for (let row = Math.max(bounds.startRow, start); row <= Math.min(bounds.endRow, end); row += 1) {
    rows.push({ row, at: map(row) });
  }
  if (bounds.endRow > end) rows.push({ row: end + 1, at: end + 1 });
  // Expand the outside stretches back into their extent when building runs.
  const extentOf = (row: number) => (row === bounds.startRow && row < start
    ? { from: row, to: start - 1 }
    : row === end + 1 && row > end
      ? { from: row, to: bounds.endRow }
      : { from: row, to: row });
  rows.sort((a, b) => a.at - b.at);
  const runs: Run[] = [];
  for (const { row, at } of rows) {
    const { from, to } = extentOf(row);
    const last = runs[runs.length - 1];
    if (last && last.to + 1 === from && last.at + (last.to - last.from) + 1 === at) last.to = to;
    else runs.push({ from, to, at });
  }
  return runs;
}

/** The borders a run of rows carries when cut out of `bounds`. */
function runBorders(borders: RangeBorders, bounds: RangeBounds, run: Run): RangeBorders {
  const out: RangeBorders = { ...borders };
  delete out.top;
  delete out.bottom;
  const top = run.from === bounds.startRow ? borders.top : borders.innerHorizontal;
  const bottom = run.to === bounds.endRow ? borders.bottom : undefined;
  const ordered: RangeBorders = {};
  if (top !== undefined) ordered.top = top;
  if (bottom !== undefined) ordered.bottom = bottom;
  return { ...ordered, ...out };
}

/** Two runs of one bordered range are one range again when the line between them is the inner line. */
function mergeBorderRuns(borders: RangeBorders, upper: RangeBorders, lower: RangeBorders): RangeBorders | null {
  if (upper.bottom !== undefined || !sameJson(lower.top, borders.innerHorizontal)) return null;
  const merged: RangeBorders = { ...upper };
  delete merged.bottom;
  if (lower.bottom !== undefined) merged.bottom = lower.bottom;
  return merged;
}

/**
 * One range-keyed entry after the move, as pieces in row order. Values are
 * reused unless the entry is a border entry cut at a run boundary.
 */
function pieces<T>(
  key: string,
  value: T,
  start: number,
  end: number,
  map: RowMap,
  borders: boolean,
): [string, T][] {
  const bounds = parseRangeKey(key);
  if (!bounds || bounds.endRow < start || bounds.startRow > end) return [[key, value]];
  const out: { startRow: number; endRow: number; value: T }[] = [];
  for (const run of runsOf(bounds, start, end, map)) {
    const runValue = borders ? runBorders(value as RangeBorders, bounds, run) as T : value;
    const startRow = run.at;
    const endRow = run.at + (run.to - run.from);
    const last = out[out.length - 1];
    if (last && last.endRow + 1 === startRow) {
      const merged = borders
        ? mergeBorderRuns(value as RangeBorders, last.value as RangeBorders, runValue as RangeBorders) as T | null
        : value;
      if (merged !== null) {
        last.endRow = endRow;
        last.value = merged;
        continue;
      }
    }
    out.push({ startRow, endRow, value: runValue });
  }
  return out.map((piece) => [
    rangeKeyOf({ startRow: piece.startRow, endRow: piece.endRow, startCol: bounds.startCol, endCol: bounds.endCol }),
    piece.value,
  ]);
}

function reorderRecord<T>(
  record: Readonly<Record<string, T>>,
  start: number,
  end: number,
  map: RowMap,
  borders = false,
  layered = borders,
): Record<string, T> {
  const next = new RangeRecordBuilder<T>(layered);
  for (const [key, value] of Object.entries(record)) {
    for (const [pieceKey, pieceValue] of pieces(key, value, start, end, map, borders)) next.put(pieceKey, pieceValue);
  }
  return next.toRecord();
}

function reorderSingleRowKey(key: string, start: number, end: number, map: RowMap): string {
  const bounds = parseRangeKey(key);
  if (!bounds || bounds.startRow !== bounds.endRow || bounds.startRow < start || bounds.startRow > end) return key;
  const row = map(bounds.startRow);
  return rangeKeyOf({ ...bounds, startRow: row, endRow: row });
}

/**
 * Row-scoped metadata after rows `start + i` take the rows at `start + order[i]`.
 * Fields the reorder does not touch keep their identity.
 */
export function reorderRowMetadata(meta: SheetMeta, start: number, order: readonly number[]): SheetMeta {
  const end = start + order.length - 1;
  const target = new Array<number>(order.length);
  order.forEach((from, i) => { target[from] = start + i; });
  const map: RowMap = (row) => (row >= start && row <= end ? target[row - start] : row);
  const inBlock = (row: number) => row >= start && row <= end;

  const rowHeights: Record<number, number> = {};
  for (const [row, height] of Object.entries(meta.rowHeights)) rowHeights[map(Number(row))] = height;

  return {
    ...meta,
    cellFormats: reorderRecord(meta.cellFormats, start, end, map),
    validation: reorderRecord(meta.validation, start, end, map),
    cellStyles: reorderRecord(meta.cellStyles, start, end, map, false, true) as CellStyleRanges,
    borders: reorderRecord(meta.borders, start, end, map, true),
    wrap: Object.keys(reorderRecord(Object.fromEntries(meta.wrap.map((key) => [key, true])), start, end, map)),
    conditionalFormats: meta.conditionalFormats.map((format) => {
      const ranges = format.ranges.map((key) => reorderSingleRowKey(key, start, end, map));
      return ranges.every((key, i) => key === format.ranges[i]) ? format : { ...format, ranges };
    }),
    rowHeights: Object.keys(meta.rowHeights).some((row) => inBlock(Number(row))) ? rowHeights : meta.rowHeights,
    hiddenRows: meta.hiddenRows.some(inBlock) ? meta.hiddenRows.map(map).sort((a, b) => a - b) : meta.hiddenRows,
  };
}
