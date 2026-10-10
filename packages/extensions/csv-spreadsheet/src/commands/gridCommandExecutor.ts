/**
 * Runs `SheetCommand`s against the live RevoGrid store.
 *
 * RevoGrid stays the store of cell data for now (plan: Architecture sketch);
 * this layer sits on top of it. Every mutation reads the grid into a
 * `SheetState`, applies a pure command, and writes the result back as one
 * whole-source replacement (RevoGrid replaces all data on `source` anyway).
 * Metadata is read and written synchronously in the same step, so a grid change
 * and the header/format change that goes with it can never be split across a
 * React commit.
 *
 * Commands run one at a time through a queue. A command can be given as a
 * function of the current state; it is built inside the queue, against the
 * state it will actually apply to, never against a snapshot taken before an
 * earlier command finished.
 *
 * Each grid write recalculates formulas incrementally from the cells the
 * command wrote; structural, reorder and header changes recalculate in full.
 *
 * Origins: `user` and `agent` commands are recorded for undo (an agent tool
 * call is one step); `remote` commands are applied but never recorded. CSV
 * collaboration delivers remote edits as whole-document replacements through
 * the hydration path (`collab/gridHydration.ts`), not as commands, so they
 * never reach the undo stack either.
 */

import type { RevoGridElement } from '../revogrid-types';
import type { Cell, NormalizedSelectionRange, SpreadsheetData, TrimmedRows } from '../types';
import { columnIndexToLetter, columnLetterToIndex, createCell } from '../utils/csvParser';
import type { FormulaChanges, FormulaViewState } from '../utils/formulaViewState';
import type { FormulaRecalcStats } from '../utils/formulaEngine';
import { createRowIndexMapping, type RowIndexMapping } from '../filter/rowIndexMapping';
import { applyCommand, type SheetCommand } from './sheetCommand';
import { CommandHistory, type CommandOrigin } from './commandHistory';
import { contentRowCount, type SheetMeta, type SheetRow, type SheetState } from './sheetState';
import { headerRowCountForPinned, pinnedRowCount } from '../sheetMeta/formatting';

type GridModel = Record<string, unknown>;

export interface SelectionSnapshot {
  readonly cell: { row: number; col: number } | null;
  readonly range: NormalizedSelectionRange | null;
}

export interface GridCommandExecutorOptions {
  gridRef: { readonly current: RevoGridElement | null };
  /** Current metadata, synchronously (not a React render behind). */
  getMeta: () => SheetMeta;
  setMeta: (meta: SheetMeta, origin: CommandOrigin) => void;
  getTrimmedRows?: () => TrimmedRows;
  formulaViewState?: FormulaViewState;
  /** Blank rows kept below the content so there is somewhere to type. */
  bufferRows?: number;
  onDirty?: () => void;
  /** Wraps each write (the collab binding's `mutate`, which publishes after). */
  runMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Runs inside the mutation after a grid write (filtered-view refresh). */
  afterWrite?: () => Promise<void>;
  getSelection?: () => SelectionSnapshot | null;
  restoreSelection?: (selection: SelectionSnapshot) => void;
  onHistoryChange?: () => void;
}

export interface ExecuteContext {
  readonly state: SheetState;
  /** Visible <-> logical rows under the active filter. */
  readonly rowMapping: RowIndexMapping;
}

export type CommandSource = SheetCommand | ((context: ExecuteContext) => SheetCommand | null);

export interface ExecuteOptions {
  readonly origin?: CommandOrigin;
  /** Selection to show after the command (and to restore on redo). */
  readonly selectAfter?: SelectionSnapshot | ((after: SheetState) => SelectionSnapshot | null);
}

export interface ExecuteResult {
  readonly before: SheetState;
  readonly after: SheetState;
  readonly changed: boolean;
  /** The formula pass the write ran, when it rewrote the grid. */
  readonly recalc?: FormulaRecalcStats;
}

export interface GridCommandExecutor {
  execute(source: CommandSource, options?: ExecuteOptions): Promise<ExecuteResult | null>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  clearHistory(): void;
  /** The current sheet and row mapping, read through the queue. */
  readContext(): Promise<ExecuteContext>;
  /** The live row model a logical row was last written to, for display lookups. */
  modelAt(row: number): GridModel | undefined;
  /** Run `read` through the queue, after every command queued before it, with the revision it sees. */
  readAfterQueued<T>(read: (revision: number) => T | Promise<T>): Promise<T>;
  /** Bumped by every grid write; a save compares it to know nothing changed while it was in flight. */
  readonly revision: number;
}

const COLUMN_KEY = /^[A-Z]+$/;

/** The cells a command wrote, or `'structural'` when it moved cells or changed metadata. */
function formulaChangesOf(command: SheetCommand): FormulaChanges {
  if (command.type === 'setCells') return command.cells.map(({ row, col }) => ({ row, col }));
  if (command.type !== 'batch') return 'structural';
  const cells: { row: number; col: number }[] = [];
  for (const inner of command.commands) {
    const changes = formulaChangesOf(inner);
    if (changes === 'structural') return changes;
    cells.push(...changes);
  }
  return cells;
}

function modelToRow(model: GridModel): string[] {
  const row: string[] = [];
  for (const key of Object.keys(model)) {
    if (!COLUMN_KEY.test(key)) continue;
    const value = model[key];
    row[columnLetterToIndex(key)] = value === undefined || value === null ? '' : String(value);
  }
  for (let i = 0; i < row.length; i += 1) if (row[i] === undefined) row[i] = '';
  return row;
}

/** A grid model with a key for every column up to `width`, so new rows read '' rather than undefined. */
function rowToModel(row: SheetRow, header: boolean, width: number): GridModel {
  const model: GridModel = {};
  for (let col = 0; col < Math.max(width, row.length); col += 1) model[columnIndexToLetter(col)] = row[col] ?? '';
  if (header) model._rowClass = 'header-row';
  return model;
}

/**
 * Undo of a step that grew the sheet (a paste past the end): the restored
 * cells are blank, but the rows holding them, and the buffer rows the write
 * kept below them, would stay. Drop trailing blank rows back to the count the
 * step started from, and blank cells past `columnCount` with them.
 */
function shrinkToRowCount(state: SheetState, rowCount: number | undefined): SheetState {
  if (rowCount === undefined || state.rows.length <= rowCount) return state;
  const keep = Math.max(rowCount, contentRowCount(state.rows));
  if (keep >= state.rows.length) return state;
  const width = state.meta.columnCount;
  const rows = state.rows.slice(0, keep).map((row) => (
    row.length > width && row.slice(width).every((cell) => cell === '') ? row.slice(0, width) : row
  ));
  return { rows, meta: state.meta };
}

/**
 * Parsed cells per sheet row. Rows are immutable and a command keeps the
 * identity of every row it leaves alone, so only the rows an edit touched are
 * parsed again; rebuilding every cell on every edit cost ~200ms at 100k rows.
 * The engine never mutates its input cells or rows (it copies before writing).
 */
const cellRowCache = new WeakMap<SheetRow, { width: number; cells: Cell[] }>();

function cellsOf(row: SheetRow, width: number): Cell[] {
  const cached = cellRowCache.get(row);
  if (cached && cached.width === width) return cached.cells;
  const cells = Array.from({ length: width }, (_, c) => createCell(row[c] ?? ''));
  cellRowCache.set(row, { width, cells });
  return cells;
}

export function spreadsheetDataOf(state: SheetState): SpreadsheetData {
  const rows = state.rows.slice(0, Math.max(state.meta.headerRowCount, contentRowCount(state.rows)));
  let columnCount = Math.max(1, state.meta.columnCount);
  for (const row of rows) {
    for (let c = row.length - 1; c >= columnCount; c -= 1) {
      if (row[c] !== '') { columnCount = c + 1; break; }
    }
  }
  return {
    rows: rows.map((row) => cellsOf(row, columnCount)),
    columnCount,
    hasHeaders: state.meta.headerRowCount > 0,
    headerRowCount: state.meta.headerRowCount,
    frozenColumnCount: state.meta.frozenColumnCount,
    frozenRowCount: state.meta.frozenRowCount,
    columnFormats: { ...state.meta.columnFormats },
    cellStyles: state.meta.cellStyles,
    namedRanges: state.meta.namedRanges,
  };
}

interface Snapshot {
  source: GridModel[];
  pinnedTop: GridModel[];
  meta: SheetMeta;
  state: SheetState;
  models: Map<SheetRow, GridModel>;
}

/**
 * The rows the grid holds. The `source` / `pinnedTopSource` properties are the
 * arrays last assigned (by a command or a whole-sheet load); `getSource()`
 * reads RevoGrid's store, which catches up a render later. Reading the store
 * right after a command lost that command when the next one wrote over it.
 */
export async function readGridSources(current: RevoGridElement): Promise<{ source: GridModel[]; pinnedTop: GridModel[] }> {
  const assigned = current as unknown as { source?: GridModel[]; pinnedTopSource?: GridModel[] };
  if (Array.isArray(assigned.source) && Array.isArray(assigned.pinnedTopSource)) {
    return { source: assigned.source, pinnedTop: assigned.pinnedTopSource };
  }
  const [source, pinnedTop] = await Promise.all([current.getSource('rgRow'), current.getSource('rowPinStart')]);
  return { source: (source ?? []) as GridModel[], pinnedTop: (pinnedTop ?? []) as GridModel[] };
}

export function createGridCommandExecutor(options: GridCommandExecutorOptions): GridCommandExecutor {
  const history = new CommandHistory<SelectionSnapshot>(options.onHistoryChange);
  const bufferRows = options.bufferRows ?? 0;
  let tail: Promise<unknown> = Promise.resolve();
  let snapshot: Snapshot | null = null;
  let revision = 0;

  const enqueue = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };

  const grid = (): RevoGridElement => {
    const current = options.gridRef.current;
    if (!current) throw new Error('Grid not available');
    return current;
  };

  async function read(): Promise<Snapshot> {
    const { source, pinnedTop } = await readGridSources(grid());
    const metaNow = options.getMeta();
    if (snapshot && snapshot.source === source && snapshot.pinnedTop === pinnedTop && snapshot.meta === metaNow) {
      return snapshot;
    }
    const models = new Map<SheetRow, GridModel>();
    const rows = [...pinnedTop, ...source].map((model) => {
      const row = modelToRow(model);
      models.set(row, model);
      return row;
    });
    // Pinned rows are the header rows plus the frozen rows; see headerRowCountForPinned.
    const headerRowCount = headerRowCountForPinned(metaNow, pinnedTop.length, contentRowCount(rows) > pinnedTop.length);
    const meta = headerRowCount === metaNow.headerRowCount ? metaNow : { ...metaNow, headerRowCount };
    snapshot = { source, pinnedTop, meta: metaNow, state: { rows, meta }, models };
    return snapshot;
  }

  /** Writes `next` to the grid; returns the formula pass when the rows were rewritten. */
  async function write(
    previous: Snapshot,
    next: SheetState,
    origin: CommandOrigin,
    changes: FormulaChanges,
  ): Promise<FormulaRecalcStats | undefined> {
    const current = grid();
    let recalc: FormulaRecalcStats | undefined;
    const header = next.meta.headerRowCount;
    const pinned = pinnedRowCount(next.meta);
    const pinnedChanged = pinned !== pinnedRowCount(previous.state.meta);
    let { source, pinnedTop } = previous;
    let models = previous.models;

    // Formulas read named ranges, so redefining one recalculates like a structural edit.
    const namesChanged = next.meta.namedRanges !== previous.state.meta.namedRanges;
    if (next.rows !== previous.state.rows || header !== previous.state.meta.headerRowCount || pinnedChanged || namesChanged) {
      let rows = next.rows;
      const blanks = rows.length - contentRowCount(rows);
      if (blanks < bufferRows) rows = [...rows, ...Array.from({ length: bufferRows - blanks }, () => [] as SheetRow)];
      models = new Map();
      const built = rows.map((row, index) => {
        const isHeader = index < header;
        const reused = previous.models.get(row);
        const model = reused && (reused._rowClass === 'header-row') === isHeader ? reused : rowToModel(row, isHeader, next.meta.columnCount);
        models.set(row, model);
        return model;
      });
      pinnedTop = built.slice(0, pinned);
      source = built.slice(pinned);
      const rollback = { source: previous.source, pinnedTop: previous.pinnedTop };
      try {
        const formulas = options.formulaViewState;
        formulas?.recalculate(spreadsheetDataOf({ rows, meta: next.meta }), {
          source: source as Record<string, string | number>[],
          pinnedTop: pinnedTop as Record<string, string | number>[],
        }, header === previous.state.meta.headerRowCount && !pinnedChanged && !namesChanged ? changes : 'structural');
        recalc = formulas?.lastStats ?? undefined;
        current.source = source as Record<string, string | number>[];
        current.pinnedTopSource = pinnedTop as Record<string, string | number>[];
        await current.refresh('all');
      } catch (error) {
        current.source = rollback.source as Record<string, string | number>[];
        current.pinnedTopSource = rollback.pinnedTop as Record<string, string | number>[];
        try {
          options.formulaViewState?.recalculate(spreadsheetDataOf(previous.state), {
            source: rollback.source as Record<string, string | number>[],
            pinnedTop: rollback.pinnedTop as Record<string, string | number>[],
          });
          await current.refresh('all');
        } catch (rollbackError) {
          console.error('[CSV] Failed to repaint after rolling back a command:', rollbackError);
        }
        snapshot = null;
        throw error;
      }
      next = { rows, meta: next.meta };
    }

    if (next.meta !== previous.state.meta) options.setMeta(next.meta, origin);
    snapshot = { source, pinnedTop, meta: options.getMeta(), state: next, models };
    revision += 1;
    if (origin !== 'remote') options.onDirty?.();
    await options.afterWrite?.();
    return recalc;
  }

  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    return options.runMutation ? options.runMutation(operation) : operation();
  }

  function rowMappingFor(state: SheetState): RowIndexMapping {
    return createRowIndexMapping({
      rowCount: state.rows.length,
      headerRowCount: pinnedRowCount(state.meta),
      trimmedRows: options.getTrimmedRows?.() ?? {},
    });
  }

  function execute(source: CommandSource, executeOptions: ExecuteOptions = {}): Promise<ExecuteResult | null> {
    const origin = executeOptions.origin ?? 'user';
    return enqueue(() => mutate(async () => {
      const before = await read();
      const command = typeof source === 'function'
        ? source({ state: before.state, rowMapping: rowMappingFor(before.state) })
        : source;
      if (!command) return null;
      const applied = applyCommand(before.state, command);
      if (!applied.changed) return { before: before.state, after: before.state, changed: false };
      const selectionBefore = options.getSelection?.() ?? null;
      const recalc = await write(before, applied.state, origin, formulaChangesOf(command));
      const after = snapshot!.state;
      const selectAfter = typeof executeOptions.selectAfter === 'function'
        ? executeOptions.selectAfter(after)
        : executeOptions.selectAfter;
      if (selectAfter) options.restoreSelection?.(selectAfter);
      history.record({ inverse: applied.inverse, origin, selection: selectionBefore, rowCount: before.state.rows.length });
      return { before: before.state, after, changed: true, recalc };
    }));
  }

  function step(direction: 'undo' | 'redo'): Promise<boolean> {
    return enqueue(() => mutate(async () => {
      const entry = history.peek(direction);
      if (!entry) return false;
      const before = await read();
      const applied = applyCommand(before.state, entry.inverse);
      const selectionNow = options.getSelection?.() ?? null;
      const next = shrinkToRowCount(applied.state, entry.rowCount);
      if (applied.changed || next !== applied.state) {
        await write(before, next, 'user', next === applied.state ? formulaChangesOf(entry.inverse) : 'structural');
      }
      history.complete(direction, {
        inverse: applied.inverse, origin: entry.origin, selection: selectionNow, rowCount: before.state.rows.length,
      });
      if (entry.selection) options.restoreSelection?.(entry.selection);
      return true;
    }));
  }

  return {
    execute,
    undo: () => step('undo'),
    redo: () => step('redo'),
    get canUndo() { return history.canUndo; },
    get canRedo() { return history.canRedo; },
    clearHistory: () => history.clear(),
    readContext: () => enqueue(async () => {
      const { state } = await read();
      return { state, rowMapping: rowMappingFor(state) };
    }),
    readAfterQueued: (read) => enqueue(async () => read(revision)),
    get revision() { return revision; },
    modelAt: (row) => {
      if (!snapshot) return undefined;
      const header = snapshot.pinnedTop.length;
      return row < header ? snapshot.pinnedTop[row] : snapshot.source[row - header];
    },
  };
}
