/**
 * The sheet as plain data: what a `SheetCommand` reads and produces.
 *
 * Coordinates are the sheet's A1 space, zero-based, header rows included (see
 * `structure/structuralEdit.ts`). Rows are immutable string arrays; a command
 * that leaves a row alone keeps its array identity, which is how the grid
 * writer knows which row models it can reuse. Rows may be ragged: a missing
 * cell reads as ''.
 */

import type { CellStyleRanges, ColumnFormat } from '../types';
import { FORMATTING_KEYS, type SheetFormatting } from '../sheetMeta/formatting';

export interface SheetMeta extends Readonly<SheetFormatting> {
  readonly headerRowCount: number;
  readonly frozenColumnCount: number;
  readonly columnCount: number;
  readonly columnFormats: Readonly<Record<number, ColumnFormat>>;
  readonly columnWidths: Readonly<Record<number, number>>;
  readonly cellStyles: CellStyleRanges;
}

export type SheetRow = readonly string[];

export interface SheetState {
  readonly rows: readonly SheetRow[];
  readonly meta: SheetMeta;
}

export interface CellWrite {
  readonly row: number;
  readonly col: number;
  readonly value: string;
}

export const SHEET_META_KEYS = [
  'headerRowCount',
  'frozenColumnCount',
  'columnCount',
  'columnFormats',
  'columnWidths',
  'cellStyles',
  ...FORMATTING_KEYS,
] as const satisfies readonly (keyof SheetMeta)[];

export function cellAt(state: SheetState, row: number, col: number): string {
  return state.rows[row]?.[col] ?? '';
}

export function isFormulaText(text: string): boolean {
  return text.trimStart().startsWith('=');
}

/** Rows that hold anything, ignoring the blank buffer rows at the end. */
export function contentRowCount(rows: readonly SheetRow[]): number {
  let count = rows.length;
  while (count > 0 && !rows[count - 1].some((cell) => cell !== '')) count -= 1;
  return count;
}
