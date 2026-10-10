/**
 * Formatting and layout actions as pure metadata patches.
 *
 * Every toolbar button, shortcut and menu item that formats builds its patch
 * here and runs it through `gridOps.setMeta`, which makes it one `setMeta`
 * command: undoable, published to collab, written to the metadata line.
 * Each function reads the metadata it is applied to (the executor builds the
 * command against the current state), never a snapshot from an earlier render.
 */

import type { CellStyle, ColumnFormat, ColumnType, NormalizedSelectionRange } from '../types';
import type { SheetMeta } from '../commands/sheetState';
import { applyStyleToRange, CellStyleIndex, parseRangeKey, rangeKeyOf } from '../cells/cellStyles';
import { RangeIndex } from '../cells/sheetDecorations';
import { contains, overlaps, removeRange, subtractRange } from '../cells/rangeMath';
import { getDefaultFormatForType } from '../utils/formatters';
import type { BorderSide, RangeBorders } from '../sheetMeta/formatting';

type Patch = Partial<SheetMeta>;
type Cell = { row: number; col: number };

/** Drop the entries of a range-keyed record that the selection covers entirely. */
function withoutCovered<T>(record: Readonly<Record<string, T>>, range: NormalizedSelectionRange): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    const bounds = parseRangeKey(key);
    if (bounds && contains(range, bounds)) continue;
    next[key] = value;
  }
  return next;
}

// ---- number formats ------------------------------------------------------------

export type NumberFormatPreset =
  | 'automatic' | 'text' | 'number' | 'percent' | 'scientific' | 'accounting'
  | 'currency' | 'currencyRounded' | 'date' | 'time' | 'datetime';

export function presetFormat(preset: NumberFormatPreset): ColumnFormat | null {
  switch (preset) {
    case 'automatic': return null;
    case 'number': return getDefaultFormatForType('number');
    case 'percent': return { ...getDefaultFormatForType('percentage'), decimals: 2 };
    case 'scientific': return { ...getDefaultFormatForType('number'), numberStyle: 'scientific' };
    case 'accounting': return { ...getDefaultFormatForType('currency'), numberStyle: 'accounting' };
    case 'currency': return getDefaultFormatForType('currency');
    case 'currencyRounded': return { ...getDefaultFormatForType('currency'), decimals: 0 };
    default: return getDefaultFormatForType(preset as ColumnType);
  }
}

/**
 * Give the selection its own number format (null = back to the column's).
 * Entries the selection covers entirely are replaced, so re-formatting the
 * same cells never grows the metadata line. Clearing cuts the selection out of
 * every entry it overlaps and keeps the rest of each.
 */
export function setCellFormat(meta: SheetMeta, range: NormalizedSelectionRange, format: ColumnFormat | null): Patch {
  if (!format) return { cellFormats: removeRange(meta.cellFormats, range) };
  const cellFormats = withoutCovered(meta.cellFormats, range);
  cellFormats[rangeKeyOf(range)] = format;
  return { cellFormats };
}

/** The format a cell displays with: its own, else its column's. */
export function effectiveFormat(meta: SheetMeta, cell: Cell): ColumnFormat | undefined {
  return new RangeIndex(meta.cellFormats).at(cell.row, cell.col) ?? meta.columnFormats[cell.col];
}

const NUMERIC_TYPES = new Set<ColumnType>(['number', 'currency', 'percentage']);
export const MAX_DECIMALS = 10;

/**
 * Decimals +/-: start from the active cell's format (a plain number when it has
 * none or is not numeric) and write the result to the whole selection.
 */
export function adjustDecimals(meta: SheetMeta, range: NormalizedSelectionRange, active: Cell, delta: 1 | -1): Patch {
  const current = effectiveFormat(meta, active);
  const base = current && NUMERIC_TYPES.has(current.type)
    ? current
    : { ...getDefaultFormatForType('number'), decimals: 0, showThousandsSeparator: false };
  const fallback = base.type === 'percentage' ? 1 : 2;
  const decimals = Math.max(0, Math.min(MAX_DECIMALS, (base.decimals ?? fallback) + delta));
  return setCellFormat(meta, range, { ...base, decimals });
}

// ---- text styles -----------------------------------------------------------------

export type ToggleStyle = 'bold' | 'italic' | 'underline' | 'strikethrough';

/** B/I/U/S: toggle from the active cell's state, applied to the selection. */
export function toggleStyle(meta: SheetMeta, range: NormalizedSelectionRange, active: Cell, style: ToggleStyle): Patch {
  const current = new CellStyleIndex(meta.cellStyles).styleAt(active.row, active.col);
  return { cellStyles: applyStyleToRange(meta.cellStyles, range, { [style]: !current?.[style] }) };
}

export function setStyle(meta: SheetMeta, range: NormalizedSelectionRange, change: CellStyle): Patch {
  return { cellStyles: applyStyleToRange(meta.cellStyles, range, change) };
}

// ---- wrap ------------------------------------------------------------------------

export function isWrapped(meta: SheetMeta, cell: Cell): boolean {
  return new RangeIndex(Object.fromEntries(meta.wrap.map((key) => [key, true as const]))).at(cell.row, cell.col) === true;
}

/**
 * Wrap on/off for the selection. Off removes the wrap ranges inside the
 * selection; a wider range that still covers part of it is split around it.
 */
export function setWrap(meta: SheetMeta, range: NormalizedSelectionRange, wrap: boolean): Patch {
  const kept: string[] = [];
  for (const key of meta.wrap) {
    const bounds = parseRangeKey(key);
    if (!bounds) { kept.push(key); continue; }
    if (contains(range, bounds)) continue;
    if (!overlaps(bounds, range) || wrap) { kept.push(key); continue; }
    kept.push(...subtractRange(bounds, range).map(rangeKeyOf));
  }
  if (wrap) kept.push(rangeKeyOf(range));
  return { wrap: [...new Set(kept)] };
}

// ---- borders ---------------------------------------------------------------------

export type BorderPreset = 'all' | 'outer' | 'inner' | 'horizontal' | 'vertical' | 'top' | 'bottom' | 'left' | 'right' | 'none';

const PRESET_SIDES: Record<Exclude<BorderPreset, 'none'>, (keyof RangeBorders)[]> = {
  all: ['top', 'bottom', 'left', 'right', 'innerHorizontal', 'innerVertical'],
  outer: ['top', 'bottom', 'left', 'right'],
  inner: ['innerHorizontal', 'innerVertical'],
  horizontal: ['innerHorizontal'],
  vertical: ['innerVertical'],
  top: ['top'],
  bottom: ['bottom'],
  left: ['left'],
  right: ['right'],
};

/**
 * Apply a border preset to the selection. Merges into an entry for exactly the
 * same range; `none` clears every border inside the selection (entries it
 * covers are dropped, and the rest are cleared under it with `null` sides).
 */
export function applyBorders(meta: SheetMeta, range: NormalizedSelectionRange, preset: BorderPreset, side: BorderSide): Patch {
  const key = rangeKeyOf(range);
  if (preset === 'none') {
    const borders = withoutCovered(meta.borders, range);
    const overlapped = Object.keys(borders).some((other) => {
      const bounds = parseRangeKey(other);
      return bounds !== null && overlaps(bounds, range);
    });
    if (overlapped) {
      borders[key] = { top: null, bottom: null, left: null, right: null, innerHorizontal: null, innerVertical: null };
    }
    return { borders };
  }
  const borders: Record<string, RangeBorders> = { ...meta.borders };
  const existing = borders[key] ?? {};
  delete borders[key];
  const added: RangeBorders = {};
  for (const name of PRESET_SIDES[preset]) added[name] = side;
  borders[key] = { ...existing, ...added };
  return { borders };
}

// ---- rows and columns --------------------------------------------------------------

function indexesIn(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

export function hideRows(meta: SheetMeta, start: number, end: number): Patch {
  // Pinned rows cannot be trimmed out of RevoGrid's view.
  const first = Math.max(start, meta.headerRowCount + meta.frozenRowCount);
  if (first > end) return {};
  return { hiddenRows: [...new Set([...meta.hiddenRows, ...indexesIn(first, end)])].sort((a, b) => a - b) };
}

/** Unhide the hidden rows in [start, end], or every hidden row when the range holds none. */
export function unhideRows(meta: SheetMeta, start: number, end: number): Patch {
  const inside = meta.hiddenRows.filter((row) => row >= start && row <= end);
  return { hiddenRows: inside.length === 0 ? [] : meta.hiddenRows.filter((row) => row < start || row > end) };
}

export function hideCols(meta: SheetMeta, start: number, end: number): Patch {
  const next = [...new Set([...meta.hiddenCols, ...indexesIn(start, end)])].sort((a, b) => a - b);
  // Hiding every column would leave nothing to click to bring them back.
  if (next.length >= meta.columnCount && indexesIn(0, meta.columnCount - 1).every((col) => next.includes(col))) return {};
  return { hiddenCols: next };
}

export function unhideCols(meta: SheetMeta, start: number, end: number): Patch {
  const inside = meta.hiddenCols.filter((col) => col >= start && col <= end);
  return { hiddenCols: inside.length === 0 ? [] : meta.hiddenCols.filter((col) => col < start || col > end) };
}

/** Freeze `count` rows from the top. Header rows stay frozen; the rest are data rows. */
export function freezeRows(meta: SheetMeta, count: number): Patch {
  const frozenRowCount = Math.max(0, count - meta.headerRowCount);
  // Frozen rows are pinned, and a pinned row cannot be hidden.
  const pinned = meta.headerRowCount + frozenRowCount;
  return { frozenRowCount, hiddenRows: meta.hiddenRows.filter((row) => row >= pinned) };
}

export function freezeCols(meta: SheetMeta, count: number): Patch {
  return { frozenColumnCount: Math.max(0, Math.min(count, meta.columnCount)) };
}

/** Explicit row heights for the given rows, or back to automatic when `height` is null. */
export function setRowHeights(meta: SheetMeta, rows: readonly number[], height: number | null): Patch {
  const rowHeights = { ...meta.rowHeights };
  for (const row of rows) {
    if (height === null) delete rowHeights[row];
    else rowHeights[row] = Math.round(height);
  }
  return { rowHeights };
}

export function setColumnWidths(meta: SheetMeta, cols: readonly number[], width: number): Patch {
  const columnWidths = { ...meta.columnWidths };
  for (const col of cols) columnWidths[col] = Math.round(width);
  return { columnWidths };
}
