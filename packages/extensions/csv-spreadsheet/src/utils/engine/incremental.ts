/**
 * Incremental recalculation: after a cell edit, re-evaluate only the formulas
 * that transitively read the edited cells, reusing every other result from the
 * previous pass.
 *
 * The contract is equality with `recalculateFormulas`: for any edit, the
 * incremental result matches a full recalculation of the edited sheet. Where
 * that cannot be guaranteed cheaply, the pass falls back to a full
 * recalculation and says why in `stats.fallbackReason`:
 *
 * - structural edits (row/column insert, delete, move, resize) and any change
 *   to the sheet's dimensions or date-typed columns;
 * - a sheet containing a dependency cycle before or after the edit, because
 *   which cycle members are flagged `#CIRC!` depends on traversal order;
 * - a sheet over the dependency-scan budget, because which formulas become
 *   `#LIMIT!` depends on the order they were scanned.
 */

import type { ColumnFormat, SpreadsheetData } from '../../types';
import { FORMULA_LIMITS, type FormulaAst } from './ast';
import { CoverageIndex } from './coverageIndex';
import { VOLATILE_FUNCTIONS } from './functions';
import {
  createFormulaNode,
  getEvaluationOrder,
  scanNodeDependencies,
  type EvaluationOrder,
} from './graph';
import { computeFormulaResult, runFullRecalculation } from './recalc';
import { cellKey, isFormula, type EvaluationValue, type FormulaNode } from './types';

export interface FormulaCellChange {
  row: number;
  col: number;
}

export interface FormulaRecalcStats {
  mode: 'full' | 'incremental';
  /** Formulas evaluated in this pass. */
  evaluatedFormulas: number;
  /** Why an incremental request ran as a full recalculation. */
  fallbackReason?: string;
}

/**
 * The result of a recalculation plus what an incremental pass needs to reuse
 * it. Treat it as opaque and single-use: an incremental pass takes ownership
 * of the previous state, and passing a state in twice falls back to a full
 * recalculation.
 */
export interface FormulaRecalcState {
  readonly data: SpreadsheetData;
  readonly stats: FormulaRecalcStats;
  /** @internal */
  readonly internals: RecalcInternals;
}

interface RecalcInternals {
  nodes: Map<string, FormulaNode>;
  scannedCells: number;
  evaluationOrder: EvaluationOrder;
  /** Reverse edges: formula cell -> formula cells that read it. */
  dependents: Map<string, Set<string>>;
  coverage: CoverageIndex;
  volatileKeys: Set<string>;
  formulaCache: Map<string, EvaluationValue>;
  rowCount: number;
  columnCount: number;
  dateColumns: string;
  consumed: boolean;
}

/** Full recalculation that also returns the state an incremental pass reuses. */
export function recalculateFormulasWithState(
  data: SpreadsheetData,
  fallbackReason?: string
): FormulaRecalcState {
  const full = runFullRecalculation(data);
  const { nodes, scannedCells } = full.graph;
  const dependents = new Map<string, Set<string>>();
  const coverage = new CoverageIndex();
  const volatileKeys = new Set<string>();
  for (const [key, node] of nodes) addNodeIndexes(key, node, dependents, coverage, volatileKeys);

  return {
    data: full.data,
    stats: { mode: 'full', evaluatedFormulas: nodes.size, fallbackReason },
    internals: {
      nodes,
      scannedCells,
      evaluationOrder: full.evaluationOrder,
      dependents,
      coverage,
      volatileKeys,
      formulaCache: full.formulaCache,
      rowCount: data.rows.length,
      columnCount: data.columnCount,
      dateColumns: dateColumnSignature(data),
      consumed: false,
    },
  };
}

/**
 * Recalculate `next` after the listed cells changed, re-evaluating only their
 * transitive dependents.
 *
 * `next` must be `previous.data` with only `changedCells` replaced: every other
 * cell, including formula cells' `computed` and `error`, is carried over as-is.
 * Pass `'structural'` for edits that move cells; that runs a full pass.
 */
export function recalculateFormulasIncremental(
  previous: FormulaRecalcState,
  next: SpreadsheetData,
  changedCells: Iterable<FormulaCellChange> | 'structural'
): FormulaRecalcState {
  const internals = previous.internals;
  const fallback = (reason: string) => recalculateFormulasWithState(next, reason);

  if (changedCells === 'structural') return fallback('structural edit');
  if (internals.consumed) return fallback('state already consumed');
  if (next.rows.length !== internals.rowCount || next.columnCount !== internals.columnCount) {
    return fallback('sheet dimensions changed');
  }
  if (dateColumnSignature(next) !== internals.dateColumns) return fallback('date columns changed');
  if (JSON.stringify(next.namedRanges ?? {}) !== JSON.stringify(previous.data.namedRanges ?? {})) {
    return fallback('named ranges changed');
  }
  if (internals.evaluationOrder.cycleKeys.size > 0) return fallback('sheet has a dependency cycle');
  if (internals.scannedCells > FORMULA_LIMITS.maxDependencyScanCells) {
    return fallback('dependency scan budget exceeded');
  }

  const changes = new Map<string, FormulaCellChange>();
  for (const change of changedCells) {
    const previousRow = previous.data.rows[change.row];
    const nextRow = next.rows[change.row];
    if (!previousRow?.[change.col] || !nextRow?.[change.col] || previousRow.length !== nextRow.length) {
      return fallback('changed cell outside the sheet');
    }
    changes.set(cellKey(change.row, change.col), change);
  }

  // From here on the previous state's maps are mutated in place.
  internals.consumed = true;
  const { nodes, dependents, coverage, volatileKeys, formulaCache } = internals;

  const removedNodes = new Set<string>();
  const addedNodes = new Map<string, FormulaNode>();
  for (const [key, change] of changes) {
    const raw = next.rows[change.row][change.col].raw;
    const oldNode = nodes.get(key);
    const nowFormula = isFormula(raw);
    if (oldNode && nowFormula && oldNode.raw === raw) continue;
    if (!oldNode && !nowFormula) continue;
    if (oldNode) {
      removeNodeIndexes(key, oldNode, dependents, coverage, volatileKeys);
      nodes.delete(key);
      formulaCache.delete(key);
      internals.scannedCells -= oldNode.scannedCells;
      removedNodes.add(key);
    }
    if (nowFormula) {
      const node = createFormulaNode(raw, change.row, change.col, next.namedRanges);
      nodes.set(key, node);
      addedNodes.set(key, node);
    }
  }

  const graphChanged = removedNodes.size > 0 || addedNodes.size > 0;
  let evaluationOrder = internals.evaluationOrder;
  const seeds = new Set<string>();

  if (graphChanged) {
    for (const [key, node] of addedNodes) {
      internals.scannedCells = scanNodeDependencies(node, nodes, next, internals.scannedCells);
      addNodeIndexes(key, node, dependents, coverage, volatileKeys);
    }
    if (internals.scannedCells > FORMULA_LIMITS.maxDependencyScanCells) {
      return fallback('dependency scan budget exceeded');
    }

    // A cell that started or stopped being a formula gains or loses the edges
    // from every existing formula whose areas cover it.
    for (const key of new Set([...removedNodes, ...addedNodes.keys()])) {
      const becameFormula = addedNodes.has(key);
      if (becameFormula === removedNodes.has(key)) continue;
      const { row, col } = changes.get(key)!;
      const covering = new Set<string>();
      coverage.collectCovering(row, col, covering);
      for (const reader of covering) {
        if (addedNodes.has(reader)) continue;
        const readerNode = nodes.get(reader);
        if (!readerNode) continue;
        if (becameFormula) {
          readerNode.dependencies.add(key);
          addDependent(dependents, key, reader);
        } else {
          readerNode.dependencies.delete(key);
        }
      }
      if (!becameFormula) dependents.delete(key);
    }

    evaluationOrder = getEvaluationOrder(nodes);
    if (evaluationOrder.cycleKeys.size > 0) return fallback('edit created a dependency cycle');
    for (const key of evaluationOrder.limitKeys) {
      if (!internals.evaluationOrder.limitKeys.has(key)) seeds.add(key);
    }
    for (const key of internals.evaluationOrder.limitKeys) {
      if (!evaluationOrder.limitKeys.has(key)) seeds.add(key);
    }
    internals.evaluationOrder = evaluationOrder;
  }

  for (const [key, change] of changes) {
    if (nodes.has(key)) seeds.add(key);
    coverage.collectCovering(change.row, change.col, seeds);
  }
  for (const key of volatileKeys) seeds.add(key);

  const dirty = collectTransitiveDependents(seeds, dependents, nodes);
  for (const key of dirty) formulaCache.delete(key);

  const rows = next.rows.slice();
  const copiedRows = new Set<number>();
  const writableRow = (row: number) => {
    if (!copiedRows.has(row)) {
      rows[row] = rows[row].slice();
      copiedRows.add(row);
    }
    return rows[row];
  };
  for (const [key, change] of changes) {
    const cell = rows[change.row][change.col];
    if (!nodes.has(key) && cell.error !== undefined) {
      writableRow(change.row)[change.col] = { ...cell, error: undefined };
    }
  }

  const data: SpreadsheetData = { ...next, rows };
  let evaluatedFormulas = 0;
  if (dirty.size > 0) {
    for (const key of evaluationOrder.order) {
      if (!dirty.has(key)) continue;
      const node = nodes.get(key)!;
      const result = computeFormulaResult(key, node, evaluationOrder, data, formulaCache, nodes);
      const row = writableRow(node.row);
      row[node.col] = { ...row[node.col], computed: result.computed, error: result.error };
      evaluatedFormulas += 1;
    }
  }

  return {
    data,
    stats: { mode: 'incremental', evaluatedFormulas },
    internals: { ...internals, consumed: false },
  };
}

function collectTransitiveDependents(
  seeds: Set<string>,
  dependents: Map<string, Set<string>>,
  nodes: Map<string, FormulaNode>
): Set<string> {
  const dirty = new Set<string>();
  const pending: string[] = [];
  for (const seed of seeds) {
    if (nodes.has(seed) && !dirty.has(seed)) {
      dirty.add(seed);
      pending.push(seed);
    }
  }
  while (pending.length > 0) {
    const key = pending.pop()!;
    for (const reader of dependents.get(key) ?? []) {
      if (dirty.has(reader)) continue;
      dirty.add(reader);
      pending.push(reader);
    }
  }
  return dirty;
}

function addNodeIndexes(
  key: string,
  node: FormulaNode,
  dependents: Map<string, Set<string>>,
  coverage: CoverageIndex,
  volatileKeys: Set<string>
): void {
  for (const dependency of node.dependencies) addDependent(dependents, dependency, key);
  coverage.add(key, node.areas);
  if (node.ast && callsVolatileFunction(node.ast)) volatileKeys.add(key);
}

function removeNodeIndexes(
  key: string,
  node: FormulaNode,
  dependents: Map<string, Set<string>>,
  coverage: CoverageIndex,
  volatileKeys: Set<string>
): void {
  for (const dependency of node.dependencies) dependents.get(dependency)?.delete(key);
  coverage.remove(key);
  volatileKeys.delete(key);
}

function addDependent(dependents: Map<string, Set<string>>, dependency: string, reader: string): void {
  let readers = dependents.get(dependency);
  if (!readers) dependents.set(dependency, readers = new Set());
  readers.add(reader);
}

function callsVolatileFunction(ast: FormulaAst): boolean {
  switch (ast.type) {
    case 'call':
      return VOLATILE_FUNCTIONS.has(ast.name.toUpperCase()) || ast.args.some(callsVolatileFunction);
    case 'unary':
    case 'percent':
      return callsVolatileFunction(ast.operand);
    case 'binary':
      return callsVolatileFunction(ast.left) || callsVolatileFunction(ast.right);
    default:
      return false;
  }
}

function dateColumnSignature(data: SpreadsheetData & { columnFormats?: Record<number, ColumnFormat> }): string {
  const formats = data.columnFormats;
  if (!formats) return '';
  return Object.keys(formats)
    .filter((col) => formats[Number(col)]?.type === 'date' || formats[Number(col)]?.type === 'datetime')
    .sort()
    .join(',');
}
