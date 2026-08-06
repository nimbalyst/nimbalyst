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

import { useEffect, useRef, useCallback, useState, useMemo, type RefObject } from 'react';
import { RevoGrid, type RevoGridCustomEvent, type ColumnRegular } from '@revolist/react-datagrid';
import type { RevoGridElement } from '../revogrid-types';
import type {
  EditorHostProps,
  NormalizedSelectionRange,
  ColumnFormat,
  DiffState,
  CellDiff,
  SpreadsheetData,
  FilterScalar,
} from '../types';
import {
  useEditorLifecycle,
  useCollaborativeEditor,
  readClipboard,
  type DiffConfig,
} from '@nimbalyst/extension-sdk';
import { CsvBinding } from '../collab/csvBinding';
import { isCsvYDocEmpty, seedCsvYDoc, getYCsv } from '../collab/seed';
import type { RemotePresence } from '../collab/presence';
import { CollabPresenceOverlay } from './CollabPresenceOverlay';
import { useSpreadsheetMetadata } from '../hooks/useSpreadsheetMetadata';
import {
  createGridOperations,
  FormulaViewState,
  spreadsheetDataToGridSource,
  type GridOperations,
  type GridSourceData,
} from '../utils/gridOperations';
import { createSpreadsheetEditorAPI } from '../editorAPI';
import { UndoRedoPlugin } from '../plugins/UndoRedoPlugin';
import { columnIndexToLetter, columnLetterToIndex, generateColumnHeaders, parseCSV } from '../utils/csvParser';
import { computeDiff, getCellDiffClass, getCellPreviousValue } from '../utils/diffCompute';
import { isFormula } from '../utils/formulaEngine';
import { formatCellValue, getColumnTypeName, isNumericCellValue } from '../utils/formatters';
import { FormulaBar, type FormulaBarHandle } from './FormulaBar';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { ColumnFormatDialog } from './ColumnFormatDialog';
import { FindBar } from './FindBar';
import { ColumnFilterDropdown } from './ColumnFilterDropdown';
import { useSpreadsheetFind, type FindContext } from '../hooks/useSpreadsheetFind';
import { useColumnFilters, type ColumnFilters } from '../hooks/useColumnFilters';
import { createRowIndexMapping, logicalRowForGridRow, logicalRowsForSelection } from '../filter/rowIndexMapping';
import { snapRowsToVisible } from '../filter/visibleRange';
import { getAppliedTrimmedRows } from '../filter/filterEngine';
import { EMPTY_FIND_HIGHLIGHT, type FindHighlight } from '../filter/findHighlight';
import { SheetsTextEditor } from '../editors/SheetsTextEditor';
import { buildSpreadsheetSelectionContextItem } from '../selectionContext';
import {
  notifySpreadsheetCellFlash,
  subscribeSpreadsheetCellFlash,
  type AICellFlashEventDetail,
} from '../aiCellFlash';
import { useCellDragSelection } from '../selection/useCellDragSelection';
import {
  gridBounds,
  paintCrossSectionRange,
  readHeaderColumnTarget,
  resolveGridSections,
  resolveHeaderColumnIndex,
  toAbsoluteColumn,
  type SectionAwareGrid,
} from '../selection/crossSectionSelection';

// Buffer of extra empty rows/columns to show beyond actual data
const DISPLAY_BUFFER_ROWS = 20;
const DISPLAY_BUFFER_COLS = 20;

/**
 * Every grid operation that changes a cell value, the row set or the row order.
 * Each one can invalidate an active filter's hidden rows, the row mapping, or
 * both, so they are all wrapped to invalidate afterwards -- a new mutating
 * operation added to `GridOperations` only needs its name here.
 */
const MUTATING_GRID_OPERATIONS = [
  'updateCell',
  'updateCells',
  'clearCells',
  'addRow',
  'deleteRow',
  'addColumn',
  'deleteColumn',
  'updateHeaderRowCount',
  'cutSelection',
  'pasteFromText',
  'sortByColumn',
] as const satisfies readonly (keyof GridOperations)[];

/** Wrap the mutating operations so each one refreshes the filtered view. */
function withRowViewInvalidation(
  operations: GridOperations,
  invalidate: () => Promise<void>
): GridOperations {
  const wrapped: GridOperations = { ...operations };
  for (const name of MUTATING_GRID_OPERATIONS) {
    const original = operations[name] as (...args: unknown[]) => Promise<unknown>;
    (wrapped as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      const result = await original(...args);
      await invalidate();
      return result;
    };
  }
  return wrapped;
}

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
  formulaViewState: FormulaViewState,
  frozenColumnCount: number = 0,
  columnFormats: Record<number, ColumnFormat> = {},
  columnWidths: Record<number, number> = {},
  diffState: DiffState | null = null,
  /**
   * Read through refs, never through props: the columns memo must not be
   * rebuilt on every keystroke of a find query or every filter change, so both
   * are mutable state the templates sample at paint time (the same trick
   * `formulaViewState` uses). Callers repaint with `grid.refresh('all')`.
   */
  findHighlightRef: RefObject<FindHighlight> = { current: EMPTY_FIND_HIGHLIGHT },
  filteredColumnsRef: RefObject<ReadonlySet<number>> = { current: new Set() },
  aiFlashRef: RefObject<WeakMap<object, ReadonlySet<string>>> = { current: new WeakMap() },
): ColumnRegular[] {
  const columnHeaders = generateColumnHeaders(columnCount);
  const DEFAULT_COLUMN_WIDTH = 120;

  return columnHeaders.map((letter, index) => {
    const format = columnFormats[index];
    const alignClass = getColumnAlignmentClass(format);
    const width = columnWidths[index] ?? DEFAULT_COLUMN_WIDTH;

    return {
      prop: letter,
      name: letter,
      size: width,
      editor: 'sheets',
      ...(index < frozenColumnCount ? { pin: 'colPinStart' as const } : {}),
      // The funnel is a plain marked-up span rather than a React node; the
      // editor picks its clicks up through the header mousedown delegation it
      // already runs, and anchors the dropdown to this element.
      columnTemplate: (h, props) => h('span', { class: 'csv-header-cell' }, [
        h('span', { class: 'csv-header-label' }, props.name ?? ''),
        h('span', {
          class: filteredColumnsRef.current.has(index)
            ? 'csv-filter-affordance csv-filter-affordance-active'
            : 'csv-filter-affordance',
          title: 'Filter column',
        }, '▼'),
      ]),
      // RevoGrid's editor reads the raw model value, while this template can
      // render the separately-derived formula result. Column formatting is
      // applied last so formulas and literals follow the same display rules.
      cellTemplate: (h, props) => {
        const prop = props.prop as string;
        const raw = props.model?.[prop];
        const formulaDisplay = props.model
          ? formulaViewState.getDisplayValue(props.model, prop)
          : undefined;
        const displayValue = formulaDisplay !== undefined ? formulaDisplay : raw;
        const value = typeof displayValue === 'string' || typeof displayValue === 'number'
          ? displayValue
          : null;
        return h('span', {}, format ? formatCellValue(value, format) : String(value ?? ''));
      },
      cellProperties: (cellData: { model: Record<string, unknown>; rowIndex: number }) => {
        const classes: Record<string, boolean> = {};

        // Detect if this is a pinned (header) row by checking for header-row class
        const isPinned = cellData.model._rowClass === 'header-row';

        // Alignment. An explicit column format wins; otherwise fall back to what
        // every spreadsheet does and right-align values that read as numbers,
        // leaving text against the left edge. Header rows stay left-aligned even
        // when their label happens to be numeric -- a header is a label, not a
        // measurement. The value tested is the *displayed* one, so a formula
        // aligns by its result rather than by the `=SUM(...)` source text.
        if (alignClass) {
          classes[alignClass] = true;
        } else if (!isPinned) {
          const displayed = formulaViewState.getDisplayValue(cellData.model, letter)
            ?? cellData.model[letter];
          if (isNumericCellValue(displayed)) {
            classes['cell-align-right'] = true;
          }
        }

        // Find-match highlight, keyed by row model rather than row index so it
        // survives pinned rows and filtered-out rows alike.
        const findState = findHighlightRef.current.get(cellData.model)?.get(letter);
        if (findState !== undefined) {
          classes['csv-find-match'] = true;
          classes['csv-find-current'] = findState;
        }

        if (aiFlashRef.current.get(cellData.model)?.has(letter)) {
          classes['csv-ai-cell-flash'] = true;
        }

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
  const formulaViewStateRef = useRef(new FormulaViewState());

  // Ref for spreadsheetMeta so callbacks stay current
  const spreadsheetMetaRef = useRef(spreadsheetMeta);
  spreadsheetMetaRef.current = spreadsheetMeta;
  const hostRef = useRef(host);
  hostRef.current = host;

  // Selection state (refs to avoid re-renders)
  const selectedCellRef = useRef<{ row: number; col: number } | null>(null);
  const selectionRangeRef = useRef<NormalizedSelectionRange | null>(null);
  const [hasRangeSelection, setHasRangeSelection] = useState(false);
  const selectionContextPublishVersionRef = useRef(0);
  const lastPublishedSelectionContextRef = useRef<string | null>(null);
  const skipFocusHandlerRef = useRef(false); // Flag to skip focus handler during programmatic selection
  // Set while our own cross-section drag owns the selection. RevoGrid keeps
  // emitting setrange with its clamped, single-section range during the drag;
  // honouring it would snap the selection back at the frozen boundary.
  const suppressGridRangeRef = useRef(false);

  // Grid initialization - render grid immediately, load data imperatively after mount
  // This avoids React props overwriting RevoGrid's internal state on re-renders
  const pendingDataRef = useRef<GridSourceData | null>(null);
  const dataLoadedRef = useRef(false);
  const loadedCsvContentRef = useRef('');

  /* ----------------------------------------------------------------------- */
  /* Filtered-view invalidation                                               */
  /* ----------------------------------------------------------------------- */

  /**
   * The visible <-> logical row boundary.
   *
   * RevoGrid addresses rows by *visible* position: with a filter on, `data-rgrow`,
   * its focus/range events, its selection stores and `scrollToRow` all skip the
   * trimmed rows. Selections, formulas and every clipboard consumer are in
   * *logical* sheet rows. Everything in this component is logical; the only
   * places that speak visible rows are the DOM/event entry points below and
   * `paintLogicalRange`, which converts back on the way out.
   */
  const rowSpaceRef = useRef(createRowIndexMapping({ rowCount: 0 }));

  // Assigned once `useColumnFilters` runs further down; read through a ref so
  // the invalidation path below can be defined before it and stay stable.
  const columnFiltersRef = useRef<ColumnFilters | null>(null);

  /**
   * Both filtered-view derivations are snapshots of the sheet, so *any* mutation
   * makes them lie: the trimmed rows a filter derived, and the row mapping built
   * from them. Rather than refresh at each of the dozen call sites that can
   * mutate the sheet -- where the next one added silently misses -- every
   * mutating grid operation and every whole-source load funnels through here.
   */
  const rebuildRowSpace = useCallback(async () => {
    const grid = revoGridRef.current;
    if (!grid) return;
    const source = await grid.getSource('rgRow');
    const headerRows = spreadsheetMetaRef.current.metadata.headerRowCount;
    rowSpaceRef.current = createRowIndexMapping({
      rowCount: headerRows + (source?.length ?? 0),
      headerRowCount: headerRows,
      trimmedRows: getAppliedTrimmedRows(grid),
    });
  }, []);

  const runRowViewInvalidation = useCallback(async () => {
    await columnFiltersRef.current?.refresh();
    await rebuildRowSpace();
  }, [rebuildRowSpace]);

  // Coalesced: a replace-all writes one cell at a time, and re-deriving the
  // whole filter per cell would be quadratic. Requests made while a pass is
  // running are folded into one more pass, so the last mutation is always the
  // one the mapping reflects.
  const rowViewInvalidationRef = useRef<Promise<void> | null>(null);
  const rowViewIsStaleRef = useRef(false);
  const invalidateRowView = useCallback((): Promise<void> => {
    rowViewIsStaleRef.current = true;
    if (!rowViewInvalidationRef.current) {
      rowViewInvalidationRef.current = (async () => {
        try {
          while (rowViewIsStaleRef.current) {
            rowViewIsStaleRef.current = false;
            await runRowViewInvalidation();
          }
        } finally {
          rowViewInvalidationRef.current = null;
        }
      })();
    }
    return rowViewInvalidationRef.current;
  }, [runRowViewInvalidation]);

  /**
   * Single write path for a whole-sheet source replacement (initial load, diff
   * clear, remote collab content). The rows underneath every filter and the row
   * mapping are both replaced wholesale, so neither survives the swap.
   */
  const applyGridSource = useCallback((grid: RevoGridElement, gridData: GridSourceData) => {
    grid.source = gridData.source;
    grid.pinnedTopSource = gridData.pinnedTop;
    void invalidateRowView();
  }, [invalidateRowView]);

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

  /**
   * Editing lock.
   *
   * A diff splices phantom rows (the AI's deletions) into the grid source, so
   * grid row indices no longer line up with the file's. Every mutation path --
   * formula bar, paste, clear, replace, insert/delete row -- addresses cells by
   * index, so an edit made mid-review lands on the wrong row, and `toCSV()`
   * would write the phantom rows back out as real ones. Whatever survived that
   * is then thrown away: accept/reject reloads from disk. So review is
   * read-only, and Keep/Revert is the only way out of it.
   *
   * The grid's own cell editor is gated by RevoGrid's `readonly` prop; this
   * covers everything that writes without going through it.
   */
  const isDiffActive = diffState?.isActive ?? false;
  const editingLockedRef = useRef(false);
  editingLockedRef.current = readOnly || isDiffActive;

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
      const gridData = prepareGridData(data);

      // Store data to be loaded imperatively once grid is mounted
      pendingDataRef.current = gridData;

      // If grid already mounted, load immediately
      const grid = revoGridRef.current;
      if (grid) {
        applyGridSource(grid, gridData);
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
      // Mid-review the grid holds the AI's content plus phantom rows for its
      // deletions. Writing that back would resurrect every deleted row as a
      // real one -- and there is nothing to save anyway, since the proposed
      // content is already the file on disk. Keep/Revert owns this.
      if (diffStateRef.current?.isActive) return;

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
      const gridData = prepareGridData(modifiedData);

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
          applyGridSource(grid, { ...gridData, source: [...finalDataRows, ...bufferRows] });
        } else {
          applyGridSource(grid, gridData);
        }
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
        const gridData = prepareGridData(data);

        const grid = revoGridRef.current;
        if (grid) applyGridSource(grid, gridData);

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
  // Remote collaborator presence (selected/editing cells) for the in-grid
  // overlay. `presenceRepaintTick` forces the overlay to re-measure cell rects
  // on scroll/resize even when the presence list itself is unchanged.
  const [remotePresences, setRemotePresences] = useState<RemotePresence[]>([]);
  const [presenceRepaintTick, setPresenceRepaintTick] = useState(0);
  const presenceRafRef = useRef<number | null>(null);
  // Trailing throttle for local selection publishes (rapid arrow-key nav).
  const awarenessThrottleRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; last: number }>({ timer: null, last: 0 });
  const { isCollaborative: isCollabActive } = useCollaborativeEditor(host, {
    isEmpty: isCsvYDocEmpty,
    initializeFromContent: seedCsvYDoc,
    createBinding: ({ yDoc, awareness }) => {
      const applyCsvContent = (content: string) => {
        loadedCsvContentRef.current = content;
        const { data } = parseCSV(content);
        const gridData = prepareGridData(data);
        // Stash for the deferred ref-callback path. The collab createBinding
        // can fire applyCsvContent before the grid is mounted -- if so, the
        // ref callback's pendingDataRef branch is what populates the grid on
        // mount. Without this, an earlier lifecycle applyContent('') wins by
        // leaving an empty pendingDataRef in place and the reopened tab
        // comes back blank.
        pendingDataRef.current = gridData;
        const grid = revoGridRef.current;
        if (grid) {
          applyGridSource(grid, gridData);
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
          onRemoteAwareness: () => {
            // A collaborator's selection/edit changed -- refresh the presence
            // list. The overlay re-measures cell rects off this state change.
            setRemotePresences(collabBindingRef.current?.getRemotePresences() ?? []);
          },
        },
        awareness,
      );
      collabBindingRef.current = binding;
      // Seed presence from whoever is already in the room (onRemoteAwareness
      // only fires on subsequent changes).
      setRemotePresences(binding.getRemotePresences());
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
          setRemotePresences([]);
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
      // Same reason the save path bails: the grid is showing phantom rows, and
      // syncing them would broadcast the AI's deleted rows to collaborators as
      // live content.
      if (diffStateRef.current?.isActive) return;
      collabBindingRef.current?.scheduleSync();
    }, 1000);
    return () => clearInterval(id);
  }, [isCollabActive]);

  // Coalesced repaint of the presence overlay. Cell rects are read from the
  // live DOM, so any scroll/resize needs a re-measure even when the presence
  // list is unchanged. rAF-batched so a scroll burst repaints once per frame.
  const schedulePresenceRepaint = useCallback(() => {
    if (presenceRafRef.current !== null) return;
    presenceRafRef.current = requestAnimationFrame(() => {
      presenceRafRef.current = null;
      setPresenceRepaintTick((t) => t + 1);
    });
  }, []);

  // Publish the local selected cell to awareness, trailing-throttled so rapid
  // arrow-key navigation doesn't churn the awareness channel. Selecting a cell
  // is not editing it, so editingCell is cleared here; it is set on edit start.
  const AWARENESS_THROTTLE_MS = 100;
  const publishLocalSelection = useCallback((cell: { row: number; col: number } | null) => {
    if (!collabActiveRef.current) return;
    const state = awarenessThrottleRef.current;
    const flush = () => {
      state.last = Date.now();
      state.timer = null;
      collabBindingRef.current?.setLocalAwareness({ selectedCell: cell, editingCell: null });
    };
    const elapsed = Date.now() - state.last;
    if (state.timer) clearTimeout(state.timer);
    if (elapsed >= AWARENESS_THROTTLE_MS) {
      flush();
    } else {
      state.timer = setTimeout(flush, AWARENESS_THROTTLE_MS - elapsed);
    }
  }, []);

  // Clean up the throttle timer / pending rAF on unmount.
  useEffect(() => {
    return () => {
      if (awarenessThrottleRef.current.timer) clearTimeout(awarenessThrottleRef.current.timer);
      if (presenceRafRef.current !== null) cancelAnimationFrame(presenceRafRef.current);
    };
  }, []);

  // Re-measure presence markers when the grid container resizes (pane resize,
  // window resize, formula-bar show/hide). No-op when not collaborating.
  useEffect(() => {
    if (!isCollabActive) return;
    const el = gridContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => schedulePresenceRepaint());
    ro.observe(el);
    return () => ro.disconnect();
  }, [isCollabActive, schedulePresenceRepaint]);

  // Stable editors object
  const editors = useMemo(() => ({ sheets: SheetsTextEditor }), []);

  // Display dimensions
  const displayColumnCount = spreadsheetMeta.metadata.columnCount + DISPLAY_BUFFER_COLS;
  const frozenColumnCount = spreadsheetMeta.metadata.frozenColumnCount;
  const columnFormats = spreadsheetMeta.metadata.columnFormats;
  const columnWidths = spreadsheetMeta.metadata.columnWidths;
  const headerRowCount = spreadsheetMeta.metadata.headerRowCount;

  // Find/filter view state the column templates sample at paint time. Kept in
  // refs so neither a search keystroke nor a filter rebuilds `columns`.
  const findHighlightRef = useRef<FindHighlight>(EMPTY_FIND_HIGHLIGHT);
  const filteredColumnsRef = useRef<ReadonlySet<number>>(new Set());
  const aiFlashRef = useRef<WeakMap<object, ReadonlySet<string>>>(new WeakMap());
  const aiFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiFlashPaintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiFlashCellsRef = useRef<((cells: readonly { row: number; column: number }[]) => Promise<void>) | null>(null);

  // Memoized column definitions
  const columns = useMemo(
    () => generateColumns(
      displayColumnCount,
      formulaViewStateRef.current,
      frozenColumnCount,
      columnFormats,
      columnWidths,
      diffState,
      findHighlightRef,
      filteredColumnsRef,
      aiFlashRef,
    ),
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
          onDataChange: () => {
            void gridOpsRef.current?.recalculateFormulas().catch((error) => {
              console.error('[CSV] Failed to recalculate formulas after undo/redo:', error);
            });
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
    const rawGridOps = createGridOperations(revoGridRef, {
      getHeaderRowCount: () => spreadsheetMetaRef.current.metadata.headerRowCount,
      getColumnCount: () => spreadsheetMetaRef.current.metadata.columnCount,
      setColumnCount: (count) => spreadsheetMetaRef.current.setColumnCount(count),
      getDelimiter: () => spreadsheetMetaRef.current.delimiter,
      getColumnFormats: () => spreadsheetMetaRef.current.metadata.columnFormats,
      getColumnWidths: () => spreadsheetMetaRef.current.metadata.columnWidths,
      getFrozenColumnCount: () => spreadsheetMetaRef.current.metadata.frozenColumnCount,
      onDirty: () => hostRef.current.setDirty(true),
      getUndoPlugin: () => undoPluginRef.current,
      getTrimmedRows: () => getAppliedTrimmedRows(grid),
      formulaViewState: formulaViewStateRef.current,
    });
    // Nothing downstream sees the unwrapped operations, so no mutation path can
    // skip the filtered-view refresh.
    const gridOps = withRowViewInvalidation(rawGridOps, invalidateRowView);
    gridOpsRef.current = gridOps;
    const ownEditor = editorRef.current;

    const flashCells = async (cells: readonly { row: number; column: number }[]) => {
      const { source, pinnedTop } = await gridOps.getData();
      const headerRows = spreadsheetMetaRef.current.metadata.headerRowCount;
      const frozenColumns = spreadsheetMetaRef.current.metadata.frozenColumnCount;
      const mapping = createRowIndexMapping({
        rowCount: headerRows + source.length,
        headerRowCount: headerRows,
        trimmedRows: getAppliedTrimmedRows(grid),
      });
      const flashRenderedCells = () => {
        if (!ownEditor) return;
        for (const cell of cells) {
          const visibleRow = mapping.logicalToVisible(cell.row);
          if (visibleRow === undefined) continue;
          const rowType = cell.row < headerRows ? 'rowPinStart' : 'rgRow';
          const renderedRow = cell.row < headerRows ? cell.row : visibleRow - headerRows;
          const columnType = cell.column < frozenColumns ? 'colPinStart' : 'rgCol';
          const renderedColumn = cell.column < frozenColumns ? cell.column : cell.column - frozenColumns;
          const selector = `revogr-data[type="${rowType}"] [data-rgrow="${renderedRow}"][data-rgcol="${renderedColumn}"]`;
          for (const candidate of ownEditor.querySelectorAll(selector)) {
            const viewport = candidate.closest('revogr-viewport-scroll');
            if (viewport?.classList.contains(columnType)) {
              candidate.classList.add('csv-ai-cell-flash');
            }
          }
        }
      };
      for (const cell of cells) {
        const model = cell.row < headerRows
          ? pinnedTop[cell.row]
          : source[cell.row - headerRows];
        if (!model) continue;
        const flashed = new Set(aiFlashRef.current.get(model) ?? []);
        flashed.add(columnIndexToLetter(cell.column));
        aiFlashRef.current.set(model, flashed);

        // RevoGrid does not always re-run cellProperties for an already-painted
        // viewport cell. Add the same transient class to the live DOM so a user
        // watching the edit sees it immediately; the model-backed class above
        // covers cells painted while the flash is active.
      }
      flashRenderedCells();
      // The editor-write bridge flushes the file immediately after the handler
      // returns. Repaint once after that save-driven render so the visible flash
      // survives model replacement instead of disappearing with the old cells.
      if (aiFlashPaintTimerRef.current) clearTimeout(aiFlashPaintTimerRef.current);
      aiFlashPaintTimerRef.current = setTimeout(() => {
        flashRenderedCells();
        aiFlashPaintTimerRef.current = null;
      }, 250);
      if (aiFlashTimerRef.current) clearTimeout(aiFlashTimerRef.current);
      aiFlashTimerRef.current = setTimeout(() => {
        aiFlashRef.current = new WeakMap();
        ownEditor?.querySelectorAll('.csv-ai-cell-flash').forEach((cell) => {
          cell.classList.remove('csv-ai-cell-flash');
        });
        void grid.refresh('all');
        aiFlashTimerRef.current = null;
      }, 1400);
    };
    aiFlashCellsRef.current = flashCells;

    hostRef.current.registerEditorAPI(createSpreadsheetEditorAPI({
      operations: gridOps,
      getMetadata: () => {
        const current = spreadsheetMetaRef.current;
        return {
          ...current.metadata,
          delimiter: current.delimiter,
        };
      },
      getSelection: async () => {
        const range = selectionRangeRef.current;
        if (!range) return null;
        const { source } = await gridOps.getData();
        const headerRows = spreadsheetMetaRef.current.metadata.headerRowCount;
        const mapping = createRowIndexMapping({
          rowCount: headerRows + source.length,
          headerRowCount: headerRows,
          trimmedRows: getAppliedTrimmedRows(grid),
        });
        return {
          range: { ...range },
          logicalRows: logicalRowsForSelection(mapping, range).logicalRows,
        };
      },
      getDisplayValue: (model, prop) => formulaViewStateRef.current.getDisplayValue(model, prop),
      flashCells: (cells) => notifySpreadsheetCellFlash(filePath, cells),
    }));

    return () => {
      cancelled = true;
      hostRef.current.registerEditorAPI(null);
      if (aiFlashTimerRef.current) {
        clearTimeout(aiFlashTimerRef.current);
        aiFlashTimerRef.current = null;
      }
      if (aiFlashPaintTimerRef.current) {
        clearTimeout(aiFlashPaintTimerRef.current);
        aiFlashPaintTimerRef.current = null;
      }
      aiFlashRef.current = new WeakMap();
      if (aiFlashCellsRef.current === flashCells) aiFlashCellsRef.current = null;
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
  }, [isLoading, filePath]);

  useEffect(() => {
    const flashDetail = (detail: AICellFlashEventDetail | undefined) => {
      if (detail?.filePath === filePath) void aiFlashCellsRef.current?.(detail.cells);
    };
    return subscribeSpreadsheetCellFlash(flashDetail);
  }, [filePath]);

  // (Loading, saving, file changes, echo detection, diff mode are all handled by useEditorLifecycle above)

  /** Build raw RevoGrid source rows and the derived formula display state. */
  function prepareGridData(data: SpreadsheetData): GridSourceData {
    const gridData = spreadsheetDataToGridSource(
      data,
      DISPLAY_BUFFER_ROWS,
      DISPLAY_BUFFER_COLS,
    );
    formulaViewStateRef.current.recalculate(data, gridData);
    return gridData;
  }

  // The visible <-> logical row conversions every DOM/event entry point goes
  // through. See `rowSpaceRef` above for the boundary they enforce.
  const toLogicalRow = useCallback(
    (visibleRow: number) => rowSpaceRef.current.visibleToLogical(visibleRow) ?? visibleRow,
    [],
  );
  const toVisibleRow = useCallback(
    (logicalRow: number) => rowSpaceRef.current.logicalToVisible(logicalRow) ?? logicalRow,
    [],
  );

  const translateRowIndex = useCallback((gridRowIndex: number, isPinned: boolean): number => (
    logicalRowForGridRow(rowSpaceRef.current, gridRowIndex, isPinned, headerRowCount)
  ), [headerRowCount]);

  const publishSelectionContext = useCallback(async (range: NormalizedSelectionRange | null) => {
    const publishVersion = ++selectionContextPublishVersionRef.current;

    if (!range) {
      if (lastPublishedSelectionContextRef.current !== null) {
        lastPublishedSelectionContextRef.current = null;
        hostRef.current.setEditorContextItems(null);
      }
      return;
    }

    let rows: Record<string, unknown>[] = [];
    const gridOps = gridOpsRef.current;
    if (gridOps) {
      try {
        const { pinnedTop, source } = await gridOps.getData();
        rows = [...pinnedTop, ...source];
      } catch {
        // The range label remains useful if RevoGrid is unavailable mid-unmount.
      }
    }

    if (publishVersion !== selectionContextPublishVersionRef.current) return;

    const item = buildSpreadsheetSelectionContextItem(range, rows);
    const signature = JSON.stringify(item);
    if (signature === lastPublishedSelectionContextRef.current) return;

    lastPublishedSelectionContextRef.current = signature;
    hostRef.current.setEditorContextItems([item]);
  }, []);

  useEffect(() => () => {
    selectionContextPublishVersionRef.current += 1;
    lastPublishedSelectionContextRef.current = null;
    host.setEditorContextItems(null);
  }, [host]);

  /**
   * Update selection refs and formula bar
   */
  const updateSelection = useCallback(async (
    cell: { row: number; col: number } | null,
    range: NormalizedSelectionRange | null
  ) => {
    selectedCellRef.current = cell;
    selectionRangeRef.current = range;
    // Only the find bar's "In selection" needs this as state; React bails out
    // when the boolean is unchanged, so a drag doesn't re-render per cell.
    setHasRangeSelection(
      !!range && (range.startRow !== range.endRow || range.startCol !== range.endCol)
    );
    void publishSelectionContext(range);
    publishLocalSelection(cell);

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
  }, [publishSelectionContext, publishLocalSelection]);

  // Handle direct RevoGrid edits. The source already contains the committed
  // raw value when this event fires, so recalculate every dependent display.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleAfterEdit = useCallback(
    async (event: RevoGridCustomEvent<any>) => {
      if (!event.detail) return;
      try {
        await gridOpsRef.current?.recalculateFormulas();
      } catch (error) {
        console.error('[CSV] Failed to recalculate formulas after edit:', error);
      }
      host.setDirty(true);
      await updateSelection(selectedCellRef.current, selectionRangeRef.current);
      // Edit committed/closed: keep the selection box, drop the editing flag.
      collabBindingRef.current?.setLocalAwareness({ editingCell: null });
    },
    [host, updateSelection]
  );

  // Handle edit start - flag the currently-selected cell as actively editing so
  // collaborators see an "editing" indicator (and name label). Reuses the
  // already-translated selectedCellRef rather than re-parsing event coords.
  const handleBeforeEditStart = useCallback(() => {
    if (!collabActiveRef.current) return;
    collabBindingRef.current?.setLocalAwareness({ editingCell: selectedCellRef.current ?? null });
  }, []);

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
      // Column geometry changed -- presence markers must re-measure.
      schedulePresenceRepaint();
    },
    [spreadsheetMeta, schedulePresenceRepaint]
  );

  // Handle cell focus (selection)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleFocusCell = useCallback(
    (event: RevoGridCustomEvent<any>) => {
      // Skip if we're doing programmatic selection (e.g., select-all) or if our
      // own drag is mid-flight and owns the range.
      if (skipFocusHandlerRef.current || suppressGridRangeRef.current) return;
      if (!event.detail) return;
      const { rowIndex, colIndex, type, rowType, column } = event.detail;

      // `afterfocus` names the row section `rowType`; only the earlier
      // `beforecellfocus` calls it `type`. Reading the wrong one leaves
      // `isPinned` undefined, which shifts every pinned-row click down a row.
      const isPinned = (rowType ?? type) === 'rowPinStart';
      const actualRowIndex = translateRowIndex(rowIndex, isPinned);
      // `column.prop` is the sheet-wide column letter, so it survives the frozen
      // boundary that `colIndex` (section-local) does not.
      const actualColIndex = column?.prop
        ? columnLetterToIndex(String(column.prop))
        : toAbsoluteColumn(event.target as Element | null, colIndex, frozenColumnCount);

      const newCell = { row: actualRowIndex, col: actualColIndex };
      updateSelection(
        newCell,
        normalizeRange(actualRowIndex, actualColIndex, actualRowIndex, actualColIndex)
      );
    },
    [translateRowIndex, updateSelection, frozenColumnCount]
  );

  // Handle range selection
  const handleSetRange = useCallback(
    (event: RevoGridCustomEvent<{
      type: string;
      area?: { x: number; y: number; x1: number; y1: number };
      x?: number; y?: number; x1?: number; y1?: number;
    } | null>) => {
      if (!event.detail) return;
      if (suppressGridRangeRef.current) return;

      const x = event.detail.area?.x ?? event.detail.x;
      const y = event.detail.area?.y ?? event.detail.y;
      const x1 = event.detail.area?.x1 ?? event.detail.x1;
      const y1 = event.detail.area?.y1 ?? event.detail.y1;

      if (x === undefined || y === undefined || x1 === undefined || y1 === undefined) return;

      const isPinned = event.detail.type === 'rowPinStart';
      const actualY = translateRowIndex(y, isPinned);
      const actualY1 = translateRowIndex(y1, isPinned);
      // The payload carries no column section, but the overlay that emitted it
      // is the event target and knows which one it is.
      const section = event.target as Element | null;
      const actualX = toAbsoluteColumn(section, x, frozenColumnCount);
      const actualX1 = toAbsoluteColumn(section, x1, frozenColumnCount);

      const newRange = normalizeRange(actualY, actualX, actualY1, actualX1);
      updateSelection({ row: actualY, col: actualX }, newRange);
    },
    [translateRowIndex, updateSelection, frozenColumnCount]
  );

  // Own cell drag-selection so ranges can cross the frozen/pinned boundaries
  // that RevoGrid's built-in drag is clamped to.
  useCellDragSelection({
    containerRef: gridContainerRef,
    gridRef: revoGridRef as RefObject<SectionAwareGrid | null>,
    // Gate on the grid actually being rendered, not just on the tab being
    // active -- the loading tree has no container to bind to.
    enabled: isActive && !isLoading && !loadError,
    // The drag hit-tests and paints in visible rows; the selection it reports
    // has to cross back into logical space.
    onSelectionChange: useCallback((cell, range) => updateSelection(
      cell && { ...cell, row: toLogicalRow(cell.row) },
      range && { ...range, startRow: toLogicalRow(range.startRow), endRow: toLogicalRow(range.endRow) },
    ), [updateSelection, toLogicalRow]),
    suppressGridRangeRef,
  });

  // Handle formula bar input
  const handleFormulaChange = useCallback(
    async (value: string) => {
      if (editingLockedRef.current) return;
      const cell = selectedCellRef.current;
      const gridOps = gridOpsRef.current;
      if (cell && gridOps) {
        await gridOps.updateCell(cell.row, cell.col, value);
        void publishSelectionContext(selectionRangeRef.current);
      }
    },
    [publishSelectionContext]
  );

  /**
   * Paint a logical range across every viewport section it touches and adopt it
   * as the selection. Replaces per-section `setCellsFocus` calls, which could
   * only ever address one section and silently painted nothing when a range
   * straddled a boundary.
   */
  const paintLogicalRange = useCallback(
    async (range: NormalizedSelectionRange, focus?: { row: number; col: number }) => {
      const grid = revoGridRef.current as SectionAwareGrid | null;
      if (!grid) return;
      const sections = await resolveGridSections(grid);
      if (!sections) return;
      // Endpoints can name a filtered-out row (select-all, a column header, a
      // find hit); narrow onto visible rows before either space sees them.
      const snapped = snapRowsToVisible(rowSpaceRef.current, range.startRow, range.endRow);
      if (!snapped) return;
      const logicalRange = { ...range, ...snapped };
      // The stores address visible rows; the range here is logical.
      await paintCrossSectionRange(grid, sections, {
        ...logicalRange,
        startRow: toVisibleRow(logicalRange.startRow),
        endRow: toVisibleRow(logicalRange.endRow),
      });
      void updateSelection(
        focus ?? { row: logicalRange.startRow, col: logicalRange.startCol },
        logicalRange,
      );
    },
    [updateSelection, toVisibleRow]
  );

  /* ----------------------------------------------------------------------- */
  /* Find and column filters                                                  */
  /* ----------------------------------------------------------------------- */

  const [filterDropdown, setFilterDropdown] = useState<{ columnIndex: number; anchor: HTMLElement } | null>(null);
  const [filterValues, setFilterValues] = useState<readonly FilterScalar[]>([]);

  /**
   * Repaint the grid after any view state the column templates read changes.
   * Guarded because this can fire before the custom element has hydrated.
   */
  const repaintGrid = useCallback(() => {
    const grid = revoGridRef.current;
    if (typeof grid?.refresh === 'function') void grid.refresh('all');
  }, []);

  const columnFilters = useColumnFilters(revoGridRef, repaintGrid);
  columnFiltersRef.current = columnFilters;

  useEffect(() => {
    filteredColumnsRef.current = new Set(columnFilters.filters.keys());
    repaintGrid();
    // The engine has already derived the hidden rows for this filter change, so
    // only the mapping needs rebuilding. Every *other* way the row spaces
    // diverge (edits, sorts, row mutations, reloads) goes through
    // `invalidateRowView`, which re-derives the filter first.
    void rebuildRowSpace();
  }, [columnFilters.filters, headerRowCount, repaintGrid, rebuildRowSpace]);

  const setFindHighlight = useCallback((highlight: FindHighlight) => {
    findHighlightRef.current = highlight;
    repaintGrid();
  }, [repaintGrid]);

  /**
   * Snapshot the sheet in the shape the find engines expect: row models indexed
   * by logical row (headers first), plus the mapping that keeps filtered-out
   * rows out of the search.
   */
  const readFindContext = useCallback(async (): Promise<FindContext | null> => {
    const grid = revoGridRef.current;
    if (!grid) return null;
    const [source, pinnedTop] = await Promise.all([grid.getSource('rgRow'), grid.getSource('rowPinStart')]);
    const headerRows = (pinnedTop ?? []).slice(0, headerRowCount);
    return {
      rows: [...headerRows, ...(source ?? [])] as FindContext['rows'],
      columnCount: displayColumnCount,
      mapping: createRowIndexMapping({
        rowCount: headerRows.length + (source?.length ?? 0),
        headerRowCount: headerRows.length,
        trimmedRows: getAppliedTrimmedRows(grid),
      }),
    };
    // `columnFilters.filters` is not read here, but a filter change must re-run
    // the search -- the hook keys its refresh off this callback's identity.
  }, [headerRowCount, displayColumnCount, columnFilters.filters]);

  const find = useSpreadsheetFind({
    readContext: readFindContext,
    // Stable, so `find.open` is stable and the host subscription below does not
    // re-register on every render.
    getSelection: useCallback(() => selectionRangeRef.current, []),
    hasSelection: hasRangeSelection,
    setHighlight: setFindHighlight,
    applyReplacements: useCallback(async (replacements) => {
      const gridOps = gridOpsRef.current;
      if (!gridOps) return;
      for (const replacement of replacements) {
        await gridOps.updateCell(replacement.logicalRow, replacement.columnIndex, replacement.value);
      }
    }, []),
    reveal: useCallback((match) => {
      void (async () => {
        const grid = revoGridRef.current;
        if (!grid) return;
        await paintLogicalRange({
          startRow: match.logicalRow,
          endRow: match.logicalRow,
          startCol: match.columnIndex,
          endCol: match.columnIndex,
        });
        // `scrollToCoordinate` addresses the scrollable body, so the target is
        // the match's *visible* position minus the pinned header rows.
        const mapping = createRowIndexMapping({
          rowCount: headerRowCount + ((await grid.getSource('rgRow'))?.length ?? 0),
          headerRowCount,
          trimmedRows: getAppliedTrimmedRows(grid),
        });
        const visibleRow = mapping.logicalToVisible(match.logicalRow);
        if (visibleRow === undefined) return;
        await grid.scrollToCoordinate({
          x: Math.max(0, match.columnIndex - frozenColumnCount),
          y: Math.max(0, visibleRow - headerRowCount),
        });
      })();
    }, [paintLogicalRange, headerRowCount, frozenColumnCount]),
  });

  // Cmd+F is a native menu accelerator, so the keystroke never reaches this
  // renderer -- the host routes the command to us instead.
  useEffect(() => host.onFindRequested?.(() => find.open()), [host, find.open]);

  const openFilterDropdown = useCallback((columnIndex: number, anchor: HTMLElement) => {
    void (async () => {
      setFilterValues(await columnFilters.distinctValues(columnIndex));
      setFilterDropdown({ columnIndex, anchor });
    })();
  }, [columnFilters]);

  /** Full row/column extent of the grid, for header-click selections. */
  const getGridExtent = useCallback(async () => {
    const grid = revoGridRef.current as SectionAwareGrid | null;
    if (!grid) return null;
    const sections = await resolveGridSections(grid);
    if (!sections) return null;
    // `gridBounds` counts the rows the sections hold, i.e. visible ones.
    const { lastRow, lastCol } = gridBounds(sections);
    return { lastRow: toLogicalRow(lastRow), lastCol };
  }, [toLogicalRow]);

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

        const selection = normalizeRange(0, 0, lastRow, lastColWithData);

        // Paint across every section so the highlight covers pinned header rows
        // and frozen columns as well as the body.
        await paintLogicalRange(selection, { row: 0, col: 0 });
      } finally {
        // Re-enable focus handler after a short delay to allow RevoGrid events to settle
        setTimeout(() => {
          skipFocusHandlerRef.current = false;
        }, 100);
      }
    })();
  }, [paintLogicalRange]);

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
      // Selection, copy and find stay live while locked; anything that writes
      // does not. See the `editingLockedRef` declaration for why.
      const locked = editingLockedRef.current;

      if (cmdOrCtrl && !event.altKey) {
        switch (event.key.toLowerCase()) {
          case 'z':
            if (locked) return;
            event.preventDefault();
            if (event.shiftKey) {
              undoPlugin?.redo();
            } else {
              undoPlugin?.undo();
            }
            return;
          case 'y':
            if (!isMac) {
              if (locked) return;
              event.preventDefault();
              undoPlugin?.redo();
              return;
            }
            break;
          // Clipboard operates on our own logical selection, never on
          // `grid.getSelectedRange()`: that returns the *focused section's*
          // clipped range in section-local coordinates, so for a selection
          // spanning the frozen boundary it would copy the wrong cells without
          // any sign that it had. Our refs are kept in sheet coordinates by
          // every selection path.
          case 'c':
            if (!event.shiftKey && gridOps) {
              event.preventDefault();
              const range = selectionRangeRef.current;
              if (range) {
                await gridOps.copySelection(range);
              }
            }
            return;
          case 'x':
            if (locked) return;
            if (!event.shiftKey && gridOps) {
              event.preventDefault();
              const range = selectionRangeRef.current;
              if (range) {
                await gridOps.cutSelection(range);
              }
            }
            return;
          case 'v':
            if (locked) return;
            if (!event.shiftKey && gridOps) {
              event.preventDefault();
              const cell = selectedCellRef.current;
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
      if (!locked && (event.key === 'Delete' || event.key === 'Backspace')) {
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
    // While locked the editing context menu (insert / delete row, format
    // column, etc.) is meaningless -- let the browser's default selection /
    // copy menu through instead.
    if (editingLockedRef.current) return;
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

      // Never parse the header's text: the column template decorates it with a
      // filter funnel, so `A` renders as `A▼` and reads back as column 9621.
      const colIndex = resolveHeaderColumnIndex(readHeaderColumnTarget(columnHeader), frozenColumnCount);
      if (colIndex !== null) {
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
          // Through the mapping, not `gridRowIndex + headerRowCount`: with a
          // filter on, visible row 0 is whichever logical row survived it.
          const logicalRowIndex = translateRowIndex(gridRowIndex, isPinned);

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
      // Both attributes are section-local; a right-click in the scrollable body
      // must not address the frozen columns or the pinned header rows.
      const isPinnedRow = cell.closest('revogr-data')?.getAttribute('type') === 'rowPinStart';
      const rawRow = parseInt(cell.dataset.rgrow || '', 10);
      const rawCol = parseInt(cell.dataset.rgcol || '', 10);
      const rowIndex = translateRowIndex(rawRow, isPinnedRow);
      const colIndex = toAbsoluteColumn(cell, rawCol, frozenColumnCount);

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
  }, [
    spreadsheetMeta.metadata.columnCount,
    updateSelection,
    translateRowIndex,
    frozenColumnCount,
  ]);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Helper to get column index from header element
  const getColumnIndexFromHeader = useCallback((target: HTMLElement): number | null => {
    const headerCell = target.closest('[data-rgcol]') as HTMLElement | null;
    if (headerCell && headerCell.closest('revogr-header')) {
      return resolveHeaderColumnIndex(readHeaderColumnTarget(headerCell), frozenColumnCount);
    }
    return null;
  }, [frozenColumnCount]);

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

    return translateRowIndex(gridRowIndex, isPinned);
  }, [translateRowIndex]);

  // Selection helpers
  const selectColumn = useCallback((colIndex: number) => {
    void (async () => {
      const extent = await getGridExtent();
      if (!extent) return;
      await paintLogicalRange(normalizeRange(0, colIndex, extent.lastRow, colIndex));
    })();
  }, [getGridExtent, paintLogicalRange]);

  const selectColumnRange = useCallback((startCol: number, endCol: number) => {
    void (async () => {
      const extent = await getGridExtent();
      if (!extent) return;
      const minCol = Math.min(startCol, endCol);
      const maxCol = Math.max(startCol, endCol);
      await paintLogicalRange(normalizeRange(0, minCol, extent.lastRow, maxCol));
    })();
  }, [getGridExtent, paintLogicalRange]);

  const selectRow = useCallback((rowIndex: number) => {
    void (async () => {
      const extent = await getGridExtent();
      if (!extent) return;
      await paintLogicalRange(normalizeRange(rowIndex, 0, rowIndex, extent.lastCol));
    })();
  }, [getGridExtent, paintLogicalRange]);

  const selectRowRange = useCallback((startRow: number, endRow: number) => {
    void (async () => {
      const extent = await getGridExtent();
      if (!extent) return;
      const minRow = Math.min(startRow, endRow);
      const maxRow = Math.max(startRow, endRow);
      await paintLogicalRange(normalizeRange(minRow, 0, maxRow, extent.lastCol));
    })();
  }, [getGridExtent, paintLogicalRange]);

  // Header mouse handlers
  const handleHeaderMouseDown = useCallback((event: React.MouseEvent) => {
    const target = event.target as HTMLElement;

    // The filter funnel sits inside the header cell, so it has to be checked
    // before the header click turns into a whole-column selection.
    const affordance = target.closest('.csv-filter-affordance') as HTMLElement | null;
    if (affordance) {
      const affordanceColumn = getColumnIndexFromHeader(target);
      if (affordanceColumn !== null) {
        event.preventDefault();
        event.stopPropagation();
        openFilterDropdown(affordanceColumn, affordance);
        return;
      }
    }

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
  }, [getColumnIndexFromHeader, getRowIndexFromHeader, selectColumn, selectRow, selectAll, openFilterDropdown]);

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

    // Header pinning is available again now that selection spans the pinned
    // boundary (see selection/crossSectionSelection.ts).
    const isCurrentlyHeader = rowIndex < headerRowCount;
    const isTopRowOrAdjacentToHeader = rowIndex === 0 || rowIndex === headerRowCount;

    // Helper to update both grid data and metadata
    const setHeaderCount = async (count: number) => {
      await gridOps?.updateHeaderRowCount(count);
      spreadsheetMeta.setHeaderRowCount(count);
    };

    if (isCurrentlyHeader) {
      if (rowIndex === headerRowCount - 1) {
        items.push({
          label: 'Remove Header Row',
          action: () => setHeaderCount(headerRowCount - 1),
        });
      }
      if (headerRowCount > 1) {
        items.push({
          label: 'Remove All Header Rows',
          action: () => setHeaderCount(0),
        });
      }
    } else if (isTopRowOrAdjacentToHeader) {
      items.push({
        label: 'Set as Header Row',
        action: () => setHeaderCount(rowIndex + 1),
      });
    } else {
      items.push({
        label: `Set Rows 1-${rowIndex + 1} as Headers`,
        action: () => setHeaderCount(rowIndex + 1),
      });
    }

    items.push({ label: '', action: () => {}, separator: true });

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

    // Freeze is available again now that selection spans the frozen boundary
    // (see selection/crossSectionSelection.ts).
    const isCurrentlyFrozen = colIndex < currentFrozenCount;
    const isAtFrozenBoundary = colIndex === currentFrozenCount;

    if (isCurrentlyFrozen) {
      if (colIndex === currentFrozenCount - 1) {
        items.push({
          label: 'Unfreeze Column',
          action: () => spreadsheetMeta.setFrozenColumnCount(currentFrozenCount - 1),
        });
      }
      if (currentFrozenCount > 1) {
        items.push({
          label: 'Unfreeze All Columns',
          action: () => spreadsheetMeta.setFrozenColumnCount(0),
        });
      }
    } else if (isAtFrozenBoundary) {
      items.push({
        label: 'Freeze Column',
        action: () => spreadsheetMeta.setFrozenColumnCount(colIndex + 1),
      });
    } else {
      items.push({
        label: `Freeze Columns A-${colLetter}`,
        action: () => spreadsheetMeta.setFrozenColumnCount(colIndex + 1),
      });
    }

    items.push({ label: '', action: () => {}, separator: true });

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
            readOnly={isDiffActive}
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
      {!readOnly && find.isOpen && <FindBar find={find} readOnly={isDiffActive} />}
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
              applyGridSource(el, pendingDataRef.current);
              dataLoadedRef.current = true;
            }
          }}
          columns={columns}
          rowHeaders={true}
          // Denser than RevoGrid's 27px default. Its theme hardcodes the
          // matching `line-height`, so revogrid-theme.css restates this value.
          rowSize={24}
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
          onAftercolumnresize={handleColumnResize}
          onBeforeeditstart={handleBeforeEditStart}
          onViewportscroll={schedulePresenceRepaint}
        />
        {isCollabActive && remotePresences.length > 0 && (
          <CollabPresenceOverlay
            presences={remotePresences}
            containerRef={gridContainerRef}
            headerRowCount={headerRowCount}
            repaintKey={presenceRepaintTick}
          />
        )}
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenuItems}
            onClose={handleCloseContextMenu}
          />
        )}
        {filterDropdown && (
          <ColumnFilterDropdown
            key={filterDropdown.columnIndex}
            columnIndex={filterDropdown.columnIndex}
            anchor={filterDropdown.anchor}
            distinctValues={filterValues}
            currentFilter={columnFilters.filters.get(filterDropdown.columnIndex)}
            onApply={(filter) => { void columnFilters.setColumnFilter(filterDropdown.columnIndex, filter); }}
            onClose={() => setFilterDropdown(null)}
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
