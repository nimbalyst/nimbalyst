/**
 * Formula evaluation using a small expression parser and formula.js functions.
 */

import * as formulajs from '@formulajs/formulajs';
import type { SpreadsheetData, FormulaEvalData, CellValue } from '../types';
import {
  collectReferenceAreas,
  FORMULA_LIMITS,
  FormulaParseError,
  parseFormulaExpression,
  type BinaryOperator,
  type FormulaAst,
  type FormulaErrorCode,
  type FormulaReference,
} from './formulaParser';

type FormulaFunction = (...args: unknown[]) => unknown;
type EvaluationValue = string | number | boolean | null | unknown[][];

interface EvaluationContext {
  activeCells: Set<string>;
  formulaCache: Map<string, EvaluationValue>;
  remainingOperations: number;
  remainingRangeCells: number;
  dependencyDepth: number;
  /** Parsed formula nodes from the recalculation graph, so evaluation reuses their ASTs. */
  formulaNodes?: Map<string, FormulaNode>;
}

interface FormulaNode {
  row: number;
  col: number;
  ast?: FormulaAst;
  parseError?: FormulaErrorCode;
  dependencies: Set<string>;
}

const FUNCTION_ALIASES = new Map([
  ['STDEV', 'STDEV.S'],
  ['VAR', 'VAR.S'],
]);

// Static by design: dependency upgrades cannot silently expose new formula.js code.
const ALLOWED_FORMULA_FUNCTIONS = [
  // Logical, lookup, and information.
  'AND', 'CHOOSE', 'COLUMN', 'COLUMNS', 'FALSE', 'HLOOKUP', 'IF', 'IFERROR', 'IFNA',
  'IFS', 'INDEX', 'ISBLANK', 'ISERR', 'ISERROR', 'ISEVEN', 'ISLOGICAL', 'ISNA',
  'ISNONTEXT', 'ISNUMBER', 'ISODD', 'ISTEXT', 'LOOKUP', 'N', 'NA', 'NOT', 'OR',
  'ROW', 'ROWS', 'SWITCH', 'TRUE', 'TYPE', 'VLOOKUP', 'XOR',
  // Arithmetic and trigonometry.
  'ABS', 'ACOS', 'ACOSH', 'ACOT', 'ACOTH', 'ARABIC', 'ASIN', 'ASINH', 'ATAN', 'ATAN2',
  'ATANH', 'BASE', 'CEILING', 'CEILINGMATH', 'CEILINGPRECISE', 'COMBIN', 'COMBINA',
  'COS', 'COSH', 'COT', 'COTH', 'CSC', 'CSCH', 'DECIMAL', 'DEGREES', 'EVEN', 'EXP',
  'FACT', 'FACTDOUBLE', 'FLOOR', 'FLOORMATH', 'FLOORPRECISE', 'GCD', 'INT', 'LCM',
  'LN', 'LOG', 'LOG10', 'MOD', 'MROUND', 'MULTINOMIAL', 'ODD', 'PI', 'POWER',
  'PRODUCT', 'QUOTIENT', 'RADIANS', 'RAND', 'RANDBETWEEN', 'ROMAN', 'ROUND',
  'ROUNDDOWN', 'ROUNDUP', 'SEC', 'SECH', 'SIGN', 'SIN', 'SINH', 'SQRT', 'SQRTPI',
  'SUBTOTAL', 'SUM', 'SUMPRODUCT', 'SUMSQ', 'SUMX2MY2', 'SUMX2PY2', 'SUMXMY2',
  'TAN', 'TANH', 'TRUNC',
  // Statistics.
  'AVEDEV', 'AVERAGE', 'AVERAGEA', 'CORREL', 'COUNT', 'COUNTA', 'COUNTBLANK',
  'COVARIANCE.P', 'COVARIANCE.S', 'DEVSQ', 'FREQUENCY', 'GEOMEAN', 'HARMEAN',
  'INTERCEPT', 'KURT', 'LARGE', 'MAX', 'MAXA', 'MEDIAN', 'MIN', 'MINA', 'MODE.MULT',
  'MODE.SNGL', 'PEARSON', 'PERCENTILE.EXC', 'PERCENTILE.INC', 'PERCENTRANK.EXC',
  'PERCENTRANK.INC', 'PERMUT', 'PERMUTATIONA', 'QUARTILE.EXC', 'QUARTILE.INC',
  'RANK.AVG', 'RANK.EQ', 'RSQ', 'SKEW', 'SKEWP', 'SLOPE', 'SMALL', 'STANDARDIZE',
  'STDEV.P', 'STDEV.S', 'STDEVA', 'STDEVPA', 'STEYX', 'TRIMMEAN', 'VAR.P', 'VAR.S',
  'VARA', 'VARPA',
  // Text.
  'CHAR', 'CLEAN', 'CODE', 'CONCAT', 'CONCATENATE', 'DOLLAR', 'EXACT', 'FIND', 'FIXED',
  'LEFT', 'LEN', 'LOWER', 'MID', 'NUMBERVALUE', 'PROPER', 'REPLACE', 'REPT', 'RIGHT',
  'SEARCH', 'SUBSTITUTE', 'T', 'TEXT', 'TEXTJOIN', 'TRIM', 'UNICHAR', 'UNICODE', 'UPPER',
  'VALUE',
  // Date and time.
  'DATE', 'DATEDIF', 'DATEVALUE', 'DAY', 'DAYS', 'DAYS360', 'EDATE', 'EOMONTH', 'HOUR',
  'ISOWEEKNUM', 'MINUTE', 'MONTH', 'NETWORKDAYS', 'NETWORKDAYSINTL', 'NOW', 'SECOND',
  'TIME', 'TIMEVALUE', 'TODAY', 'WEEKDAY', 'WEEKNUM', 'WORKDAY', 'WORKDAYINTL', 'YEAR',
  'YEARFRAC',
  // Financial and engineering functions without expression or wildcard parsing.
  'BIN2DEC', 'BIN2HEX', 'BIN2OCT', 'BITAND', 'BITLSHIFT', 'BITOR', 'BITRSHIFT', 'BITXOR',
  'COMPLEX', 'CONVERT', 'DEC2BIN', 'DEC2HEX', 'DEC2OCT', 'DELTA', 'EFFECT', 'FV',
  'FVSCHEDULE', 'GESTEP', 'HEX2BIN', 'HEX2DEC', 'HEX2OCT', 'IMABS', 'IMAGINARY',
  'IMARGUMENT', 'IMCONJUGATE', 'IMCOS', 'IMCOSH', 'IMCOT', 'IMCSC', 'IMCSCH', 'IMDIV',
  'IMEXP', 'IMLN', 'IMLOG10', 'IMLOG2', 'IMPOWER', 'IMPRODUCT', 'IMREAL', 'IMSEC',
  'IMSECH', 'IMSIN', 'IMSINH', 'IMSQRT', 'IMSUB', 'IMSUM', 'IMTAN', 'IPMT', 'IRR',
  'ISPMT', 'MIRR', 'NOMINAL', 'NPER', 'NPV', 'OCT2BIN', 'OCT2DEC', 'OCT2HEX', 'PDURATION',
  'PMT', 'PPMT', 'PV', 'RATE', 'RRI', 'SLN', 'SYD', 'TBILLEQ', 'TBILLPRICE',
  'TBILLYIELD', 'XIRR', 'XNPV',
] as const;

const WRAPPED_CRITERIA_FUNCTIONS = [
  'AVERAGEIF', 'AVERAGEIFS', 'COUNTIF', 'COUNTIFS', 'MATCH', 'MAXIFS', 'MINIFS',
  'SUMIF', 'SUMIFS',
] as const;
const FORMULA_FUNCTIONS = buildFormulaFunctionMap();

class FormulaEvaluationError extends Error {
  constructor(readonly code: FormulaErrorCode) {
    super(code);
  }
}

/** Check if a value is a formula (starts with =). */
export function isFormula(value: string): boolean {
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

/** Parse and evaluate one formula against spreadsheet data. */
export function evaluateFormula(
  formula: string,
  data: FormulaEvalData,
  currentRow: number,
  currentCol: number
): { value: CellValue; error?: string } {
  if (!isFormula(formula)) return { value: formula };

  const currentKey = cellKey(currentRow, currentCol);
  const context: EvaluationContext = {
    activeCells: new Set([currentKey]),
    formulaCache: new Map(),
    remainingOperations: FORMULA_LIMITS.maxEvaluationOperations,
    remainingRangeCells: FORMULA_LIMITS.maxRangeCells,
    dependencyDepth: 0,
  };

  try {
    const ast = parseFormulaExpression(formula.slice(1).trim());
    const value = normalizeCellResult(evaluateAst(ast, data, context));
    return { value };
  } catch (error) {
    return { value: null, error: getErrorCode(error) };
  }
}

/** Recalculate formulas in dependency order and mark dependency cycles. */
export function recalculateFormulas(data: SpreadsheetData): SpreadsheetData {
  const rows = data.rows.map((row) => row.map((cell) => (
    isFormula(cell.raw)
      ? { ...cell, computed: null, error: undefined }
      : { ...cell, error: undefined }
  )));
  const recalculationData: SpreadsheetData = { ...data, rows };
  const nodes = buildFormulaGraph(recalculationData);
  const { order, cycleKeys, limitKeys } = getEvaluationOrder(nodes);
  const formulaCache = new Map<string, EvaluationValue>();

  for (const key of order) {
    const node = nodes.get(key);
    if (!node) continue;

    if (cycleKeys.has(key)) {
      setFormulaResult(rows, node, null, '#CIRC!');
      continue;
    }

    if (limitKeys.has(key)) {
      setFormulaResult(rows, node, null, '#LIMIT!');
      continue;
    }

    if (node.parseError || !node.ast) {
      setFormulaResult(rows, node, null, node.parseError ?? '#VALUE!');
      continue;
    }

    try {
      const evaluated = evaluateAst(node.ast, recalculationData, {
        activeCells: new Set([key]),
        formulaCache,
        formulaNodes: nodes,
        remainingOperations: FORMULA_LIMITS.maxEvaluationOperations,
        remainingRangeCells: FORMULA_LIMITS.maxRangeCells,
        dependencyDepth: 0,
      });
      const computed = normalizeCellResult(evaluated);
      formulaCache.set(key, evaluated);
      setFormulaResult(rows, node, computed);
    } catch (error) {
      setFormulaResult(rows, node, null, getErrorCode(error));
    }
  }

  return recalculationData;
}

/** List every callable formula.js function name understood by the engine. */
export function getSupportedFunctions(): string[] {
  return [...FORMULA_FUNCTIONS.keys()].sort();
}

function evaluateAst(
  ast: FormulaAst,
  data: FormulaEvalData,
  context: EvaluationContext
): EvaluationValue {
  consumeOperation(context);
  switch (ast.type) {
    case 'literal':
      return ast.value;
    case 'name':
      throw new FormulaEvaluationError('#NAME?');
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
    case 'IFS':
      return evaluateIfs(argumentAsts, data, context);
    case 'SWITCH':
      return evaluateSwitch(argumentAsts, data, context);
  }

  const args = argumentAsts.map((argument) => evaluateAst(argument, data, context));
  return invokeFormulaFunction(formulaFunction, args);
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
    const ast = node?.ast ?? parseFormulaExpression(cell.raw.slice(1).trim());
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

  for (let row = minRow; row <= maxRow; row += 1) {
    const rangeRow: unknown[] = [];
    for (let col = minCol; col <= maxCol; col += 1) {
      const reference: FormulaReference = {
        row,
        col,
        rowAbsolute: false,
        colAbsolute: false,
      };
      rangeRow.push(isReferenceInBounds(data, reference)
        ? resolveCellReference(data, reference, context)
        : null);
    }
    values.push(rangeRow);
  }

  return values;
}

function buildFormulaGraph(data: SpreadsheetData): Map<string, FormulaNode> {
  const nodes = new Map<string, FormulaNode>();
  let scannedDependencyCells = 0;

  data.rows.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      if (!isFormula(cell.raw)) return;

      const node: FormulaNode = {
        row: rowIndex,
        col: colIndex,
        dependencies: new Set(),
      };
      try {
        node.ast = parseFormulaExpression(cell.raw.slice(1).trim());
      } catch (error) {
        node.parseError = getErrorCode(error);
      }
      nodes.set(cellKey(rowIndex, colIndex), node);
    });
  });

  for (const node of nodes.values()) {
    if (!node.ast) continue;

    let exceededBudget = false;

    for (const area of collectReferenceAreas(node.ast)) {
      const minRow = Math.max(0, Math.min(area.start.row, area.end.row));
      const maxRow = Math.min(data.rows.length - 1, Math.max(area.start.row, area.end.row));
      const minCol = Math.max(0, Math.min(area.start.col, area.end.col));
      const maxCol = Math.min(data.columnCount - 1, Math.max(area.start.col, area.end.col));

      for (let row = minRow; row <= maxRow; row += 1) {
        for (let col = minCol; col <= maxCol; col += 1) {
          scannedDependencyCells += 1;
          if (scannedDependencyCells > FORMULA_LIMITS.maxDependencyScanCells) {
            node.ast = undefined;
            node.parseError = '#LIMIT!';
            node.dependencies.clear();
            exceededBudget = true;
            break;
          }
          const dependencyKey = cellKey(row, col);
          if (nodes.has(dependencyKey)) node.dependencies.add(dependencyKey);
        }
        if (exceededBudget) break;
      }
      if (exceededBudget) break;
    }
  }

  return nodes;
}

function getEvaluationOrder(nodes: Map<string, FormulaNode>): {
  order: string[];
  cycleKeys: Set<string>;
  limitKeys: Set<string>;
} {
  const states = new Map<string, 'visiting' | 'visited'>();
  const order: string[] = [];
  const cycleKeys = new Set<string>();
  const limitKeys = new Set<string>();

  for (const rootKey of nodes.keys()) {
    if (states.get(rootKey) === 'visited') continue;

    const path: string[] = [];
    const pathIndexes = new Map<string, number>();
    const stack: Array<{ key: string; dependencies: string[]; nextIndex: number }> = [];

    const push = (key: string): void => {
      states.set(key, 'visiting');
      pathIndexes.set(key, path.length);
      path.push(key);
      stack.push({
        key,
        dependencies: [...(nodes.get(key)?.dependencies ?? [])],
        nextIndex: 0,
      });
    };

    push(rootKey);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.nextIndex < frame.dependencies.length) {
        const dependency = frame.dependencies[frame.nextIndex];
        frame.nextIndex += 1;
        const dependencyState = states.get(dependency);
        if (dependencyState === 'visited') continue;
        if (dependencyState === 'visiting') {
          const cycleStart = pathIndexes.get(dependency);
          if (cycleStart !== undefined) {
            for (let index = cycleStart; index < path.length; index += 1) {
              cycleKeys.add(path[index]);
            }
          }
          continue;
        }
        push(dependency);
        continue;
      }

      stack.pop();
      path.pop();
      pathIndexes.delete(frame.key);
      states.set(frame.key, 'visited');
      order.push(frame.key);
    }
  }

  const dependencyDepths = new Map<string, number>();
  for (const key of order) {
    let depth = 1;
    for (const dependency of nodes.get(key)?.dependencies ?? []) {
      if (cycleKeys.has(dependency)) continue;
      if (limitKeys.has(dependency)) {
        depth = FORMULA_LIMITS.maxDependencyDepth + 1;
        break;
      }
      depth = Math.max(depth, (dependencyDepths.get(dependency) ?? 0) + 1);
    }
    dependencyDepths.set(key, depth);
    if (depth > FORMULA_LIMITS.maxDependencyDepth) limitKeys.add(key);
  }

  return { order, cycleKeys, limitKeys };
}

function buildFormulaFunctionMap(): Map<string, FormulaFunction> {
  const functions = new Map<string, FormulaFunction>();

  for (const name of ALLOWED_FORMULA_FUNCTIONS) {
    const formulaFunction = getFormulaJsFunction(name);
    if (formulaFunction) functions.set(name, formulaFunction);
  }

  const wrappedFunctions: Record<(typeof WRAPPED_CRITERIA_FUNCTIONS)[number], FormulaFunction> = {
    AVERAGEIF: linearAverageIf,
    AVERAGEIFS: linearAverageIfs,
    COUNTIF: linearCountIf,
    COUNTIFS: linearCountIfs,
    MATCH: linearMatch,
    MAXIFS: (...args) => linearExtremaIfs('max', args[0], ...args.slice(1)),
    MINIFS: (...args) => linearExtremaIfs('min', args[0], ...args.slice(1)),
    SUMIF: linearSumIf,
    SUMIFS: linearSumIfs,
  };
  for (const name of WRAPPED_CRITERIA_FUNCTIONS) functions.set(name, wrappedFunctions[name]);

  for (const [alias, target] of FUNCTION_ALIASES) {
    const targetFunction = functions.get(target);
    if (targetFunction) functions.set(alias, targetFunction);
  }

  return functions;
}

function getFormulaJsFunction(name: string): FormulaFunction | null {
  let exported: unknown = formulajs;
  for (const segment of name.split('.')) {
    if (!exported || typeof exported !== 'object' || !(segment in exported)) return null;
    exported = (exported as Record<string, unknown>)[segment];
  }
  return typeof exported === 'function' ? exported as FormulaFunction : null;
}

function linearMatch(lookupValue: unknown, lookupArray: unknown, matchType: unknown = 1): number {
  const values = flattenFormulaValues(lookupArray);
  const normalizedMatchType = Number(matchType);
  if (!lookupArray || ![-1, 0, 1].includes(normalizedMatchType)) {
    throw new FormulaEvaluationError('#N/A');
  }

  let candidateIndex = -1;
  let candidateValue: unknown;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (normalizedMatchType === 0) {
      const matches = typeof lookupValue === 'string' && typeof value === 'string'
        ? linearGlobMatch(lookupValue, value)
        : value === lookupValue;
      if (matches) return index + 1;
      continue;
    }

    if (value === lookupValue) return index + 1;
    const comparison = compareCriteriaValues(value, lookupValue);
    const isCandidate = normalizedMatchType === 1 ? comparison < 0 : comparison > 0;
    if (!isCandidate) continue;
    if (
      candidateIndex < 0
      || (normalizedMatchType === 1 && compareCriteriaValues(value, candidateValue) > 0)
      || (normalizedMatchType === -1 && compareCriteriaValues(value, candidateValue) < 0)
    ) {
      candidateIndex = index;
      candidateValue = value;
    }
  }

  if (candidateIndex >= 0) return candidateIndex + 1;
  throw new FormulaEvaluationError('#N/A');
}

function linearCountIf(range: unknown, criteria: unknown): number {
  return flattenFormulaValues(range).filter((value) => matchesCriteria(value, criteria)).length;
}

function linearCountIfs(...args: unknown[]): number {
  const { ranges, criteria, length } = parseCriteriaPairs(args);
  let count = 0;
  for (let index = 0; index < length; index += 1) {
    if (ranges.every((range, rangeIndex) => matchesCriteria(range[index], criteria[rangeIndex]))) {
      count += 1;
    }
  }
  return count;
}

function linearSumIf(range: unknown, criteria: unknown, sumRange?: unknown): number {
  const criteriaValues = flattenFormulaValues(range);
  const sumValues = sumRange === undefined ? criteriaValues : flattenFormulaValues(sumRange);
  let sum = 0;
  for (let index = 0; index < criteriaValues.length; index += 1) {
    if (matchesCriteria(criteriaValues[index], criteria)) sum += aggregateNumber(sumValues[index]);
  }
  return sum;
}

function linearSumIfs(sumRange: unknown, ...args: unknown[]): number {
  const sumValues = flattenFormulaValues(sumRange);
  const { ranges, criteria, length } = parseCriteriaPairs(args, sumValues.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    if (ranges.every((range, rangeIndex) => matchesCriteria(range[index], criteria[rangeIndex]))) {
      sum += aggregateNumber(sumValues[index]);
    }
  }
  return sum;
}

function linearAverageIf(range: unknown, criteria: unknown, averageRange?: unknown): number {
  const criteriaValues = flattenFormulaValues(range);
  const averageValues = averageRange === undefined
    ? criteriaValues
    : flattenFormulaValues(averageRange);
  const matches: number[] = [];
  for (let index = 0; index < criteriaValues.length; index += 1) {
    if (matchesCriteria(criteriaValues[index], criteria)) {
      const value = finiteAggregateNumber(averageValues[index]);
      if (value !== null) matches.push(value);
    }
  }
  if (matches.length === 0) throw new FormulaEvaluationError('#DIV/0!');
  return matches.reduce((sum, value) => sum + value, 0) / matches.length;
}

function linearAverageIfs(averageRange: unknown, ...args: unknown[]): number {
  const averageValues = flattenFormulaValues(averageRange);
  const { ranges, criteria, length } = parseCriteriaPairs(args, averageValues.length);
  const matches: number[] = [];
  for (let index = 0; index < length; index += 1) {
    if (ranges.every((range, rangeIndex) => matchesCriteria(range[index], criteria[rangeIndex]))) {
      const value = finiteAggregateNumber(averageValues[index]);
      if (value !== null) matches.push(value);
    }
  }
  if (matches.length === 0) throw new FormulaEvaluationError('#DIV/0!');
  return matches.reduce((sum, value) => sum + value, 0) / matches.length;
}

function linearExtremaIfs(kind: 'min' | 'max', extremaRange: unknown, ...args: unknown[]): number {
  const extremaValues = flattenFormulaValues(extremaRange);
  const { ranges, criteria, length } = parseCriteriaPairs(args, extremaValues.length);
  const matches: number[] = [];
  for (let index = 0; index < length; index += 1) {
    if (ranges.every((range, rangeIndex) => matchesCriteria(range[index], criteria[rangeIndex]))) {
      const value = finiteAggregateNumber(extremaValues[index]);
      if (value !== null) matches.push(value);
    }
  }
  if (matches.length === 0) return 0;
  return kind === 'max' ? Math.max(...matches) : Math.min(...matches);
}

function parseCriteriaPairs(
  args: unknown[],
  expectedLength?: number
): { ranges: unknown[][]; criteria: unknown[]; length: number } {
  if (args.length === 0 || args.length % 2 !== 0) throw new FormulaEvaluationError('#VALUE!');
  const ranges: unknown[][] = [];
  const criteria: unknown[] = [];
  for (let index = 0; index < args.length; index += 2) {
    ranges.push(flattenFormulaValues(args[index]));
    criteria.push(args[index + 1]);
  }
  const length = expectedLength ?? ranges[0].length;
  if (ranges.some((range) => range.length !== length)) throw new FormulaEvaluationError('#VALUE!');
  return { ranges, criteria, length };
}

function matchesCriteria(value: unknown, criteria: unknown): boolean {
  if (criteria instanceof Error) throw new FormulaEvaluationError(normalizeErrorCode(criteria.message));
  if (typeof criteria !== 'string') return value === criteria;
  if (criteria.length > FORMULA_LIMITS.maxFormulaLength) throw new FormulaEvaluationError('#LIMIT!');

  const operatorMatch = /^(<=|>=|<>|=|<|>)(.*)$/s.exec(criteria);
  const operator = operatorMatch?.[1] ?? '=';
  const operandText = operatorMatch?.[2] ?? criteria;
  const numericOperand = operandText.trim() === '' ? null : Number(operandText);
  const numericValue = typeof value === 'number' ? value : Number(value);
  const bothNumeric = numericOperand !== null
    && Number.isFinite(numericOperand)
    && Number.isFinite(numericValue)
    && value !== null
    && value !== '';

  if ((operator === '=' || operator === '<>') && containsGlob(operandText)) {
    const matches = typeof value === 'string' && linearGlobMatch(operandText, value);
    return operator === '=' ? matches : !matches;
  }

  const comparison = bothNumeric
    ? numericValue - numericOperand
    : compareCriteriaValues(value, operandText);
  switch (operator) {
    case '=': return comparison === 0;
    case '<>': return comparison !== 0;
    case '<': return comparison < 0;
    case '>': return comparison > 0;
    case '<=': return comparison <= 0;
    case '>=': return comparison >= 0;
    default: return false;
  }
}

function containsGlob(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' || character === '?') return true;
    if (character === '~' && ['*', '?', '~'].includes(pattern[index + 1] ?? '')) return true;
  }
  return false;
}

function linearGlobMatch(pattern: string, input: string): boolean {
  if (pattern.length > FORMULA_LIMITS.maxFormulaLength) throw new FormulaEvaluationError('#LIMIT!');
  const tokens: Array<string | '*' | '?'> = [];
  const normalizedPattern = pattern.toLocaleLowerCase();
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    if (
      character === '~'
      && index + 1 < normalizedPattern.length
      && ['*', '?', '~'].includes(normalizedPattern[index + 1])
    ) {
      tokens.push(normalizedPattern[index + 1]);
      index += 1;
    } else if (character === '*' || character === '?') {
      if (character !== '*' || tokens[tokens.length - 1] !== '*') tokens.push(character);
    } else {
      tokens.push(character);
    }
  }

  const text = input.toLocaleLowerCase();
  let tokenIndex = 0;
  let textIndex = 0;
  let starIndex = -1;
  let starTextIndex = -1;
  while (textIndex < text.length) {
    const token = tokens[tokenIndex];
    if (token === '?' || token === text[textIndex]) {
      tokenIndex += 1;
      textIndex += 1;
    } else if (token === '*') {
      starIndex = tokenIndex;
      starTextIndex = textIndex;
      tokenIndex += 1;
    } else if (starIndex >= 0) {
      tokenIndex = starIndex + 1;
      starTextIndex += 1;
      textIndex = starTextIndex;
    } else {
      return false;
    }
  }
  while (tokens[tokenIndex] === '*') tokenIndex += 1;
  return tokenIndex === tokens.length;
}

function flattenFormulaValues(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [value];
  const flattened: unknown[] = [];
  const pending = [...value].reverse();
  while (pending.length > 0) {
    const item = pending.pop();
    if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index -= 1) pending.push(item[index]);
    } else {
      flattened.push(item);
    }
  }
  return flattened;
}

function aggregateNumber(value: unknown): number {
  return finiteAggregateNumber(value) ?? 0;
}

function finiteAggregateNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function compareCriteriaValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  const leftText = left === null || left === undefined ? '' : String(left).toLocaleLowerCase();
  const rightText = right === null || right === undefined ? '' : String(right).toLocaleLowerCase();
  return leftText.localeCompare(rightText);
}

function setFormulaResult(
  rows: SpreadsheetData['rows'],
  node: FormulaNode,
  computed: CellValue,
  error?: FormulaErrorCode
): void {
  rows[node.row][node.col] = {
    ...rows[node.row][node.col],
    computed,
    error,
  };
}

function normalizeCellResult(value: EvaluationValue): CellValue {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FormulaEvaluationError('#VALUE!');
    return value;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  throw new FormulaEvaluationError('#VALUE!');
}

function toNumber(value: EvaluationValue): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null) return 0;
  if (typeof value === 'string') {
    if (value.trim() === '') return 0;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  throw new FormulaEvaluationError('#VALUE!');
}

function toText(value: EvaluationValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  throw new FormulaEvaluationError('#VALUE!');
}

function toLogical(value: EvaluationValue): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value === 'string') {
    if (value.toUpperCase() === 'TRUE') return true;
    if (value.toUpperCase() === 'FALSE' || value === '') return false;
  }
  if (value === null) return false;
  throw new FormulaEvaluationError('#VALUE!');
}

function consumeOperation(context: EvaluationContext): void {
  context.remainingOperations -= 1;
  if (context.remainingOperations < 0) throw new FormulaEvaluationError('#LIMIT!');
}

function compareValues(left: EvaluationValue, right: EvaluationValue): number {
  try {
    return toNumber(left) - toNumber(right);
  } catch {
    return toText(left).toLocaleLowerCase().localeCompare(toText(right).toLocaleLowerCase());
  }
}

function isReferenceInBounds(data: FormulaEvalData, reference: FormulaReference): boolean {
  return reference.row >= 0
    && reference.row < data.rows.length
    && reference.col >= 0
    && reference.col < data.columnCount
    && Boolean(data.rows[reference.row]?.[reference.col]);
}

function formulaJsErrorCode(value: unknown): FormulaErrorCode | null {
  if (!(value instanceof Error)) return null;
  return normalizeErrorCode(value.message);
}

function getErrorCode(error: unknown): FormulaErrorCode {
  if (error instanceof FormulaEvaluationError || error instanceof FormulaParseError) {
    return error.code;
  }
  if (error instanceof Error && error.message.startsWith('#')) {
    return normalizeErrorCode(error.message);
  }
  return '#VALUE!';
}

function normalizeErrorCode(error: string): FormulaErrorCode {
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

function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}
