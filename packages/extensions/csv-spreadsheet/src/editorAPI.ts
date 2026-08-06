import type { ColumnFormat, NormalizedSelectionRange } from './types';
import type { GridOperations } from './utils/gridOperations';
import { columnIndexToLetter } from './utils/csvParser';

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
}

interface CreateSpreadsheetEditorAPIOptions {
  operations: GridOperations;
  getMetadata: () => SpreadsheetEditorMetadata;
  getSelection: () => Promise<SpreadsheetEditorSelection | null>;
  getDisplayValue?: (model: object, prop: string) => string | number | null | undefined;
  flashCells?: (cells: readonly { row: number; column: number }[]) => Promise<void> | void;
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
}: CreateSpreadsheetEditorAPIOptions): SpreadsheetEditorAPI {
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
    const headers = pinnedTop.slice(0, Math.min(metadata.headerRowCount, pinnedTop.length));
    return {
      metadata,
      rows: [...headers, ...contentRows(source, metadata.columnCount)],
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
          const displayValue = getDisplayValue?.(model, prop);
          const value = displayValue ?? rawValue ?? null;
          return {
            raw: String(rawValue ?? ''),
            value: typeof value === 'string' || typeof value === 'number' ? value : null,
          };
        });
      });
    },
    async updateCells(updates) {
      const results = await operations.updateCells(updates);
      try {
        await flashCells?.(updates);
      } catch (error) {
        console.warn('[CSV] Failed to display an AI cell flash:', error);
      }
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
