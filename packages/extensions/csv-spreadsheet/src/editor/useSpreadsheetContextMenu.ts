/**
 * The right-click menu: hit-testing which target was clicked (cell, row
 * header, column header), adjusting the selection to it, and building the
 * matching item list.
 */

import { useCallback, useMemo, useState } from 'react';
import type { UseSpreadsheetMetadataResult } from '../hooks/useSpreadsheetMetadata';
import {
  readHeaderColumnTarget,
  resolveHeaderColumnIndex,
  toAbsoluteColumn,
} from '../selection/crossSectionSelection';
import type { EditorCore } from './editorCore';
import type { RowView } from './useRowView';
import type { Selection } from './useSelection';
import type { Formatting } from './formatting';
import { normalizeRange } from './editorUtils';
import {
  buildCellMenuItems,
  buildColumnHeaderMenuItems,
  buildRowHeaderMenuItems,
  type ContextMenuDeps,
} from './contextMenus';

interface ContextMenuState {
  x: number;
  y: number;
  isRowHeader: boolean;
  rowIndex: number | null;
  isColumnHeader: boolean;
  colIndex: number | null;
}

export function useSpreadsheetContextMenu(
  core: EditorCore,
  spreadsheetMeta: UseSpreadsheetMetadataResult,
  rowView: RowView,
  { updateSelection }: Pick<Selection, 'updateSelection'>,
  formatting: Formatting,
) {
  const { editingLockedRef, gridContainerRef, selectionRangeRef, selectedCellRef, gridOpsRef } = core;
  const { translateRowIndex } = rowView;
  const { columnCount, frozenColumnCount, headerRowCount, columnFormats } = spreadsheetMeta.metadata;
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

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

          updateSelection({ row: logicalRowIndex, col: 0 }, normalizeRange(logicalRowIndex, 0, logicalRowIndex, columnCount - 1));
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
    columnCount,
    updateSelection,
    translateRowIndex,
    frozenColumnCount,
  ]);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const { setFormatDialogColumn, setCellFormatOpen, applyCellStyle, applyDetectedColumnType } = formatting;
  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return [];
    const deps: ContextMenuDeps = {
      gridOps: gridOpsRef.current,
      meta: spreadsheetMeta,
      headerRowCount,
      updateSelection,
      openCellFormat: () => {
        setContextMenu(null);
        setCellFormatOpen(true);
      },
      openColumnFormat: (columnIndex) => {
        setContextMenu(null);
        setFormatDialogColumn(columnIndex);
      },
      applyCellStyle,
      applyDetectedColumnType: (columnIndex) => {
        setContextMenu(null);
        void applyDetectedColumnType(columnIndex);
      },
      selectionRange: selectionRangeRef.current,
      hiddenRows: spreadsheetMeta.metadata.hiddenRows,
      hiddenCols: spreadsheetMeta.metadata.hiddenCols,
    };
    if (contextMenu.isColumnHeader && contextMenu.colIndex !== null) {
      return buildColumnHeaderMenuItems(contextMenu.colIndex, { frozenColumnCount, columnFormats }, deps);
    }
    if (contextMenu.isRowHeader && contextMenu.rowIndex !== null) {
      return buildRowHeaderMenuItems(contextMenu.rowIndex, deps);
    }
    return buildCellMenuItems(selectedCellRef.current, selectionRangeRef.current, deps);
  }, [contextMenu, gridOpsRef, spreadsheetMeta, headerRowCount, updateSelection, frozenColumnCount, columnFormats,
      setCellFormatOpen, setFormatDialogColumn, applyCellStyle, applyDetectedColumnType, selectedCellRef, selectionRangeRef]);

  return { contextMenu, contextMenuItems, handleContextMenu, handleCloseContextMenu };
}
