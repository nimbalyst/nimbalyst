/**
 * Tolerant, position-preserving scanner for formula text.
 *
 * `parseFormulaExpression` throws on anything incomplete, which is fine for
 * evaluation but useless for the things that operate on text the user is still
 * typing or text that must be rewritten without disturbing its formatting:
 * point mode (`=SUM(` + click), F4 cycling, colored reference tokens, and the
 * structural/relative ref rewriters in `../structure`. This scanner never
 * throws. It walks the text once and reports every token with its exact
 * `[start, end)` offsets, so a caller can splice a single token and leave every
 * other character (spacing, case, string literals) as the user wrote it.
 *
 * Coordinates are the sheet's A1 space, zero-based: row 0 is A1's row (the
 * first row of the file, header rows included), column 0 is column A.
 *
 * What counts as a reference:
 * - `A1`, `$A$1`, `A$1`, `$A1` (cell), `A1:C10` (range), `A:C` (column-range),
 *   `1:10` (row-range), case-insensitive, up to `XFD` / row 1048576.
 * - Spaces or tabs around a range colon (`A1 : C10`) belong to the range, as
 *   the evaluator accepts them.
 * - Not inside a string literal: `"A1"` is text.
 * - Not a function name: `LOG10(` is a call even though `LOG10` is shaped like
 *   a cell. A word followed (after optional spaces) by `(` is a function.
 * - Not part of a longer word: `A1B`, `Item_1`, `ABCD1` are names.
 */

import { columnIndexToLetter, columnLetterToIndex } from '../utils/csvParser';

/** Matches the parser's limits (`FORMULA_LIMITS`), so the two agree on what a reference is. */
export const MAX_SHEET_ROWS = 1_048_576;
export const MAX_SHEET_COLUMNS = 16_384;

export type ReferenceKind = 'cell' | 'range' | 'column-range' | 'row-range';

/**
 * One end of a reference. A column-range endpoint has `row: null`; a row-range
 * endpoint has `col: null`. The absolute flag of a missing axis is false.
 */
export interface ReferenceEndpoint {
  col: number | null;
  row: number | null;
  colAbsolute: boolean;
  rowAbsolute: boolean;
  /**
   * On a range's `from` endpoint: the colon as written, with any surrounding
   * spaces (`' : '`). `formatReference` reuses it so a rewrite keeps the
   * user's spacing; it lives on the endpoint because rewriters spread
   * endpoints into new references. Absent means a bare `:`.
   */
  rangeSeparator?: string;
}

export interface ScannedReference {
  kind: ReferenceKind;
  /** Offset of the first character in the scanned text. */
  start: number;
  /** Offset one past the last character. */
  end: number;
  text: string;
  /** For `cell`, `from` and `to` are the same endpoint. Not normalized: `B5:A1` keeps its order. */
  from: ReferenceEndpoint;
  to: ReferenceEndpoint;
}

export type FormulaTokenKind =
  | 'reference'
  | 'function'
  | 'name'
  | 'number'
  | 'string'
  | 'error'
  | 'operator'
  | 'leftParen'
  | 'rightParen'
  | 'comma'
  | 'colon'
  | 'whitespace'
  | 'unknown';

export interface FormulaToken {
  kind: FormulaTokenKind;
  start: number;
  end: number;
  text: string;
  /** Set when `kind === 'reference'`. */
  reference?: ScannedReference;
  /** For `string`: false when the closing quote has not been typed yet. */
  closed?: boolean;
}

const WORD_CHAR = /[A-Za-z0-9_.$]/;
const CELL_RANGE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})([ \t]*:[ \t]*)(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/;
const COLUMN_RANGE = /^(\$?)([A-Za-z]{1,3})([ \t]*:[ \t]*)(\$?)([A-Za-z]{1,3})/;
const ROW_RANGE = /^(\$?)(\d{1,7})([ \t]*:[ \t]*)(\$?)(\d{1,7})/;
const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/;
const ERROR_LITERAL = /^#(?:REF!|NAME\?|VALUE!|DIV\/0!|N\/A|NUM!|NULL!|CIRC!|ERROR!|LIMIT!)/i;
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const OPERATORS = ['<>', '<=', '>=', '+', '-', '*', '/', '^', '&', '=', '<', '>', '%'];

function columnFromLetters(letters: string): number | null {
  const col = columnLetterToIndex(letters);
  return col >= 0 && col < MAX_SHEET_COLUMNS ? col : null;
}

function rowFromDigits(digits: string): number | null {
  const row = Number.parseInt(digits, 10) - 1;
  return row >= 0 && row < MAX_SHEET_ROWS ? row : null;
}

/** True when `text[index]` can't continue the token that ended just before it. */
function endsWord(text: string, index: number): boolean {
  return index >= text.length || !WORD_CHAR.test(text[index]);
}

function isCallFollowing(text: string, index: number): boolean {
  let i = index;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  return text[i] === '(';
}

function cellEndpoint(colAbs: string, letters: string, rowAbs: string, digits: string): ReferenceEndpoint | null {
  const col = columnFromLetters(letters);
  const row = rowFromDigits(digits);
  if (col === null || row === null) return null;
  return { col, row, colAbsolute: colAbs === '$', rowAbsolute: rowAbs === '$' };
}

function withSeparator(endpoint: ReferenceEndpoint, separator: string): ReferenceEndpoint {
  return separator === ':' ? endpoint : { ...endpoint, rangeSeparator: separator };
}

function matchReferenceAt(text: string, index: number): ScannedReference | null {
  const rest = text.slice(index);
  const build = (kind: ReferenceKind, length: number, from: ReferenceEndpoint, to: ReferenceEndpoint): ScannedReference | null => {
    const end = index + length;
    if (!endsWord(text, end) || isCallFollowing(text, end)) return null;
    return { kind, start: index, end, text: text.slice(index, end), from, to };
  };

  let match = CELL_RANGE.exec(rest);
  if (match) {
    const from = cellEndpoint(match[1], match[2], match[3], match[4]);
    const to = cellEndpoint(match[6], match[7], match[8], match[9]);
    const range = from && to ? build('range', match[0].length, withSeparator(from, match[5]), to) : null;
    if (range) return range;
  }

  match = COLUMN_RANGE.exec(rest);
  if (match) {
    const fromCol = columnFromLetters(match[2]);
    const toCol = columnFromLetters(match[5]);
    if (fromCol !== null && toCol !== null) {
      const range = build(
        'column-range',
        match[0].length,
        withSeparator({ col: fromCol, row: null, colAbsolute: match[1] === '$', rowAbsolute: false }, match[3]),
        { col: toCol, row: null, colAbsolute: match[4] === '$', rowAbsolute: false },
      );
      if (range) return range;
    }
  }

  match = ROW_RANGE.exec(rest);
  if (match) {
    const fromRow = rowFromDigits(match[2]);
    const toRow = rowFromDigits(match[5]);
    if (fromRow !== null && toRow !== null) {
      const range = build(
        'row-range',
        match[0].length,
        withSeparator({ col: null, row: fromRow, colAbsolute: false, rowAbsolute: match[1] === '$' }, match[3]),
        { col: null, row: toRow, colAbsolute: false, rowAbsolute: match[4] === '$' },
      );
      if (range) return range;
    }
  }

  match = CELL.exec(rest);
  if (match) {
    const endpoint = cellEndpoint(match[1], match[2], match[3], match[4]);
    if (endpoint) return build('cell', match[0].length, endpoint, endpoint);
  }

  return null;
}

/**
 * Tokenize formula text. Never throws; every character belongs to exactly one
 * token, so the concatenated token texts equal the input.
 */
export function scanFormulaTokens(text: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  let index = 0;
  const push = (kind: FormulaTokenKind, end: number, extra?: Partial<FormulaToken>) => {
    tokens.push({ kind, start: index, end, text: text.slice(index, end), ...extra });
    index = end;
  };

  while (index < text.length) {
    const character = text[index];
    const atWordStart = index === 0 || !WORD_CHAR.test(text[index - 1]);

    if (/\s/.test(character)) {
      let end = index + 1;
      while (end < text.length && /\s/.test(text[end])) end += 1;
      push('whitespace', end);
      continue;
    }

    if (character === '"') {
      let end = index + 1;
      let closed = false;
      while (end < text.length) {
        if (text[end] === '"') {
          if (text[end + 1] === '"') {
            end += 2;
            continue;
          }
          end += 1;
          closed = true;
          break;
        }
        // Mirrors the parser's readString, which also accepts `\"` as an escaped quote.
        end += text[end] === '\\' && text[end + 1] === '"' ? 2 : 1;
      }
      push('string', Math.min(end, text.length), { closed });
      continue;
    }

    if (character === '#') {
      const error = ERROR_LITERAL.exec(text.slice(index));
      if (error) {
        push('error', index + error[0].length);
        continue;
      }
    }

    if (atWordStart && /[A-Za-z$0-9]/.test(character)) {
      const reference = matchReferenceAt(text, index);
      if (reference) {
        push('reference', reference.end, { reference });
        continue;
      }
    }

    if (/\d/.test(character) || (character === '.' && /\d/.test(text[index + 1] ?? ''))) {
      const number = NUMBER.exec(text.slice(index));
      push('number', index + (number?.[0].length ?? 1));
      continue;
    }

    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1;
      while (end < text.length && WORD_CHAR.test(text[end])) end += 1;
      push(isCallFollowing(text, end) ? 'function' : 'name', end);
      continue;
    }

    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, index));
    if (operator) {
      push('operator', index + operator.length);
      continue;
    }

    if (character === '(') push('leftParen', index + 1);
    else if (character === ')') push('rightParen', index + 1);
    else if (character === ',') push('comma', index + 1);
    else if (character === ':') push('colon', index + 1);
    else push('unknown', index + 1);
  }

  return tokens;
}

/** Every reference in the text, in order of appearance. */
export function scanReferences(text: string): ScannedReference[] {
  const references: ScannedReference[] = [];
  for (const token of scanFormulaTokens(text)) {
    if (token.reference) references.push(token.reference);
  }
  return references;
}

/**
 * The reference the caret is in or touching, or null.
 *
 * A caret at either edge counts (`=A1|` and `=|A1` both find `A1`), because
 * that is where the caret sits right after typing or pointing a reference.
 * A reference ending at the caret beats one starting there, matching how point
 * mode replaces the reference just typed.
 */
export function referenceAtCaret(text: string, caret: number): ScannedReference | null {
  let touchingStart: ScannedReference | null = null;
  for (const reference of scanReferences(text)) {
    if (reference.start < caret && caret <= reference.end) return reference;
    if (reference.start === caret) touchingStart = reference;
  }
  return touchingStart;
}

function formatColumn(col: number, absolute: boolean): string {
  return `${absolute ? '$' : ''}${columnIndexToLetter(col)}`;
}

function formatRow(row: number, absolute: boolean): string {
  return `${absolute ? '$' : ''}${row + 1}`;
}

/** Format one endpoint: `$A$1`, `A`, or `5` depending on which axes it has. */
export function formatEndpoint(endpoint: ReferenceEndpoint): string {
  const col = endpoint.col === null ? '' : formatColumn(endpoint.col, endpoint.colAbsolute);
  const row = endpoint.row === null ? '' : formatRow(endpoint.row, endpoint.rowAbsolute);
  return col + row;
}

/** Format a reference in canonical upper-case A1 form. */
export function formatReference(reference: Pick<ScannedReference, 'kind' | 'from' | 'to'>): string {
  if (reference.kind === 'cell') return formatEndpoint(reference.from);
  return `${formatEndpoint(reference.from)}${reference.from.rangeSeparator ?? ':'}${formatEndpoint(reference.to)}`;
}
