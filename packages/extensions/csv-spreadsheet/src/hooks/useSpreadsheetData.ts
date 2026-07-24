/**
 * Hook for spreadsheet data management with undo/redo support
 * Replaces the Zustand store with a simpler approach using use-undoable
 */

import { useState, useCallback, useRef } from 'react';
import useUndoable from 'use-undoable';
import type { SpreadsheetData, Cell, SortDirection, SortConfig, NormalizedSelectionRange, ColumnFormat } from '../types';
import { parseCSV, serializeToCSV, createCell } from '../utils/csvParser';
import { copyToClipboard } from '@nimbalyst/extension-sdk';
import { recalculateFormulas, isFormula, evaluateFormula } from '../utils/formulaEngine';

/**
 * Trim trailing empty rows and columns from data for saving
 */
function trimEmptyRowsAndColumns(data: SpreadsheetData): SpreadsheetData {
  const rows = [...data.rows];

  // Find last non-empty row
  let lastNonEmptyRow = rows.length - 1;
  while (lastNonEmptyRow >= 0 && rows[lastNonEmptyRow].every(cell => cell.raw === '')) {
    lastNonEmptyRow--;
  }

  // Keep at least one row
  const trimmedRows = rows.slice(0, Math.max(1, lastNonEmptyRow + 1));

  // Find last non-empty column
  let lastNonEmptyCol = data.columnCount - 1;
  while (lastNonEmptyCol >= 0) {
    const colHasData = trimmedRows.some(row => row[lastNonEmptyCol]?.raw !== '');
    if (colHasData) break;
    lastNonEmptyCol--;
  }

  // Keep at least one column
  const newColumnCount = Math.max(1, lastNonEmptyCol + 1);

  // Trim columns from each row
  const finalRows = trimmedRows.map(row => row.slice(0, newColumnCount));

  return {
    ...data,
    rows: finalRows,
    columnCount: newColumnCount,
  };
}

/**
 * Create an empty spreadsheet with default dimensions
 */
function createEmptySpreadsheet(): SpreadsheetData {
  const rows: Cell[][] = [];
  const columnCount = 5;
  const rowCount = 10;

  for (let r = 0; r < rowCount; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < columnCount; c++) {
      row.push({ raw: '', computed: '' });
    }
    rows.push(row);
  }

  return {
    rows,
    columnCount,
    hasHeaders: false,
    headerRowCount: 0,
    frozenColumnCount: 0,
    columnFormats: {},
  };
}

export interface UseSpreadsheetDataOptions {
  onDirtyChange?: (isDirty: boolean) => void;
  onContentChange?: () => void;
}

export interface UseSpreadsheetDataResult {
  // Data
  data: SpreadsheetData;
  isDirty: boolean;
  delimiter: ',' | '\t';

  // Undo/Redo
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;

  // Data mutations
  updateCell: (row: number, col: number, value: string) => void;
  addRow: (index?: number) => void;
  deleteRow: (index: number) => void;
  addColumn: (index?: number) => void;
  deleteColumn: (index: number) => void;
  sortByColumn: (columnIndex: number, direction: SortDirection) => void;
  setHeaderRowCount: (count: number) => void;
  setFrozenColumnCount: (count: number) => void;
  setColumnFormat: (columnIndex: number, format: ColumnFormat | null) => void;
  toggleHeaders: () => void;

  // Clipboard (uses system clipboard)
  copySelection: (selection: NormalizedSelectionRange) => void;
  cutSelection: (selection: NormalizedSelectionRange) => void;
  pasteFromText: (row: number, col: number, text: string) => void;
  clearCells: (selection: NormalizedSelectionRange) => void;

  // Serialization
  toCSV: () => string;
  loadFromCSV: (content: string) => void;
  markClean: () => void;

  // Disk content tracking (for external change detection)
  contentMatchesDisk: (content: string) => boolean;
  updateDiskContent: (content: string) => void;

  // Sort state
  sortConfig: SortConfig | null;
}

export function useSpreadsheetData(
  initialContent: string,
  _filePath: string,
  options: UseSpreadsheetDataOptions = {}
): UseSpreadsheetDataResult {
  const { onDirtyChange, onContentChange } = options;

  // Parse initial content and evaluate formulas
  const initialParse = useRef(() => {
    const parsed = parseCSV(initialContent || '');
    // Evaluate formulas on the initial data
    const dataWithFormulas = recalculateFormulas(parsed.data);
    return { ...parsed, data: dataWithFormulas };
  });
  const parsedData = useRef(initialParse.current());
  const [delimiter, setDelimiter] = useState<',' | '\t'>(parsedData.current.delimiter);

  // Track the last content we received from disk (for detecting external changes)
  // This is used to ignore file watcher notifications that match what we already have
  const lastKnownDiskContentRef = useRef<string>(initialContent);

  // Main data state with undo/redo
  const [data, setData, { undo, redo, canUndo, canRedo, reset }] = useUndoable<SpreadsheetData>(
    initialContent ? parsedData.current.data : createEmptySpreadsheet()
  );

  // Non-undoable state
  const [isDirty, setIsDirty] = useState(false);
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);

  // Track dirty state changes and notify of content changes
  const markDirty = useCallback(() => {
    if (!isDirty) {
      setIsDirty(true);
      onDirtyChange?.(true);
    }
    // Always notify of content change for autosave
    onContentChange?.();
  }, [isDirty, onDirtyChange, onContentChange]);

  // Update a cell (expands data if editing beyond current bounds)
  const updateCell = useCallback((row: number, col: number, value: string) => {
    console.log('[CSV updateCell] row:', row, 'col:', col, 'value:', value);
    setData(prev => {
      console.log('[CSV updateCell] prev rows[9]:', prev.rows[9]?.map(c => c.raw).join(','));
      const newData = { ...prev };

      // Expand rows if needed
      const neededRows = row + 1;
      if (neededRows > prev.rows.length) {
        newData.rows = [...prev.rows];
        for (let r = prev.rows.length; r < neededRows; r++) {
          const newRow: Cell[] = [];
          for (let c = 0; c < prev.columnCount; c++) {
            newRow.push({ raw: '', computed: '' });
          }
          newData.rows.push(newRow);
        }
      } else {
        newData.rows = [...prev.rows];
      }

      // Expand columns if needed
      const neededCols = col + 1;
      if (neededCols > prev.columnCount) {
        newData.columnCount = neededCols;
        newData.rows = newData.rows.map(r => {
          const newRow = [...r];
          for (let c = r.length; c < neededCols; c++) {
            newRow.push({ raw: '', computed: '' });
          }
          return newRow;
        });
      }

      // Now update the specific cell
      newData.rows[row] = [...newData.rows[row]];
      const cell = createCell(value);
      if (isFormula(value)) {
        const { value: computed, error } = evaluateFormula(value, newData, row, col);
        cell.computed = computed;
        cell.error = error;
      }
      newData.rows[row][col] = cell;

      // Update headers array if editing header row
      if (row === 0 && newData.hasHeaders) {
        newData.headers = newData.rows[0].map(c => c.raw);
      }

      return recalculateFormulas(newData);
    });
    markDirty();
  }, [setData, markDirty]);

  // Add a row
  const addRow = useCallback((index?: number) => {
    setData(prev => {
      const newData = { ...prev };
      newData.rows = [...prev.rows];

      const newRow: Cell[] = [];
      for (let c = 0; c < newData.columnCount; c++) {
        newRow.push({ raw: '', computed: '' });
      }

      if (index !== undefined && index >= 0 && index <= newData.rows.length) {
        newData.rows.splice(index, 0, newRow);
      } else {
        newData.rows.push(newRow);
      }

      return newData;
    });
    markDirty();
  }, [setData, markDirty]);

  // Delete a row
  const deleteRow = useCallback((index: number) => {
    setData(prev => {
      if (prev.rows.length <= 1) return prev;

      const newData = { ...prev };
      newData.rows = [...prev.rows];
      newData.rows.splice(index, 1);

      return recalculateFormulas(newData);
    });
    markDirty();
  }, [setData, markDirty]);

  // Add a column
  const addColumn = useCallback((index?: number) => {
    setData(prev => {
      const newData = { ...prev };
      newData.rows = prev.rows.map(row => {
        const newRow = [...row];
        const newCell: Cell = { raw: '', computed: '' };

        if (index !== undefined && index >= 0 && index <= newRow.length) {
          newRow.splice(index, 0, newCell);
        } else {
          newRow.push(newCell);
        }

        return newRow;
      });
      newData.columnCount = newData.rows[0]?.length || 1;

      return newData;
    });
    markDirty();
  }, [setData, markDirty]);

  // Delete a column
  const deleteColumn = useCallback((index: number) => {
    setData(prev => {
      if (prev.columnCount <= 1) return prev;

      const newData = { ...prev };
      newData.rows = prev.rows.map(row => {
        const newRow = [...row];
        newRow.splice(index, 1);
        return newRow;
      });
      newData.columnCount = newData.rows[0]?.length || 1;

      return recalculateFormulas(newData);
    });
    markDirty();
  }, [setData, markDirty]);

  // Sort by column
  const sortByColumn = useCallback((columnIndex: number, direction: SortDirection) => {
    if (direction === null) {
      setSortConfig(null);
      return;
    }

    setData(prev => {
      const newData = { ...prev };
      const headerRowCount = newData.headerRowCount || 0;

      const headerRows = headerRowCount > 0 ? newData.rows.slice(0, headerRowCount) : [];
      const dataRows = headerRowCount > 0 ? newData.rows.slice(headerRowCount) : newData.rows;

      // Helper to check if a row is empty (all cells are empty strings)
      const isRowEmpty = (row: Cell[]): boolean => {
        return row.every(cell => cell.raw === '' && (cell.computed === '' || cell.computed === null));
      };

      // Separate non-empty rows from empty rows
      const nonEmptyRows = dataRows.filter(row => !isRowEmpty(row));
      const emptyRows = dataRows.filter(row => isRowEmpty(row));

      // Only sort the non-empty rows
      const sortedNonEmptyRows = [...nonEmptyRows].sort((a, b) => {
        const aVal = a[columnIndex]?.computed;
        const bVal = b[columnIndex]?.computed;

        // Handle empty values within non-empty rows
        const aEmpty = aVal === null || aVal === undefined || aVal === '';
        const bEmpty = bVal === null || bVal === undefined || bVal === '';

        if (aEmpty && bEmpty) return 0;
        if (aEmpty) return direction === 'asc' ? 1 : -1; // Empty values go to end in asc, start in desc
        if (bEmpty) return direction === 'asc' ? -1 : 1;

        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return direction === 'asc' ? aVal - bVal : bVal - aVal;
        }

        const result = String(aVal).localeCompare(String(bVal));
        return direction === 'asc' ? result : -result;
      });

      // Combine: header rows + sorted non-empty rows + empty rows at the end
      newData.rows = [...headerRows, ...sortedNonEmptyRows, ...emptyRows];
      return newData;
    });

    setSortConfig({ columnIndex, direction });
    markDirty();
  }, [setData, markDirty]);

  // Set header row count
  const setHeaderRowCount = useCallback((count: number) => {
    setData(prev => {
      const newData = { ...prev };
      const maxRows = newData.rows.length;
      const safeCount = Math.max(0, Math.min(count, maxRows));

      newData.headerRowCount = safeCount;
      newData.hasHeaders = safeCount > 0;

      if (safeCount > 0 && newData.rows.length > 0) {
        newData.headers = newData.rows[0].map(cell => cell.raw);
      } else {
        newData.headers = undefined;
      }

      return newData;
    });
    markDirty();
  }, [setData, markDirty]);

  // Set frozen column count
  const setFrozenColumnCount = useCallback((count: number) => {
    setData(prev => {
      const newData = { ...prev };
      const maxCols = newData.columnCount;
      const safeCount = Math.max(0, Math.min(count, maxCols));

      newData.frozenColumnCount = safeCount;

      return newData;
    });
    markDirty();
  }, [setData, markDirty]);

  // Set column format (null to clear/reset to default)
  const setColumnFormat = useCallback((columnIndex: number, format: ColumnFormat | null) => {
    console.log('[CSV setColumnFormat] Setting format for column', columnIndex, 'to:', format);
    setData(prev => {
      console.log('[CSV setColumnFormat] Previous formats:', prev.columnFormats);
      const newData = { ...prev };
      const newFormats = { ...newData.columnFormats };

      if (format === null) {
        // Remove the format (reset to default text)
        delete newFormats[columnIndex];
      } else {
        newFormats[columnIndex] = format;
      }

      console.log('[CSV setColumnFormat] New formats:', newFormats);
      newData.columnFormats = newFormats;
      return newData;
    });
    markDirty();
  }, [setData, markDirty]);

  // Toggle headers (legacy)
  const toggleHeaders = useCallback(() => {
    setData(prev => {
      const newData = { ...prev };
      const newCount = newData.headerRowCount > 0 ? 0 : 1;
      newData.headerRowCount = newCount;
      newData.hasHeaders = newCount > 0;

      if (newData.hasHeaders && newData.rows.length > 0) {
        newData.headers = newData.rows[0].map(cell => cell.raw);
      } else {
        newData.headers = undefined;
      }

      return newData;
    });
    markDirty();
  }, [setData, markDirty]);

  // Clear cells in selection
  const clearCells = useCallback((selection: NormalizedSelectionRange) => {
    console.log('[CSV clearCells] Clearing selection:', selection);
    setData(prev => {
      console.log('[CSV clearCells] prev rows[9]:', prev.rows[9]?.map(c => c.raw).join(','));
      const newData = { ...prev };
      newData.rows = prev.rows.map(row => [...row]);

      for (let r = selection.startRow; r <= selection.endRow; r++) {
        for (let c = selection.startCol; c <= selection.endCol; c++) {
          if (r < newData.rows.length && c < newData.columnCount) {
            newData.rows[r][c] = { raw: '', computed: '' };
          }
        }
      }

      console.log('[CSV clearCells] newData rows[9]:', newData.rows[9]?.map(c => c.raw).join(','));
      return recalculateFormulas(newData);
    });
    markDirty();
  }, [setData, markDirty]);

  // Copy selection to system clipboard
  const copySelection = useCallback((selection: NormalizedSelectionRange) => {
    const values: string[][] = [];
    for (let r = selection.startRow; r <= selection.endRow; r++) {
      const row: string[] = [];
      for (let c = selection.startCol; c <= selection.endCol; c++) {
        const cell = data.rows[r]?.[c];
        row.push(cell?.raw || '');
      }
      values.push(row);
    }

    // Copy to system clipboard as tab-delimited text
    const text = values.map(row => row.join('\t')).join('\n');
    copyToClipboard(text).catch(() => {
      // Clipboard access denied - nothing to do
    });
  }, [data.rows]);

  // Cut selection - copy to clipboard and clear cells immediately
  const cutSelection = useCallback((selection: NormalizedSelectionRange) => {
    // First copy the values
    const values: string[][] = [];
    for (let r = selection.startRow; r <= selection.endRow; r++) {
      const row: string[] = [];
      for (let c = selection.startCol; c <= selection.endCol; c++) {
        const cell = data.rows[r]?.[c];
        row.push(cell?.raw || '');
      }
      values.push(row);
    }

    // Copy to system clipboard
    const text = values.map(row => row.join('\t')).join('\n');
    copyToClipboard(text).catch(() => {
      // Clipboard access denied - nothing to do
    });

    // Clear the cells
    clearCells(selection);
  }, [data.rows, clearCells]);

  // Paste from text (system clipboard) - parses tab/newline delimited text
  const pasteFromText = useCallback((targetRow: number, targetCol: number, text: string) => {
    // Parse text as tab-delimited rows (Excel/Sheets format)
    const lines = text.split(/\r?\n/);

    const values = lines
      .filter(line => line.length > 0) // Skip empty lines
      .map(line => line.split('\t'));

    if (values.length === 0) {
      return;
    }

    setData(prev => {
      const newData = { ...prev };

      // Calculate needed dimensions
      const neededRows = targetRow + values.length;
      const neededCols = targetCol + Math.max(...values.map(row => row.length));

      // Expand rows if needed
      if (neededRows > prev.rows.length) {
        newData.rows = [...prev.rows];
        for (let r = prev.rows.length; r < neededRows; r++) {
          const newRow: Cell[] = [];
          for (let c = 0; c < Math.max(prev.columnCount, neededCols); c++) {
            newRow.push({ raw: '', computed: '' });
          }
          newData.rows.push(newRow);
        }
      } else {
        newData.rows = prev.rows.map(row => [...row]);
      }

      // Expand columns if needed
      if (neededCols > prev.columnCount) {
        newData.columnCount = neededCols;
        newData.rows = newData.rows.map(r => {
          const newRow = [...r];
          for (let c = r.length; c < neededCols; c++) {
            newRow.push({ raw: '', computed: '' });
          }
          return newRow;
        });
      }

      // Paste values
      for (let r = 0; r < values.length; r++) {
        const destRow = targetRow + r;

        for (let c = 0; c < values[r].length; c++) {
          const destCol = targetCol + c;

          const value = values[r][c];
          const cell = createCell(value);
          if (isFormula(value)) {
            const { value: computed, error } = evaluateFormula(value, newData, destRow, destCol);
            cell.computed = computed;
            cell.error = error;
          }
          newData.rows[destRow][destCol] = cell;
        }
      }

      return recalculateFormulas(newData);
    });

    markDirty();
  }, [setData, markDirty]);

  // Serialize to CSV (trims empty trailing rows/columns)
  const toCSV = useCallback(() => {
    const trimmedData = trimEmptyRowsAndColumns(data);
    return serializeToCSV(trimmedData, delimiter);
  }, [data, delimiter]);

  // Check if content matches what we last received from disk
  // Used to skip unnecessary reloads when file watcher fires after our own save
  const contentMatchesDisk = useCallback((content: string): boolean => {
    return content === lastKnownDiskContentRef.current;
  }, []);

  // Load from CSV (called when file is reloaded from disk, e.g., after AI edit)
  const loadFromCSV = useCallback((content: string) => {
    const parsed = parseCSV(content);
    // Recalculate formulas on the loaded data (same as initial load)
    const dataWithFormulas = recalculateFormulas(parsed.data);
    setDelimiter(parsed.delimiter);
    reset(dataWithFormulas);
    setIsDirty(false);
    setSortConfig(null);
    // Update our record of what's on disk
    lastKnownDiskContentRef.current = content;
  }, [reset]);

  // Update our record of what's on disk (called after save)
  const updateDiskContent = useCallback((content: string) => {
    lastKnownDiskContentRef.current = content;
  }, []);

  // Mark clean
  const markClean = useCallback(() => {
    setIsDirty(false);
    onDirtyChange?.(false);
  }, [onDirtyChange]);

  return {
    data,
    isDirty,
    delimiter,

    undo,
    redo,
    canUndo,
    canRedo,

    updateCell,
    addRow,
    deleteRow,
    addColumn,
    deleteColumn,
    sortByColumn,
    setHeaderRowCount,
    setFrozenColumnCount,
    setColumnFormat,
    toggleHeaders,

    copySelection,
    cutSelection,
    pasteFromText,
    clearCells,

    toCSV,
    loadFromCSV,
    markClean,
    contentMatchesDisk,
    updateDiskContent,

    sortConfig,
  };
}
