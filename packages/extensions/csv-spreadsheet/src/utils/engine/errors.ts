/**
 * Evaluation errors and normalization of formula.js / thrown errors into
 * spreadsheet error codes.
 */

import { FormulaParseError, type FormulaErrorCode } from './ast';

export class FormulaEvaluationError extends Error {
  constructor(readonly code: FormulaErrorCode) {
    super(code);
  }
}

export function formulaJsErrorCode(value: unknown): FormulaErrorCode | null {
  if (!(value instanceof Error)) return null;
  return normalizeErrorCode(value.message);
}

export function getErrorCode(error: unknown): FormulaErrorCode {
  if (error instanceof FormulaEvaluationError || error instanceof FormulaParseError) {
    return error.code;
  }
  if (error instanceof Error && error.message.startsWith('#')) {
    return normalizeErrorCode(error.message);
  }
  return '#VALUE!';
}

export function normalizeErrorCode(error: string): FormulaErrorCode {
  switch (error) {
    case '#VALUE!':
    case '#NAME?':
    case '#REF!':
    case '#DIV/0!':
    case '#CIRC!':
    case '#ERROR!':
    case '#N/A':
    case '#NUM!':
    case '#NULL!':
    case '#LIMIT!':
      return error;
    default:
      return '#VALUE!';
  }
}
