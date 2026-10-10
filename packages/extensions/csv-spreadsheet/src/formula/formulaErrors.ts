/**
 * Short explanations for the error values a formula cell can show, for the
 * hover card over an error cell. When the cell's formula is known, the text
 * names the specific cause where the formula makes it obvious (the unknown
 * function behind `#NAME?`, the deleted reference behind `#REF!`).
 */

import { FORMULA_LIMITS, type FormulaErrorCode } from '../utils/engine/ast';
import { getFunctionEntry } from './functionCatalog';
import { scanFormulaTokens } from './referenceScanner';

export interface FormulaErrorDescription {
  code: FormulaErrorCode;
  title: string;
  detail: string;
}

const ERROR_CODES: readonly FormulaErrorCode[] = [
  '#VALUE!', '#NAME?', '#REF!', '#DIV/0!', '#CIRC!', '#ERROR!', '#N/A', '#NUM!', '#NULL!', '#LIMIT!',
];

/** The error code a displayed cell value is, or null for any other value. */
export function asFormulaErrorCode(value: unknown): FormulaErrorCode | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return (ERROR_CODES as readonly string[]).includes(upper) ? upper as FormulaErrorCode : null;
}

function unknownNames(formula: string): string[] {
  const names = new Set<string>();
  for (const token of scanFormulaTokens(formula)) {
    if (token.kind === 'function' && !getFunctionEntry(token.text)) names.add(token.text.toUpperCase());
    if (token.kind === 'name' && !/^(TRUE|FALSE)$/i.test(token.text)) names.add(token.text);
  }
  return [...names];
}

/** Describe an error value. `formula` is the cell's raw text, when known. */
export function describeFormulaError(code: FormulaErrorCode, formula?: string): FormulaErrorDescription {
  const text = formula?.startsWith('=') ? formula : undefined;
  switch (code) {
    case '#REF!':
      return {
        code,
        title: 'Invalid reference',
        detail: text?.toUpperCase().includes('#REF!')
          ? 'The formula points at a row or column that was deleted.'
          : 'A reference points outside the sheet.',
      };
    case '#NAME?': {
      const names = text ? unknownNames(text) : [];
      return {
        code,
        title: 'Unknown name',
        detail: names.length > 0
          ? `Not a function or reference: ${names.join(', ')}. Check the spelling, or quote text.`
          : 'The formula uses a name that is not a function or reference. Check the spelling, or quote text.',
      };
    }
    case '#VALUE!':
      return { code, title: 'Wrong value type', detail: 'An argument has the wrong type, such as text where a number is needed.' };
    case '#DIV/0!':
      return { code, title: 'Division by zero', detail: 'The formula divides by zero or by an empty cell.' };
    case '#CIRC!':
      return { code, title: 'Circular reference', detail: 'The formula depends on its own result, directly or through other cells.' };
    case '#LIMIT!':
      return {
        code,
        title: 'Too large to calculate',
        detail: `The formula reads too many cells, or sits in a chain of more than ${FORMULA_LIMITS.maxDependencyDepth} dependent formulas.`,
      };
    case '#N/A':
      return { code, title: 'Value not available', detail: 'A lookup did not find a match, or a value is missing.' };
    case '#NUM!':
      return { code, title: 'Invalid number', detail: 'A calculation produced a number that is out of range or undefined.' };
    case '#NULL!':
      return { code, title: 'Empty intersection', detail: 'Two ranges that were meant to intersect do not overlap.' };
    case '#ERROR!':
      return { code, title: 'Formula error', detail: 'The formula could not be read. Check for a missing parenthesis or operator.' };
  }
}
