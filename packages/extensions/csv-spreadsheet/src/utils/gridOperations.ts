/**
 * Grid operations utility module
 *
 * Provides centralized functions for all RevoGrid data operations.
 * All operations work directly with RevoGrid as the single source of truth.
 */

import type { DimensionCols, DimensionRows } from '@revolist/revogrid';
import type { RevoGridElement } from '../revogrid-types';
import type {
  NormalizedSelectionRange,
  ColumnFormat,
  CSVMetadata,
  SpreadsheetData,
  CellValue,
  TrimmedRows,
} from '../types';
import { copyToClipboard } from '@nimbalyst/extension-sdk';
import {
  columnIndexToLetter,
  columnLetterToIndex,
  createCell,
  serializeMetadata,
} from './csvParser';
import { isFormula, recalculateFormulas as recalculateFormulaData } from './formulaEngine';
import type { UndoRedoPlugin } from '../plugins/UndoRedoPlugin';
import { getAppliedTrimmedRows } from '../filter/filterEngine';
import { createRowIndexMapping, logicalRowsForPaste, logicalRowsForSelection } from '../filter/rowIndexMapping';

export interface GridSourceData {
  source: Record<string, string | number>[];
  pinnedTop: Record<string, string | number>[];
}

export interface GridCellUpdate {
  row: number;
  column: number;
  value: string;
}

export interface GridCellUpdateResult extends GridCellUpdate {
  raw: string;
  displayed: string | number | null;
}

/**
 * Derived formula display values keyed by the actual RevoGrid row models.
 * Raw values remain in the source models, so editing and CSV serialization
 * never need to reconstruct formulas from display text.
 */
export class FormulaViewState {
  private displayByModel = new WeakMap<object, Map<string, CellValue>>();

  getDisplayValue(model: object, prop: string): CellValue | undefined {
    return this.displayByModel.get(model)?.get(prop);
  }

  recalculate(data: SpreadsheetData, gridData: GridSourceData): number {
    const startedAt = globalThis.performance?.now() ?? Date.now();
    const recalculated = recalculateFormulaData(data);
    const nextDisplayByModel = new WeakMap<object, Map<string, CellValue>>();

    recalculated.rows.forEach((row, rowIndex) => {
      const model = rowIndex < recalculated.headerRowCount
        ? gridData.pinnedTop[rowIndex]
        : gridData.source[rowIndex - recalculated.headerRowCount];
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

/** Convert parsed cells into RevoGrid rows while keeping formulas raw. */
export function spreadsheetDataToGridSource(
  data: SpreadsheetData,
  bufferRows = 20,
  bufferColumns = 20,
): GridSourceData {
  const columnCount = Math.max(data.columnCount, data.rows[0]?.length ?? 0);

  const convertRow = (row: SpreadsheetData['rows'][number] | undefined) => {
    const model: Record<string, string | number> = {};
    for (let colIndex = 0; colIndex < columnCount + bufferColumns; colIndex += 1) {
      const cell = row?.[colIndex];
      model[columnIndexToLetter(colIndex)] = cell
        ? (isFormula(cell.raw) ? cell.raw : (cell.computed ?? cell.raw))
        : '';
    }
    return model;
  };

  const pinnedTop = data.rows
    .slice(0, data.headerRowCount)
    .map((row) => ({ ...convertRow(row), _rowClass: 'header-row' }));
  const source = data.rows
    .slice(data.headerRowCount)
    .map(convertRow);

  for (let index = 0; index < bufferRows; index += 1) {
    source.push(convertRow(undefined));
  }

  return { source, pinnedTop };
}

function rowHasContent(row: Record<string, unknown>): boolean {
  return Object.entries(row).some(([key, value]) => (
    /^[A-Z]+$/.test(key) && value !== undefined && value !== null && value !== ''
  ));
}

function splitTrailingBufferRows(source: Record<string, unknown>[]): {
  contentRows: Record<string, unknown>[];
  bufferRows: Record<string, unknown>[];
} {
  let contentRowCount = source.length;
  while (contentRowCount > 0 && !rowHasContent(source[contentRowCount - 1])) {
    contentRowCount -= 1;
  }
  return {
    contentRows: source.slice(0, contentRowCount),
    bufferRows: source.slice(contentRowCount),
  };
}

function spreadsheetDataFromGridSources(
  pinnedTop: Record<string, unknown>[],
  source: Record<string, unknown>[],
  options: Pick<
    GridOperationsOptions,
    'getHeaderRowCount' | 'getColumnCount' | 'getColumnFormats' | 'getFrozenColumnCount'
  >,
): SpreadsheetData {
  const headerRowCount = Math.min(options.getHeaderRowCount(), pinnedTop.length);
  const { contentRows } = splitTrailingBufferRows(source);
  const rowsToConvert = [...pinnedTop.slice(0, headerRowCount), ...contentRows];
  let columnCount = Math.max(1, options.getColumnCount());

  for (const row of rowsToConvert) {
    for (const [key, value] of Object.entries(row)) {
      if (/^[A-Z]+$/.test(key) && value !== undefined && value !== null && value !== '') {
        columnCount = Math.max(columnCount, columnLetterToIndex(key) + 1);
      }
    }
  }

  return {
    rows: rowsToConvert.map((row) => Array.from(
      { length: columnCount },
      (_, colIndex) => createCell(String(row[columnIndexToLetter(colIndex)] ?? '')),
    )),
    columnCount,
    hasHeaders: headerRowCount > 0,
    headerRowCount,
    frozenColumnCount: options.getFrozenColumnCount(),
    columnFormats: options.getColumnFormats(),
  };
}

export interface GridOperationsOptions {
  getHeaderRowCount: () => number;
  getColumnCount: () => number;
  setColumnCount: (count: number) => void;
  getDelimiter: () => ',' | '\t';
  getColumnFormats: () => Record<number, ColumnFormat>;
  getColumnWidths: () => Record<number, number>;
  getFrozenColumnCount: () => number;
  onDirty: () => void;
  getUndoPlugin: () => UndoRedoPlugin | null;
  getTrimmedRows?: () => TrimmedRows;
  formulaViewState?: FormulaViewState;
}

export interface GridOperations {
  // Cell operations
  updateCell: (row: number, col: number, value: string) => Promise<void>;
  updateCells: (updates: readonly GridCellUpdate[]) => Promise<readonly GridCellUpdateResult[]>;
  clearCells: (range: NormalizedSelectionRange) => Promise<void>;
  getCellValue: (row: number, col: number) => Promise<string | number | null>;
  getCellRawValue: (row: number, col: number) => Promise<string>;
  recalculateFormulas: () => Promise<number>;

  // Row operations
  addRow: (index?: number) => Promise<void>;
  deleteRow: (index: number) => Promise<void>;

  // Column operations
  addColumn: (index?: number) => Promise<void>;
  deleteColumn: (index: number) => Promise<void>;

  // Header row operations
  /** Move rows between pinned (header) and regular sections based on new header count */
  updateHeaderRowCount: (newCount: number) => Promise<void>;

  // Clipboard operations
  copySelection: (range: NormalizedSelectionRange) => Promise<void>;
  cutSelection: (range: NormalizedSelectionRange) => Promise<void>;
  pasteFromText: (row: number, col: number, text: string) => Promise<void>;

  // Serialization
  toCSV: () => Promise<string>;
  getData: () => Promise<{ source: Record<string, unknown>[]; pinnedTop: Record<string, unknown>[] }>;

  // Sorting
  sortByColumn: (columnIndex: number, direction: 'asc' | 'desc' | null) => Promise<void>;
}

/**
 * Create grid operations bound to a specific grid element
 */
export function createGridOperations(
  gridRef: React.RefObject<RevoGridElement | null>,
  options: GridOperationsOptions
): GridOperations {
  const {
    getHeaderRowCount,
    getColumnCount,
    setColumnCount,
    getDelimiter,
    getColumnFormats,
    getColumnWidths,
    getFrozenColumnCount,
    onDirty,
    getUndoPlugin,
    getTrimmedRows,
    formulaViewState,
  } = options;

  const recalculateGridFormulas = async (): Promise<number> => {
    const grid = gridRef.current;
    if (!grid || !formulaViewState) return 0;

    const [source, pinnedTop] = await Promise.all([
      grid.getSource('rgRow'),
      grid.getSource('rowPinStart'),
    ]);
    const gridData = {
      source: (source ?? []) as Record<string, string | number>[],
      pinnedTop: (pinnedTop ?? []) as Record<string, string | number>[],
    };
    const data = spreadsheetDataFromGridSources(gridData.pinnedTop, gridData.source, options);
    const durationMs = formulaViewState.recalculate(data, gridData);
    await grid.refresh('all');
    return durationMs;
  };

  function rowMapping(grid: RevoGridElement, sourceRowCount: number) {
    const headerRowCount = getHeaderRowCount();
    return createRowIndexMapping({
      rowCount: headerRowCount + sourceRowCount,
      headerRowCount,
      trimmedRows: getTrimmedRows?.() ?? getAppliedTrimmedRows(grid),
    });
  }

  /**
   * Translate logical row index to RevoGrid row index and type
   */
  function translateRowIndex(logicalRow: number): { gridRow: number; rowType: DimensionRows } {
    const headerRowCount = getHeaderRowCount();
    if (logicalRow < headerRowCount) {
      return { gridRow: logicalRow, rowType: 'rowPinStart' };
    }
    return { gridRow: logicalRow - headerRowCount, rowType: 'rgRow' };
  }

  /** Translate an absolute sheet column into its RevoGrid viewport section. */
  function translateColumnIndex(logicalCol: number): { gridCol: number; colType: DimensionCols } {
    const frozenColumnCount = getFrozenColumnCount();
    if (logicalCol < frozenColumnCount) {
      return { gridCol: logicalCol, colType: 'colPinStart' };
    }
    return { gridCol: logicalCol - frozenColumnCount, colType: 'rgCol' };
  }

  /**
   * Apply a validated cell batch as one source replacement. Formula derivation
   * happens against cloned rows before the live grid changes; a failed repaint
   * restores both the original source and formula view before rejecting.
   */
  const updateCells = async (
    updates: readonly GridCellUpdate[],
  ): Promise<readonly GridCellUpdateResult[]> => {
    const grid = gridRef.current;
    if (!grid) throw new Error('Grid not available');
    if (updates.length === 0) return [];

    const [sourceValue, pinnedTopValue] = await Promise.all([
      grid.getSource('rgRow'),
      grid.getSource('rowPinStart'),
    ]);
    const source = (sourceValue ?? []) as Record<string, string | number>[];
    const pinnedTop = (pinnedTopValue ?? []) as Record<string, string | number>[];
    const nextSource = [...source];
    const nextPinnedTop = [...pinnedTop];
    const clonedSourceRows = new Set<number>();
    const clonedPinnedRows = new Set<number>();
    const seen = new Set<string>();
    const changes: Array<{
      rowIndex: number;
      colIndex: number;
      prop: string;
      oldValue: unknown;
      newValue: unknown;
      rowType: DimensionRows;
      colType: DimensionCols;
    }> = [];
    let sourceChanged = false;
    let pinnedTopChanged = false;

    for (const update of updates) {
      if (!Number.isInteger(update.row) || update.row < 0) {
        throw new Error(`Row index ${String(update.row)} is out of bounds`);
      }
      if (!Number.isInteger(update.column) || update.column < 0 || update.column >= getColumnCount()) {
        throw new Error(`Column index ${String(update.column)} is out of bounds`);
      }
      const key = `${update.row}:${update.column}`;
      if (seen.has(key)) throw new Error(`Duplicate cell update for ${key}`);
      seen.add(key);

      const { gridRow, rowType } = translateRowIndex(update.row);
      const { gridCol, colType } = translateColumnIndex(update.column);
      const rows = rowType === 'rowPinStart' ? nextPinnedTop : nextSource;
      const originalRows = rowType === 'rowPinStart' ? pinnedTop : source;
      if (!originalRows[gridRow]) {
        throw new Error(`Row index ${String(update.row)} is out of bounds`);
      }
      const clonedRows = rowType === 'rowPinStart' ? clonedPinnedRows : clonedSourceRows;
      if (!clonedRows.has(gridRow)) {
        rows[gridRow] = { ...originalRows[gridRow] };
        clonedRows.add(gridRow);
      }

      const prop = columnIndexToLetter(update.column);
      const oldValue = originalRows[gridRow][prop] ?? '';
      rows[gridRow][prop] = update.value;
      if (rowType === 'rowPinStart') pinnedTopChanged = true;
      else sourceChanged = true;
      if (oldValue !== update.value) {
        changes.push({
          rowIndex: gridRow,
          colIndex: gridCol,
          prop,
          oldValue,
          newValue: update.value,
          rowType,
          colType,
        });
      }
    }

    const nextGridData = { source: nextSource, pinnedTop: nextPinnedTop };
    const previousGridData = { source, pinnedTop };

    try {
      if (formulaViewState) {
        const nextData = spreadsheetDataFromGridSources(nextPinnedTop, nextSource, options);
        formulaViewState.recalculate(nextData, nextGridData);
      }
      if (sourceChanged) grid.source = nextSource;
      if (pinnedTopChanged) grid.pinnedTopSource = nextPinnedTop;
      await grid.refresh('all');
    } catch (error) {
      if (sourceChanged) grid.source = source;
      if (pinnedTopChanged) grid.pinnedTopSource = pinnedTop;
      try {
        if (formulaViewState) {
          const previousData = spreadsheetDataFromGridSources(pinnedTop, source, options);
          formulaViewState.recalculate(previousData, previousGridData);
        }
        await grid.refresh('all');
      } catch (rollbackError) {
        console.error('[CSV] Failed to repaint after rolling back a cell batch:', rollbackError);
      }
      throw error;
    }

    const undoPlugin = getUndoPlugin();
    if (undoPlugin && changes.length > 0) undoPlugin.recordManualChange(changes);
    if (changes.length > 0) onDirty();

    return updates.map((update) => {
      const { gridRow, rowType } = translateRowIndex(update.row);
      const rows = rowType === 'rowPinStart' ? nextPinnedTop : nextSource;
      const model = rows[gridRow];
      const prop = columnIndexToLetter(update.column);
      const raw = String(model[prop] ?? '');
      return {
        ...update,
        raw,
        displayed: formulaViewState?.getDisplayValue(model, prop) ?? model[prop] ?? null,
      };
    });
  };

  /** Update a single cell through the same transactional path. */
  const updateCell = async (row: number, col: number, value: string): Promise<void> => {
    await updateCells([{ row, column: col, value }]);
  };

  /**
   * Clear all cells in a selection range
   */
  const clearCells = async (range: NormalizedSelectionRange): Promise<void> => {
    const grid = gridRef.current;
    if (!grid) throw new Error('Grid not available');

    const changes: Array<{
      rowIndex: number;
      colIndex: number;
      prop: string;
      oldValue: unknown;
      newValue: unknown;
      rowType: DimensionRows;
      colType: DimensionCols;
    }> = [];

    // Get current data for undo tracking
    const [source, pinnedTop] = await Promise.all([
      grid.getSource('rgRow'),
      grid.getSource('rowPinStart'),
    ]);

    const promises: Promise<void | undefined>[] = [];

    const logicalRows = logicalRowsForSelection(rowMapping(grid, source?.length ?? 0), range).logicalRows;
    for (const r of logicalRows) {
      for (let c = range.startCol; c <= range.endCol; c++) {
        const { gridRow, rowType } = translateRowIndex(r);
        const { gridCol, colType } = translateColumnIndex(c);
        const prop = columnIndexToLetter(c);

        // Get old value
        const dataSource = rowType === 'rowPinStart' ? pinnedTop : source;
        const oldValue = dataSource?.[gridRow]?.[prop] ?? '';

        if (oldValue !== '') {
          changes.push({
            rowIndex: gridRow,
            colIndex: gridCol,
            colType,
            prop,
            oldValue,
            newValue: '',
            rowType,
          });
        }

        promises.push(grid.setDataAt({
          row: gridRow,
          col: gridCol,
          val: '',
          rowType,
          colType,
        }));
      }
    }

    await Promise.all(promises);
    await recalculateGridFormulas();

    // Record for undo
    const undoPlugin = getUndoPlugin();
    if (undoPlugin && changes.length > 0) {
      undoPlugin.recordManualChange(changes);
    }

    onDirty();
  };

  /**
   * Get the display value of a cell
   */
  const getCellValue = async (row: number, col: number): Promise<string | number | null> => {
    const grid = gridRef.current;
    if (!grid) return null;

    const { gridRow, rowType } = translateRowIndex(row);
    const source = await grid.getSource(rowType);
    const prop = columnIndexToLetter(col);

    const model = source?.[gridRow];
    if (!model) return null;
    return formulaViewState?.getDisplayValue(model, prop) ?? model[prop] ?? null;
  };

  /**
   * Get the raw value of a cell (for formulas, returns the formula text)
   */
  const getCellRawValue = async (row: number, col: number): Promise<string> => {
    const grid = gridRef.current;
    if (!grid) return '';

    const { gridRow, rowType } = translateRowIndex(row);
    const source = await grid.getSource(rowType);
    const prop = columnIndexToLetter(col);

    return String(source?.[gridRow]?.[prop] ?? '');
  };

  /**
   * Add a new row at the specified index
   */
  const addRow = async (index?: number): Promise<void> => {
    const grid = gridRef.current;
    if (!grid) throw new Error('Grid not available');

    // For now, we'll need to get all data, add row, and set it back
    // This is a limitation of RevoGrid's API
    const [source, pinnedTop] = await Promise.all([
      grid.getSource('rgRow'),
      grid.getSource('rowPinStart'),
    ]);

    const headerRowCount = getHeaderRowCount();
    const columnCount = getColumnCount();

    // Create empty row
    const newRow: Record<string, string> = {};
    for (let c = 0; c < columnCount; c++) {
      newRow[columnIndexToLetter(c)] = '';
    }

    const insertIndex = index ?? (headerRowCount + (source?.length ?? 0));

    if (insertIndex < headerRowCount) {
      // Insert into pinned (header) rows
      const newPinned = [...(pinnedTop || [])];
      newPinned.splice(insertIndex, 0, newRow);
      grid.pinnedTopSource = newPinned;
    } else {
      // Insert into regular rows
      const dataIndex = insertIndex - headerRowCount;
      const newSource = [...(source || [])];
      newSource.splice(dataIndex, 0, newRow);
      grid.source = newSource;
    }

    await recalculateGridFormulas();
    onDirty();
  };

  /**
   * Delete a row at the specified index
   */
  const deleteRow = async (index: number): Promise<void> => {
    const grid = gridRef.current;
    if (!grid) throw new Error('Grid not available');

    const [source, pinnedTop] = await Promise.all([
      grid.getSource('rgRow'),
      grid.getSource('rowPinStart'),
    ]);

    const headerRowCount = getHeaderRowCount();
    const totalRows = headerRowCount + (source?.length ?? 0);

    // Don't allow deleting the last row
    if (totalRows <= 1) return;

    if (index < headerRowCount) {
      // Delete from pinned rows
      const newPinned = [...(pinnedTop || [])];
      newPinned.splice(index, 1);
      grid.pinnedTopSource = newPinned;
    } else {
      // Delete from regular rows
      const dataIndex = index - headerRowCount;
      const newSource = [...(source || [])];
      newSource.splice(dataIndex, 1);
      grid.source = newSource;
    }

    await recalculateGridFormulas();
    onDirty();
  };

  /**
   * Update header row count - moves rows between pinned and regular sections
   */
  const updateHeaderRowCount = async (newCount: number): Promise<void> => {
    const grid = gridRef.current;
    if (!grid) throw new Error('Grid not available');

    const [source, pinnedTop] = await Promise.all([
      grid.getSource('rgRow'),
      grid.getSource('rowPinStart'),
    ]);

    const currentCount = pinnedTop?.length ?? 0;
    const safeNewCount = Math.max(0, newCount);

    if (safeNewCount === currentCount) return;

    let newPinned = [...(pinnedTop || [])];
    let newSource = [...(source || [])];

    if (safeNewCount > currentCount) {
      // Moving rows from source to pinned (making them headers)
      const rowsToMove = safeNewCount - currentCount;
      const movedRows = newSource.splice(0, rowsToMove);
      // Add header-row class to moved rows
      movedRows.forEach(row => {
        row._rowClass = 'header-row';
      });
      newPinned = [...newPinned, ...movedRows];
    } else {
      // Moving rows from pinned to source (removing headers)
      const rowsToMove = currentCount - safeNewCount;
      const movedRows = newPinned.splice(safeNewCount, rowsToMove);
      // Remove header-row class from moved rows
      movedRows.forEach(row => {
        delete row._rowClass;
      });
      newSource = [...movedRows, ...newSource];
    }

    grid.pinnedTopSource = newPinned;
    grid.source = newSource;
    await recalculateGridFormulas();
    onDirty();
  };

  /**
   * Add a new column at the specified index
   */
  const addColumn = async (index?: number): Promise<void> => {
    const grid = gridRef.current;
    if (!grid) throw new Error('Grid not available');

    const [source, pinnedTop] = await Promise.all([
      grid.getSource('rgRow'),
      grid.getSource('rowPinStart'),
    ]);

    const currentColumnCount = getColumnCount();
    const insertIndex = index ?? currentColumnCount;

    // Shift column data: for each row, shift columns from insertIndex onward
    const shiftColumnsInRow = (row: Record<string, unknown>): Record<string, unknown> => {
      const newRow: Record<string, unknown> = {};
      for (let c = 0; c < currentColumnCount + 1; c++) {
        const newKey = columnIndexToLetter(c);
        if (c < insertIndex) {
          // Columns before insert point stay the same
          const oldKey = columnIndexToLetter(c);
          newRow[newKey] = row[oldKey] ?? '';
        } else if (c === insertIndex) {
          // New column is empty
          newRow[newKey] = '';
        } else {
          // Columns after insert point shift right (read from c-1)
          const oldKey = columnIndexToLetter(c - 1);
          newRow[newKey] = row[oldKey] ?? '';
        }
      }
      // Preserve special properties like _rowClass
      if (row._rowClass) {
        newRow._rowClass = row._rowClass;
      }
      return newRow;
    };

    // Apply to all rows
    if (pinnedTop) {
      const newPinned = pinnedTop.map(shiftColumnsInRow);
      grid.pinnedTopSource = newPinned;
    }
    if (source) {
      const newSource = source.map(shiftColumnsInRow);
      grid.source = newSource;
    }

    // Update column count
    setColumnCount(currentColumnCount + 1);
    await recalculateGridFormulas();
    onDirty();
  };

  /**
   * Delete a column at the specified index
   */
  const deleteColumn = async (index: number): Promise<void> => {
    const grid = gridRef.current;
    if (!grid) throw new Error('Grid not available');

    const [source, pinnedTop] = await Promise.all([
      grid.getSource('rgRow'),
      grid.getSource('rowPinStart'),
    ]);

    const currentColumnCount = getColumnCount();

    // Don't allow deleting the last column
    if (currentColumnCount <= 1) return;

    // Shift column data: for each row, shift columns after deleteIndex left
    const shiftColumnsInRow = (row: Record<string, unknown>): Record<string, unknown> => {
      const newRow: Record<string, unknown> = {};
      for (let c = 0; c < currentColumnCount - 1; c++) {
        const newKey = columnIndexToLetter(c);
        if (c < index) {
          // Columns before delete point stay the same
          const oldKey = columnIndexToLetter(c);
          newRow[newKey] = row[oldKey] ?? '';
        } else {
          // Columns after delete point shift left (read from c+1)
          const oldKey = columnIndexToLetter(c + 1);
          newRow[newKey] = row[oldKey] ?? '';
        }
      }
      // Preserve special properties like _rowClass
      if (row._rowClass) {
        newRow._rowClass = row._rowClass;
      }
      return newRow;
    };

    // Apply to all rows
    if (pinnedTop) {
      const newPinned = pinnedTop.map(shiftColumnsInRow);
      grid.pinnedTopSource = newPinned;
    }
    if (source) {
      const newSource = source.map(shiftColumnsInRow);
      grid.source = newSource;
    }

    // Update column count
    setColumnCount(currentColumnCount - 1);
    await recalculateGridFormulas();
    onDirty();
  };

  /**
   * Copy selection to clipboard
   */
  const copySelection = async (range: NormalizedSelectionRange): Promise<void> => {
    const grid = gridRef.current;
    if (!grid) return;

    const [source, pinnedTop] = await Promise.all([
      grid.getSource('rgRow'),
      grid.getSource('rowPinStart'),
    ]);

    const values: string[][] = [];

    const logicalRows = logicalRowsForSelection(rowMapping(grid, source?.length ?? 0), range).logicalRows;
    for (const r of logicalRows) {
      const row: string[] = [];
      for (let c = range.startCol; c <= range.endCol; c++) {
        const { gridRow, rowType } = translateRowIndex(r);
        const prop = columnIndexToLetter(c);
        const dataSource = rowType === 'rowPinStart' ? pinnedTop : source;
        const value = dataSource?.[gridRow]?.[prop] ?? '';
        row.push(String(value));
      }
      values.push(row);
    }

    const text = values.map(row => row.join('\t')).join('\n');
    await copyToClipboard(text);
  };

  /**
   * Cut selection (copy + clear)
   */
  const cutSelection = async (range: NormalizedSelectionRange): Promise<void> => {
    await copySelection(range);
    await clearCells(range);
  };

  /**
   * Paste text at the specified position
   */
  const pasteFromText = async (targetRow: number, targetCol: number, text: string): Promise<void> => {
    const grid = gridRef.current;
    if (!grid) throw new Error('Grid not available');

    // Parse the pasted text (tab and newline delimited)
    const lines = text.split(/\r?\n/);
    const values = lines
      .filter(line => line.length > 0)
      .map(line => line.split('\t'));

    if (values.length === 0) return;

    // Calculate required dimensions after paste
    const pasteRowCount = values.length;
    const pasteColCount = Math.max(...values.map(row => row.length));
    const requiredColCount = targetCol + pasteColCount;

    // Expand column count if paste extends beyond current columns
    const currentColumnCount = getColumnCount();
    if (requiredColCount > currentColumnCount) {
      setColumnCount(requiredColCount);
    }

    const headerRowCount = getHeaderRowCount();
    const finalColumnCount = Math.max(currentColumnCount, requiredColCount);

    // Get current data
    const [source, pinnedTop] = await Promise.all([
      grid.getSource('rgRow'),
      grid.getSource('rowPinStart'),
    ]);

    const currentDataRows = source?.length ?? 0;
    const totalLogicalRows = headerRowCount + currentDataRows;
    const destinationRows = logicalRowsForPaste(
      rowMapping(grid, currentDataRows),
      targetRow,
      pasteRowCount,
      totalLogicalRows,
    ).logicalRows;

    // Expand grid source if needed
    let newSource = [...(source || [])];
    const requiredLastRow = Math.max(...destinationRows);
    const requiredDataRows = requiredLastRow >= headerRowCount
      ? requiredLastRow - headerRowCount + 1
      : 0;
    if (requiredDataRows > currentDataRows) {
      // Add empty rows to accommodate pasted data
      const rowsToAdd = requiredDataRows - currentDataRows;
      for (let i = 0; i < rowsToAdd; i++) {
        const emptyRow: Record<string, string> = {};
        for (let c = 0; c < finalColumnCount; c++) {
          emptyRow[columnIndexToLetter(c)] = '';
        }
        newSource.push(emptyRow);
      }
      // Update grid source with expanded rows
      grid.source = newSource;
    }

    const changes: Array<{
      rowIndex: number;
      colIndex: number;
      prop: string;
      oldValue: unknown;
      newValue: unknown;
      rowType: DimensionRows;
      colType: DimensionCols;
    }> = [];

    const promises: Promise<void | undefined>[] = [];

    for (let r = 0; r < values.length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        const destRow = destinationRows[r];
        const destCol = targetCol + c;
        const { gridRow, rowType } = translateRowIndex(destRow);
        const { gridCol, colType } = translateColumnIndex(destCol);
        const prop = columnIndexToLetter(destCol);
        const value = values[r][c];

        // Get old value
        const dataSource = rowType === 'rowPinStart' ? pinnedTop : newSource;
        const oldValue = dataSource?.[gridRow]?.[prop] ?? '';

        if (oldValue !== value) {
          changes.push({
            rowIndex: gridRow,
            colIndex: gridCol,
            colType,
            prop,
            oldValue,
            newValue: value,
            rowType,
          });
        }

        promises.push(grid.setDataAt({
          row: gridRow,
          col: gridCol,
          val: value,
          rowType,
          colType,
        }));
      }
    }

    await Promise.all(promises);
    await recalculateGridFormulas();

    // Record for undo
    const undoPlugin = getUndoPlugin();
    if (undoPlugin && changes.length > 0) {
      undoPlugin.recordManualChange(changes);
    }

    onDirty();
  };

  /**
   * Serialize grid data to CSV
   */
  const toCSV = async (): Promise<string> => {
    const grid = gridRef.current;
    if (!grid) throw new Error('Grid not available');

    const [source, pinnedTop] = await Promise.all([
      grid.getSource('rgRow'),
      grid.getSource('rowPinStart'),
    ]);

    const headerRowCount = getHeaderRowCount();
    const columnCount = getColumnCount();
    const delimiter = getDelimiter();
    const columnFormats = getColumnFormats();
    const frozenColumnCount = getFrozenColumnCount();

    // Helper to format a cell value for CSV
    function formatCell(value: unknown): string {
      const str = String(value ?? '');
      if (str.includes(delimiter) || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }

    // Helper to check if a cell value is empty
    function isEmptyCell(value: unknown): boolean {
      return value === undefined || value === null || value === '';
    }

    // Find the last non-empty column across all rows (pinned + regular)
    // We need to check ALL column keys that exist in row data, not just up to columnCount,
    // because new columns may have been added that aren't reflected in the metadata
    let lastNonEmptyCol = -1;
    const allRows = [...(pinnedTop?.slice(0, headerRowCount) || []), ...(source || [])];

    // Find the maximum possible column by looking at row object keys
    let maxColToCheck = columnCount - 1;
    for (const rowData of allRows) {
      for (const key of Object.keys(rowData)) {
        // Column keys are single or double letters (A-Z, AA-ZZ, etc.)
        if (/^[A-Z]+$/.test(key)) {
          const colIdx = columnLetterToIndex(key);
          if (colIdx > maxColToCheck) {
            maxColToCheck = colIdx;
          }
        }
      }
    }

    for (const rowData of allRows) {
      // Check all columns in this row from right to left
      for (let colIdx = maxColToCheck; colIdx >= 0; colIdx--) {
        const prop = columnIndexToLetter(colIdx);
        if (!isEmptyCell(rowData[prop])) {
          if (colIdx > lastNonEmptyCol) {
            lastNonEmptyCol = colIdx;
          }
          break; // Found rightmost non-empty cell in this row
        }
      }
    }

    // Use at least 1 column
    const effectiveColumnCount = Math.max(1, lastNonEmptyCol + 1);

    const csvRows: string[] = [];

    // Add pinned (header) rows first
    if (pinnedTop) {
      for (let rowIdx = 0; rowIdx < headerRowCount && rowIdx < pinnedTop.length; rowIdx++) {
        const rowData = pinnedTop[rowIdx];
        const cells: string[] = [];
        for (let colIdx = 0; colIdx < effectiveColumnCount; colIdx++) {
          const prop = columnIndexToLetter(colIdx);
          const value = rowData[prop];
          cells.push(formatCell(value));
        }
        csvRows.push(cells.join(delimiter));
      }
    }

    // Add regular rows (include empty rows - they'll be trimmed from the end only)
    if (source) {
      for (let rowIdx = 0; rowIdx < source.length; rowIdx++) {
        const rowData = source[rowIdx];
        const cells: string[] = [];
        for (let colIdx = 0; colIdx < effectiveColumnCount; colIdx++) {
          const prop = columnIndexToLetter(colIdx);
          const value = rowData[prop];
          cells.push(formatCell(value));
        }
        csvRows.push(cells.join(delimiter));
      }
    }

    // Trim trailing empty rows
    while (csvRows.length > 0 && csvRows[csvRows.length - 1].split(delimiter).every(c => c === '')) {
      csvRows.pop();
    }

    // Ensure at least one row
    if (csvRows.length === 0) {
      csvRows.push('');
    }

    // Build metadata - only include if using non-default features
    const columnWidths = getColumnWidths();
    const hasColumnFormats = Object.keys(columnFormats).length > 0;
    const hasColumnWidths = Object.keys(columnWidths).length > 0;
    const hasNonDefaultMetadata = headerRowCount > 0 || frozenColumnCount > 0 || hasColumnFormats || hasColumnWidths;

    if (hasNonDefaultMetadata) {
      const metadata: CSVMetadata = {
        hasHeaders: headerRowCount > 0,
        headerRowCount,
        frozenColumnCount,
        ...(hasColumnFormats ? { columnFormats } : {}),
        ...(hasColumnWidths ? { columnWidths } : {}),
      };
      return `${serializeMetadata(metadata)}\n${csvRows.join('\n')}`;
    }

    return csvRows.join('\n');
  };

  /**
   * Get raw grid data
   */
  const getData = async (): Promise<{ source: Record<string, unknown>[]; pinnedTop: Record<string, unknown>[] }> => {
    const grid = gridRef.current;
    if (!grid) return { source: [], pinnedTop: [] };

    const [source, pinnedTop] = await Promise.all([
      grid.getSource('rgRow'),
      grid.getSource('rowPinStart'),
    ]);

    return {
      source: source || [],
      pinnedTop: pinnedTop || [],
    };
  };

  /**
   * Sort by column
   */
  const sortByColumn = async (columnIndex: number, direction: 'asc' | 'desc' | null): Promise<void> => {
    const grid = gridRef.current;
    if (!grid) throw new Error('Grid not available');

    if (direction === null) {
      // Clear sort - would need to restore original order
      // For now, just return
      return;
    }

    const source = await grid.getSource('rgRow');
    if (!source) return;

    const prop = columnIndexToLetter(columnIndex);

    // Buffer rows stay trailing and are not part of spreadsheet sorting.
    const { contentRows, bufferRows } = splitTrailingBufferRows(source);
    const sorted = [...contentRows].sort((a, b) => {
      const aVal = formulaViewState?.getDisplayValue(a, prop) ?? a[prop];
      const bVal = formulaViewState?.getDisplayValue(b, prop) ?? b[prop];

      // Handle empty values
      const aEmpty = aVal === null || aVal === undefined || aVal === '';
      const bEmpty = bVal === null || bVal === undefined || bVal === '';

      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return direction === 'asc' ? 1 : -1;
      if (bEmpty) return direction === 'asc' ? -1 : 1;

      // Numeric comparison
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return direction === 'asc' ? aVal - bVal : bVal - aVal;
      }

      // String comparison
      const result = String(aVal).localeCompare(String(bVal));
      return direction === 'asc' ? result : -result;
    });

    grid.source = [...sorted, ...bufferRows];
    await recalculateGridFormulas();
    onDirty();
  };

  return {
    updateCell,
    updateCells,
    clearCells,
    getCellValue,
    getCellRawValue,
    recalculateFormulas: recalculateGridFormulas,
    addRow,
    deleteRow,
    addColumn,
    deleteColumn,
    updateHeaderRowCount,
    copySelection,
    cutSelection,
    pasteFromText,
    toCSV,
    getData,
    sortByColumn,
  };
}
