/**
 * Formula engine facade. The implementation lives in `./engine/`:
 *
 * - `functions.ts`: the formula.js allow-list, local replacements, aliases
 * - `criteria.ts`: linear COUNTIF/SUMIFS/MATCH-style criteria functions
 * - `coercion.ts`: value coercion and date serials
 * - `evaluator.ts`: AST evaluation, references, and ranges
 * - `graph.ts`: dependency graph and evaluation order (#CIRC!, #LIMIT!)
 * - `recalc.ts`: full-sheet recalculation
 * - `incremental.ts` + `coverageIndex.ts`: incremental recalculation
 *
 * ## Incremental recalculation
 *
 * `recalculateFormulas(data)` recomputes every formula and is unchanged.
 * To recompute only what an edit affects, keep a `FormulaRecalcState`:
 *
 * ```ts
 * let state = recalculateFormulasWithState(data);   // on load / hydrate
 * render(state.data);
 *
 * // Value or formula edit: `next` is state.data with only these cells replaced.
 * state = recalculateFormulasIncremental(state, next, [{ row, col }, ...]);
 *
 * // Row/column insert, delete, move, or anything that changes dimensions:
 * state = recalculateFormulasIncremental(state, next, 'structural');
 * ```
 *
 * The state is single-use: each incremental pass takes ownership of the one
 * passed in. Undo, collab hydration, or any path that replaces the sheet with
 * data not derived from the latest `state.data` must start over with
 * `recalculateFormulasWithState`. `state.stats` reports which mode ran and why
 * a request fell back to a full pass. Results always equal a full
 * recalculation of `next`.
 */

export { getCellValue, isFormula } from './engine/types';
export { evaluateFormula } from './engine/evaluator';
export { getSupportedFunctions } from './engine/functions';
export { recalculateFormulas } from './engine/recalc';
export {
  recalculateFormulasIncremental,
  recalculateFormulasWithState,
  type FormulaCellChange,
  type FormulaRecalcState,
  type FormulaRecalcStats,
} from './engine/incremental';
