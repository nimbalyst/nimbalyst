/**
 * Formula evaluation engine using formula.js
 *
 * Supports Excel-like formulas with cell references
 */

import * as formulajs from '@formulajs/formulajs';
import type { SpreadsheetData, FormulaEvalData, CellValue } from '../types';
import { parseCellReference, parseRangeReference } from './csvParser';

/**
 * Check if a value is a formula (starts with =)
 */
export function isFormula(value: string): boolean {
  return value.trim().startsWith('=');
}

/**
 * Get the computed value of a cell, evaluating formulas if needed
 */
export function getCellValue(data: FormulaEvalData, row: number, col: number): CellValue {
  if (row < 0 || row >= data.rows.length || col < 0 || col >= data.columnCount) {
    return null;
  }

  const cell = data.rows[row][col];
  return cell.computed;
}

/**
 * Get a range of cell values for formula functions
 */
function getCellRange(
  data: FormulaEvalData,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): CellValue[] {
  const values: CellValue[] = [];

  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);

  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      values.push(getCellValue(data, r, c));
    }
  }

  return values;
}

/**
 * Parse and resolve cell/range references in a formula
 */
function resolveReferences(
  formula: string,
  data: FormulaEvalData,
  currentRow: number,
  currentCol: number
): { resolved: string; error?: string } {
  // Match cell references like A1, B2, AA10 and ranges like A1:B5
  const refPattern = /([A-Za-z]+\d+)(?::([A-Za-z]+\d+))?/g;

  let resolved = formula;
  let match;

  while ((match = refPattern.exec(formula)) !== null) {
    const fullMatch = match[0];
    const startRef = match[1];
    const endRef = match[2];

    if (endRef) {
      // It's a range reference
      const range = parseRangeReference(fullMatch);
      if (range) {
        const values = getCellRange(
          data,
          range.start.row,
          range.start.col,
          range.end.row,
          range.end.col
        );
        // Convert to array literal for formula.js
        const arrayLiteral = values
          .map(v => (v === null ? 0 : typeof v === 'number' ? v : `"${v}"`))
          .join(',');
        resolved = resolved.replace(fullMatch, `[${arrayLiteral}]`);
      }
    } else {
      // It's a single cell reference
      const ref = parseCellReference(startRef);
      if (ref) {
        // Check for circular reference
        if (ref.row === currentRow && ref.col === currentCol) {
          return { resolved: '', error: '#REF!' };
        }

        const value = getCellValue(data, ref.row, ref.col);
        if (value === null) {
          resolved = resolved.replace(fullMatch, '0');
        } else if (typeof value === 'number') {
          resolved = resolved.replace(fullMatch, String(value));
        } else {
          resolved = resolved.replace(fullMatch, `"${value}"`);
        }
      }
    }
  }

  return { resolved };
}

/**
 * Evaluate a formula and return the computed value
 */
export function evaluateFormula(
  formula: string,
  data: FormulaEvalData,
  currentRow: number,
  currentCol: number
): { value: CellValue; error?: string } {
  if (!isFormula(formula)) {
    return { value: formula };
  }

  // Remove the leading =
  const expression = formula.slice(1).trim().toUpperCase();

  try {
    // Resolve cell references
    const { resolved, error } = resolveReferences(expression, data, currentRow, currentCol);
    if (error) {
      return { value: null, error };
    }

    // Parse the function call
    const funcMatch = resolved.match(/^([A-Z_]+)\s*\((.*)\)$/);
    if (!funcMatch) {
      // Try to evaluate as a simple expression
      return evaluateExpression(resolved);
    }

    const funcName = funcMatch[1];
    const argsStr = funcMatch[2];

    // Get the function from formula.js
    const func = getFormulaFunction(funcName);
    if (!func) {
      return { value: null, error: '#NAME?' };
    }

    // Parse arguments
    const args = parseArguments(argsStr);

    // Call the function
    const result = func(...args);

    // Check for formula.js error objects
    if (result && typeof result === 'object' && 'error' in result) {
      return { value: null, error: String(result.error) };
    }

    return { value: result as CellValue };
  } catch (err) {
    console.error('[Formula] Evaluation error:', err);
    return { value: null, error: '#ERROR!' };
  }
}

/**
 * Get a formula.js function by name
 */
function getFormulaFunction(name: string): ((...args: unknown[]) => unknown) | null {
  // Map common function names to formula.js
  const funcMap: Record<string, (...args: unknown[]) => unknown> = {
    // Math functions
    SUM: formulajs.SUM,
    AVERAGE: formulajs.AVERAGE,
    MIN: formulajs.MIN,
    MAX: formulajs.MAX,
    COUNT: formulajs.COUNT,
    ROUND: formulajs.ROUND,
    ABS: formulajs.ABS,
    SQRT: formulajs.SQRT,
    POWER: formulajs.POWER,

    // Logic functions
    IF: formulajs.IF,
    AND: formulajs.AND,
    OR: formulajs.OR,
    NOT: formulajs.NOT,

    // Text functions
    CONCAT: formulajs.CONCAT,
    CONCATENATE: formulajs.CONCATENATE,
    LEFT: formulajs.LEFT,
    RIGHT: formulajs.RIGHT,
    MID: formulajs.MID,
    LEN: formulajs.LEN,
    UPPER: formulajs.UPPER,
    LOWER: formulajs.LOWER,
    TRIM: formulajs.TRIM,

    // Statistical functions
    COUNTA: formulajs.COUNTA,
    COUNTBLANK: formulajs.COUNTBLANK,
    MEDIAN: formulajs.MEDIAN,
    STDEV: formulajs.STDEV.S as (...args: unknown[]) => unknown,
    VAR: formulajs.VAR.S as (...args: unknown[]) => unknown,
  };

  return funcMap[name] || null;
}

/**
 * Parse function arguments from a string
 */
function parseArguments(argsStr: string): unknown[] {
  const args: unknown[] = [];
  let current = '';
  let depth = 0;
  let inString = false;

  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i];

    if (char === '"' && argsStr[i - 1] !== '\\') {
      inString = !inString;
      current += char;
    } else if (!inString && char === '(') {
      depth++;
      current += char;
    } else if (!inString && char === ')') {
      depth--;
      current += char;
    } else if (!inString && char === '[') {
      depth++;
      current += char;
    } else if (!inString && char === ']') {
      depth--;
      current += char;
    } else if (!inString && char === ',' && depth === 0) {
      args.push(parseArgumentValue(current.trim()));
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    args.push(parseArgumentValue(current.trim()));
  }

  return args;
}

/**
 * Parse a single argument value
 */
function parseArgumentValue(value: string): unknown {
  // Array literal
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1);
    return parseArguments(inner);
  }

  // String literal
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }

  // Boolean
  if (value === 'TRUE') return true;
  if (value === 'FALSE') return false;

  // Number
  const num = parseFloat(value);
  if (!isNaN(num)) return num;

  // Otherwise return as string
  return value;
}

/**
 * Evaluate a simple expression (basic math)
 */
function evaluateExpression(expr: string): { value: CellValue; error?: string } {
  try {
    // Only allow safe characters for evaluation
    const safeExpr = expr.replace(/[^0-9+\-*/().," ]/g, '');
    if (safeExpr !== expr) {
      return { value: null, error: '#VALUE!' };
    }

    // Use Function constructor for safe evaluation (no access to globals)
    const result = new Function(`return (${safeExpr})`)();
    return { value: typeof result === 'number' ? result : String(result) };
  } catch {
    return { value: null, error: '#VALUE!' };
  }
}

/**
 * Recalculate all formulas in the spreadsheet
 */
export function recalculateFormulas(data: SpreadsheetData): SpreadsheetData {
  const newRows = data.rows.map((row, rowIndex) =>
    row.map((cell, colIndex) => {
      if (isFormula(cell.raw)) {
        const { value, error } = evaluateFormula(cell.raw, data, rowIndex, colIndex);
        return {
          ...cell,
          computed: value,
          error,
        };
      }
      return cell;
    })
  );

  return {
    ...data,
    rows: newRows,
  };
}

/**
 * Get list of supported functions for documentation
 */
export function getSupportedFunctions(): string[] {
  return [
    'SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'ROUND', 'ABS', 'SQRT', 'POWER',
    'IF', 'AND', 'OR', 'NOT',
    'CONCAT', 'CONCATENATE', 'LEFT', 'RIGHT', 'MID', 'LEN', 'UPPER', 'LOWER', 'TRIM',
    'COUNTA', 'COUNTBLANK', 'MEDIAN', 'STDEV', 'VAR',
  ];
}
