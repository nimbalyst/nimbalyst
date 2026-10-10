/**
 * The formula dependency graph: one node per formula cell, edges to the
 * formula cells it reads, and a topological evaluation order with cycle and
 * depth-limit detection.
 */

import type { SpreadsheetData } from '../../types';
import { FORMULA_LIMITS } from './ast';
import { collectReferenceAreas, parseFormulaExpression } from './astParser';
import { getErrorCode } from './errors';
import { cellKey, isFormula, type CellRect, type FormulaNode } from './types';

export interface FormulaGraph {
  nodes: Map<string, FormulaNode>;
  /** Total cells charged against `maxDependencyScanCells`. */
  scannedCells: number;
}

export interface EvaluationOrder {
  order: string[];
  cycleKeys: Set<string>;
  limitKeys: Set<string>;
}

/** Parse a formula cell into a node with no dependencies yet. */
export function createFormulaNode(
  raw: string,
  row: number,
  col: number,
  namedRanges?: Readonly<Record<string, string>>,
): FormulaNode {
  const node: FormulaNode = {
    row,
    col,
    raw,
    dependencies: new Set(),
    areas: [],
    scannedCells: 0,
  };
  try {
    node.ast = parseFormulaExpression(raw.slice(1).trim(), namedRanges);
  } catch (error) {
    node.parseError = getErrorCode(error);
  }
  return node;
}

export function buildFormulaGraph(data: SpreadsheetData): FormulaGraph {
  const nodes = new Map<string, FormulaNode>();

  data.rows.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      if (!isFormula(cell.raw)) return;
      nodes.set(cellKey(rowIndex, colIndex), createFormulaNode(cell.raw, rowIndex, colIndex, data.namedRanges));
    });
  });

  // The scan budget is shared across the sheet, in row-major node order.
  let scannedCells = 0;
  for (const node of nodes.values()) {
    scannedCells = scanNodeDependencies(node, nodes, data, scannedCells);
  }

  return { nodes, scannedCells };
}

/**
 * Fill in a node's areas and dependency edges, charging every scanned cell
 * against the shared budget. Returns the updated budget total. A node that
 * crosses the budget becomes a `#LIMIT!` node with no dependencies.
 */
export function scanNodeDependencies(
  node: FormulaNode,
  nodes: Map<string, FormulaNode>,
  data: SpreadsheetData,
  scannedBefore: number
): number {
  node.dependencies.clear();
  node.areas = [];
  node.scannedCells = 0;
  if (!node.ast) return scannedBefore;

  let scannedCells = scannedBefore;
  for (const area of collectReferenceAreas(node.ast)) {
    const rect = clampArea(data, area.start, area.end);
    if (!rect) continue;
    node.areas.push(rect);

    for (let row = rect.minRow; row <= rect.maxRow; row += 1) {
      for (let col = rect.minCol; col <= rect.maxCol; col += 1) {
        scannedCells += 1;
        node.scannedCells += 1;
        if (scannedCells > FORMULA_LIMITS.maxDependencyScanCells) {
          node.ast = undefined;
          node.parseError = '#LIMIT!';
          node.dependencies.clear();
          node.areas = [];
          return scannedCells;
        }
        const dependencyKey = cellKey(row, col);
        if (nodes.has(dependencyKey)) node.dependencies.add(dependencyKey);
      }
    }
  }
  return scannedCells;
}

function clampArea(
  data: SpreadsheetData,
  start: { row: number; col: number },
  end: { row: number; col: number }
): CellRect | null {
  const minRow = Math.max(0, Math.min(start.row, end.row));
  const maxRow = Math.min(data.rows.length - 1, Math.max(start.row, end.row));
  const minCol = Math.max(0, Math.min(start.col, end.col));
  const maxCol = Math.min(data.columnCount - 1, Math.max(start.col, end.col));
  if (minRow > maxRow || minCol > maxCol) return null;
  return { minRow, maxRow, minCol, maxCol };
}

export function getEvaluationOrder(nodes: Map<string, FormulaNode>): EvaluationOrder {
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
