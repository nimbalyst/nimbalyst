/**
 * The callable function table: a static allow-list of formula.js functions
 * plus local replacements and aliases.
 */

import * as formulajs from '@formulajs/formulajs';
import { encodeHyperlink } from '../formatters';
import {
  linearAverageIf,
  linearAverageIfs,
  linearCountIf,
  linearCountIfs,
  linearExtremaIfs,
  linearMatch,
  linearSumIf,
  linearSumIfs,
} from './criteria';
import { FormulaEvaluationError } from './errors';
import type { FormulaFunction } from './types';

export const FUNCTION_ALIASES = new Map([
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

/**
 * Numeric aggregates that read date/datetime-typed cells in their range
 * arguments as serial numbers, so `=MAX(A:A)` over a date column finds the
 * latest date instead of 0. Lookup and criteria functions are deliberately
 * absent: they compare against the text the column stores.
 */
export const DATE_SERIAL_AGGREGATES = new Set([
  'AVERAGE', 'AVERAGEA', 'COUNT', 'LARGE', 'MAX', 'MAXA', 'MEDIAN', 'MIN', 'MINA',
  'MODE.SNGL', 'PERCENTILE.EXC', 'PERCENTILE.INC', 'QUARTILE.EXC', 'QUARTILE.INC',
  'SMALL', 'STDEV.P', 'STDEV.S', 'SUM', 'VAR.P', 'VAR.S',
]);

/**
 * Functions whose result can change without any cell they read changing.
 * Incremental recalculation re-evaluates them on every pass, as a full
 * recalculation would.
 */
export const VOLATILE_FUNCTIONS = new Set(['NOW', 'RAND', 'RANDBETWEEN', 'TODAY']);

const WRAPPED_CRITERIA_FUNCTIONS = [
  'AVERAGEIF', 'AVERAGEIFS', 'COUNTIF', 'COUNTIFS', 'MATCH', 'MAXIFS', 'MINIFS',
  'SUMIF', 'SUMIFS',
] as const;

export const FORMULA_FUNCTIONS = buildFormulaFunctionMap();

/** List every callable formula.js function name understood by the engine. */
export function getSupportedFunctions(): string[] {
  return [...FORMULA_FUNCTIONS.keys()].sort();
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

  // formula.js takes ATAN2(y, x); Excel and every other spreadsheet take
  // ATAN2(x_num, y_num), so =ATAN2(1,0) is 0, not PI/2.
  const formulaJsAtan2 = functions.get('ATAN2');
  if (formulaJsAtan2) functions.set('ATAN2', (xNum, yNum) => formulaJsAtan2(yNum, xNum));

  // Implemented locally rather than taken from formula.js: a computed cell value
  // is `string | number | null`, so the label has to travel with the URL inside
  // one string. `encodeHyperlink` packs both; the URL cell renderer unpacks them.
  functions.set('HYPERLINK', (url: unknown, label?: unknown) => {
    const href = typeof url === 'string' ? url.trim() : '';
    if (href === '') throw new FormulaEvaluationError('#VALUE!');
    const text = label === undefined || label === null ? href : String(label);
    return encodeHyperlink(href, text);
  });

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
