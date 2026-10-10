/**
 * Grid operations: the editor's and agent tools' API over the sheet.
 *
 * Reads go straight to RevoGrid. Every mutation is a `SheetCommand` run by the
 * grid command executor (`commands/gridCommandExecutor.ts`), so undo, formula
 * and metadata rewriting, collab publication and the filtered-view refresh
 * happen in one place for all of them.
 */

import type { RevoGridElement } from '../revogrid-types';
import type { NormalizedSelectionRange, SpreadsheetData, CellValue } from '../types';
import {
  autoDetectHeaderRowCount,
  buildMetadataLine,
  columnIndexToLetter,
  columnLetterToIndex,
  DEFAULT_FILE_LAYOUT,
  quoteCsvField,
  type CsvFileLayout,
} from './csvParser';
import { headerRowCountForPinned, pickFormatting, pinnedRowCount } from '../sheetMeta/formatting';
import { isFormula } from './formulaEngine';
import type { GridSourceData } from './formulaViewState';
import { cellDisplayText, getSortKey, shownValue } from './formatters';
import { createRowIndexMapping, logicalRowsForPaste, logicalRowsForSelection } from '../filter/rowIndexMapping';
import { CellStyleIndex } from '../cells/cellStyles';
import { RangeIndex } from '../cells/sheetDecorations';
import { buildCopyPayload, resolvePasteSource, type ClipboardInput, type CopyPayload } from '../clipboard/copyPayload';
import { readClipboardInput, toHtmlCellStyle, writeClipboard } from '../clipboard/systemClipboard';
import {
  buildClear,
  buildFillBetween,
  buildFillCopy,
  buildFillValue,
  buildPaste,
  buildSort,
  buildUpdateCells,
} from '../commands/builders';
import {
  createGridCommandExecutor,
  readGridSources,
  spreadsheetDataOf,
  type GridCommandExecutor,
  type GridCommandExecutorOptions,
} from '../commands/gridCommandExecutor';
import type { CommandOrigin } from '../commands/commandHistory';
import { cellAt, type SheetMeta } from '../commands/sheetState';
import { fillDownEndRow } from '../fill/fillExtent';

export { FormulaViewState, type FormulaChanges, type GridSourceData } from './formulaViewState';

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
 * Convert parsed cells into RevoGrid rows while keeping formulas raw.
 *
 * Models carry keys for the data columns only. The empty columns the grid
 * shows past the data are column definitions with no cells behind them (a
 * missing key reads as blank); a write there creates the key.
 */
export function spreadsheetDataToGridSource(
  data: SpreadsheetData,
  bufferRows = 20,
): GridSourceData {
  const columnCount = Math.max(data.columnCount, data.rows[0]?.length ?? 0);

  const convertRow = (row: SpreadsheetData['rows'][number] | undefined) => {
    const model: Record<string, string | number> = {};
    for (let colIndex = 0; colIndex < columnCount; colIndex += 1) {
      const cell = row?.[colIndex];
      // A number only when it prints back as the file's text: `007` and `1.50`
      // stay strings, or the next save would write `7` and `1.5`.
      model[columnIndexToLetter(colIndex)] = cell
        ? (typeof cell.computed === 'number' && !isFormula(cell.raw) && String(cell.computed) === cell.raw
          ? cell.computed
          : cell.raw)
        : '';
    }
    return model;
  };

  // Header rows and frozen rows are both pinned; only header rows look like headers.
  const pinned = Math.min(data.rows.length, pinnedRowCount(data));
  const pinnedTop = data.rows
    .slice(0, pinned)
    .map((row, index) => (index < data.headerRowCount ? { ...convertRow(row), _rowClass: 'header-row' } : convertRow(row)));
  const source = data.rows
    .slice(pinned)
    .map(convertRow);

  for (let index = 0; index < bufferRows; index += 1) {
    source.push(convertRow(undefined));
  }

  return { source, pinnedTop };
}

export interface GridOperationsOptions extends Omit<GridCommandExecutorOptions, 'gridRef'> {
  getDelimiter: () => ',' | '\t';
  /** Line endings, final newline and metadata-line presence of the loaded file. */
  getFileLayout?: () => CsvFileLayout;
}

export interface PasteOptions {
  /** Cmd+Shift+V: display values only, no formulas. */
  valuesOnly?: boolean;
  /** The native paste event's data, when there is one. */
  transfer?: DataTransfer | null;
}

export interface GridOperations {
  /** The command executor behind every mutation (undo/redo live here). */
  readonly executor: GridCommandExecutor;

  updateCell: (row: number, col: number, value: string, origin?: CommandOrigin) => Promise<void>;
  /** One validated batch, one undo step; nothing is written if any update is out of bounds. */
  updateCells: (updates: readonly GridCellUpdate[], origin?: CommandOrigin) => Promise<readonly GridCellUpdateResult[]>;
  clearCells: (range: NormalizedSelectionRange) => Promise<void>;
  getCellValue: (row: number, col: number) => Promise<string | number | null>;
  getCellRawValue: (row: number, col: number) => Promise<string>;
  recalculateFormulas: () => Promise<number>;

  addRow: (index?: number) => Promise<void>;
  deleteRow: (index: number) => Promise<void>;
  addColumn: (index?: number) => Promise<void>;
  deleteColumn: (index: number) => Promise<void>;
  /** Pin the first `count` rows as headers (moves rows between grid sections). */
  updateHeaderRowCount: (count: number) => Promise<void>;
  /** Freeze, formats, widths, styles: undoable like everything else. */
  setMeta: (patch: Partial<SheetMeta> | ((meta: SheetMeta) => Partial<SheetMeta>)) => Promise<void>;

  copySelection: (range: NormalizedSelectionRange, transfer?: DataTransfer | null) => Promise<CopyPayload | null>;
  cutSelection: (range: NormalizedSelectionRange, transfer?: DataTransfer | null) => Promise<void>;
  /** Paste the clipboard (or `input`) at the selection; returns the range written. */
  paste: (selection: NormalizedSelectionRange, options?: PasteOptions & { input?: ClipboardInput }) => Promise<NormalizedSelectionRange | null>;
  pasteFromText: (row: number, col: number, text: string) => Promise<void>;

  /** Fill handle: continue `source` as a series through the rest of `target` (which contains it). */
  fillSeries: (source: NormalizedSelectionRange, target: NormalizedSelectionRange) => Promise<void>;
  /** Fill-handle double-click: continue `source` down as far as the neighboring column's data; returns the filled range. */
  fillDown: (source: NormalizedSelectionRange) => Promise<NormalizedSelectionRange | null>;
  /** Ctrl+D / Ctrl+R. */
  fillCopy: (range: NormalizedSelectionRange, axis: 'down' | 'right') => Promise<void>;
  /** Cmd+Enter: one value into every cell, formulas shifted from `origin`. */
  fillValue: (range: NormalizedSelectionRange, value: string, origin: { row: number; col: number }) => Promise<void>;

  /** The sheet as CSV, after every command queued before the call. */
  toCSV: () => Promise<string>;
  /** `toCSV` plus the executor revision it reflects, so a save can tell whether anything changed since. */
  snapshotCSV: () => Promise<{ content: string; revision: number }>;
  /**
   * The grid as CSV right now, without waiting for the queue. Only for the
   * collab binding: it serializes inside a running command's mutation, where
   * waiting on the queue would deadlock.
   */
  serializeCSV: () => Promise<string>;
  getData: () => Promise<{ source: Record<string, unknown>[]; pinnedTop: Record<string, unknown>[] }>;
  sortByColumn: (columnIndex: number, direction: 'asc' | 'desc' | null) => Promise<void>;
}

type GridModel = Record<string, unknown>;

function isEmptyCell(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Narrow a grid model value to what the formatter helpers accept. */
function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return String(value);
}

export function createGridOperations(
  gridRef: { readonly current: RevoGridElement | null },
  options: GridOperationsOptions,
): GridOperations {
  const { getMeta, getDelimiter, formulaViewState } = options;
  const executor = createGridCommandExecutor({ ...options, gridRef });

  const readSources = async () => {
    const grid = gridRef.current;
    if (!grid) throw new Error('Grid not available');
    const { source, pinnedTop } = await readGridSources(grid);
    return {
      source: source as Record<string, string | number>[],
      pinnedTop: pinnedTop as Record<string, string | number>[],
    };
  };

  const recalculateFormulas = async (): Promise<number> => {
    const grid = gridRef.current;
    if (!grid || !formulaViewState) return 0;
    const { state } = await executor.readContext();
    const durationMs = formulaViewState.recalculate(spreadsheetDataOf(state), await readSources());
    await grid.refresh('all');
    return durationMs;
  };

  const updateCells = async (
    updates: readonly GridCellUpdate[],
    origin: CommandOrigin = 'user',
  ): Promise<readonly GridCellUpdateResult[]> => {
    if (updates.length === 0) return [];
    await executor.execute(({ state }) => buildUpdateCells(state, updates), { origin });
    return updates.map((update) => {
      const model = executor.modelAt(update.row);
      const prop = columnIndexToLetter(update.column);
      const raw = String(model?.[prop] ?? '');
      return {
        ...update,
        raw,
        displayed: shownValue((model && formulaViewState?.getDisplayValue(model, prop)) ?? (model?.[prop] as CellValue | undefined) ?? null),
      };
    });
  };

  const clearCells = async (range: NormalizedSelectionRange) => {
    await executor.execute(({ rowMapping }) => buildClear(logicalRowsForSelection(rowMapping, range).logicalRows, range));
  };

  /**
   * Build the copy payload synchronously from the grid's current sources: a
   * native `copy` event's DataTransfer can only be written before the handler
   * returns, so nothing here may await.
   */
  const buildCopy = (range: NormalizedSelectionRange): CopyPayload | null => {
    const grid = gridRef.current as unknown as { source?: GridModel[]; pinnedTopSource?: GridModel[] } | null;
    const pinnedTop = grid?.pinnedTopSource ?? [];
    const source = grid?.source ?? [];
    const modelAt = (row: number) => (row < pinnedTop.length ? pinnedTop[row] : source[row - pinnedTop.length]);
    const mapping = createRowIndexMapping({
      rowCount: pinnedTop.length + source.length,
      headerRowCount: pinnedTop.length,
      trimmedRows: options.getTrimmedRows?.() ?? {},
    });
    const rows = logicalRowsForSelection(mapping, range).logicalRows;
    if (rows.length === 0) return null;
    const meta = getMeta();
    const cols = Array.from({ length: range.endCol - range.startCol + 1 }, (_, i) => range.startCol + i);
    const raw = rows.map((row) => cols.map((col) => String(modelAt(row)?.[columnIndexToLetter(col)] ?? '')));
    const cellFormats = new RangeIndex(meta.cellFormats);
    const display = rows.map((row, r) => cols.map((col, c) => {
      const model = modelAt(row);
      const prop = columnIndexToLetter(col);
      const shown = (model && formulaViewState?.getDisplayValue(model, prop)) ?? raw[r][c];
      const format = cellFormats.at(row, col) ?? meta.columnFormats[col];
      return cellDisplayText(toCellValue(shown), format);
    }));
    const styles = new CellStyleIndex(meta.cellStyles);
    return buildCopyPayload({
      range: { startRow: rows[0], endRow: rows[0] + rows.length - 1, startCol: range.startCol, endCol: range.endCol },
      raw,
      display,
      rows,
      styleAt: (r, c) => toHtmlCellStyle(styles.styleAt(rows[r], cols[c])),
    });
  };

  const copySelection = (range: NormalizedSelectionRange, transfer?: DataTransfer | null) => {
    const payload = buildCopy(range);
    if (!payload) return Promise.resolve(null);
    return writeClipboard(payload, transfer).then(() => payload);
  };

  const paste: GridOperations['paste'] = async (selection, pasteOptions = {}) => {
    const input = pasteOptions.input ?? await readClipboardInput(pasteOptions.transfer);
    const source = resolvePasteSource(input, { valuesOnly: pasteOptions.valuesOnly });
    if (!source) return null;
    let written: NormalizedSelectionRange | null = null;
    await executor.execute(({ state, rowMapping }) => {
      const result = buildPaste({
        source,
        selection,
        visibleSelectionRows: Math.max(1, logicalRowsForSelection(rowMapping, selection).logicalRows.length),
        destinationRows: (count) => logicalRowsForPaste(rowMapping, selection.startRow, count, state.rows.length).logicalRows,
        columnFormats: state.meta.columnFormats,
      });
      written = result?.range ?? null;
      return result?.command ?? null;
    }, { selectAfter: () => (written ? { cell: { row: written.startRow, col: written.startCol }, range: written } : null) });
    return written;
  };

  const fillSeries: GridOperations['fillSeries'] = async (source, target) => {
    await executor.execute(({ state, rowMapping }) => buildFillBetween(state, rowMapping.logicalRows, source, target),
      { selectAfter: { cell: { row: target.startRow, col: target.startCol }, range: target } });
  };

  const fillDown: GridOperations['fillDown'] = async (source) => {
    let target: NormalizedSelectionRange | null = null;
    await executor.execute(({ state, rowMapping }) => {
      const endRow = fillDownEndRow(state, source);
      if (endRow === null) return null;
      target = { ...source, endRow };
      return buildFillBetween(state, rowMapping.logicalRows, source, target);
    }, { selectAfter: () => (target ? { cell: { row: target.startRow, col: target.startCol }, range: target } : null) });
    return target;
  };

  const serializeCSV = async (): Promise<string> => {
    const { source, pinnedTop } = await readSources();
    const meta = getMeta();
    const delimiter = getDelimiter();
    const allRows: Record<string, unknown>[] = [...pinnedTop, ...source];

    let width = 0;
    let populatedBelow = false;
    allRows.forEach((row, index) => {
      for (const [key, value] of Object.entries(row)) {
        if (/^[A-Z]+$/.test(key) && !isEmptyCell(value)) {
          width = Math.max(width, columnLetterToIndex(key) + 1);
          if (index >= pinnedTop.length) populatedBelow = true;
        }
      }
    });
    width = Math.max(1, width);
    // The pinned section is the header rows plus the frozen rows.
    const headerRowCount = headerRowCountForPinned(meta, pinnedTop.length, populatedBelow);

    const cellText = (row: Record<string, unknown> | undefined, col: number) => String(row?.[columnIndexToLetter(col)] ?? '');
    const csvRows = allRows.map((row) => Array.from({ length: width }, (_, col) => (
      quoteCsvField(cellText(row, col), delimiter)
    )).join(delimiter));
    while (csvRows.length > 0 && csvRows[csvRows.length - 1].split(delimiter).every((cell) => cell === '')) {
      csvRows.pop();
    }
    const contentRows = csvRows.length;
    if (csvRows.length === 0) csvRows.push('');

    const layout = options.getFileLayout?.() ?? DEFAULT_FILE_LAYOUT;
    const firstRow = Array.from({ length: width }, (_, col) => cellText(allRows[0], col));
    const metadataLine = buildMetadataLine({
      headerRowCount,
      frozenColumnCount: meta.frozenColumnCount,
      columnFormats: meta.columnFormats,
      columnWidths: meta.columnWidths,
      cellStyles: meta.cellStyles,
      ...pickFormatting(meta),
    }, { detectedHeaderRowCount: autoDetectHeaderRowCount(firstRow, contentRows), keepLine: layout.hasMetadataLine });
    const { lineEnding } = layout;
    const body = csvRows.join(lineEnding) + (layout.trailingNewline && contentRows > 0 ? lineEnding : '');
    return metadataLine ? `${metadataLine}${lineEnding}${body}` : body;
  };

  const getRowModel = async (row: number) => {
    const { source, pinnedTop } = await readSources();
    const header = pinnedTop.length;
    return row < header ? pinnedTop[row] : source[row - header];
  };

  return {
    executor,
    updateCell: async (row, col, value, origin) => { await updateCells([{ row, column: col, value }], origin); },
    updateCells,
    clearCells,
    getCellValue: async (row, col) => {
      const model = await getRowModel(row);
      if (!model) return null;
      const prop = columnIndexToLetter(col);
      return formulaViewState?.getDisplayValue(model, prop) ?? model[prop] ?? null;
    },
    getCellRawValue: async (row, col) => String((await getRowModel(row))?.[columnIndexToLetter(col)] ?? ''),
    recalculateFormulas,
    // Without an index the row goes after the last row, as it always has.
    addRow: async (index) => {
      await executor.execute(({ state }) => ({
        type: 'structural', edit: { type: 'insertRows', at: index ?? state.rows.length, count: 1 },
      }));
    },
    deleteRow: async (index) => {
      await executor.execute(({ state }) => (state.rows.length <= 1 ? null : {
        type: 'structural', edit: { type: 'deleteRows', at: index, count: 1 },
      }));
    },
    addColumn: async (index) => {
      await executor.execute(({ state }) => ({
        type: 'structural', edit: { type: 'insertCols', at: index ?? state.meta.columnCount, count: 1 },
      }));
    },
    deleteColumn: async (index) => {
      await executor.execute(({ state }) => (state.meta.columnCount <= 1 ? null : {
        type: 'structural', edit: { type: 'deleteCols', at: index, count: 1 },
      }));
    },
    updateHeaderRowCount: async (count) => {
      await executor.execute({ type: 'setMeta', patch: { headerRowCount: Math.max(0, count) } });
    },
    setMeta: async (patch) => {
      await executor.execute(({ state }) => ({
        type: 'setMeta', patch: typeof patch === 'function' ? patch(state.meta) : patch,
      }));
    },
    copySelection,
    cutSelection: async (range, transfer) => {
      if (await copySelection(range, transfer)) await clearCells(range);
    },
    paste,
    pasteFromText: async (row, col, text) => {
      await paste({ startRow: row, endRow: row, startCol: col, endCol: col }, { input: { text } });
    },
    fillSeries,
    fillDown,
    fillCopy: async (range, axis) => {
      await executor.execute(({ state, rowMapping }) => (
        buildFillCopy(state, logicalRowsForSelection(rowMapping, range).logicalRows, range, axis)
      ));
    },
    fillValue: async (range, value, origin) => {
      await executor.execute(({ rowMapping }) => (
        buildFillValue(logicalRowsForSelection(rowMapping, range).logicalRows, range, value, origin)
      ), { selectAfter: { cell: origin, range } });
    },
    toCSV: () => executor.readAfterQueued(() => serializeCSV()),
    snapshotCSV: () => executor.readAfterQueued(async (revision) => ({ content: await serializeCSV(), revision })),
    serializeCSV,
    getData: readSources,
    sortByColumn: async (columnIndex, direction) => {
      // Clearing a sort would need the original order; nothing to do.
      if (direction === null) return;
      const prop = columnIndexToLetter(columnIndex);
      await executor.execute(({ state }) => buildSort(state, direction, (row) => {
        const model = executor.modelAt(row);
        const shown = (model && formulaViewState?.getDisplayValue(model, prop)) ?? cellAt(state, row, columnIndex);
        return getSortKey(shownValue(toCellValue(shown)), state.meta.columnFormats[columnIndex]);
      }));
    },
  };
}
