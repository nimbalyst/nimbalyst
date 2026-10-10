/**
 * A1 notation for agent tools, in the sheet's A1 space: row 1 is the first
 * line of the file, header rows included, the same space formulas use.
 *
 * Accepts `B2`, `A1:C10`, whole columns `B:D` and whole rows `2:5`. Open
 * ranges resolve against the sheet's used range when the tool reads them.
 * Absolute markers (`$A$1`) are accepted and ignored.
 */

import { columnIndexToLetter, columnLetterToIndex } from '../utils/csvParser';

/** The grid limits of the largest common spreadsheet (XFD1048576). */
export const MAX_SHEET_COLUMNS = 16_384;
export const MAX_SHEET_ROWS = 1_048_576;

/** Zero-based, inclusive. `null` bounds are open (whole rows / whole columns). */
export interface A1Range {
  readonly startRow: number | null;
  readonly endRow: number | null;
  readonly startCol: number | null;
  readonly endCol: number | null;
}

export interface CellBounds {
  readonly startRow: number;
  readonly endRow: number;
  readonly startCol: number;
  readonly endCol: number;
}

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;
const COLUMN = /^\$?([A-Za-z]{1,3})$/;
const ROW = /^\$?(\d{1,7})$/;

/** Parse a column letter (`A`, `AA`, `XFD`) to a zero-based index. */
export function parseColumnLetter(text: unknown, name = 'column'): number {
  if (typeof text !== 'string' || !COLUMN.test(text.trim())) {
    throw new Error(`${name} must be a column letter such as "A" or "AB"; got ${JSON.stringify(text)}`);
  }
  const index = columnLetterToIndex(text.trim().replace('$', ''));
  if (index >= MAX_SHEET_COLUMNS) throw new Error(`${name} ${text} is past the last column (${columnIndexToLetter(MAX_SHEET_COLUMNS - 1)})`);
  return index;
}

function parseRowNumber(text: string, source: string): number {
  const row = Number(text) - 1;
  if (row < 0) throw new Error(`Row numbers start at 1 in "${source}"`);
  if (row >= MAX_SHEET_ROWS) throw new Error(`Row ${text} in "${source}" is past the last row (${MAX_SHEET_ROWS})`);
  return row;
}

export function parseA1Cell(text: unknown, name = 'cell'): { row: number; col: number } {
  const match = typeof text === 'string' ? CELL.exec(text.trim()) : null;
  if (!match) throw new Error(`${name} must be an A1 cell reference such as "B2"; got ${JSON.stringify(text)}`);
  return { row: parseRowNumber(match[2], text as string), col: parseColumnLetter(match[1], name) };
}

type Endpoint = { row: number | null; col: number | null };

function parseEndpoint(text: string, source: string): Endpoint {
  let match = CELL.exec(text);
  if (match) return { row: parseRowNumber(match[2], source), col: parseColumnLetter(match[1]) };
  match = COLUMN.exec(text);
  if (match) return { row: null, col: parseColumnLetter(match[1]) };
  match = ROW.exec(text);
  if (match) return { row: parseRowNumber(match[1], source), col: null };
  throw new Error(`"${source}" is not an A1 range; use "B2", "A1:C10", "B:D" or "2:5"`);
}

export function parseA1Range(text: unknown): A1Range {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('range must be an A1 range such as "A1:C10"');
  }
  const source = text.trim();
  const parts = source.split(':');
  if (parts.length > 2) throw new Error(`"${source}" has more than one ":"`);
  const start = parseEndpoint(parts[0].trim(), source);
  const end = parts.length === 2 ? parseEndpoint(parts[1].trim(), source) : start;
  if ((start.row === null) !== (end.row === null) || (start.col === null) !== (end.col === null)) {
    throw new Error(`"${source}" mixes a cell with a whole row or column; use "A1:C10", "B:D" or "2:5"`);
  }
  if (parts.length === 1 && (start.row === null || start.col === null)) {
    throw new Error(`"${source}" is not a cell; write a whole column as "B:B" and a whole row as "2:2"`);
  }
  const order = (a: number | null, b: number | null) => (a === null || b === null ? [a, b] : [Math.min(a, b), Math.max(a, b)]);
  const [startRow, endRow] = order(start.row, end.row);
  const [startCol, endCol] = order(start.col, end.col);
  return { startRow, endRow, startCol, endCol };
}

/** Close open bounds against the used range (`rows` x `cols`). */
export function resolveRange(range: A1Range, rows: number, cols: number): CellBounds {
  return {
    startRow: range.startRow ?? 0,
    endRow: range.endRow ?? Math.max(0, rows - 1),
    startCol: range.startCol ?? 0,
    endCol: range.endCol ?? Math.max(0, cols - 1),
  };
}

export function cellName(row: number, col: number): string {
  return `${columnIndexToLetter(col)}${row + 1}`;
}

export function rangeName(bounds: CellBounds): string {
  const start = cellName(bounds.startRow, bounds.startCol);
  if (bounds.startRow === bounds.endRow && bounds.startCol === bounds.endCol) return start;
  return `${start}:${cellName(bounds.endRow, bounds.endCol)}`;
}
