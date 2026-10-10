/**
 * Hook for spreadsheet metadata management (headers, frozen columns, formats)
 *
 * Cell data lives in RevoGrid. Every change to either goes through a command
 * (gridOperations / the command executor), which writes metadata through
 * `replaceMetadata` in the same step as the grid.
 */

import { useState, useCallback, useRef } from 'react';
import type { SortConfig, ColumnFormat, CellStyleRanges } from '../types';
import { DEFAULT_FILE_LAYOUT, detectFileLayout, parseCSV, resolveFileDelimiter, type CsvFileLayout } from '../utils/csvParser';
import { EMPTY_FORMATTING, formattingFromFile, pickFormatting, type SheetFormatting } from '../sheetMeta/formatting';

export interface SpreadsheetMetadata extends SheetFormatting {
  headerRowCount: number;
  frozenColumnCount: number;
  columnFormats: Record<number, ColumnFormat>;
  columnWidths: Record<number, number>;
  cellStyles: CellStyleRanges;
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

  /** The delimiter saves must use; current even before React re-renders. */
  getDelimiter: () => ',' | '\t';
  /** Line endings, final newline and metadata-line presence of the loaded file. */
  getFileLayout: () => CsvFileLayout;

  /**
   * Current metadata, synchronously. `metadata` is a render behind any change
   * made in this tick; commands read and write through this pair so a grid
   * change and its metadata change land together.
   */
  getMetadata: () => SpreadsheetMetadata;
  /** Replace the structural metadata (a command's result). Remote changes do not mark dirty. */
  replaceMetadata: (next: Omit<SpreadsheetMetadata, 'hasHeaders'>, origin: 'user' | 'agent' | 'remote') => void;

  /**
   * Adopt metadata a collaborator changed. Deliberately does not mark dirty:
   * the edit is already in the shared document, and flagging the file as
   * modified locally would make every collaborator's session claim unsaved
   * changes the moment anyone formatted a column.
   */
  applyRemoteMetadata: (patch: Partial<SpreadsheetMetadata>) => void;

  // Metadata changes go through commands (`replaceMetadata`); sort is view state.
  setSortConfig: (config: SortConfig | null) => void;

  // State management
  markDirty: () => void;
  markClean: () => void;

  // Disk content tracking (for external change detection)
  contentMatchesDisk: (content: string) => boolean;
  updateDiskContent: (content: string) => void;

  // Parse new content (for file reload)
  loadFromCSV: (content: string) => void;
}

const EMPTY_METADATA: SpreadsheetMetadata = {
  headerRowCount: 0,
  frozenColumnCount: 0,
  columnFormats: {},
  columnWidths: {},
  cellStyles: {},
  columnCount: 5,
  hasHeaders: false,
  ...EMPTY_FORMATTING,
};

/**
 * Content arrives later through `loadFromCSV`; the hook starts empty. The
 * file path only decides the delimiter of a file whose content cannot.
 */
export function useSpreadsheetMetadata(
  filePath: string,
  options: UseSpreadsheetMetadataOptions = {}
): UseSpreadsheetMetadataResult {
  const { onDirtyChange } = options;

  // Metadata state. Every write goes through `setMetadata`, which updates the
  // ref first so `getMetadata()` never lags a render behind.
  const [metadata, setMetadataState] = useState<SpreadsheetMetadata>(EMPTY_METADATA);
  const metadataRef = useRef<SpreadsheetMetadata>(EMPTY_METADATA);
  const setMetadata = useCallback((update: SpreadsheetMetadata | ((prev: SpreadsheetMetadata) => SpreadsheetMetadata)) => {
    const next = typeof update === 'function' ? update(metadataRef.current) : update;
    metadataRef.current = next;
    setMetadataState(next);
  }, []);
  // State for consumers that render it; the ref is what serialization reads,
  // so a save issued before React commits a reload still uses the new file's
  // delimiter.
  const [delimiter, setDelimiter] = useState<',' | '\t'>(() => resolveFileDelimiter('', filePath));
  const delimiterRef = useRef(delimiter);
  const layoutRef = useRef<CsvFileLayout>(DEFAULT_FILE_LAYOUT);
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // Track disk content for change detection
  const lastKnownDiskContentRef = useRef<string>('');

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

  const applyRemoteMetadata = useCallback((patch: Partial<SpreadsheetMetadata>) => {
    setMetadata(prev => {
      const next = { ...prev, ...patch };
      // `hasHeaders` is derived, so a remote header-row change has to carry it.
      if (patch.headerRowCount !== undefined) next.hasHeaders = patch.headerRowCount > 0;
      return next;
    });
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

    setMetadata({
      headerRowCount: data.headerRowCount,
      frozenColumnCount: data.frozenColumnCount,
      columnFormats: data.columnFormats,
      columnWidths: csvMetadata?.columnWidths ?? {},
      cellStyles: data.cellStyles,
      columnCount: data.columnCount,
      hasHeaders: data.hasHeaders,
      ...formattingFromFile(csvMetadata),
    });
    const nextDelimiter = resolveFileDelimiter(content, filePath);
    delimiterRef.current = nextDelimiter;
    layoutRef.current = detectFileLayout(content);
    setDelimiter(nextDelimiter);

    setSortConfig(null);
    setIsDirty(false);
    lastKnownDiskContentRef.current = content;
  }, [filePath]);

  const getDelimiter = useCallback(() => delimiterRef.current, []);
  const getFileLayout = useCallback(() => layoutRef.current, []);
  const getMetadata = useCallback(() => metadataRef.current, []);
  const replaceMetadata = useCallback((
    next: Omit<SpreadsheetMetadata, 'hasHeaders'>,
    origin: 'user' | 'agent' | 'remote',
  ) => {
    setMetadata({
      headerRowCount: next.headerRowCount,
      frozenColumnCount: next.frozenColumnCount,
      columnFormats: next.columnFormats,
      columnWidths: next.columnWidths,
      cellStyles: next.cellStyles,
      columnCount: next.columnCount,
      hasHeaders: next.headerRowCount > 0,
      ...pickFormatting(next),
    });
    if (origin !== 'remote') markDirty();
  }, [setMetadata, markDirty]);

  return {
    metadata,
    delimiter,
    getDelimiter,
    getFileLayout,
    getMetadata,
    replaceMetadata,
    sortConfig,
    isDirty,
    applyRemoteMetadata,
    setSortConfig,
    markDirty,
    markClean,
    contentMatchesDisk,
    updateDiskContent,
    loadFromCSV,
  };
}
