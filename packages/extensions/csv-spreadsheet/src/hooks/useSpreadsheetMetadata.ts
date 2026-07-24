/**
 * Hook for spreadsheet metadata management (headers, frozen columns, formats)
 *
 * This hook manages ONLY metadata - cell data is owned by RevoGrid.
 * Use gridOperations for cell data operations.
 */

import { useState, useCallback, useRef, useMemo } from 'react';
import type { SortConfig, ColumnFormat, CSVMetadata } from '../types';
import { parseCSV, serializeMetadata } from '../utils/csvParser';

export interface SpreadsheetMetadata {
  headerRowCount: number;
  frozenColumnCount: number;
  columnFormats: Record<number, ColumnFormat>;
  columnWidths: Record<number, number>;
  columnCount: number;
  hasHeaders: boolean;
}

export interface UseSpreadsheetMetadataOptions {
  onDirtyChange?: (isDirty: boolean) => void;
}

export interface UseSpreadsheetMetadataResult {
  // Metadata
  metadata: SpreadsheetMetadata;
  delimiter: ',' | '\t';
  sortConfig: SortConfig | null;
  isDirty: boolean;

  // Initial data for grid (only used on first render)
  initialSource: Record<string, string | number>[];
  initialPinnedTop: Record<string, string | number>[];

  // Metadata mutations
  setHeaderRowCount: (count: number) => void;
  setFrozenColumnCount: (count: number) => void;
  setColumnFormat: (columnIndex: number, format: ColumnFormat | null) => void;
  setColumnWidth: (columnIndex: number, width: number) => void;
  setColumnCount: (count: number) => void;
  setSortConfig: (config: SortConfig | null) => void;

  // State management
  markDirty: () => void;
  markClean: () => void;

  // Disk content tracking (for external change detection)
  contentMatchesDisk: (content: string) => boolean;
  updateDiskContent: (content: string) => void;

  // Parse new content (for file reload)
  loadFromCSV: (content: string) => {
    source: Record<string, string | number>[];
    pinnedTop: Record<string, string | number>[];
  };

  // Serialize metadata for saving (combined with CSV content from grid)
  serializeMetadataForSave: () => string;
}

/**
 * Convert parsed CSV rows to RevoGrid source format
 */
function toGridSource(
  rows: { raw: string; computed: string | number | null; error?: string }[][],
  headerRowCount: number,
  bufferRows: number = 20,
  bufferCols: number = 20
): { source: Record<string, string | number>[]; pinnedTop: Record<string, string | number>[] } {
  const columnCount = rows[0]?.length ?? 0;
  const displayColumnCount = columnCount + bufferCols;

  // Helper to convert column index to letter
  function columnIndexToLetter(index: number): string {
    let letter = '';
    let n = index;
    while (n >= 0) {
      letter = String.fromCharCode((n % 26) + 65) + letter;
      n = Math.floor(n / 26) - 1;
    }
    return letter;
  }

  // Pinned (header) rows
  const pinnedTop: Record<string, string | number>[] = [];
  for (let rowIndex = 0; rowIndex < headerRowCount && rowIndex < rows.length; rowIndex++) {
    const rowData: Record<string, string | number> = {};
    const row = rows[rowIndex];
    for (let c = 0; c < displayColumnCount; c++) {
      const colKey = columnIndexToLetter(c);
      const cell = row?.[c];
      if (cell?.error) {
        rowData[colKey] = cell.error;
      } else if (cell?.computed !== null && cell?.computed !== undefined) {
        rowData[colKey] = cell.computed;
      } else {
        rowData[colKey] = cell?.raw || '';
      }
    }
    rowData._rowClass = 'header-row';
    pinnedTop.push(rowData);
  }

  // Regular (data) rows
  const dataRows = rows.slice(headerRowCount);
  const displayRowCount = dataRows.length + bufferRows;
  const source: Record<string, string | number>[] = [];

  for (let rowIndex = 0; rowIndex < displayRowCount; rowIndex++) {
    const rowData: Record<string, string | number> = {};
    const row = dataRows[rowIndex];
    for (let c = 0; c < displayColumnCount; c++) {
      const colKey = columnIndexToLetter(c);
      const cell = row?.[c];
      if (cell?.error) {
        rowData[colKey] = cell.error;
      } else if (cell?.computed !== null && cell?.computed !== undefined) {
        rowData[colKey] = cell.computed;
      } else {
        rowData[colKey] = cell?.raw || '';
      }
    }
    source.push(rowData);
  }

  return { source, pinnedTop };
}

/**
 * Create empty grid data for new files
 */
function createEmptyGridData(
  rowCount: number = 10,
  columnCount: number = 5,
  bufferRows: number = 20,
  bufferCols: number = 20
): { source: Record<string, string | number>[]; pinnedTop: Record<string, string | number>[] } {
  const displayColumnCount = columnCount + bufferCols;
  const displayRowCount = rowCount + bufferRows;

  function columnIndexToLetter(index: number): string {
    let letter = '';
    let n = index;
    while (n >= 0) {
      letter = String.fromCharCode((n % 26) + 65) + letter;
      n = Math.floor(n / 26) - 1;
    }
    return letter;
  }

  const source: Record<string, string | number>[] = [];
  for (let r = 0; r < displayRowCount; r++) {
    const rowData: Record<string, string | number> = {};
    for (let c = 0; c < displayColumnCount; c++) {
      rowData[columnIndexToLetter(c)] = '';
    }
    source.push(rowData);
  }

  return { source, pinnedTop: [] };
}

export function useSpreadsheetMetadata(
  initialContent: string,
  _filePath: string,
  options: UseSpreadsheetMetadataOptions = {}
): UseSpreadsheetMetadataResult {
  const { onDirtyChange } = options;

  // Parse initial content
  const initialParsed = useMemo(() => {
    if (!initialContent) {
      return {
        metadata: {
          headerRowCount: 0,
          frozenColumnCount: 0,
          columnFormats: {} as Record<number, ColumnFormat>,
          columnWidths: {} as Record<number, number>,
          columnCount: 5,
          hasHeaders: false,
        },
        delimiter: ',' as const,
        gridData: createEmptyGridData(),
      };
    }

    const { data, delimiter, metadata: csvMetadata } = parseCSV(initialContent);
    const gridData = toGridSource(data.rows, data.headerRowCount);

    return {
      metadata: {
        headerRowCount: data.headerRowCount,
        frozenColumnCount: data.frozenColumnCount,
        columnFormats: data.columnFormats,
        columnWidths: csvMetadata?.columnWidths ?? {},
        columnCount: data.columnCount,
        hasHeaders: data.hasHeaders,
      },
      delimiter,
      gridData,
    };
  }, []); // Only run once on mount

  // Metadata state
  const [metadata, setMetadata] = useState<SpreadsheetMetadata>(initialParsed.metadata);
  const [delimiter] = useState<',' | '\t'>(initialParsed.delimiter);
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // Initial grid data (only used on first render)
  const initialGridDataRef = useRef(initialParsed.gridData);

  // Track disk content for change detection
  const lastKnownDiskContentRef = useRef<string>(initialContent);

  // Dirty state management
  const markDirty = useCallback(() => {
    if (!isDirty) {
      setIsDirty(true);
      onDirtyChange?.(true);
    }
  }, [isDirty, onDirtyChange]);

  const markClean = useCallback(() => {
    setIsDirty(false);
    onDirtyChange?.(false);
  }, [onDirtyChange]);

  // Metadata mutations
  const setHeaderRowCount = useCallback((count: number) => {
    setMetadata(prev => ({
      ...prev,
      headerRowCount: Math.max(0, count),
      hasHeaders: count > 0,
    }));
    markDirty();
  }, [markDirty]);

  const setFrozenColumnCount = useCallback((count: number) => {
    setMetadata(prev => ({
      ...prev,
      frozenColumnCount: Math.max(0, Math.min(count, prev.columnCount)),
    }));
    markDirty();
  }, [markDirty]);

  const setColumnFormat = useCallback((columnIndex: number, format: ColumnFormat | null) => {
    setMetadata(prev => {
      const newFormats = { ...prev.columnFormats };
      if (format === null) {
        delete newFormats[columnIndex];
      } else {
        newFormats[columnIndex] = format;
      }
      return { ...prev, columnFormats: newFormats };
    });
    markDirty();
  }, [markDirty]);

  const setColumnWidth = useCallback((columnIndex: number, width: number) => {
    setMetadata(prev => {
      const newWidths = { ...prev.columnWidths };
      newWidths[columnIndex] = width;
      return { ...prev, columnWidths: newWidths };
    });
    markDirty();
  }, [markDirty]);

  const setColumnCount = useCallback((count: number) => {
    setMetadata(prev => ({
      ...prev,
      columnCount: Math.max(1, count),
    }));
  }, []);

  // Disk content tracking
  const contentMatchesDisk = useCallback((content: string): boolean => {
    return content === lastKnownDiskContentRef.current;
  }, []);

  const updateDiskContent = useCallback((content: string) => {
    lastKnownDiskContentRef.current = content;
  }, []);

  // Load new content (for file reload)
  const loadFromCSV = useCallback((content: string) => {
    const { data, metadata: csvMetadata } = parseCSV(content);
    const gridData = toGridSource(data.rows, data.headerRowCount);

    setMetadata({
      headerRowCount: data.headerRowCount,
      frozenColumnCount: data.frozenColumnCount,
      columnFormats: data.columnFormats,
      columnWidths: csvMetadata?.columnWidths ?? {},
      columnCount: data.columnCount,
      hasHeaders: data.hasHeaders,
    });

    setSortConfig(null);
    setIsDirty(false);
    lastKnownDiskContentRef.current = content;

    return gridData;
  }, []);

  // Serialize metadata for saving
  const serializeMetadataForSave = useCallback((): string => {
    const hasColumnFormats = Object.keys(metadata.columnFormats).length > 0;
    const hasColumnWidths = Object.keys(metadata.columnWidths).length > 0;
    const csvMetadata: CSVMetadata = {
      hasHeaders: metadata.hasHeaders,
      headerRowCount: metadata.headerRowCount,
      frozenColumnCount: metadata.frozenColumnCount,
      ...(hasColumnFormats ? { columnFormats: metadata.columnFormats } : {}),
      ...(hasColumnWidths ? { columnWidths: metadata.columnWidths } : {}),
    };
    return serializeMetadata(csvMetadata);
  }, [metadata]);

  return {
    metadata,
    delimiter,
    sortConfig,
    isDirty,
    initialSource: initialGridDataRef.current.source,
    initialPinnedTop: initialGridDataRef.current.pinnedTop,
    setHeaderRowCount,
    setFrozenColumnCount,
    setColumnFormat,
    setColumnWidth,
    setColumnCount,
    setSortConfig,
    markDirty,
    markClean,
    contentMatchesDisk,
    updateDiskContent,
    loadFromCSV,
    serializeMetadataForSave,
  };
}
