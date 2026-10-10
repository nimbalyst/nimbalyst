/**
 * Shared evaluator types and cell helpers.
 */

import type { CellValue, ColumnFormat, FormulaEvalData } from '../../types';
import type { FormulaAst, FormulaErrorCode } from './ast';

export type FormulaFunction = (...args: unknown[]) => unknown;
export type EvaluationValue = string | number | boolean | null | unknown[][];

export interface EvaluationContext {
  activeCells: Set<string>;
  formulaCache: Map<string, EvaluationValue>;
  remainingOperations: number;
  remainingRangeCells: number;
  dependencyDepth: number;
  /** Parsed formula nodes from the recalculation graph, so evaluation reuses their ASTs. */
  formulaNodes?: Map<string, FormulaNode>;
  /** Set while evaluating the arguments of a `DATE_SERIAL_AGGREGATES` function. */
  dateRangesAsSerials?: boolean;
}

/**
 * Formula data that may carry column formats. `recalculateFormulas` receives a
 * full `SpreadsheetData`, so the formats are there at runtime even though
 * `FormulaEvalData` does not declare them.
 */
export type FormulaEvalDataWithFormats = FormulaEvalData & {
  columnFormats?: Record<number, ColumnFormat>;
};

/** A clamped rectangle of cells a formula reads. */
export interface CellRect {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

export interface FormulaNode {
  row: number;
  col: number;
  /** The raw formula text the node was parsed from. */
  raw: string;
  ast?: FormulaAst;
  parseError?: FormulaErrorCode;
  /** Formula cells this formula reads. */
  dependencies: Set<string>;
  /** Every in-bounds area the formula reads, value cells included. */
  areas: CellRect[];
  /** Cells charged against `maxDependencyScanCells` while building this node. */
  scannedCells: number;
}

/** Check if a value is a formula (starts with =). */
export function isFormula(value: string): boolean {
  // Called for every cell on every pass: decide on the first character when
  // it settles the question, and trim only text that starts with whitespace.
  const first = value.charCodeAt(0);
  if (first === 61) return true;
  if (first > 32 && first !== 160 && first < 0x1680) return false;
  return value.trim().startsWith('=');
}

/** Get the currently computed value of a cell. */
export function getCellValue(data: FormulaEvalData, row: number, col: number): CellValue {
  if (
    row < 0
    || row >= data.rows.length
    || col < 0
    || col >= data.columnCount
    || !data.rows[row]?.[col]
  ) {
    return null;
  }

  return data.rows[row][col].computed;
}

export function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}
