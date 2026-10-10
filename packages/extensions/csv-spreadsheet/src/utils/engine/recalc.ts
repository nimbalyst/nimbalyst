/**
 * Full-sheet recalculation, and the per-formula evaluation step it shares with
 * incremental recalculation.
 */

import type { CellValue, SpreadsheetData } from '../../types';
import type { FormulaErrorCode } from './ast';
import { normalizeCellResult } from './coercion';
import { getErrorCode } from './errors';
import { createEvaluationContext, evaluateAst } from './evaluator';
import {
  buildFormulaGraph,
  getEvaluationOrder,
  type EvaluationOrder,
  type FormulaGraph,
} from './graph';
import { isFormula, type EvaluationValue, type FormulaNode } from './types';

export interface FormulaResult {
  computed: CellValue;
  error?: FormulaErrorCode;
}

export interface FullRecalculation {
  data: SpreadsheetData;
  graph: FormulaGraph;
  evaluationOrder: EvaluationOrder;
  formulaCache: Map<string, EvaluationValue>;
}

/** Recalculate formulas in dependency order and mark dependency cycles. */
export function recalculateFormulas(data: SpreadsheetData): SpreadsheetData {
  return runFullRecalculation(data).data;
}

export function runFullRecalculation(data: SpreadsheetData): FullRecalculation {
  // Copy only what changes: a row with a formula (its cells get results
  // written below) or a stale error. Everything else is shared with the input.
  const rows: SpreadsheetData['rows'] = data.rows.map((row) => (
    row.some((cell) => cell.error !== undefined || isFormula(cell.raw))
      ? row.map((cell) => (
        isFormula(cell.raw)
          ? { ...cell, computed: null, error: undefined }
          : cell.error === undefined ? cell : { ...cell, error: undefined }
      ))
      : row
  ));
  const recalculationData: SpreadsheetData = { ...data, rows };
  const graph = buildFormulaGraph(recalculationData);
  const evaluationOrder = getEvaluationOrder(graph.nodes);
  const formulaCache = new Map<string, EvaluationValue>();

  for (const key of evaluationOrder.order) {
    const node = graph.nodes.get(key);
    if (!node) continue;
    const result = computeFormulaResult(key, node, evaluationOrder, recalculationData, formulaCache, graph.nodes);
    rows[node.row][node.col] = { ...rows[node.row][node.col], computed: result.computed, error: result.error };
  }

  return { data: recalculationData, graph, evaluationOrder, formulaCache };
}

/**
 * Evaluate one formula node, recording its raw result in `formulaCache` on
 * success. Its dependencies must already be evaluated: either cached, or
 * carrying their error on the cell.
 */
export function computeFormulaResult(
  key: string,
  node: FormulaNode,
  evaluationOrder: EvaluationOrder,
  data: SpreadsheetData,
  formulaCache: Map<string, EvaluationValue>,
  nodes: Map<string, FormulaNode>
): FormulaResult {
  if (evaluationOrder.cycleKeys.has(key)) return { computed: null, error: '#CIRC!' };
  if (evaluationOrder.limitKeys.has(key)) return { computed: null, error: '#LIMIT!' };
  if (node.parseError || !node.ast) return { computed: null, error: node.parseError ?? '#VALUE!' };

  try {
    const evaluated = evaluateAst(node.ast, data, createEvaluationContext(key, formulaCache, nodes));
    const computed = normalizeCellResult(evaluated);
    formulaCache.set(key, evaluated);
    return { computed };
  } catch (error) {
    return { computed: null, error: getErrorCode(error) };
  }
}
