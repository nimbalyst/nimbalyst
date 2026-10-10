/**
 * AST evaluation: operators, control-flow functions, references, and ranges.
 */

import type { CellValue, FormulaEvalData } from '../../types';
import {
  FORMULA_LIMITS,
  type BinaryOperator,
  type FormulaAst,
  type FormulaErrorCode,
  type FormulaReference,
} from './ast';
import { parseFormulaExpression } from './astParser';
import {
  aggregateDateValue,
  compareValues,
  normalizeCellResult,
  toLogical,
  toNumber,
  toText,
} from './coercion';
import {
  FormulaEvaluationError,
  formulaJsErrorCode,
  getErrorCode,
  normalizeErrorCode,
} from './errors';
import { DATE_SERIAL_AGGREGATES, FORMULA_FUNCTIONS, FUNCTION_ALIASES } from './functions';
import {
  cellKey,
  isFormula,
  type EvaluationContext,
  type EvaluationValue,
  type FormulaEvalDataWithFormats,
  type FormulaFunction,
  type FormulaNode,
} from './types';

/** A fresh per-formula budget for evaluating the formula at `key`. */
export function createEvaluationContext(
  key: string,
  formulaCache: Map<string, EvaluationValue>,
  formulaNodes?: Map<string, FormulaNode>
): EvaluationContext {
  return {
    activeCells: new Set([key]),
    formulaCache,
    formulaNodes,
    remainingOperations: FORMULA_LIMITS.maxEvaluationOperations,
    remainingRangeCells: FORMULA_LIMITS.maxRangeCells,
    dependencyDepth: 0,
  };
}

/** Parse and evaluate one formula against spreadsheet data. */
export function evaluateFormula(
  formula: string,
  data: FormulaEvalData,
  currentRow: number,
  currentCol: number
): { value: CellValue; error?: string } {
  if (!isFormula(formula)) return { value: formula };

  const context = createEvaluationContext(cellKey(currentRow, currentCol), new Map());

  try {
    const ast = parseFormulaExpression(formula.slice(1).trim(), data.namedRanges);
    const value = normalizeCellResult(evaluateAst(ast, data, context));
    return { value };
  } catch (error) {
    return { value: null, error: getErrorCode(error) };
  }
}

export function evaluateAst(
  ast: FormulaAst,
  data: FormulaEvalData,
  context: EvaluationContext
): EvaluationValue {
  consumeOperation(context);
  switch (ast.type) {
    case 'literal':
      return ast.value;
    case 'name':
      // An undefined word shaped like a cell ref is an out-of-bounds reference, not a misspelled name.
      throw new FormulaEvaluationError(/^[A-Z]+\d+$/.test(ast.name) ? '#REF!' : '#NAME?');
    case 'error':
      throw new FormulaEvaluationError(ast.code);
    case 'reference':
      return resolveCellReference(data, ast.reference, context);
    case 'range':
      return resolveRange(data, ast.start, ast.end, context);
    case 'unary': {
      const value = toNumber(evaluateAst(ast.operand, data, context));
      return ast.operator === '-' ? -value : value;
    }
    case 'percent':
      return toNumber(evaluateAst(ast.operand, data, context)) / 100;
    case 'binary':
      return evaluateBinary(
        ast.operator,
        evaluateAst(ast.left, data, context),
        evaluateAst(ast.right, data, context)
      );
    case 'call':
      return evaluateFunctionCall(ast.name, ast.args, data, context);
  }
}

function evaluateFunctionCall(
  name: string,
  argumentAsts: FormulaAst[],
  data: FormulaEvalData,
  context: EvaluationContext
): EvaluationValue {
  const normalizedName = FUNCTION_ALIASES.get(name.toUpperCase()) ?? name.toUpperCase();
  const formulaFunction = FORMULA_FUNCTIONS.get(normalizedName);
  if (!formulaFunction) throw new FormulaEvaluationError('#NAME?');

  switch (normalizedName) {
    case 'IF':
      return evaluateIf(argumentAsts, data, context);
    case 'IFERROR':
      return evaluateIfError(argumentAsts, data, context, false);
    case 'IFNA':
      return evaluateIfError(argumentAsts, data, context, true);
    case 'ISERROR':
    case 'ISERR':
    case 'ISNA':
      return evaluateIsError(normalizedName, argumentAsts, data, context);
    case 'IFS':
      return evaluateIfs(argumentAsts, data, context);
    case 'SWITCH':
      return evaluateSwitch(argumentAsts, data, context);
  }

  // Numeric aggregates read dates as serials: ranges convert per cell in
  // `resolveRange`, single-cell and computed arguments here.
  const aggregate = DATE_SERIAL_AGGREGATES.has(normalizedName);
  const outerDateMode = context.dateRangesAsSerials;
  context.dateRangesAsSerials = aggregate;
  try {
    const args = argumentAsts.map((argument) => {
      const value = evaluateAst(argument, data, context);
      if (!aggregate) return value;
      const col = argument.type === 'reference' ? argument.reference.col : -1;
      return aggregateDateValue(value, dateTypedColumns(data, col, col) !== null);
    });
    return invokeFormulaFunction(formulaFunction, args);
  } finally {
    context.dateRangesAsSerials = outerDateMode;
  }
}

function evaluateIf(
  args: FormulaAst[],
  data: FormulaEvalData,
  context: EvaluationContext
): EvaluationValue {
  if (args.length < 1 || args.length > 3) throw new FormulaEvaluationError('#VALUE!');
  const condition = toLogical(evaluateAst(args[0], data, context));
  if (condition) return args[1] ? evaluateAst(args[1], data, context) : true;
  return args[2] ? evaluateAst(args[2], data, context) : false;
}

function evaluateIfError(
  args: FormulaAst[],
  data: FormulaEvalData,
  context: EvaluationContext,
  onlyNotAvailable: boolean
): EvaluationValue {
  if (args.length !== 2) throw new FormulaEvaluationError('#VALUE!');
  try {
    return evaluateAst(args[0], data, context);
  } catch (error) {
    const code = getErrorCode(error);
    if (onlyNotAvailable && code !== '#N/A') throw error;
    return evaluateAst(args[1], data, context);
  }
}

/**
 * Errors travel as exceptions, so the IS-error tests have to catch them here:
 * handing formula.js the evaluated argument would mean the error had already
 * aborted the whole formula.
 */
function evaluateIsError(
  name: 'ISERROR' | 'ISERR' | 'ISNA',
  args: FormulaAst[],
  data: FormulaEvalData,
  context: EvaluationContext
): EvaluationValue {
  if (args.length !== 1) throw new FormulaEvaluationError('#VALUE!');
  let code: FormulaErrorCode;
  try {
    evaluateAst(args[0], data, context);
    return false;
  } catch (error) {
    code = getErrorCode(error);
  }
  // A budget overrun is not the formula's error to test; let it surface.
  if (code === '#LIMIT!') throw new FormulaEvaluationError(code);
  if (name === 'ISNA') return code === '#N/A';
  if (name === 'ISERR') return code !== '#N/A';
  return true;
}

function evaluateIfs(
  args: FormulaAst[],
  data: FormulaEvalData,
  context: EvaluationContext
): EvaluationValue {
  if (args.length < 2 || args.length % 2 !== 0) throw new FormulaEvaluationError('#VALUE!');
  for (let index = 0; index < args.length; index += 2) {
    if (toLogical(evaluateAst(args[index], data, context))) {
      return evaluateAst(args[index + 1], data, context);
    }
  }
  throw new FormulaEvaluationError('#N/A');
}

function evaluateSwitch(
  args: FormulaAst[],
  data: FormulaEvalData,
  context: EvaluationContext
): EvaluationValue {
  if (args.length < 3) throw new FormulaEvaluationError('#VALUE!');
  const target = evaluateAst(args[0], data, context);
  const hasDefault = args.length % 2 === 0;
  const pairEnd = hasDefault ? args.length - 1 : args.length;

  for (let index = 1; index < pairEnd; index += 2) {
    if (compareValues(target, evaluateAst(args[index], data, context)) === 0) {
      return evaluateAst(args[index + 1], data, context);
    }
  }
  if (hasDefault) return evaluateAst(args[args.length - 1], data, context);
  throw new FormulaEvaluationError('#N/A');
}

function invokeFormulaFunction(
  formulaFunction: FormulaFunction,
  args: unknown[]
): EvaluationValue {
  const result = formulaFunction(...args);
  const errorCode = formulaJsErrorCode(result);
  if (errorCode) throw new FormulaEvaluationError(errorCode);
  if (result === undefined) throw new FormulaEvaluationError('#VALUE!');
  return result as EvaluationValue;
}

function evaluateBinary(
  operator: BinaryOperator,
  left: EvaluationValue,
  right: EvaluationValue
): EvaluationValue {
  switch (operator) {
    case '+':
      return toNumber(left) + toNumber(right);
    case '-':
      return toNumber(left) - toNumber(right);
    case '*':
      return toNumber(left) * toNumber(right);
    case '/': {
      const divisor = toNumber(right);
      if (divisor === 0) throw new FormulaEvaluationError('#DIV/0!');
      return toNumber(left) / divisor;
    }
    case '^':
      return Math.pow(toNumber(left), toNumber(right));
    case '&':
      return `${toText(left)}${toText(right)}`;
    case '=':
      return compareValues(left, right) === 0;
    case '<>':
      return compareValues(left, right) !== 0;
    case '<':
      return compareValues(left, right) < 0;
    case '>':
      return compareValues(left, right) > 0;
    case '<=':
      return compareValues(left, right) <= 0;
    case '>=':
      return compareValues(left, right) >= 0;
  }
}

function resolveCellReference(
  data: FormulaEvalData,
  reference: FormulaReference,
  context: EvaluationContext
): EvaluationValue {
  if (!isReferenceInBounds(data, reference)) throw new FormulaEvaluationError('#REF!');

  const key = cellKey(reference.row, reference.col);
  if (context.activeCells.has(key)) throw new FormulaEvaluationError('#CIRC!');
  const cached = context.formulaCache.get(key);
  if (cached !== undefined) return cached;

  const cell = data.rows[reference.row][reference.col];
  if (cell.error) throw new FormulaEvaluationError(normalizeErrorCode(cell.error));
  if (!isFormula(cell.raw)) return cell.computed ?? 0;

  const node = context.formulaNodes?.get(key);
  if (node?.parseError) throw new FormulaEvaluationError(node.parseError);

  context.activeCells.add(key);
  context.dependencyDepth += 1;
  if (context.dependencyDepth > FORMULA_LIMITS.maxDependencyDepth) {
    context.activeCells.delete(key);
    context.dependencyDepth -= 1;
    throw new FormulaEvaluationError('#LIMIT!');
  }
  try {
    const ast = node?.ast ?? parseFormulaExpression(cell.raw.slice(1).trim(), data.namedRanges);
    const evaluated = evaluateAst(ast, data, context);
    normalizeCellResult(evaluated);
    context.formulaCache.set(key, evaluated);
    return evaluated;
  } finally {
    context.dependencyDepth -= 1;
    context.activeCells.delete(key);
  }
}

function resolveRange(
  data: FormulaEvalData,
  start: FormulaReference,
  end: FormulaReference,
  context: EvaluationContext
): unknown[][] {
  const minRow = Math.max(0, Math.min(start.row, end.row));
  const maxRow = Math.min(data.rows.length - 1, Math.max(start.row, end.row));
  const minCol = Math.max(0, Math.min(start.col, end.col));
  const maxCol = Math.min(data.columnCount - 1, Math.max(start.col, end.col));
  const values: unknown[][] = [];

  if (minRow > maxRow || minCol > maxCol) return values;
  const rangeCells = (maxRow - minRow + 1) * (maxCol - minCol + 1);
  context.remainingRangeCells -= rangeCells;
  if (context.remainingRangeCells < 0) throw new FormulaEvaluationError('#LIMIT!');

  const dateColumns = context.dateRangesAsSerials ? dateTypedColumns(data, minCol, maxCol) : null;
  const asSerial = context.dateRangesAsSerials === true;
  for (let row = minRow; row <= maxRow; row += 1) {
    const rangeRow: unknown[] = [];
    for (let col = minCol; col <= maxCol; col += 1) {
      const reference: FormulaReference = {
        row,
        col,
        rowAbsolute: false,
        colAbsolute: false,
      };
      const value = isReferenceInBounds(data, reference)
        ? resolveCellReference(data, reference, context)
        : null;
      rangeRow.push(asSerial ? aggregateDateValue(value, dateColumns?.has(col) ?? false) : value);
    }
    values.push(rangeRow);
  }

  return values;
}

function dateTypedColumns(data: FormulaEvalDataWithFormats, minCol: number, maxCol: number): Set<number> | null {
  const formats = data.columnFormats;
  if (!formats) return null;
  const columns = new Set<number>();
  for (let col = minCol; col <= maxCol; col += 1) {
    const type = formats[col]?.type;
    if (type === 'date' || type === 'datetime') columns.add(col);
  }
  return columns.size > 0 ? columns : null;
}

function consumeOperation(context: EvaluationContext): void {
  context.remainingOperations -= 1;
  if (context.remainingOperations < 0) throw new FormulaEvaluationError('#LIMIT!');
}

function isReferenceInBounds(data: FormulaEvalData, reference: FormulaReference): boolean {
  return reference.row >= 0
    && reference.row < data.rows.length
    && reference.col >= 0
    && reference.col < data.columnCount
    && Boolean(data.rows[reference.row]?.[reference.col]);
}
