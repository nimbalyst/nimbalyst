/**
 * Derived formula display values keyed by the actual RevoGrid row models.
 * Raw values remain in the source models, so editing and CSV serialization
 * never need to reconstruct formulas from display text.
 *
 * Recalculation is incremental when the caller says which cells changed: only
 * the formulas reading them re-evaluate (`engine/incremental.ts`). Load and
 * hydration pass no changes and get a full pass, which also resets the state
 * the next incremental pass builds on.
 */

import type { CellValue, SpreadsheetData } from '../types';
import { columnIndexToLetter } from './csvParser';
import {
  isFormula,
  recalculateFormulasIncremental,
  recalculateFormulasWithState,
  type FormulaCellChange,
  type FormulaRecalcState,
  type FormulaRecalcStats,
} from './formulaEngine';

export interface GridSourceData {
  source: Record<string, string | number>[];
  pinnedTop: Record<string, string | number>[];
}

/** The cells a write changed, or `'structural'` when it moved cells or changed the header. */
export type FormulaChanges = readonly FormulaCellChange[] | 'structural';

export class FormulaViewState {
  private displayByModel = new WeakMap<object, Map<string, CellValue>>();
  private state: FormulaRecalcState | null = null;
  /** What the last pass did: its mode, how many formulas it evaluated, and why it fell back. */
  lastStats: FormulaRecalcStats | null = null;

  getDisplayValue(model: object, prop: string): CellValue | undefined {
    return this.displayByModel.get(model)?.get(prop);
  }

  recalculate(data: SpreadsheetData, gridData: GridSourceData, changes?: FormulaChanges): number {
    const startedAt = globalThis.performance?.now() ?? Date.now();
    const previous = this.state;
    let next: FormulaRecalcState;
    if (!previous || changes === undefined) {
      next = recalculateFormulasWithState(data);
    } else if (changes === 'structural') {
      next = recalculateFormulasIncremental(previous, data, 'structural');
    } else {
      const inBounds = changes.filter((change) => change.row < data.rows.length && change.col < data.columnCount);
      const patched = patchPrevious(previous.data, data, inBounds);
      next = patched
        ? recalculateFormulasIncremental(previous, patched, inBounds)
        : recalculateFormulasWithState(data, 'sheet differs outside the changed cells');
    }
    this.state = next;
    this.lastStats = next.stats;

    const recalculated = next.data;
    const nextDisplayByModel = new WeakMap<object, Map<string, CellValue>>();
    recalculated.rows.forEach((row, rowIndex) => {
      // The engine copies every row that holds a formula and shares the rest
      // with its input, so a shared row has nothing to display.
      if (row === data.rows[rowIndex]) return;
      // The pinned section is the header rows plus any frozen rows.
      const pinned = gridData.pinnedTop.length;
      const model = rowIndex < pinned ? gridData.pinnedTop[rowIndex] : gridData.source[rowIndex - pinned];
      if (!model) return;

      row.forEach((cell, colIndex) => {
        if (!isFormula(cell.raw)) return;
        const prop = columnIndexToLetter(colIndex);
        const displays = nextDisplayByModel.get(model) ?? new Map<string, CellValue>();
        displays.set(prop, cell.error ?? cell.computed);
        nextDisplayByModel.set(model, displays);
      });
    });

    this.displayByModel = nextDisplayByModel;
    return (globalThis.performance?.now() ?? Date.now()) - startedAt;
  }
}

/**
 * The previous result with the changed cells taken from `data`: what an
 * incremental pass requires as input. Null when the previous result does not
 * describe `data` apart from those cells (another path replaced the grid), so
 * the caller recalculates everything instead of trusting stale results.
 */
function patchPrevious(
  previous: SpreadsheetData,
  data: SpreadsheetData,
  changes: readonly FormulaCellChange[],
): SpreadsheetData | null {
  if (previous.rows.length !== data.rows.length || previous.columnCount !== data.columnCount) return null;
  const changed = new Set(changes.map(({ row, col }) => `${row}:${col}`));
  const changedRows = new Set(changes.map(({ row }) => row));
  const rows = previous.rows.slice();
  for (let row = 0; row < data.rows.length; row += 1) {
    const before = previous.rows[row];
    const after = data.rows[row];
    if (before === after) continue;
    if (before.length !== after.length) return null;
    let plain = true;
    for (let col = 0; col < after.length; col += 1) {
      if (before[col].raw !== after[col].raw && !changed.has(`${row}:${col}`)) return null;
      if (plain && (before[col].error !== undefined || isFormula(before[col].raw))) plain = false;
    }
    // A row without formulas or errors has no results to carry over, so the
    // input's own row stands in for it; from then on the identity check above
    // skips it, and so does the display pass (an edit re-reads only its rows).
    if (plain && !changedRows.has(row)) rows[row] = after;
  }
  for (const { row, col } of changes) {
    if (rows[row] === previous.rows[row]) rows[row] = rows[row].slice();
    rows[row][col] = data.rows[row][col];
  }
  return { ...data, rows };
}
