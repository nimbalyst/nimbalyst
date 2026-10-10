/**
 * Build `SheetCommand`s for the editor's actions: agent updates, clear, paste,
 * fill (handle, Ctrl+D/R, Cmd+Enter) and sort.
 *
 * Row arguments are lists of logical rows rather than ranges, because a filter
 * hides rows inside a selection and every one of these actions writes only the
 * rows the user can see. The callers resolve those lists through the row
 * mapping; the builders stay pure.
 */

import type { ColumnFormat, NormalizedSelectionRange } from '../types';
import { planPaste } from '../clipboard/pastePlan';
import type { ResolvedPasteSource } from '../clipboard/copyPayload';
import { fillSeries, type FillDirection } from '../fill/fillSeries';
import { shiftFormulaRelative } from '../structure/rewriteFormula';
import { normalizePastedValue } from '../utils/formatters';
import type { SheetCommand } from './sheetCommand';
import { cellAt, contentRowCount, isFormulaText, type CellWrite, type SheetState } from './sheetState';

export interface CellUpdate {
  readonly row: number;
  readonly column: number;
  readonly value: string;
}

/**
 * Validate a batch of explicit updates (agent tools, formula bar, find/replace)
 * and turn it into one command, so the whole batch is one undo step. Throws
 * before anything is written when any update is out of bounds.
 */
export function buildUpdateCells(state: SheetState, updates: readonly CellUpdate[]): SheetCommand {
  const seen = new Set<string>();
  for (const update of updates) {
    if (!Number.isInteger(update.row) || update.row < 0 || update.row >= state.rows.length) {
      throw new Error(`Row index ${String(update.row)} is out of bounds`);
    }
    if (!Number.isInteger(update.column) || update.column < 0 || update.column >= state.meta.columnCount) {
      throw new Error(`Column index ${String(update.column)} is out of bounds`);
    }
    const key = `${update.row}:${update.column}`;
    if (seen.has(key)) throw new Error(`Duplicate cell update for ${key}`);
    seen.add(key);
  }
  return { type: 'setCells', cells: updates.map((u) => ({ row: u.row, col: u.column, value: u.value })) };
}

function columnsOf(range: Pick<NormalizedSelectionRange, 'startCol' | 'endCol'>): number[] {
  const cols: number[] = [];
  for (let c = range.startCol; c <= range.endCol; c += 1) cols.push(c);
  return cols;
}

export function buildClear(rows: readonly number[], range: NormalizedSelectionRange): SheetCommand {
  const cells: CellWrite[] = [];
  for (const row of rows) for (const col of columnsOf(range)) cells.push({ row, col, value: '' });
  return { type: 'setCells', cells };
}

/** Write `value` into every cell, shifting a formula's relative refs from `origin` (Cmd+Enter). */
export function buildFillValue(
  rows: readonly number[],
  range: NormalizedSelectionRange,
  value: string,
  origin: { row: number; col: number },
): SheetCommand {
  const formula = isFormulaText(value);
  const cells: CellWrite[] = [];
  for (const row of rows) {
    for (const col of columnsOf(range)) {
      cells.push({ row, col, value: formula ? shiftFormulaRelative(value, row - origin.row, col - origin.col) : value });
    }
  }
  return { type: 'setCells', cells };
}

/**
 * Ctrl+D / Ctrl+R: copy the first row (column) of the selection through the
 * rest of it. A copy, not a series, with formula refs shifted per cell.
 */
export function buildFillCopy(
  state: SheetState,
  rows: readonly number[],
  range: NormalizedSelectionRange,
  axis: 'down' | 'right',
): SheetCommand {
  const cells: CellWrite[] = [];
  const cols = columnsOf(range);
  if (axis === 'down') {
    const [top, ...rest] = rows;
    for (const col of cols) {
      const value = cellAt(state, top, col);
      for (const row of rest) cells.push({ row, col, value: shiftIfFormula(value, row - top, 0) });
    }
  } else {
    const [left, ...rest] = cols;
    for (const row of rows) {
      const value = cellAt(state, row, left);
      for (const col of rest) cells.push({ row, col, value: shiftIfFormula(value, 0, col - left) });
    }
  }
  return { type: 'setCells', cells };
}

function shiftIfFormula(value: string, dRow: number, dCol: number): string {
  return isFormulaText(value) ? shiftFormulaRelative(value, dRow, dCol) : value;
}

/**
 * Fill handle: continue the source block into the target cells as a series
 * (`fillSeries`). Source and target lists are in sheet order; for `up`/`left`
 * the target is above/left of the source. Under a filter the lists skip hidden
 * rows, and repeated formulas shift by the rows actually between source and target.
 */
export function buildSeriesFill(
  state: SheetState,
  source: { rows: readonly number[]; cols: readonly number[] },
  target: { rows: readonly number[]; cols: readonly number[] },
  direction: FillDirection,
): SheetCommand {
  const vertical = direction === 'down' || direction === 'up';
  const outward = <T,>(items: readonly T[]) => (direction === 'up' || direction === 'left' ? [...items].reverse() : [...items]);
  const cells: CellWrite[] = [];
  if (vertical) {
    const targets = outward(target.rows);
    for (const col of source.cols) {
      const values = fillSeries(source.rows.map((row) => cellAt(state, row, col)), targets.length, {
        direction, positions: { source: source.rows, target: targets },
      });
      targets.forEach((row, k) => cells.push({ row, col, value: values[k] }));
    }
  } else {
    const targets = outward(target.cols);
    for (const row of source.rows) {
      const values = fillSeries(source.cols.map((col) => cellAt(state, row, col)), targets.length, {
        direction, positions: { source: source.cols, target: targets },
      });
      targets.forEach((col, k) => cells.push({ row, col, value: values[k] }));
    }
  }
  return { type: 'setCells', cells };
}

/**
 * The fill handle dragged from `source` to `target` (which contains it): the
 * series fill for the cells `target` adds, in whichever direction it grew.
 * `visibleRows` are the logical rows a filter leaves showing; either end of a
 * bound may itself be hidden, so rows are picked from them, not expanded.
 */
export function buildFillBetween(
  state: SheetState,
  visibleRows: readonly number[],
  source: NormalizedSelectionRange,
  target: NormalizedSelectionRange,
): SheetCommand | null {
  const rowsIn = (startRow: number, endRow: number) => visibleRows.filter((row) => row >= startRow && row <= endRow);
  const colsIn = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) => start + i);
  let direction: FillDirection;
  let added: NormalizedSelectionRange;
  if (target.endRow > source.endRow) {
    direction = 'down';
    added = { ...source, startRow: source.endRow + 1, endRow: target.endRow };
  } else if (target.startRow < source.startRow) {
    direction = 'up';
    added = { ...source, startRow: target.startRow, endRow: source.startRow - 1 };
  } else if (target.endCol > source.endCol) {
    direction = 'right';
    added = { ...source, startCol: source.endCol + 1, endCol: target.endCol };
  } else if (target.startCol < source.startCol) {
    direction = 'left';
    added = { ...source, startCol: target.startCol, endCol: source.startCol - 1 };
  } else {
    return null;
  }
  return buildSeriesFill(
    state,
    { rows: rowsIn(source.startRow, source.endRow), cols: colsIn(source.startCol, source.endCol) },
    { rows: rowsIn(added.startRow, added.endRow), cols: colsIn(added.startCol, added.endCol) },
    direction,
  );
}

export interface PasteRequest {
  readonly source: ResolvedPasteSource;
  /** Logical selection; its top-left is where the paste starts. */
  readonly selection: NormalizedSelectionRange;
  /** How many rows of the selection are visible (the rest are filtered out). */
  readonly visibleSelectionRows: number;
  /** Logical destination rows for `count` pasted rows, skipping filtered rows and extending past the end. */
  readonly destinationRows: (count: number) => readonly number[];
  readonly columnFormats: Readonly<Record<number, ColumnFormat>>;
}

export interface PasteResult {
  readonly command: SheetCommand;
  /** Logical rectangle written (first to last destination row). */
  readonly range: NormalizedSelectionRange;
}

/**
 * Plan a paste: tile across the selection when it is a multiple of the copied
 * block (Sheets), shift formula refs for internal pastes, and store typed
 * columns' canonical form for external values.
 */
export function buildPaste(request: PasteRequest): PasteResult | null {
  const { source, selection } = request;
  const plan = planPaste(
    { values: source.values },
    {
      selection: {
        startRow: 0,
        endRow: Math.max(0, request.visibleSelectionRows - 1),
        startCol: selection.startCol,
        endCol: selection.endCol,
      },
      rowCount: Number.MAX_SAFE_INTEGER,
      colCount: Number.MAX_SAFE_INTEGER,
    },
  );
  if (!plan) return null;

  const srcRows = source.values.length;
  const srcCols = source.values.reduce((max, row) => Math.max(max, row.length), 0);
  const rows = request.destinationRows(plan.values.length);
  const cells: CellWrite[] = [];
  plan.values.forEach((values, r) => {
    const row = rows[r];
    values.forEach((raw, c) => {
      const col = selection.startCol + c;
      let value = raw;
      if (source.origin && isFormulaText(raw)) {
        const dRow = row - (source.rows?.[r % srcRows] ?? source.origin.row + (r % srcRows));
        const dCol = col - (source.origin.col + (c % srcCols));
        value = shiftFormulaRelative(raw, dRow, dCol);
      } else if (!isFormulaText(raw)) {
        value = normalizePastedValue(raw, request.columnFormats[col]);
      }
      cells.push({ row, col, value });
    });
  });

  return {
    command: { type: 'setCells', cells },
    range: {
      startRow: rows[0],
      endRow: rows[rows.length - 1],
      startCol: plan.range.startCol,
      endCol: plan.range.endCol,
    },
  };
}

export type SortKey = number | string | null;

/**
 * Sort the body rows (below the header, above the trailing blank buffer) by a
 * key per row. Blanks sink in both directions; ties keep their order.
 */
export function buildSort(
  state: SheetState,
  direction: 'asc' | 'desc',
  keyOf: (row: number) => SortKey,
): SheetCommand {
  const start = state.meta.headerRowCount;
  const end = Math.max(start, contentRowCount(state.rows));
  const indexes = Array.from({ length: end - start }, (_, i) => i);
  const keys = indexes.map((i) => keyOf(start + i));
  indexes.sort((a, b) => {
    const ka = keys[a];
    const kb = keys[b];
    if (ka === null && kb === null) return a - b;
    if (ka === null) return 1;
    if (kb === null) return -1;
    const result = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb));
    return (direction === 'asc' ? result : -result) || a - b;
  });
  const reorder: SheetCommand = { type: 'reorderRows', start, order: indexes };
  // A formula that moves with its row refers to its new row, as in Sheets:
  // `=B5*C5` sorted from row 5 to row 2 becomes `=B2*C2`. Absolute parts stay.
  const shifted: CellWrite[] = [];
  indexes.forEach((from, to) => {
    const delta = to - from;
    if (delta === 0) return;
    (state.rows[start + from] ?? []).forEach((value, col) => {
      if (!isFormulaText(value)) return;
      const moved = shiftFormulaRelative(value, delta, 0);
      if (moved !== value) shifted.push({ row: start + to, col, value: moved });
    });
  });
  return shifted.length === 0 ? reorder : { type: 'batch', commands: [reorder, { type: 'setCells', cells: shifted }] };
}
