/**
 * Per-mount grid plumbing: the grid operations (and command executor) every
 * mutation goes through, AI cell flashes, and the editor API registered with the host.
 */

import { useEffect, useRef } from 'react';
import { createGridOperations } from '../utils/gridOperations';
import { columnIndexToLetter } from '../utils/csvParser';
import { createSpreadsheetEditorAPI } from '../editorAPI';
import { createRowIndexMapping, logicalRowsForSelection } from '../filter/rowIndexMapping';
import { getAppliedTrimmedRows } from '../filter/filterEngine';
import {
  notifySpreadsheetCellFlash,
  subscribeSpreadsheetCellFlash,
  type AICellFlashEventDetail,
} from '../aiCellFlash';
import type { EditorCore } from './editorCore';
import { DISPLAY_BUFFER_ROWS } from './editorUtils';

export function useGridOperationsSetup(
  core: EditorCore,
  { isLoading, filePath, invalidateRowView }: {
    isLoading: boolean;
    filePath: string;
    invalidateRowView: () => Promise<void>;
  },
): void {
  const {
    revoGridRef, gridOpsRef, collabBindingRef, spreadsheetMetaRef, hostRef,
    formulaViewState, editorRef, aiFlashRef, selectionRangeRef, selectedCellRef, restoreSelectionRef,
  } = core;
  const aiFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiFlashPaintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiFlashCellsRef = useRef<((cells: readonly { row: number; column: number }[]) => Promise<void>) | null>(null);

  // Initialize grid operations once for this mounted grid. The host and metadata
  // objects can be recreated by parent renders, but rebuilding the executor here
  // would discard its undo/redo stacks.
  useEffect(() => {
    const grid = revoGridRef.current;
    if (isLoading || !grid) return;

    const gridOps = createGridOperations(revoGridRef, {
      getMeta: () => spreadsheetMetaRef.current.getMetadata(),
      setMeta: (meta, origin) => spreadsheetMetaRef.current.replaceMetadata(meta, origin),
      getDelimiter: () => spreadsheetMetaRef.current.getDelimiter(),
      getFileLayout: () => spreadsheetMetaRef.current.getFileLayout(),
      getTrimmedRows: () => getAppliedTrimmedRows(grid),
      formulaViewState,
      bufferRows: DISPLAY_BUFFER_ROWS,
      onDirty: () => hostRef.current.setDirty(true),
      // Every command runs inside the collab mutation barrier, which publishes
      // to the Y.Doc when it finishes; without it the only push is the 1s poll,
      // and the teardown flush cannot read the grid to recover those edits.
      runMutation: (operation) => {
        const binding = collabBindingRef.current;
        return binding ? binding.mutate(operation) : operation();
      },
      // A mutation can invalidate an active filter's hidden rows and the row
      // mapping, so every command refreshes the filtered view.
      afterWrite: invalidateRowView,
      getSelection: () => ({ cell: selectedCellRef.current, range: selectionRangeRef.current }),
      restoreSelection: (selection) => restoreSelectionRef.current?.(selection),
    });
    gridOpsRef.current = gridOps;
    const ownEditor = editorRef.current;

    const flashCells = async (cells: readonly { row: number; column: number }[]) => {
      const { source, pinnedTop } = await gridOps.getData();
      // The pinned section: header rows plus frozen rows.
      const headerRows = pinnedTop.length;
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
          delimiter: current.getDelimiter(),
        };
      },
      getSelection: async () => {
        const range = selectionRangeRef.current;
        if (!range) return null;
        const { source, pinnedTop } = await gridOps.getData();
        const headerRows = pinnedTop.length;
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
      getDisplayValue: (model, prop) => formulaViewState.getDisplayValue(model, prop),
      flashCells: (cells) => notifySpreadsheetCellFlash(filePath, cells),
      getColumnFilters: () => core.columnFiltersRef.current?.filters ?? new Map(),
    }));

    return () => {
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
}
