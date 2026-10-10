/**
 * Status-bar statistics for a selection: Sum, Average, Count, Count numbers,
 * Min and Max.
 *
 * - **Count** is every non-blank cell, text included.
 * - **Sum / Average / Count numbers** cover numeric cells only. Text, booleans
 *   and dates are ignored.
 * - **Min / Max** cover numeric cells *and* dates, so a selection of dates
 *   reports its earliest and latest. When the extreme is a date, `minIsDate` /
 *   `maxIsDate` tells the status bar to format it as one. Mixed selections
 *   compare a date's epoch milliseconds against plain numbers, which is only
 *   meaningful for all-number or all-date selections; the status bar should
 *   treat a mixed result as approximate.
 *
 * The accumulator is O(1) per cell and holds no per-cell state, so a 1M-cell
 * selection can be streamed through it without allocating.
 */

import type { NormalizedSelectionRange } from '../types';
import { isNumericCellValue, parseNumber } from '../utils/formatters';

/**
 * One cell as the status bar sees it. `numeric` is the computed number when
 * the cell holds one (formulas included); when it is omitted, `raw` is parsed
 * if it looks numeric. `date` is epoch milliseconds for a temporal value and
 * makes the cell a date regardless of `numeric`.
 */
export interface StatsCell {
  raw?: string;
  display?: string;
  numeric?: number | null;
  date?: number | null;
}

export interface SelectionStats {
  /** Non-blank cells. */
  count: number;
  /** Numeric (non-date) cells. */
  countNumbers: number;
  sum: number;
  /** null when there are no numeric cells. */
  average: number | null;
  /** null when there are no numeric or date cells. */
  min: number | null;
  max: number | null;
  minIsDate: boolean;
  maxIsDate: boolean;
}

export interface SelectionStatsAccumulator {
  add(cell: StatsCell | null | undefined): void;
  result(): SelectionStats;
}

function numberOf(cell: StatsCell): number | null {
  if (typeof cell.numeric === 'number') return Number.isFinite(cell.numeric) ? cell.numeric : null;
  if (cell.numeric === null) return null;
  return cell.raw !== undefined && isNumericCellValue(cell.raw) ? parseNumber(cell.raw) : null;
}

export function createSelectionStatsAccumulator(): SelectionStatsAccumulator {
  let count = 0;
  let countNumbers = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let minIsDate = false;
  let maxIsDate = false;

  const extreme = (value: number, isDate: boolean) => {
    if (value < min) { min = value; minIsDate = isDate; }
    if (value > max) { max = value; maxIsDate = isDate; }
  };

  return {
    add(cell) {
      if (!cell) return;
      const text = cell.display ?? cell.raw ?? '';
      if (text.trim() === '') return;
      count++;

      if (typeof cell.date === 'number' && Number.isFinite(cell.date)) {
        extreme(cell.date, true);
        return;
      }
      const value = numberOf(cell);
      if (value === null) return;
      countNumbers++;
      sum += value;
      extreme(value, false);
    },
    result() {
      const hasExtreme = min !== Infinity;
      return {
        count,
        countNumbers,
        sum,
        average: countNumbers > 0 ? sum / countNumbers : null,
        min: hasExtreme ? min : null,
        max: hasExtreme ? max : null,
        minIsDate: hasExtreme && minIsDate,
        maxIsDate: hasExtreme && maxIsDate,
      };
    },
  };
}

export function computeSelectionStats(cells: Iterable<StatsCell | null | undefined>): SelectionStats {
  const accumulator = createSelectionStatsAccumulator();
  for (const cell of cells) accumulator.add(cell);
  return accumulator.result();
}

/**
 * Stats over one or more rectangles. A cell covered by several overlapping
 * rectangles is counted once, as in Sheets.
 */
export function computeRangeStats(
  ranges: readonly NormalizedSelectionRange[],
  getCell: (row: number, col: number) => StatsCell | null | undefined,
): SelectionStats {
  const accumulator = createSelectionStatsAccumulator();
  ranges.forEach((range, index) => {
    const earlier = ranges.slice(0, index);
    for (let row = range.startRow; row <= range.endRow; row++) {
      for (let col = range.startCol; col <= range.endCol; col++) {
        const covered = earlier.some((other) => row >= other.startRow && row <= other.endRow
          && col >= other.startCol && col <= other.endCol);
        if (!covered) accumulator.add(getCell(row, col));
      }
    }
  });
  return accumulator.result();
}
