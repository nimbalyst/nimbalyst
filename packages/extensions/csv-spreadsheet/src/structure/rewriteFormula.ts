/**
 * Rewrite the references inside formula text.
 *
 * Both rewriters splice only the reference tokens whose target changed; every
 * other character (spacing, function-name case, string literals) is kept as
 * the user typed it. A reference that can no longer point anywhere becomes
 * `#REF!` in place, the way Sheets shows it.
 *
 * Coordinates are the sheet's A1 space; see `structuralEdit.ts`.
 */

import {
  formatReference,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  scanReferences,
  type ReferenceEndpoint,
  type ScannedReference,
} from '../formula/referenceScanner';
import { editAxis, mapReferenceInterval, type StructuralEdit } from './structuralEdit';

export const REF_ERROR = '#REF!';

type Rewrite = (reference: ScannedReference) => Pick<ScannedReference, 'kind' | 'from' | 'to'> | null;

function isFormula(text: string): boolean {
  return text.trimStart().startsWith('=');
}

function rewriteReferences(formula: string, rewrite: Rewrite): string {
  if (!isFormula(formula)) return formula;
  let result = '';
  let cursor = 0;
  for (const reference of scanReferences(formula)) {
    const next = rewrite(reference);
    if (next !== null && sameTarget(reference, next)) continue;
    result += formula.slice(cursor, reference.start) + (next === null ? REF_ERROR : formatReference(next));
    cursor = reference.end;
  }
  return result + formula.slice(cursor);
}

function sameEndpoint(a: ReferenceEndpoint, b: ReferenceEndpoint): boolean {
  return a.col === b.col && a.row === b.row && a.colAbsolute === b.colAbsolute && a.rowAbsolute === b.rowAbsolute;
}

function sameTarget(a: ScannedReference, b: Pick<ScannedReference, 'kind' | 'from' | 'to'>): boolean {
  return a.kind === b.kind && sameEndpoint(a.from, b.from) && sameEndpoint(a.to, b.to);
}

/**
 * Rewrite a formula's references for a row/column insert, delete, or move.
 *
 * Structural edits move absolute references too: `$A$1` points at a cell, and
 * the cell moved. Ranges grow on insert and shrink on a partial delete; a
 * whole-column reference is untouched by row edits and vice versa. Text that
 * is not a formula (no leading `=`) is returned unchanged.
 */
export function rewriteFormulaForStructuralEdit(formula: string, edit: StructuralEdit): string {
  const key = editAxis(edit);
  const limit = key === 'row' ? MAX_SHEET_ROWS : MAX_SHEET_COLUMNS;
  const map = (start: number, end: number) => {
    const mapped = mapReferenceInterval({ start, end }, edit);
    // An insert can push a reference off the end of the sheet.
    return mapped && mapped.end < limit ? mapped : null;
  };

  return rewriteReferences(formula, (reference) => {
    // Column-ranges have no rows and row-ranges no columns: nothing to map.
    if (reference.from[key] === null) return reference;

    if (reference.kind === 'cell') {
      const mapped = map(reference.from[key]!, reference.from[key]!);
      if (!mapped) return null;
      const endpoint = { ...reference.from, [key]: mapped.start };
      return { kind: 'cell', from: endpoint, to: endpoint };
    }

    // Keep the user's endpoint order (`B5:A1` stays reversed) while mapping
    // the interval it covers.
    const a = reference.from[key]!;
    const b = reference.to[key]!;
    const mapped = map(Math.min(a, b), Math.max(a, b));
    if (!mapped) return null;
    const [fromValue, toValue] = a <= b ? [mapped.start, mapped.end] : [mapped.end, mapped.start];
    return {
      kind: reference.kind,
      from: { ...reference.from, [key]: fromValue },
      to: { ...reference.to, [key]: toValue },
    };
  });
}

function shiftEndpoint(endpoint: ReferenceEndpoint, dRow: number, dCol: number): ReferenceEndpoint | null {
  const row = endpoint.row === null || endpoint.rowAbsolute ? endpoint.row : endpoint.row + dRow;
  const col = endpoint.col === null || endpoint.colAbsolute ? endpoint.col : endpoint.col + dCol;
  if (row !== null && (row < 0 || row >= MAX_SHEET_ROWS)) return null;
  if (col !== null && (col < 0 || col >= MAX_SHEET_COLUMNS)) return null;
  return { ...endpoint, row, col };
}

/**
 * Shift the relative parts of a formula's references by a copy offset, for
 * paste and fill. `$` parts stay put. A reference pushed off the sheet (above
 * row 1 or left of column A) becomes `#REF!`.
 */
export function shiftFormulaRelative(formula: string, dRow: number, dCol: number): string {
  if (dRow === 0 && dCol === 0) return formula;
  return rewriteReferences(formula, (reference) => {
    const from = shiftEndpoint(reference.from, dRow, dCol);
    const to = reference.kind === 'cell' ? from : shiftEndpoint(reference.to, dRow, dCol);
    if (!from || !to) return null;
    return { kind: reference.kind, from, to };
  });
}
