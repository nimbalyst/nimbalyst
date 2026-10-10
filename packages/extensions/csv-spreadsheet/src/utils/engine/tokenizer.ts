/**
 * Formula tokenizer and A1 cell-reference parsing.
 */

import { columnLetterToIndex } from '../csvParser';
import {
  FORMULA_LIMITS,
  FormulaParseError,
  type BinaryOperator,
  type FormulaErrorCode,
  type FormulaReference,
  type Token,
} from './ast';

const CELL_REFERENCE_PATTERN = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/;
const WORD_CHARACTER_PATTERN = /[A-Za-z0-9_.$]/;
const ERROR_LITERAL_PATTERN = /^#(?:REF!|VALUE!|DIV\/0!|NAME\?|N\/A|NUM!|NULL!)/i;
// The lookahead keeps `A:A1`, `1:2B` and `A:B(` from reading as whole-axis refs.
const COLUMN_RANGE_PATTERN = /^(\$?)([A-Za-z]{1,3})[ \t]*:[ \t]*(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_.$]|\s*\()/;
const ROW_RANGE_PATTERN = /^(\$?)(\d{1,7})[ \t]*:[ \t]*(\$?)(\d{1,7})(?![A-Za-z0-9_.$])/;

export function parseCellReference(reference: string): FormulaReference | null {
  const match = CELL_REFERENCE_PATTERN.exec(reference);
  if (!match) return null;

  // Excel-compatible bounds also keep conversion of attacker-controlled digit/letter runs finite.
  if (match[2].length > 3 || match[4].length > 7) return null;

  const rowNumber = Number.parseInt(match[4], 10);
  const col = columnLetterToIndex(match[2]);
  if (
    !Number.isFinite(rowNumber)
    || rowNumber < 1
    || rowNumber > FORMULA_LIMITS.maxReferenceRows
    || !Number.isFinite(col)
    || col < 0
    || col >= FORMULA_LIMITS.maxReferenceColumns
  ) {
    return null;
  }

  return {
    col,
    row: rowNumber - 1,
    colAbsolute: match[1] === '$',
    rowAbsolute: match[3] === '$',
  };
}

export function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const character = expression[index];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    const axisRange = readAxisRange(expression, index);
    if (axisRange) {
      tokens.push(axisRange.token);
      index = axisRange.nextIndex;
      continue;
    }

    if (character === '#') {
      const error = ERROR_LITERAL_PATTERN.exec(expression.slice(index));
      if (!error) throw new FormulaParseError();
      tokens.push({ kind: 'error', code: error[0].toUpperCase() as FormulaErrorCode });
      index += error[0].length;
      continue;
    }

    if (character === '"') {
      const result = readString(expression, index + 1);
      tokens.push({ kind: 'string', value: result.value });
      index = result.nextIndex;
      continue;
    }

    if (/\d/.test(character) || (character === '.' && /\d/.test(expression[index + 1] ?? ''))) {
      const result = readNumber(expression, index);
      tokens.push({ kind: 'number', value: result.value });
      index = result.nextIndex;
      continue;
    }

    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1;
      while (end < expression.length && WORD_CHARACTER_PATTERN.test(expression[end])) {
        end += 1;
      }

      const word = expression.slice(index, end);
      // A name followed by `(` is a call even when it is shaped like a cell
      // ref: LOG10, ATAN2 and DAYS360 would otherwise tokenize as references.
      const isCall = /^\s*\(/.test(expression.slice(end));
      if (isCall && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(word)) {
        tokens.push({ kind: 'identifier', value: word });
      } else if (parseCellReference(word)) {
        // Only an in-bounds A1 ref is a reference: `ABCD1` and `Sales2026` are
        // names, matching what range-name validation accepts.
        tokens.push({ kind: 'reference', value: word });
      } else if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(word)) {
        tokens.push({ kind: 'identifier', value: word });
      } else {
        throw new FormulaParseError(word.includes('$') ? '#REF!' : '#VALUE!');
      }
      index = end;
      continue;
    }

    const pair = expression.slice(index, index + 2);
    if (pair === '<>' || pair === '<=' || pair === '>=') {
      tokens.push({ kind: 'operator', value: pair });
      index += 2;
      continue;
    }

    if ('+-*/^%&=<>'.includes(character)) {
      tokens.push({ kind: 'operator', value: character as BinaryOperator | '%' });
      index += 1;
      continue;
    }

    if (character === '(') tokens.push({ kind: 'leftParen' });
    else if (character === ')') tokens.push({ kind: 'rightParen' });
    else if (character === ',') tokens.push({ kind: 'comma' });
    else if (character === ':') tokens.push({ kind: 'colon' });
    else throw new FormulaParseError();
    index += 1;
  }

  tokens.push({ kind: 'eof' });
  return tokens;
}

/** A whole-column (`A:C`, `$A:$A`) or whole-row (`1:3`) reference starting at `index`. */
function readAxisRange(
  expression: string,
  index: number
): { token: Token; nextIndex: number } | null {
  if (index > 0 && WORD_CHARACTER_PATTERN.test(expression[index - 1])) return null;
  const rest = expression.slice(index);

  const columns = COLUMN_RANGE_PATTERN.exec(rest);
  if (columns) {
    const startCol = columnLetterToIndex(columns[2]);
    const endCol = columnLetterToIndex(columns[4]);
    if (!isColumnInBounds(startCol) || !isColumnInBounds(endCol)) return null;
    const lastRow = FORMULA_LIMITS.maxReferenceRows - 1;
    return {
      token: {
        kind: 'axisRange',
        axis: 'column',
        start: { col: startCol, row: 0, colAbsolute: columns[1] === '$', rowAbsolute: false },
        end: { col: endCol, row: lastRow, colAbsolute: columns[3] === '$', rowAbsolute: false },
      },
      nextIndex: index + columns[0].length,
    };
  }

  const rows = ROW_RANGE_PATTERN.exec(rest);
  if (rows) {
    const startRow = Number.parseInt(rows[2], 10) - 1;
    const endRow = Number.parseInt(rows[4], 10) - 1;
    if (!isRowInBounds(startRow) || !isRowInBounds(endRow)) return null;
    const lastCol = FORMULA_LIMITS.maxReferenceColumns - 1;
    return {
      token: {
        kind: 'axisRange',
        axis: 'row',
        start: { col: 0, row: startRow, colAbsolute: false, rowAbsolute: rows[1] === '$' },
        end: { col: lastCol, row: endRow, colAbsolute: false, rowAbsolute: rows[3] === '$' },
      },
      nextIndex: index + rows[0].length,
    };
  }

  return null;
}

function isColumnInBounds(col: number): boolean {
  return Number.isFinite(col) && col >= 0 && col < FORMULA_LIMITS.maxReferenceColumns;
}

function isRowInBounds(row: number): boolean {
  return Number.isFinite(row) && row >= 0 && row < FORMULA_LIMITS.maxReferenceRows;
}

function readString(expression: string, startIndex: number): { value: string; nextIndex: number } {
  let value = '';
  let index = startIndex;

  while (index < expression.length) {
    const character = expression[index];
    if (character === '"') {
      if (expression[index + 1] === '"') {
        value += '"';
        index += 2;
        continue;
      }
      return { value, nextIndex: index + 1 };
    }

    if (character === '\\' && expression[index + 1] === '"') {
      value += '"';
      index += 2;
      continue;
    }

    value += character;
    index += 1;
  }

  throw new FormulaParseError();
}

function readNumber(expression: string, startIndex: number): { value: number; nextIndex: number } {
  let index = startIndex;
  while (/\d/.test(expression[index] ?? '')) index += 1;

  if (expression[index] === '.') {
    index += 1;
    while (/\d/.test(expression[index] ?? '')) index += 1;
  }

  if (/[eE]/.test(expression[index] ?? '')) {
    const exponentStart = index;
    index += 1;
    if (/[+-]/.test(expression[index] ?? '')) index += 1;
    const digitStart = index;
    while (/\d/.test(expression[index] ?? '')) index += 1;
    if (digitStart === index) index = exponentStart;
  }

  const value = Number(expression.slice(startIndex, index));
  if (!Number.isFinite(value)) throw new FormulaParseError();
  return { value, nextIndex: index };
}
