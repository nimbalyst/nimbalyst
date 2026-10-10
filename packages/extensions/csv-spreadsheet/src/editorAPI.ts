import type { ColumnFilterState, ColumnFormat, NormalizedSelectionRange } from './types';
import type { GridOperations } from './utils/gridOperations';
import { columnIndexToLetter } from './utils/csvParser';
import { shownValue } from './utils/formatters';
import type { SheetCommand } from './commands/sheetCommand';
import { cellAt, type SheetState } from './commands/sheetState';

export interface SpreadsheetEditorMetadata {
  columnCount: number;
  headerRowCount: number;
  hasHeaders: boolean;
  frozenColumnCount: number;
  columnFormats: Record<number, ColumnFormat>;
  delimiter: ',' | '\t';
}

export interface SpreadsheetEditorSelection {
  range: NormalizedSelectionRange;
  /** Ordered logical rows represented by the visible selection. */
  logicalRows: readonly number[];
}

export interface SpreadsheetCellSnapshot {
  raw: string;
  value: string | number | null;
}

export interface SpreadsheetSheetInfo {
  rowCount: number;
  metadata: SpreadsheetEditorMetadata;
}

/** The sheet as an agent tool sees it: plain data plus what the grid shows. */
export interface AgentSheetView {
  readonly state: SheetState;
  /** Logical rows the active filter leaves visible, in order. */
  readonly visibleRows: readonly number[];
  /** The value the grid displays (formula results), falling back to the raw text. */
  display(row: number, col: number): string | number | null;
}

export interface AgentRunResult {
  readonly changed: boolean;
  readonly before: SheetState;
  readonly after: AgentSheetView;
}

/**
 * Agent tool surface over the command executor. Every `run` is one command
 * with origin `agent`: one undo step, published to collab once.
 */
export interface SpreadsheetAgentAccess {
  read(): Promise<AgentSheetView>;
  /** Build a command against the state it will apply to; `null` writes nothing. */
  run(build: (view: AgentSheetView) => SheetCommand | null): Promise<AgentRunResult>;
  flash(cells: readonly { row: number; column: number }[]): Promise<void>;
  /** Session filters per column, when the editor exposes them. */
  getColumnFilters(): ColumnFilterState | null;
}

export interface SpreadsheetEditorAPI extends Pick<
  GridOperations,
  'addRow' | 'addColumn' | 'sortByColumn' | 'toCSV' | 'copySelection' | 'clearCells' | 'getData'
> {
  updateCell(row: number, column: number, value: string): Promise<void>;
  updateCells(updates: readonly { row: number; column: number; value: string }[]): Promise<readonly (SpreadsheetCellSnapshot & {
    row: number;
    column: number;
  })[]>;
  getCellValue(row: number, column: number): Promise<string | number | null>;
  getCellRawValue(row: number, column: number): Promise<string>;
  getMetadata(): SpreadsheetEditorMetadata;
  getSelection(): Promise<SpreadsheetEditorSelection | null>;
  getSheetInfo(): Promise<SpreadsheetSheetInfo>;
  readCells(logicalRows: readonly number[], columnIndexes: readonly number[]): Promise<SpreadsheetCellSnapshot[][]>;
  readonly agent: SpreadsheetAgentAccess;
}

interface CreateSpreadsheetEditorAPIOptions {
  operations: GridOperations;
  getMetadata: () => SpreadsheetEditorMetadata;
  getSelection: () => Promise<SpreadsheetEditorSelection | null>;
  getDisplayValue?: (model: object, prop: string) => string | number | null | undefined;
  flashCells?: (cells: readonly { row: number; column: number }[]) => Promise<void> | void;
  getColumnFilters?: () => ColumnFilterState;
}

function rowHasContent(row: Record<string, unknown>, columnCount: number): boolean {
  for (let column = 0; column < columnCount; column += 1) {
    const value = row[columnIndexToLetter(column)];
    if (value !== undefined && value !== null && value !== '') return true;
  }
  return false;
}

function contentRows(source: Record<string, unknown>[], columnCount: number): Record<string, unknown>[] {
  let count = source.length;
  while (count > 0 && !rowHasContent(source[count - 1], columnCount)) count -= 1;
  return source.slice(0, count);
}

function assertIndex(name: string, value: number, upperBound: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= upperBound) {
    throw new Error(`${name} ${String(value)} is out of bounds; expected an integer from 0 to ${Math.max(0, upperBound - 1)}`);
  }
}

export function createSpreadsheetEditorAPI({
  operations,
  getMetadata,
  getSelection,
  getDisplayValue,
  flashCells,
  getColumnFilters,
}: CreateSpreadsheetEditorAPIOptions): SpreadsheetEditorAPI {
  const { executor } = operations;

  // Valid until the next command: `modelAt` reads the executor's latest snapshot.
  const viewOf = (state: SheetState, visibleRows: readonly number[]): AgentSheetView => ({
    state,
    visibleRows,
    display(row, col) {
      const model = executor.modelAt(row);
      const prop = columnIndexToLetter(col);
      const shown = shownValue(model ? getDisplayValue?.(model, prop) : undefined);
      if (typeof shown === 'string' || typeof shown === 'number') return shown;
      const raw = cellAt(state, row, col);
      return raw === '' ? null : raw;
    },
  });

  const flash = async (cells: readonly { row: number; column: number }[]) => {
    if (cells.length === 0) return;
    try {
      await flashCells?.(cells);
    } catch (error) {
      console.warn('[CSV] Failed to display an AI cell flash:', error);
    }
  };

  const agent: SpreadsheetAgentAccess = {
    async read() {
      const { state, rowMapping } = await executor.readContext();
      return viewOf(state, rowMapping.logicalRows);
    },
    async run(build) {
      let visibleRows: readonly number[] = [];
      const result = await executor.execute(({ state, rowMapping }) => {
        visibleRows = rowMapping.logicalRows;
        return build(viewOf(state, visibleRows));
      }, { origin: 'agent' });
      if (!result) {
        const view = await agent.read();
        return { changed: false, before: view.state, after: view };
      }
      return { changed: result.changed, before: result.before, after: viewOf(result.after, visibleRows) };
    },
    flash,
    getColumnFilters: () => getColumnFilters?.() ?? null,
  };
  const getMetadataSnapshot = (): SpreadsheetEditorMetadata => {
    const metadata = getMetadata();
    return {
      ...metadata,
      columnFormats: { ...metadata.columnFormats },
    };
  };

  const getModels = async () => {
    const metadata = getMetadataSnapshot();
    const { source, pinnedTop } = await operations.getData();
    // Every pinned row is a logical row: the header rows and the frozen data
    // rows below them. Callers skip `headerRowCount` rows to reach data.
    return {
      metadata,
      rows: [...pinnedTop, ...contentRows(source, metadata.columnCount)],
    };
  };

  return {
    getData: operations.getData,
    addRow: operations.addRow,
    addColumn: operations.addColumn,
    sortByColumn: operations.sortByColumn,
    toCSV: operations.toCSV,
    copySelection: operations.copySelection,
    clearCells: operations.clearCells,
    getCellValue: operations.getCellValue,
    getCellRawValue: operations.getCellRawValue,
    getMetadata: getMetadataSnapshot,
    getSelection,
    agent,
    async getSheetInfo() {
      const { metadata, rows } = await getModels();
      return { rowCount: rows.length, metadata };
    },
    async readCells(logicalRows, columnIndexes) {
      const { metadata, rows } = await getModels();
      for (const row of logicalRows) assertIndex('Row index', row, rows.length);
      for (const column of columnIndexes) assertIndex('Column index', column, metadata.columnCount);

      return logicalRows.map((rowIndex) => {
        const model = rows[rowIndex];
        return columnIndexes.map((columnIndex) => {
          const prop = columnIndexToLetter(columnIndex);
          const rawValue = model[prop];
          const displayValue = shownValue(getDisplayValue?.(model, prop));
          const value = displayValue ?? rawValue ?? null;
          return {
            raw: String(rawValue ?? ''),
            value: typeof value === 'string' || typeof value === 'number' ? value : null,
          };
        });
      });
    },
    async updateCells(updates) {
      // One tool call is one command: a single undo step, published once.
      const results = await operations.updateCells(updates, 'agent');
      await flash(updates);
      return results.map(({ row, column, raw, displayed }) => ({
        row,
        column,
        raw,
        value: displayed,
      }));
    },
    async updateCell(row, column, value) {
      await this.updateCells([{ row, column, value }]);
    },
  };
}
