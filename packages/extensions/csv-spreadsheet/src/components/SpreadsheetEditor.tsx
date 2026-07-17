/**
 * SpreadsheetEditor Component
 *
 * The main editor component for CSV files. Integrates with Nimbalyst's
 * custom editor system and provides a spreadsheet-like editing experience.
 *
 * Architecture:
 * - RevoGrid is the single source of truth for cell data
 * - useSpreadsheetMetadata manages only metadata (headers, frozen cols, formats)
 * - UndoRedoPlugin handles undo/redo via RevoGrid events
 * - gridOperations provides centralized cell operations
 */

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { RevoGrid, type RevoGridCustomEvent, type ColumnRegular } from '@revolist/react-datagrid';
import type { RevoGridElement } from '../revogrid-types';
import type { EditorHostProps, NormalizedSelectionRange, ColumnFormat, DiffState, CellDiff } from '../types';
import {
  useEditorLifecycle,
  useCollaborativeEditor,
  readClipboard,
  type DiffConfig,
} from '@nimbalyst/extension-sdk';
import { CsvBinding } from '../collab/csvBinding';
import { isCsvYDocEmpty, seedCsvYDoc, getYCsv } from '../collab/seed';
import { useSpreadsheetMetadata } from '../hooks/useSpreadsheetMetadata';
import { createGridOperations, type GridOperations } from '../utils/gridOperations';
import { UndoRedoPlugin } from '../plugins/UndoRedoPlugin';
import { columnIndexToLetter, columnLetterToIndex, generateColumnHeaders, parseCSV } from '../utils/csvParser';
import { computeDiff, getCellDiffClass, getCellPreviousValue } from '../utils/diffCompute';
import { isFormula } from '../utils/formulaEngine';
import { formatCellValue, getColumnTypeName } from '../utils/formatters';
import { FormulaBar, type FormulaBarHandle } from './FormulaBar';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { ColumnFormatDialog } from './ColumnFormatDialog';
import { SheetsTextEditor } from '../editors/SheetsTextEditor';

// Buffer of extra empty rows/columns to show beyond actual data
const DISPLAY_BUFFER_ROWS = 20;
const DISPLAY_BUFFER_COLS = 20;

/**
 * Format a selection range as a cell reference string (e.g., "A1" or "A1:C5")
 */
function formatSelectionRef(selection: NormalizedSelectionRange | null): string {
  if (!selection) return '';

  const startRef = `${columnIndexToLetter(selection.startCol)}${selection.startRow + 1}`;

  if (selection.startRow === selection.endRow && selection.startCol === selection.endCol) {
    return startRef;
  }

  const endRef = `${columnIndexToLetter(selection.endCol)}${selection.endRow + 1}`;
  return `${startRef}:${endRef}`;
}

/**
 * Get CSS class for column alignment based on format type
 */
function getColumnAlignmentClass(format: ColumnFormat | undefined): string {
  if (!format) return '';
  switch (format.type) {
    case 'number':
    case 'currency':
    case 'percentage':
      return 'cell-align-right';
    case 'date':
      return 'cell-align-center';
    case 'text':
    default:
      return '';
  }
}

/**
 * Generate column definitions for RevoGrid
 */
function generateColumns(
  columnCount: number,
  frozenColumnCount: number = 0,
  columnFormats: Record<number, ColumnFormat> = {},
  columnWidths: Record<number, number> = {},
  diffState: DiffState | null = null
): ColumnRegular[] {
  const columnHeaders = generateColumnHeaders(columnCount);
  const DEFAULT_COLUMN_WIDTH = 120;

  return columnHeaders.map((letter, index) => {
    const format = columnFormats[index];
    const alignClass = getColumnAlignmentClass(format);
    const width = columnWidths[index] ?? DEFAULT_COLUMN_WIDTH;

    const needsDisplayFormat =
      format && (format.type === 'currency' || format.type === 'percentage' || format.type === 'number');

    return {
      prop: letter,
      name: letter,
      size: width,
      editor: 'sheets',
      ...(index < frozenColumnCount ? { pin: 'colPinStart' as const } : {}),
      ...(needsDisplayFormat
        ? {
            // Format display only; edit mode reads the raw source value via editCell.val,
            // so source data is unchanged and double-click editing shows the unformatted number.
            cellTemplate: (h, props) => {
              const raw = props.model?.[props.prop as string];
              const value = typeof raw === 'string' || typeof raw === 'number' ? raw : null;
              return h('span', {}, formatCellValue(value, format));
            },
          }
        : {}),
      cellProperties: (cellData: { model: Record<string, unknown>; rowIndex: number }) => {
        const classes: Record<string, boolean> = {};

        // Apply alignment class
        if (alignClass) {
          classes[alignClass] = true;
        }

        // Detect if this is a pinned (header) row by checking for header-row class
        const isPinned = cellData.model._rowClass === 'header-row';

        // Apply diff class if in diff mode
        if (diffState?.isActive) {
          const diffClass = getCellDiffClass(diffState, cellData.rowIndex, letter, isPinned);
          if (diffClass) {
            classes[diffClass] = true;
          }
        }

        // Build props object
        const props: { class?: Record<string, boolean>; title?: string } = {};
        if (Object.keys(classes).length > 0) {
          props.class = classes;
        }

        // Add tooltip for previous value on modified/deleted cells
        if (diffState?.isActive) {
          const previousValue = getCellPreviousValue(diffState, cellData.rowIndex, letter, isPinned);
          if (previousValue !== undefined) {
            props.title = `Previous: ${previousValue}`;
          }
        }

        return props;
      },
    };
  });
}

/**
 * Normalize selection range
 */
function normalizeRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): NormalizedSelectionRange {
  return {
    startRow: Math.min(startRow, endRow),
    startCol: Math.min(startCol, endCol),
    endRow: Math.max(startRow, endRow),
    endCol: Math.max(startCol, endCol),
  };
}

export function SpreadsheetEditor({ host }: EditorHostProps) {
  const { filePath, isActive } = host;

  // Reactive read-only state. In read-only mode (inline embeds, share
  // viewer) we hide the formula-bar toolbar, suppress the right-click
  // editing context menu, and pass `readonly` through to RevoGrid so cells
  // can't be edited. Selection, scrolling, and copy still work.
  const [readOnly, setReadOnly] = useState<boolean>(host.readOnly ?? false);
  useEffect(() => {
    setReadOnly(host.readOnly ?? false);
    return host.onReadOnlyChanged?.((next) => {
      setReadOnly(next);
    });
  }, [host]);

  // Metadata hook (manages headers, frozen cols, formats - NOT cell data)
  const spreadsheetMeta = useSpreadsheetMetadata('', filePath, {
    onDirtyChange: host.setDirty,
  });

  // Refs
  const editorRef = useRef<HTMLDivElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const revoGridRef = useRef<RevoGridElement | null>(null);
  const formulaBarRef = useRef<FormulaBarHandle>(null);
  const undoPluginRef = useRef<UndoRedoPlugin | null>(null);
  const gridOpsRef = useRef<GridOperations | null>(null);

  // Ref for spreadsheetMeta so callbacks stay current
  const spreadsheetMetaRef = useRef(spreadsheetMeta);
  spreadsheetMetaRef.current = spreadsheetMeta;
  const hostRef = useRef(host);
  hostRef.current = host;

  // Selection state (refs to avoid re-renders)
  const selectedCellRef = useRef<{ row: number; col: number } | null>(null);
  const selectionRangeRef = useRef<NormalizedSelectionRange | null>(null);
  const skipFocusHandlerRef = useRef(false); // Flag to skip focus handler during programmatic selection

  // Grid initialization - render grid immediately, load data imperatively after mount
  // This avoids React props overwriting RevoGrid's internal state on re-renders
  const pendingDataRef = useRef<{ source: Record<string, string | number>[]; pinnedTop: Record<string, string | number>[] } | null>(null);
  const dataLoadedRef = useRef(false);
  const loadedCsvContentRef = useRef('');

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    isRowHeader: boolean;
    rowIndex: number | null;
    isColumnHeader: boolean;
    colIndex: number | null;
  } | null>(null);

  // Header drag selection state
  const [headerDrag, setHeaderDrag] = useState<{
    type: 'row' | 'column';
    startIndex: number;
    currentIndex: number;
  } | null>(null);
  const headerDragRef = useRef(headerDrag);
  headerDragRef.current = headerDrag;

  // Column format dialog state
  const [formatDialogColumn, setFormatDialogColumn] = useState<number | null>(null);

  // Diff mode state for AI edit review
  const [diffState, setDiffState] = useState<DiffState | null>(null);

  // Ref for diffState so callbacks stay current
  const diffStateRef = useRef(diffState);
  diffStateRef.current = diffState;

  // ---- EditorHost lifecycle (loading, echo detection, file changes, save, theme) ----
  const { isLoading, error: loadError, theme, markDirty: _markDirty } = useEditorLifecycle(host, {
    applyContent: (content: string) => {
      // Collab guard (NIM-1529): once the collab binding is active the Y.Doc
      // owns the content. A reopen of a shared doc has no file bytes, so the
      // lifecycle loads '' here -- applying it would blank pendingDataRef
      // after the binding already staged the synced content, and the next
      // grid->Y.Text poll would push a delete-all into the shared room.
      if (collabActiveRef.current && !content) {
        return;
      }
      loadedCsvContentRef.current = content;
      // Parse CSV and set RevoGrid source imperatively
      const { data } = parseCSV(content);
      const gridData = convertToGridSource(data.rows, data.headerRowCount);

      // Store data to be loaded imperatively once grid is mounted
      pendingDataRef.current = gridData;

      // If grid already mounted, load immediately
      const grid = revoGridRef.current;
      if (grid) {
        grid.source = gridData.source;
        grid.pinnedTopSource = gridData.pinnedTop;
        dataLoadedRef.current = true;
      }

      // Update metadata
      spreadsheetMetaRef.current.loadFromCSV(content);
      spreadsheetMetaRef.current.markClean();
    },
    onExternalChange: () => {
      // Clear diff state when file changes externally (e.g., after accept/reject)
      if (diffStateRef.current?.isActive) {
        // console.log('[CSV] Clearing diff state after file change');
        setDiffState(null);
      }
    },
    onSave: async () => {
      const gridOps = gridOpsRef.current;
      if (!gridOps) {
        console.warn('[CSV] Grid operations not available for save');
        return;
      }

      // Generate CSV from RevoGrid's current data
      const content = await gridOps.toCSV();

      // Update disk content tracking for echo detection
      spreadsheetMetaRef.current.updateDiskContent(content);
      spreadsheetMetaRef.current.markClean();

      // Save to disk
      await host.saveContent(content);
      // console.log('[CSV] Saved');
    },
    onDiffRequested: (config: DiffConfig) => {
      // console.log('[CSV] Diff requested:', config.tagId);

      // Compute cell-level diff between original and modified content
      const diff = computeDiff(
        config.originalContent,
        config.modifiedContent,
        config.tagId,
        config.sessionId
      );

      // Parse the modified content to get the actual data to display
      const { data: modifiedData } = parseCSV(config.modifiedContent);
      const gridData = convertToGridSource(modifiedData.rows, modifiedData.headerRowCount);

      // Update grid with modified content so the new data is visible
      const grid = revoGridRef.current;
      if (grid) {
        const actualDataRowCount = modifiedData.rows.length - modifiedData.headerRowCount;

        // If there are phantom rows (deleted rows), insert them at their correct positions
        if (diff.phantomRows.length > 0) {
          const dataRows = gridData.source.slice(0, actualDataRowCount);
          const bufferRows = gridData.source.slice(actualDataRowCount);

          type RowEntry = { row: Record<string, string | number>; isPhantom: boolean; position: number };
          const entries: RowEntry[] = [];

          for (let i = 0; i < dataRows.length; i++) {
            entries.push({ row: dataRows[i], isPhantom: false, position: i });
          }

          for (let i = 0; i < diff.phantomRows.length; i++) {
            const phantomRow = diff.phantomRows[i];
            const position = diff.phantomRowPositions[i] - modifiedData.headerRowCount;

            const rowData: Record<string, string | number> = {};
            phantomRow.forEach((cell, colIdx) => {
              const colKey = columnIndexToLetter(colIdx);
              rowData[colKey] = cell.raw || '';
            });
            rowData._rowClass = 'row-diff-deleted';
            entries.push({ row: rowData, isPhantom: true, position: position + 0.5 });
          }

          entries.sort((a, b) => a.position - b.position);

          const indexMapping = new Map<number, number>();
          let gridIdx = 0;
          for (const entry of entries) {
            if (!entry.isPhantom) {
              indexMapping.set(Math.floor(entry.position), gridIdx);
            }
            gridIdx++;
          }

          const newCells = new Map<string, CellDiff>();
          for (const [key, value] of diff.cells.entries()) {
            if (key.startsWith('data:')) {
              const parts = key.split(':');
              const oldIdx = parseInt(parts[1], 10);
              const colProp = parts[2];
              const newIdx = indexMapping.get(oldIdx);
              if (newIdx !== undefined) {
                newCells.set(`data:${newIdx}:${colProp}`, value);
              }
            } else {
              newCells.set(key, value);
            }
          }

          gridIdx = 0;
          for (const entry of entries) {
            if (entry.isPhantom) {
              const rowData = entry.row;
              for (const [key, value] of Object.entries(rowData)) {
                if (key !== '_rowClass' && value !== '') {
                  newCells.set(`data:${gridIdx}:${key}`, {
                    type: 'deleted',
                    previousValue: String(value),
                  });
                }
              }
            }
            gridIdx++;
          }

          diff.cells.clear();
          for (const [key, value] of newCells.entries()) {
            diff.cells.set(key, value);
          }

          const finalDataRows = entries.map(e => e.row);
          grid.source = [...finalDataRows, ...bufferRows];
        } else {
          grid.source = gridData.source;
        }
        grid.pinnedTopSource = gridData.pinnedTop;
      }

      spreadsheetMetaRef.current.loadFromCSV(config.modifiedContent);
      setDiffState(diff);
    },
    onDiffCleared: async () => {
      // console.log('[CSV] Diff cleared externally');
      setDiffState(null);

      // Reload content from disk to remove phantom rows
      try {
        const content = await host.loadContent();
        const { data } = parseCSV(content);
        const gridData = convertToGridSource(data.rows, data.headerRowCount);

        const grid = revoGridRef.current;
        if (grid) {
          grid.source = gridData.source;
          grid.pinnedTopSource = gridData.pinnedTop;
        }

        spreadsheetMetaRef.current.loadFromCSV(content);
        spreadsheetMetaRef.current.markClean();
      } catch (error) {
        console.error('[CSV] Failed to reload content after diff cleared:', error);
      }
    },
  });

  // ---- Collaborative wiring (no-op when host.collaboration is undefined) ---
  // CSV uses a single Y.Text for the whole document (see csvBinding.ts for
  // the reasoning). Local edits are pushed via a debounced poll because
  // RevoGrid lacks a single "any mutation" event to hook into. Remote
  // Y.Text changes flow back through the existing applyContent path so
  // every existing format/header/metadata invariant is preserved.
  const collabBindingRef = useRef<CsvBinding | null>(null);
  const collabActiveRef = useRef(false);
  const { isCollaborative: isCollabActive } = useCollaborativeEditor(host, {
    isEmpty: isCsvYDocEmpty,
    initializeFromContent: seedCsvYDoc,
    createBinding: ({ yDoc, awareness }) => {
      const applyCsvContent = (content: string) => {
        loadedCsvContentRef.current = content;
        const { data } = parseCSV(content);
        const gridData = convertToGridSource(data.rows, data.headerRowCount);
        // Stash for the deferred ref-callback path. The collab createBinding
        // can fire applyCsvContent before the grid is mounted -- if so, the
        // ref callback's pendingDataRef branch is what populates the grid on
        // mount. Without this, an earlier lifecycle applyContent('') wins by
        // leaving an empty pendingDataRef in place and the reopened tab
        // comes back blank.
        pendingDataRef.current = gridData;
        const grid = revoGridRef.current;
        if (grid) {
          grid.source = gridData.source;
          grid.pinnedTopSource = gridData.pinnedTop;
          dataLoadedRef.current = true;
        }
        spreadsheetMetaRef.current.loadFromCSV(content);
        spreadsheetMetaRef.current.markClean();
      };

      // Initial baseline = whatever Y.Text already has (the seed we just
      // wrote OR the content sync'd from another client).
      const initial = getYCsv(yDoc).toString();
      const binding = new CsvBinding(
        yDoc,
        initial,
        {
          getCurrentCsv: async () => {
            const gridOps = gridOpsRef.current;
            if (!gridOps) return loadedCsvContentRef.current || initial;
            return await gridOps.toCSV();
          },
          onRemoteContent: (content: string) => {
            // Route through the same applyContent path the host uses for
            // external file changes. The grid is reloaded; metadata gets
            // re-parsed; selection survives if the cell still exists.
            applyCsvContent(content);
            collabBindingRef.current?.noteAppliedRemote(content);
          },
        },
        awareness,
      );
      collabBindingRef.current = binding;
      // Recipient opens commonly mount with `host.loadContent() === ''` and
      // rely on the already-synced Y.Text as the first real payload. Consume
      // that snapshot immediately; otherwise there may be no subsequent remote
      // change event to wake the grid up from its blank local fallback.
      if (initial.length > 0) {
        applyCsvContent(initial);
        binding.noteAppliedRemote(initial);
      } else if (loadedCsvContentRef.current.length > 0) {
        // First-share opens can render from host.loadContent() before the Y.Text
        // has been populated. Push that already-loaded local CSV immediately so a
        // close/reopen does not depend on the poll interval or unmount flush.
        void binding.syncNow().catch((error) => {
          console.error('[SpreadsheetEditor] Failed to push initial local CSV to collab doc:', error);
        });
      }
      collabActiveRef.current = true;
      return {
        destroy: () => {
          // Flush any pending sync so a closing tab doesn't drop the last
          // edit. Fire-and-forget; the binding is about to be destroyed
          // either way.
          void binding.syncNow().catch(() => {});
          binding.destroy();
          collabBindingRef.current = null;
          collabActiveRef.current = false;
        },
      };
    },
  });

  // Forward local edits into the Y.Text. RevoGrid has no single "data
  // mutation" event we can hook, so we poll on a 1s cadence. The binding's
  // internal diff check is the actual sync gate -- when content hasn't
  // changed, syncNow is a quick string-compare + no Y.Text writes.
  useEffect(() => {
    if (!isCollabActive) return;
    const id = setInterval(() => {
      collabBindingRef.current?.scheduleSync();
    }, 1000);
    return () => clearInterval(id);
  }, [isCollabActive]);

  // Publish selection/edit cell to awareness.
  useEffect(() => {
    if (!isCollabActive) return;
    const binding = collabBindingRef.current;
    if (!binding) return;
    const sel = selectedCellRef.current ?? null;
    binding.setLocalAwareness({ selectedCell: sel, editingCell: sel });
  }, [isCollabActive]);

  // Stable editors object
  const editors = useMemo(() => ({ sheets: SheetsTextEditor }), []);

  // Display dimensions
  const displayColumnCount = spreadsheetMeta.metadata.columnCount + DISPLAY_BUFFER_COLS;
  const frozenColumnCount = spreadsheetMeta.metadata.frozenColumnCount;
  const columnFormats = spreadsheetMeta.metadata.columnFormats;
  const columnWidths = spreadsheetMeta.metadata.columnWidths;
  const headerRowCount = spreadsheetMeta.metadata.headerRowCount;

  // Memoized column definitions
  const columns = useMemo(
    () => generateColumns(displayColumnCount, frozenColumnCount, columnFormats, columnWidths, diffState),
    [displayColumnCount, frozenColumnCount, columnFormats, columnWidths, diffState]
  );

  // Note: We don't use RevoGrid's built-in themes (default/darkCompact) because
  // they apply hardcoded colors that override our CSS variables.
  // Instead, we rely entirely on our CSS that maps --revo-* to --nim-* variables.

  // Initialize grid operations once for this mounted grid. The host and metadata
  // objects can be recreated by parent renders, but rebuilding the plugin here
  // would discard its undo/redo stacks.
  useEffect(() => {
    const grid = revoGridRef.current;
    if (isLoading || !grid) return;

    let plugin: UndoRedoPlugin | null = null;
    let cancelled = false;

    // Create undo plugin (get providers asynchronously)
    grid.getProviders()
      .then((providers) => {
        if (cancelled || revoGridRef.current !== grid) return;
        plugin = new UndoRedoPlugin(grid, providers || {} as any, {
          onStateChange: () => {
            // Could update UI here if needed
          },
        });
        undoPluginRef.current = plugin;
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('[CSV] Failed to initialize undo/redo:', error);
        }
      });

    // Create grid operations - use getter to access undoPlugin dynamically
    const gridOps = createGridOperations(revoGridRef, {
      getHeaderRowCount: () => spreadsheetMetaRef.current.metadata.headerRowCount,
      getColumnCount: () => spreadsheetMetaRef.current.metadata.columnCount,
      setColumnCount: (count) => spreadsheetMetaRef.current.setColumnCount(count),
      getDelimiter: () => spreadsheetMetaRef.current.delimiter,
      getColumnFormats: () => spreadsheetMetaRef.current.metadata.columnFormats,
      getColumnWidths: () => spreadsheetMetaRef.current.metadata.columnWidths,
      getFrozenColumnCount: () => spreadsheetMetaRef.current.metadata.frozenColumnCount,
      onDirty: () => hostRef.current.setDirty(true),
      getUndoPlugin: () => undoPluginRef.current,
    });
    gridOpsRef.current = gridOps;

    return () => {
      cancelled = true;
      if (plugin) {
        plugin.destroy();
      }
      if (undoPluginRef.current === plugin) {
        undoPluginRef.current = null;
      }
      if (gridOpsRef.current === gridOps) {
        gridOpsRef.current = null;
      }
    };
  }, [isLoading]);

  // (Loading, saving, file changes, echo detection, diff mode are all handled by useEditorLifecycle above)

  // Register for AI tool access
  useEffect(() => {
    // Create a compatibility layer for AI tools
    const compatStore = {
      data: {
        rows: [], // Would need to read from grid
        columnCount: spreadsheetMeta.metadata.columnCount,
        headerRowCount: spreadsheetMeta.metadata.headerRowCount,
        hasHeaders: spreadsheetMeta.metadata.hasHeaders,
        frozenColumnCount: spreadsheetMeta.metadata.frozenColumnCount,
        columnFormats: spreadsheetMeta.metadata.columnFormats,
      },
      isDirty: spreadsheetMeta.isDirty,
      delimiter: spreadsheetMeta.delimiter,
      // Note: AI tools integration would need updates to work with new architecture
    };
    host.registerEditorAPI(compatStore);
    return () => {
      host.registerEditorAPI(null);
    };
  }, [filePath, spreadsheetMeta]);

  /**
   * Convert parsed CSV rows to RevoGrid source format
   */
  function convertToGridSource(
    rows: { raw: string; computed: string | number | null; error?: string }[][],
    headerRowCount: number
  ): { source: Record<string, string | number>[]; pinnedTop: Record<string, string | number>[] } {
    const columnCount = rows[0]?.length ?? 0;

    // Pinned (header) rows
    const pinnedTop: Record<string, string | number>[] = [];
    for (let rowIndex = 0; rowIndex < headerRowCount && rowIndex < rows.length; rowIndex++) {
      const rowData: Record<string, string | number> = {};
      const row = rows[rowIndex];
      for (let c = 0; c < columnCount + DISPLAY_BUFFER_COLS; c++) {
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
    const source: Record<string, string | number>[] = [];

    for (let rowIndex = 0; rowIndex < dataRows.length + DISPLAY_BUFFER_ROWS; rowIndex++) {
      const rowData: Record<string, string | number> = {};
      const row = dataRows[rowIndex];
      for (let c = 0; c < columnCount + DISPLAY_BUFFER_COLS; c++) {
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
   * Translate row index from RevoGrid to logical row index
   */
  const translateRowIndex = useCallback((gridRowIndex: number, isPinned: boolean): number => {
    if (isPinned) {
      return gridRowIndex;
    }
    return gridRowIndex + headerRowCount;
  }, [headerRowCount]);

  /**
   * Update selection refs and formula bar
   */
  const updateSelection = useCallback(async (
    cell: { row: number; col: number } | null,
    range: NormalizedSelectionRange | null
  ) => {
    selectedCellRef.current = cell;
    selectionRangeRef.current = range;

    if (cell && formulaBarRef.current) {
      // Read value from RevoGrid
      const gridOps = gridOpsRef.current;
      if (gridOps) {
        const value = await gridOps.getCellRawValue(cell.row, cell.col);
        const cellRef = range ? formatSelectionRef(range) : '';
        formulaBarRef.current.update(cellRef, value, isFormula(value));
      }
    } else if (formulaBarRef.current) {
      formulaBarRef.current.update('', '', false);
    }
  }, []);

  // Handle after edit - just mark dirty, RevoGrid owns the data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleAfterEdit = useCallback(
    (event: RevoGridCustomEvent<any>) => {
      if (!event.detail) return;
      host.setDirty(true);
    },
    [host]
  );

  // Handle column resize - persist the new width
  const handleColumnResize = useCallback(
    (event: RevoGridCustomEvent<{ [index: number]: ColumnRegular }>) => {
      console.log('[CSV] Column resize event:', event, event.detail);
      if (!event.detail) return;
      // event.detail is { [columnIndex]: ColumnRegular } with updated sizes
      for (const [indexStr, column] of Object.entries(event.detail)) {
        console.log('[CSV] Processing column resize:', indexStr, column);
        const columnIndex = parseInt(indexStr, 10);
        if (!isNaN(columnIndex) && column.size !== undefined) {
          console.log('[CSV] Setting column width:', columnIndex, column.size);
          spreadsheetMeta.setColumnWidth(columnIndex, column.size);
        }
      }
    },
    [spreadsheetMeta]
  );

  // Handle cell focus (selection)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleFocusCell = useCallback(
    (event: RevoGridCustomEvent<any>) => {
      // Skip if we're doing programmatic selection (e.g., select-all)
      if (skipFocusHandlerRef.current) return;
      if (!event.detail) return;
      const { rowIndex, colIndex, type } = event.detail;

      const isPinned = type === 'rowPinStart';
      const actualRowIndex = translateRowIndex(rowIndex, isPinned);

      const newCell = { row: actualRowIndex, col: colIndex };
      const newRange = normalizeRange(actualRowIndex, colIndex, actualRowIndex, colIndex);

      updateSelection(newCell, newRange);
    },
    [translateRowIndex, updateSelection]
  );

  // Handle cell click as backup for selection
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleCellClick = useCallback(
    (event: RevoGridCustomEvent<any>) => {
      if (!event.detail) return;
      const { row, col, type } = event.detail;

      const isPinned = type === 'rowPinStart';
      const actualRow = translateRowIndex(row, isPinned);

      updateSelection({ row: actualRow, col }, normalizeRange(actualRow, col, actualRow, col));
    },
    [translateRowIndex, updateSelection]
  );

  // Handle range selection
  const handleSetRange = useCallback(
    (event: RevoGridCustomEvent<{
      type: string;
      area?: { x: number; y: number; x1: number; y1: number };
      x?: number; y?: number; x1?: number; y1?: number;
    } | null>) => {
      if (!event.detail) return;

      const x = event.detail.area?.x ?? event.detail.x;
      const y = event.detail.area?.y ?? event.detail.y;
      const x1 = event.detail.area?.x1 ?? event.detail.x1;
      const y1 = event.detail.area?.y1 ?? event.detail.y1;

      if (x === undefined || y === undefined || x1 === undefined || y1 === undefined) return;

      const isPinned = event.detail.type === 'rowPinStart';
      const actualY = translateRowIndex(y, isPinned);
      const actualY1 = translateRowIndex(y1, isPinned);

      const newRange = normalizeRange(actualY, x, actualY1, x1);
      updateSelection({ row: actualY, col: x }, newRange);
    },
    [translateRowIndex, updateSelection]
  );

  // Handle formula bar input
  const handleFormulaChange = useCallback(
    async (value: string) => {
      const cell = selectedCellRef.current;
      const gridOps = gridOpsRef.current;
      if (cell && gridOps) {
        await gridOps.updateCell(cell.row, cell.col, value);
      }
    },
    []
  );

  // Select all cells (from 0,0 to last cell with data)
  const selectAll = useCallback(() => {
    const grid = revoGridRef.current;
    if (!grid) return;

    // Skip focus handler to prevent it from resetting our selection
    skipFocusHandlerRef.current = true;

    // Find actual data bounds asynchronously
    (async () => {
      try {
        const [source, pinnedTop] = await Promise.all([
          grid.getSource('rgRow'),
          grid.getSource('rowPinStart'),
        ]);

        const pinnedRows = (pinnedTop as Record<string, unknown>[]) ?? [];
        const dataRows = (source as Record<string, unknown>[]) ?? [];
        const allRows = [...pinnedRows, ...dataRows];

        // Find last column with actual data
        let lastColWithData = 0;
        for (const row of allRows) {
          for (const [key, value] of Object.entries(row)) {
            if (key === '_rowClass') continue;
            if (value !== undefined && value !== null && value !== '') {
              const colIndex = columnLetterToIndex(key);
              if (colIndex > lastColWithData) {
                lastColWithData = colIndex;
              }
            }
          }
        }

        // Find last row with actual data (not empty buffer rows)
        const isRowEmpty = (row: Record<string, unknown>): boolean => {
          for (let c = 0; c <= lastColWithData; c++) {
            const colKey = columnIndexToLetter(c);
            const value = row[colKey];
            if (value !== undefined && value !== null && value !== '') {
              return false;
            }
          }
          return true;
        };

        // Find last non-empty data row
        let lastDataRowIndex = -1;
        for (let r = dataRows.length - 1; r >= 0; r--) {
          if (!isRowEmpty(dataRows[r])) {
            lastDataRowIndex = r;
            break;
          }
        }

        // Calculate total rows (pinned + data rows with content)
        const pinnedRowCount = pinnedRows.length;
        const lastRow = Math.max(0, pinnedRowCount + lastDataRowIndex);

        // Update selection refs
        selectedCellRef.current = { row: 0, col: 0 };
        selectionRangeRef.current = normalizeRange(0, 0, lastRow, lastColWithData);

        // Update formula bar
        if (formulaBarRef.current) {
          const cellRef = formatSelectionRef(selectionRangeRef.current);
          formulaBarRef.current.update(cellRef, '', false);
        }

        // Set RevoGrid visual focus
        // Note: RevoGrid can't visually select across pinned/data boundary,
        // so we focus on data rows if present, otherwise pinned rows.
        if (lastDataRowIndex >= 0) {
          grid.setCellsFocus(
            { x: 0, y: 0 },
            { x: lastColWithData, y: lastDataRowIndex }
          );
        } else if (pinnedRowCount > 0) {
          grid.setCellsFocus(
            { x: 0, y: 0 },
            { x: lastColWithData, y: pinnedRowCount - 1 },
            undefined,
            'rowPinStart'
          );
        }
      } finally {
        // Re-enable focus handler after a short delay to allow RevoGrid events to settle
        setTimeout(() => {
          skipFocusHandlerRef.current = false;
        }, 100);
      }
    })();
  }, []);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    async (event: React.KeyboardEvent) => {
      if (!isActive) return;

      const editor = editorRef.current;
      if (!editor || !editor.contains(document.activeElement)) return;

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const cmdOrCtrl = isMac ? event.metaKey : event.ctrlKey;
      const gridOps = gridOpsRef.current;
      const undoPlugin = undoPluginRef.current;

      if (cmdOrCtrl && !event.altKey) {
        switch (event.key.toLowerCase()) {
          case 'z':
            event.preventDefault();
            if (event.shiftKey) {
              undoPlugin?.redo();
            } else {
              undoPlugin?.undo();
            }
            return;
          case 'y':
            if (!isMac) {
              event.preventDefault();
              undoPlugin?.redo();
              return;
            }
            break;
          case 'c':
            if (!event.shiftKey && gridOps) {
              event.preventDefault();
              // Get selection from RevoGrid or fall back to our ref
              const grid = revoGridRef.current;
              let range = selectionRangeRef.current;
              if (grid) {
                const gridRange = await grid.getSelectedRange();
                if (gridRange) {
                  const isPinned = gridRange.rowType === 'rowPinStart';
                  range = normalizeRange(
                    translateRowIndex(gridRange.y, isPinned),
                    gridRange.x,
                    translateRowIndex(gridRange.y1, isPinned),
                    gridRange.x1
                  );
                }
              }
              if (range) {
                await gridOps.copySelection(range);
              }
            }
            return;
          case 'x':
            if (!event.shiftKey && gridOps) {
              event.preventDefault();
              const grid = revoGridRef.current;
              let range = selectionRangeRef.current;
              if (grid) {
                const gridRange = await grid.getSelectedRange();
                if (gridRange) {
                  const isPinned = gridRange.rowType === 'rowPinStart';
                  range = normalizeRange(
                    translateRowIndex(gridRange.y, isPinned),
                    gridRange.x,
                    translateRowIndex(gridRange.y1, isPinned),
                    gridRange.x1
                  );
                }
              }
              if (range) {
                await gridOps.cutSelection(range);
              }
            }
            return;
          case 'v':
            if (!event.shiftKey && gridOps) {
              event.preventDefault();
              // Get focused cell from RevoGrid or fall back to our ref
              const grid = revoGridRef.current;
              let cell = selectedCellRef.current;
              if (grid) {
                const focused = await grid.getFocused();
                // getFocused returns { model, cell: { x, y }, colType, rowType }
                if (focused?.cell) {
                  const isPinned = focused.rowType === 'rowPinStart';
                  cell = {
                    row: translateRowIndex(focused.cell.y, isPinned),
                    col: focused.cell.x
                  };
                }
              }
              if (cell) {
                try {
                  const text = await readClipboard();
                  if (text) {
                    await gridOps.pasteFromText(cell.row, cell.col, text);
                  }
                } catch {
                  // Clipboard access denied
                }
              }
            }
            return;
          case 'a':
            if (!event.shiftKey) {
              event.preventDefault();
              selectAll();
            }
            return;
        }
      }

      // Delete/Backspace clears selection
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const activeElement = document.activeElement;
        const isEditing = activeElement?.tagName === 'INPUT' ||
                          activeElement?.getAttribute('contenteditable') === 'true';
        const range = selectionRangeRef.current;
        if (!isEditing && range && gridOps) {
          event.preventDefault();
          await gridOps.clearCells(range);
        }
      }

      // Escape clears selection
      if (event.key === 'Escape') {
        updateSelection(null, null);
      }
    },
    [isActive, updateSelection, selectAll, translateRowIndex]
  );

  // Context menu handler
  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    // In read-only mode the editing context menu (insert / delete row,
    // format column, etc.) is meaningless -- let the browser's default
    // selection / copy menu through instead.
    if (readOnly) return;
    event.preventDefault();
    const container = gridContainerRef.current;
    if (!container) return;

    const target = event.target as HTMLElement;
    const rect = container.getBoundingClientRect();

    // Check for column header click
    const columnHeader = target.closest('revogr-header [data-rgcol]') as HTMLElement | null;
    if (columnHeader) {
      const isRowHeaderArea = columnHeader.closest('.rowHeaders');
      if (isRowHeaderArea) return;

      const headerText = columnHeader.textContent?.trim() || '';
      const colIndex = columnLetterToIndex(headerText);
      if (colIndex >= 0) {
        setContextMenu({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
          isRowHeader: false,
          rowIndex: null,
          isColumnHeader: true,
          colIndex,
        });
        return;
      }
    }

    // Check for row header click
    const rowHeader = target.closest('[data-rgrow]:not([data-rgcol])') as HTMLElement | null;
    if (rowHeader) {
      const gridRowIndex = parseInt(rowHeader.dataset.rgrow || '', 10);
      if (!isNaN(gridRowIndex)) {
        // Translate grid row index to logical row index
        const isInRowHeaders = !!rowHeader.closest('.rowHeaders');
        if (isInRowHeaders) {
          const viewport = rowHeader.closest('revogr-viewport-scroll');
          const slot = viewport?.getAttribute('slot');
          const dataContainer = rowHeader.closest('revogr-data');
          const dataType = dataContainer?.getAttribute('type');
          const isPinned = slot?.includes('rowPinStart') || dataType === 'rowPinStart';
          const logicalRowIndex = isPinned ? gridRowIndex : gridRowIndex + headerRowCount;

          updateSelection({ row: logicalRowIndex, col: 0 }, normalizeRange(logicalRowIndex, 0, logicalRowIndex, spreadsheetMeta.metadata.columnCount - 1));
          setContextMenu({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
            isRowHeader: true,
            rowIndex: logicalRowIndex,
            isColumnHeader: false,
            colIndex: null,
          });
          return;
        }
      }
    }

    // Cell click
    const cell = target.closest('[data-rgrow][data-rgcol]') as HTMLElement | null;
    if (cell) {
      const rowIndex = parseInt(cell.dataset.rgrow || '', 10);
      const colIndex = parseInt(cell.dataset.rgcol || '', 10);

      if (!isNaN(rowIndex) && !isNaN(colIndex)) {
        const range = selectionRangeRef.current;
        const isInSelection = range &&
          rowIndex >= range.startRow && rowIndex <= range.endRow &&
          colIndex >= range.startCol && colIndex <= range.endCol;

        if (!isInSelection) {
          updateSelection({ row: rowIndex, col: colIndex }, normalizeRange(rowIndex, colIndex, rowIndex, colIndex));
        }
      }
    }

    setContextMenu({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      isRowHeader: false,
      rowIndex: null,
      isColumnHeader: false,
      colIndex: null,
    });
  }, [spreadsheetMeta.metadata.columnCount, updateSelection, readOnly]);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Helper to get column index from header element
  const getColumnIndexFromHeader = useCallback((target: HTMLElement): number | null => {
    const headerCell = target.closest('[data-rgcol]') as HTMLElement | null;
    if (headerCell && headerCell.closest('revogr-header')) {
      const colIndex = parseInt(headerCell.dataset.rgcol || '', 10);
      if (!isNaN(colIndex)) return colIndex;
    }
    return null;
  }, []);

  // Helper to get row index from header element
  const getRowIndexFromHeader = useCallback((target: HTMLElement): number | null => {
    const cell = target.closest('[data-rgrow]') as HTMLElement | null;
    if (!cell) return null;

    const isInRowHeaders = !!cell.closest('.rowHeaders');
    if (!isInRowHeaders) return null;

    const gridRowIndex = parseInt(cell.dataset.rgrow || '', 10);
    if (isNaN(gridRowIndex)) return null;

    const viewport = cell.closest('revogr-viewport-scroll');
    const slot = viewport?.getAttribute('slot');
    const dataContainer = cell.closest('revogr-data');
    const dataType = dataContainer?.getAttribute('type');
    const isPinned = slot?.includes('rowPinStart') || dataType === 'rowPinStart';

    return isPinned ? gridRowIndex : gridRowIndex + headerRowCount;
  }, [headerRowCount]);

  // Selection helpers
  const selectColumn = useCallback((colIndex: number) => {
    const totalRows = 100; // Would need to get from grid
    updateSelection({ row: 0, col: colIndex }, normalizeRange(0, colIndex, totalRows - 1, colIndex));
    revoGridRef.current?.setCellsFocus(
      { x: colIndex, y: 0 },
      { x: colIndex, y: totalRows - 1 - headerRowCount }
    );
  }, [headerRowCount, updateSelection]);

  const selectColumnRange = useCallback((startCol: number, endCol: number) => {
    const totalRows = 100;
    const minCol = Math.min(startCol, endCol);
    const maxCol = Math.max(startCol, endCol);
    updateSelection({ row: 0, col: minCol }, normalizeRange(0, minCol, totalRows - 1, maxCol));
    revoGridRef.current?.setCellsFocus(
      { x: minCol, y: 0 },
      { x: maxCol, y: totalRows - 1 - headerRowCount }
    );
  }, [headerRowCount, updateSelection]);

  const selectRow = useCallback((rowIndex: number) => {
    const totalCols = spreadsheetMeta.metadata.columnCount;
    updateSelection({ row: rowIndex, col: 0 }, normalizeRange(rowIndex, 0, rowIndex, totalCols - 1));

    if (rowIndex < headerRowCount) {
      revoGridRef.current?.setCellsFocus(
        { x: 0, y: rowIndex },
        { x: totalCols - 1, y: rowIndex },
        undefined,
        'rowPinStart'
      );
    } else {
      const gridRowIndex = rowIndex - headerRowCount;
      revoGridRef.current?.setCellsFocus(
        { x: 0, y: gridRowIndex },
        { x: totalCols - 1, y: gridRowIndex }
      );
    }
  }, [spreadsheetMeta.metadata.columnCount, headerRowCount, updateSelection]);

  const selectRowRange = useCallback((startRow: number, endRow: number) => {
    const totalCols = spreadsheetMeta.metadata.columnCount;
    const minRow = Math.min(startRow, endRow);
    const maxRow = Math.max(startRow, endRow);
    updateSelection({ row: minRow, col: 0 }, normalizeRange(minRow, 0, maxRow, totalCols - 1));

    if (maxRow < headerRowCount) {
      revoGridRef.current?.setCellsFocus(
        { x: 0, y: minRow },
        { x: totalCols - 1, y: maxRow },
        undefined,
        'rowPinStart'
      );
    } else if (minRow >= headerRowCount) {
      const gridMinRow = minRow - headerRowCount;
      const gridMaxRow = maxRow - headerRowCount;
      revoGridRef.current?.setCellsFocus(
        { x: 0, y: gridMinRow },
        { x: totalCols - 1, y: gridMaxRow }
      );
    }
  }, [spreadsheetMeta.metadata.columnCount, headerRowCount, updateSelection]);

  // Header mouse handlers
  const handleHeaderMouseDown = useCallback((event: React.MouseEvent) => {
    const target = event.target as HTMLElement;

    // Check for corner cell click (the cell in the row header area within the column header)
    // This is the intersection of the row headers and column headers
    const isInRowHeadersArea = !!target.closest('.rowHeaders');
    const isInColumnHeader = !!target.closest('revogr-header');
    if (isInRowHeadersArea && isInColumnHeader) {
      event.preventDefault();
      selectAll();
      return;
    }

    const colIndex = getColumnIndexFromHeader(target);
    if (colIndex !== null) {
      event.preventDefault();
      selectColumn(colIndex);
      setHeaderDrag({ type: 'column', startIndex: colIndex, currentIndex: colIndex });
      return;
    }

    const rowIndex = getRowIndexFromHeader(target);
    if (rowIndex !== null) {
      event.preventDefault();
      selectRow(rowIndex);
      setHeaderDrag({ type: 'row', startIndex: rowIndex, currentIndex: rowIndex });
      return;
    }
  }, [getColumnIndexFromHeader, getRowIndexFromHeader, selectColumn, selectRow, selectAll]);

  // Header drag effect
  useEffect(() => {
    if (!headerDrag) return;

    const handleMouseMove = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const drag = headerDragRef.current;
      if (!drag) return;

      if (drag.type === 'column') {
        const colIndex = getColumnIndexFromHeader(target);
        if (colIndex !== null && colIndex !== drag.currentIndex) {
          setHeaderDrag({ ...drag, currentIndex: colIndex });
          selectColumnRange(drag.startIndex, colIndex);
        }
      } else if (drag.type === 'row') {
        const rowIndex = getRowIndexFromHeader(target);
        if (rowIndex !== null && rowIndex !== drag.currentIndex) {
          setHeaderDrag({ ...drag, currentIndex: rowIndex });
          selectRowRange(drag.startIndex, rowIndex);
        }
      }
    };

    const handleMouseUp = () => {
      setHeaderDrag(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [headerDrag, getColumnIndexFromHeader, getRowIndexFromHeader, selectColumnRange, selectRowRange]);

  // Context menu items
  const getRowHeaderContextMenuItems = useCallback((rowIndex: number): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    const gridOps = gridOpsRef.current;

    // TODO: Header row pinning is disabled because users can't select across the pinned/unpinned boundary
    // which creates a confusing UX. Re-enable once RevoGrid supports cross-boundary selection.
    // const isCurrentlyHeader = rowIndex < headerRowCount;
    // const isTopRowOrAdjacentToHeader = rowIndex === 0 || rowIndex === headerRowCount;

    // // Helper to update both grid data and metadata
    // const setHeaderCount = async (count: number) => {
    //   await gridOps?.updateHeaderRowCount(count);
    //   spreadsheetMeta.setHeaderRowCount(count);
    // };

    // if (isCurrentlyHeader) {
    //   if (rowIndex === headerRowCount - 1) {
    //     items.push({
    //       label: 'Remove Header Row',
    //       action: () => setHeaderCount(headerRowCount - 1),
    //     });
    //   }
    //   if (headerRowCount > 1) {
    //     items.push({
    //       label: 'Remove All Header Rows',
    //       action: () => setHeaderCount(0),
    //     });
    //   }
    // } else {
    //   if (isTopRowOrAdjacentToHeader) {
    //     items.push({
    //       label: 'Set as Header Row',
    //       action: () => setHeaderCount(rowIndex + 1),
    //     });
    //   } else {
    //     items.push({
    //       label: `Set Rows 1-${rowIndex + 1} as Headers`,
    //       action: () => setHeaderCount(rowIndex + 1),
    //     });
    //   }
    // }

    // items.push({ label: '', action: () => {}, separator: true });

    items.push({
      label: 'Insert Row Above',
      action: () => {
        gridOps?.addRow(rowIndex);
        if (rowIndex < headerRowCount) {
          spreadsheetMeta.setHeaderRowCount(headerRowCount + 1);
        }
      },
    });

    items.push({
      label: 'Insert Row Below',
      action: () => gridOps?.addRow(rowIndex + 1),
    });

    items.push({
      label: 'Delete Row',
      action: () => {
        gridOps?.deleteRow(rowIndex);
        if (rowIndex < headerRowCount) {
          spreadsheetMeta.setHeaderRowCount(Math.max(0, headerRowCount - 1));
        }
        updateSelection(null, null);
      },
    });

    return items;
  }, [spreadsheetMeta, headerRowCount, updateSelection]);

  const getColumnHeaderContextMenuItems = useCallback((colIndex: number): ContextMenuItem[] => {
    const colLetter = columnIndexToLetter(colIndex);
    const currentFrozenCount = frozenColumnCount;
    const currentFormat = columnFormats[colIndex];
    const formatTypeName = currentFormat ? getColumnTypeName(currentFormat.type) : 'Text';
    const gridOps = gridOpsRef.current;

    const items: ContextMenuItem[] = [
      {
        label: `Format Column (${formatTypeName})...`,
        action: () => {
          setContextMenu(null);
          setFormatDialogColumn(colIndex);
        },
      },
      { label: '', action: () => {}, separator: true },
      {
        label: `Sort ${colLetter} A -> Z`,
        action: () => {
          gridOps?.sortByColumn(colIndex, 'asc');
          spreadsheetMeta.setSortConfig({ columnIndex: colIndex, direction: 'asc' });
        },
      },
      {
        label: `Sort ${colLetter} Z -> A`,
        action: () => {
          gridOps?.sortByColumn(colIndex, 'desc');
          spreadsheetMeta.setSortConfig({ columnIndex: colIndex, direction: 'desc' });
        },
      },
      { label: '', action: () => {}, separator: true },
    ];

    // TODO: Column freeze is disabled because users can't select across the frozen/unfrozen boundary
    // which creates a confusing UX. Re-enable once RevoGrid supports cross-boundary selection.
    // if (isCurrentlyFrozen) {
    //   if (colIndex === currentFrozenCount - 1) {
    //     items.push({
    //       label: 'Unfreeze Column',
    //       action: () => spreadsheetMeta.setFrozenColumnCount(currentFrozenCount - 1),
    //     });
    //   }
    //   if (currentFrozenCount > 1) {
    //     items.push({
    //       label: 'Unfreeze All Columns',
    //       action: () => spreadsheetMeta.setFrozenColumnCount(0),
    //     });
    //   }
    // } else {
    //   if (isAtFrozenBoundary) {
    //     items.push({
    //       label: 'Freeze Column',
    //       action: () => spreadsheetMeta.setFrozenColumnCount(colIndex + 1),
    //     });
    //   } else {
    //     items.push({
    //       label: `Freeze Columns A-${colLetter}`,
    //       action: () => spreadsheetMeta.setFrozenColumnCount(colIndex + 1),
    //     });
    //   }
    // }

    // items.push({ label: '', action: () => {}, separator: true });

    items.push({
      label: 'Insert Column Left',
      action: () => {
        gridOps?.addColumn(colIndex);
        if (colIndex < currentFrozenCount) {
          spreadsheetMeta.setFrozenColumnCount(currentFrozenCount + 1);
        }
      },
    });
    items.push({
      label: 'Insert Column Right',
      action: () => gridOps?.addColumn(colIndex + 1),
    });
    items.push({
      label: 'Delete Column',
      action: () => {
        gridOps?.deleteColumn(colIndex);
        if (colIndex < currentFrozenCount) {
          spreadsheetMeta.setFrozenColumnCount(Math.max(0, currentFrozenCount - 1));
        }
        updateSelection(null, null);
      },
    });

    return items;
  }, [spreadsheetMeta, frozenColumnCount, columnFormats, updateSelection]);

  const getContextMenuItems = useCallback((): ContextMenuItem[] => {
    const cell = selectedCellRef.current;
    const range = selectionRangeRef.current;
    const hasSelection = !!cell;
    const gridOps = gridOpsRef.current;
    const cellCount = range
      ? (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1)
      : 0;
    const hasMultipleSelected = cellCount > 1;

    return [
      {
        label: hasMultipleSelected ? `Cut (${cellCount} cells)` : 'Cut',
        action: () => {
          if (range && gridOps) gridOps.cutSelection(range);
        },
        disabled: !hasSelection,
      },
      {
        label: hasMultipleSelected ? `Copy (${cellCount} cells)` : 'Copy',
        action: () => {
          if (range && gridOps) gridOps.copySelection(range);
        },
        disabled: !hasSelection,
      },
      {
        label: 'Paste',
        action: () => {
          if (cell && gridOps) {
            readClipboard().then(text => {
              if (text) {
                gridOps.pasteFromText(cell.row, cell.col, text);
              }
            }).catch(() => {});
          }
        },
        disabled: !hasSelection,
      },
      {
        label: hasMultipleSelected ? `Clear (${cellCount} cells)` : 'Clear',
        action: () => {
          if (range && gridOps) gridOps.clearCells(range);
        },
        disabled: !hasSelection,
      },
      { label: '', action: () => {}, separator: true },
      {
        label: 'Insert Row Above',
        action: () => {
          if (cell && gridOps) gridOps.addRow(cell.row);
        },
        disabled: !hasSelection,
      },
      {
        label: 'Insert Row Below',
        action: () => {
          if (cell && gridOps) gridOps.addRow(cell.row + 1);
        },
        disabled: !hasSelection,
      },
      {
        label: 'Delete Row',
        action: () => {
          if (cell && gridOps) {
            gridOps.deleteRow(cell.row);
            updateSelection(null, null);
          }
        },
        disabled: !hasSelection,
      },
      { label: '', action: () => {}, separator: true },
      {
        label: 'Insert Column Left',
        action: () => {
          if (cell && gridOps) gridOps.addColumn(cell.col);
        },
        disabled: !hasSelection,
      },
      {
        label: 'Insert Column Right',
        action: () => {
          if (cell && gridOps) gridOps.addColumn(cell.col + 1);
        },
        disabled: !hasSelection,
      },
      {
        label: 'Delete Column',
        action: () => {
          if (cell && gridOps) {
            gridOps.deleteColumn(cell.col);
            updateSelection(null, null);
          }
        },
        disabled: !hasSelection,
      },
    ];
  }, [updateSelection]);

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return [];
    if (contextMenu.isColumnHeader && contextMenu.colIndex !== null) {
      return getColumnHeaderContextMenuItems(contextMenu.colIndex);
    }
    if (contextMenu.isRowHeader && contextMenu.rowIndex !== null) {
      return getRowHeaderContextMenuItems(contextMenu.rowIndex);
    }
    return getContextMenuItems();
  }, [contextMenu, getContextMenuItems, getRowHeaderContextMenuItems, getColumnHeaderContextMenuItems]);

  // Render loading state
  if (isLoading) {
    return (
      <div className="spreadsheet-editor flex flex-col h-full w-full bg-nim text-nim overflow-hidden" data-theme={theme}>
        <div className="flex items-center justify-center h-full text-nim-muted">
          Loading spreadsheet...
        </div>
      </div>
    );
  }

  // Render error state
  if (loadError) {
    return (
      <div className="spreadsheet-editor flex flex-col h-full w-full bg-nim text-nim overflow-hidden" data-theme={theme}>
        <div className="p-5 text-nim bg-nim">
          <h3 className="text-nim">Error Loading Spreadsheet</h3>
          <p className="text-nim-muted">{loadError.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={editorRef}
      className="spreadsheet-editor flex flex-col h-full w-full bg-nim text-nim overflow-hidden"
      data-theme={theme}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {!readOnly && (
        <div className="flex items-center gap-2 bg-nim-secondary border-b border-nim">
          <FormulaBar
            ref={formulaBarRef}
            onChange={handleFormulaChange}
          />
          {host.supportsSourceMode && (
            <button
              className="px-3 py-1.5 mr-3 text-[13px] font-medium bg-nim-tertiary border border-nim rounded text-nim-muted cursor-pointer transition-all whitespace-nowrap hover:bg-nim-hover hover:text-nim active:bg-nim"
              onClick={() => host.toggleSourceMode?.()}
              title="View raw CSV source"
            >
              View Source
            </button>
          )}
        </div>
      )}
      <div
        ref={gridContainerRef}
        className="flex-1 overflow-hidden relative"
        tabIndex={0}
        {...(!isActive ? { inert: true } : {})}
        data-is-active={isActive}
        onContextMenu={handleContextMenu}
        onMouseDown={handleHeaderMouseDown}
      >
        <RevoGrid
          ref={(el) => {
            (revoGridRef as React.MutableRefObject<RevoGridElement | null>).current = el;
            // Load pending data imperatively when grid mounts
            if (el && !dataLoadedRef.current && pendingDataRef.current) {
              el.source = pendingDataRef.current.source;
              el.pinnedTopSource = pendingDataRef.current.pinnedTop;
              dataLoadedRef.current = true;
            }
          }}
          columns={columns}
          rowHeaders={true}
          resize={true}
          autoSizeColumn={false}
          range={true}
          applyOnClose={true}
          editors={editors}
          rowClass="_rowClass"
          readonly={readOnly || diffState?.isActive}
          onAfteredit={handleAfterEdit}
          onAfterfocus={handleFocusCell}
          // @ts-expect-error onSetrange exists but not in React type defs
          onSetrange={handleSetRange}
          onBeforecellfocus={handleCellClick}
          onAftercolumnresize={handleColumnResize}
        />
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenuItems}
            onClose={handleCloseContextMenu}
          />
        )}
      </div>

      <ColumnFormatDialog
        isOpen={formatDialogColumn !== null}
        columnIndex={formatDialogColumn ?? 0}
        columnLetter={formatDialogColumn !== null ? columnIndexToLetter(formatDialogColumn) : ''}
        currentFormat={formatDialogColumn !== null ? columnFormats[formatDialogColumn] : undefined}
        onSave={(format) => {
          if (formatDialogColumn !== null) {
            spreadsheetMeta.setColumnFormat(formatDialogColumn, format);
          }
        }}
        onClose={() => setFormatDialogColumn(null)}
      />
    </div>
  );
}
