/**
 * Sheet commands: every mutation the editor makes, as data with an inverse.
 *
 * `applyCommand(state, command)` is pure. It returns the next state and the
 * command that undoes it, computed against the state it was applied to. Undo
 * applies that inverse and gets the redo command back the same way, so redo is
 * never a stored copy of the original that could drift from what was undone.
 *
 * Structural edits rewrite every formula and the structural metadata. Their
 * inverse cannot be "the opposite edit, rewritten again": a reference that
 * became `#REF!` has lost its target. So the inverse is the opposite edit as
 * geometry only, followed by a snapshot of every cell the forward edit removed
 * or rewrote and of the metadata it changed.
 */

import { rewriteMetadataForStructuralEdit } from '../structure/rewriteMetadata';
import { reorderRowMetadata } from '../structure/reorderMetadata';
import { rewriteFormulaForStructuralEdit } from '../structure/rewriteFormula';
import { editAxis, invertStructuralEdit, mapIndex, type StructuralEdit } from '../structure/structuralEdit';
import {
  SHEET_META_KEYS,
  cellAt,
  isFormulaText,
  type CellWrite,
  type SheetMeta,
  type SheetRow,
  type SheetState,
} from './sheetState';

export type SheetCommand =
  /** Write values. Rows/columns past the end are created; `columnCount` grows to cover non-empty writes. */
  | { readonly type: 'setCells'; readonly cells: readonly CellWrite[] }
  /**
   * Insert, delete or move rows/columns. Formulas and metadata are rewritten
   * unless `geometryOnly`, which only inverses use.
   */
  | { readonly type: 'structural'; readonly edit: StructuralEdit; readonly geometryOnly?: boolean }
  /**
   * Row `start + i` takes the row that was at `start + order[i]` (sorting).
   * Row-scoped metadata moves with its row (see `structure/reorderMetadata.ts`).
   */
  | { readonly type: 'reorderRows'; readonly start: number; readonly order: readonly number[] }
  | { readonly type: 'setMeta'; readonly patch: Partial<SheetMeta> }
  | { readonly type: 'batch'; readonly commands: readonly SheetCommand[] };

export interface AppliedCommand {
  readonly state: SheetState;
  readonly inverse: SheetCommand;
  /** False when the command left the sheet exactly as it was. */
  readonly changed: boolean;
}

export function applyCommand(state: SheetState, command: SheetCommand): AppliedCommand {
  switch (command.type) {
    case 'setCells': return applySetCells(state, command.cells);
    case 'structural': return applyStructural(state, command.edit, command.geometryOnly ?? false);
    case 'reorderRows': return applyReorder(state, command.start, command.order);
    case 'setMeta': return applySetMeta(state, command.patch);
    case 'batch': return applyBatch(state, command.commands);
  }
}

// ---- setCells ----------------------------------------------------------------

function applySetCells(state: SheetState, cells: readonly CellWrite[]): AppliedCommand {
  // Last write to a cell wins; the inverse restores what was there before the
  // first one.
  const finalWrites = new Map<string, CellWrite>();
  for (const cell of cells) {
    if (!Number.isInteger(cell.row) || !Number.isInteger(cell.col) || cell.row < 0 || cell.col < 0) {
      throw new Error(`Cell ${String(cell.row)}:${String(cell.col)} is out of bounds`);
    }
    const key = `${cell.row}:${cell.col}`;
    finalWrites.delete(key);
    finalWrites.set(key, cell);
  }

  const rows = state.rows.slice();
  const cloned = new Set<number>();
  const inverse: CellWrite[] = [];
  let maxWrittenCol = -1;

  for (const write of finalWrites.values()) {
    const before = cellAt(state, write.row, write.col);
    if (write.value !== '') maxWrittenCol = Math.max(maxWrittenCol, write.col);
    if (before === write.value) continue;
    while (rows.length <= write.row) rows.push([]);
    if (!cloned.has(write.row)) {
      rows[write.row] = rows[write.row].slice();
      cloned.add(write.row);
    }
    const row = rows[write.row] as string[];
    while (row.length < write.col) row.push('');
    row[write.col] = write.value;
    inverse.push({ row: write.row, col: write.col, value: before });
  }

  const columnCount = Math.max(state.meta.columnCount, maxWrittenCol + 1);
  const metaChanged = columnCount !== state.meta.columnCount;
  if (inverse.length === 0 && !metaChanged) {
    return { state, inverse: { type: 'setCells', cells: [] }, changed: false };
  }

  const next: SheetState = {
    rows: inverse.length > 0 ? rows : state.rows,
    meta: metaChanged ? { ...state.meta, columnCount } : state.meta,
  };
  const undoCells: SheetCommand = { type: 'setCells', cells: inverse };
  return {
    state: next,
    inverse: metaChanged
      ? { type: 'batch', commands: [undoCells, { type: 'setMeta', patch: { columnCount: state.meta.columnCount } }] }
      : undoCells,
    changed: true,
  };
}

// ---- structural --------------------------------------------------------------

/** Apply an index edit to one array, padding with `blank` where it reaches past the end. */
function editArray<T>(items: readonly T[], edit: StructuralEdit, blank: T): T[] {
  const { at, count } = edit;
  if (count <= 0) return items.slice();
  switch (edit.type) {
    case 'insertRows':
    case 'insertCols': {
      if (at >= items.length) return items.slice();
      const next = items.slice();
      next.splice(at, 0, ...Array.from({ length: count }, () => blank));
      return next;
    }
    case 'deleteRows':
    case 'deleteCols': {
      const next = items.slice();
      next.splice(at, count);
      return next;
    }
    case 'moveRows':
    case 'moveCols': {
      const needed = Math.max(at + count, edit.to + count);
      const next = items.slice();
      while (next.length < needed) next.push(blank);
      const block = next.splice(at, count);
      next.splice(edit.to, 0, ...block);
      return next;
    }
  }
}

function applyGeometry(rows: readonly SheetRow[], edit: StructuralEdit): SheetRow[] {
  if (editAxis(edit) === 'row') return editArray<SheetRow>(rows, edit, []);
  const reach = edit.type === 'moveCols' ? Math.min(edit.at, edit.to) : edit.at;
  // A row too short to reach the edit is unaffected by it; keep its identity.
  return rows.map((row) => (row.length <= reach ? row : editArray(row, edit, '')));
}

/** Cells (pre-edit coordinates) whose content a delete removes. */
function deletedCells(rows: readonly SheetRow[], edit: StructuralEdit): CellWrite[] {
  const removed: CellWrite[] = [];
  if (edit.type === 'deleteRows') {
    for (let r = edit.at; r < Math.min(rows.length, edit.at + edit.count); r += 1) {
      rows[r].forEach((value, col) => { if (value !== '') removed.push({ row: r, col, value }); });
    }
  } else if (edit.type === 'deleteCols') {
    rows.forEach((row, r) => {
      for (let c = edit.at; c < Math.min(row.length, edit.at + edit.count); c += 1) {
        if (row[c] !== '') removed.push({ row: r, col: c, value: row[c] });
      }
    });
  }
  return removed;
}

/** Where a pre-edit cell sits after the edit (null if deleted). */
function mapCell(row: number, col: number, edit: StructuralEdit): { row: number; col: number } | null {
  const index = editAxis(edit) === 'row' ? row : col;
  const mapped = mapIndex(index, edit);
  if (mapped === null) return null;
  return editAxis(edit) === 'row' ? { row: mapped, col } : { row, col: mapped };
}

function applyStructural(state: SheetState, edit: StructuralEdit, geometryOnly: boolean): AppliedCommand {
  if (edit.count <= 0) return { state, inverse: { type: 'batch', commands: [] }, changed: false };
  const moved = applyGeometry(state.rows, edit);
  const geometryInverse: SheetCommand = { type: 'structural', edit: invertStructuralEdit(edit), geometryOnly: true };

  if (geometryOnly) {
    return { state: { rows: moved, meta: state.meta }, inverse: geometryInverse, changed: true };
  }

  // Rewrite every formula, remembering the original text at its pre-edit
  // position so undo can restore what a #REF! destroyed.
  const restore: CellWrite[] = deletedCells(state.rows, edit);
  const rows = moved;
  state.rows.forEach((row, r) => {
    row.forEach((value, c) => {
      if (!isFormulaText(value)) return;
      const target = mapCell(r, c, edit);
      if (!target) return;
      const rewritten = rewriteFormulaForStructuralEdit(value, edit);
      if (rewritten === value) return;
      const copy = rows[target.row].slice();
      copy[target.col] = rewritten;
      rows[target.row] = copy;
      restore.push({ row: r, col: c, value });
    });
  });

  const meta = rewriteMetadataForStructuralEdit(state.meta, edit);
  const metaRestore = metaPatchBetween(meta, state.meta);
  const inverse: SheetCommand[] = [geometryInverse];
  if (restore.length > 0) inverse.push({ type: 'setCells', cells: restore });
  if (Object.keys(metaRestore).length > 0) inverse.push({ type: 'setMeta', patch: metaRestore });
  return { state: { rows, meta }, inverse: { type: 'batch', commands: inverse }, changed: true };
}

// ---- reorderRows -------------------------------------------------------------

function applyReorder(state: SheetState, start: number, order: readonly number[]): AppliedCommand {
  const n = order.length;
  const seen = new Set(order);
  if (seen.size !== n || order.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) {
    throw new Error('Row order must be a permutation');
  }
  const changed = order.some((from, i) => from !== i);
  const inverseOrder = new Array<number>(n);
  order.forEach((from, i) => { inverseOrder[from] = i; });
  const reverse: SheetCommand = { type: 'reorderRows', start, order: inverseOrder };
  if (!changed) return { state, inverse: reverse, changed: false };

  const rows = state.rows.slice();
  while (rows.length < start + n) rows.push([]);
  const block = rows.slice(start, start + n);
  order.forEach((from, i) => { rows[start + i] = block[from]; });
  // Row-scoped metadata follows its row. Cutting ranges into runs is not
  // exactly reversible, so the inverse also restores the metadata it replaced.
  const meta = reorderRowMetadata(state.meta, start, order);
  const metaRestore = metaPatchBetween(meta, state.meta);
  const inverse: SheetCommand = Object.keys(metaRestore).length === 0
    ? reverse
    : { type: 'batch', commands: [reverse, { type: 'setMeta', patch: metaRestore }] };
  return { state: { rows, meta }, inverse, changed: true };
}

// ---- setMeta -----------------------------------------------------------------

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** The fields of `from` that differ from `to`, with `to`'s values. */
function metaPatchBetween(from: SheetMeta, to: SheetMeta): Partial<SheetMeta> {
  const patch: Record<string, unknown> = {};
  for (const key of SHEET_META_KEYS) {
    if (!sameValue(from[key], to[key])) patch[key] = to[key];
  }
  return patch as Partial<SheetMeta>;
}

function applySetMeta(state: SheetState, patch: Partial<SheetMeta>): AppliedCommand {
  const undo: Record<string, unknown> = {};
  const next: Record<string, unknown> = { ...state.meta };
  for (const key of SHEET_META_KEYS) {
    if (!(key in patch) || patch[key] === undefined) continue;
    if (sameValue(state.meta[key], patch[key])) continue;
    undo[key] = state.meta[key];
    next[key] = patch[key];
  }
  if (Object.keys(undo).length === 0) {
    return { state, inverse: { type: 'setMeta', patch: {} }, changed: false };
  }
  return {
    state: { rows: state.rows, meta: next as unknown as SheetMeta },
    inverse: { type: 'setMeta', patch: undo as Partial<SheetMeta> },
    changed: true,
  };
}

// ---- batch -------------------------------------------------------------------

function applyBatch(state: SheetState, commands: readonly SheetCommand[]): AppliedCommand {
  let current = state;
  let changed = false;
  const inverses: SheetCommand[] = [];
  for (const command of commands) {
    const applied = applyCommand(current, command);
    current = applied.state;
    if (!applied.changed) continue;
    changed = true;
    inverses.unshift(applied.inverse);
  }
  return { state: current, inverse: { type: 'batch', commands: inverses }, changed };
}
