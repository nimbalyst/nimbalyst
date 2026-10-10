/**
 * Formula AST, token, and limit definitions shared by the tokenizer, parser,
 * and evaluator.
 */

export type FormulaErrorCode =
  | '#VALUE!'
  | '#NAME?'
  | '#REF!'
  | '#DIV/0!'
  | '#CIRC!'
  | '#ERROR!'
  | '#N/A'
  | '#NUM!'
  | '#NULL!'
  | '#LIMIT!';

export const FORMULA_LIMITS = {
  maxFormulaLength: 8_192,
  maxReferenceRows: 1_048_576,
  maxReferenceColumns: 16_384,
  maxAstDepth: 64,
  maxAstNodes: 2_048,
  maxDependencyDepth: 256,
  maxRangeCells: 100_000,
  maxEvaluationOperations: 10_000,
  maxDependencyScanCells: 500_000,
} as const;

export interface FormulaReference {
  col: number;
  row: number;
  colAbsolute: boolean;
  rowAbsolute: boolean;
}

export type BinaryOperator =
  | '+'
  | '-'
  | '*'
  | '/'
  | '^'
  | '&'
  | '='
  | '<>'
  | '<'
  | '>'
  | '<='
  | '>=';

export type FormulaAst =
  | { type: 'literal'; value: string | number | boolean }
  | { type: 'name'; name: string }
  /** An error typed into the formula, usually `#REF!` left by a structural edit. */
  | { type: 'error'; code: FormulaErrorCode }
  | { type: 'reference'; reference: FormulaReference }
  /**
   * `axis` marks a whole-column (`A:C`) or whole-row (`1:3`) reference. Its
   * endpoints span the full sheet on the open axis; evaluation clamps every
   * range to the used range, so `A:A` reads only the rows that exist.
   */
  | { type: 'range'; start: FormulaReference; end: FormulaReference; axis?: 'column' | 'row' }
  | { type: 'unary'; operator: '+' | '-'; operand: FormulaAst }
  | { type: 'percent'; operand: FormulaAst }
  | { type: 'binary'; operator: BinaryOperator; left: FormulaAst; right: FormulaAst }
  | { type: 'call'; name: string; args: FormulaAst[] };

export interface FormulaReferenceArea {
  start: FormulaReference;
  end: FormulaReference;
}

export type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'identifier'; value: string }
  | { kind: 'reference'; value: string }
  | { kind: 'error'; code: FormulaErrorCode }
  | { kind: 'axisRange'; axis: 'column' | 'row'; start: FormulaReference; end: FormulaReference }
  | { kind: 'operator'; value: BinaryOperator | '%' }
  | { kind: 'leftParen' }
  | { kind: 'rightParen' }
  | { kind: 'comma' }
  | { kind: 'colon' }
  | { kind: 'eof' };

export class FormulaParseError extends Error {
  constructor(readonly code: FormulaErrorCode = '#VALUE!') {
    super(code);
  }
}
