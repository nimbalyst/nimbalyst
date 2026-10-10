/**
 * Row and column header pointer handling: the filter funnel, the corner
 * select-all, whole row/column selection, and drag-extending across headers.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { readHeaderColumnTarget, resolveHeaderColumnIndex } from '../selection/crossSectionSelection';
import type { RowView } from './useRowView';
import type { Selection } from './useSelection';

export function useHeaderMouse(
  rowView: RowView,
  selection: Pick<Selection, 'selectAll' | 'selectColumn' | 'selectColumnRange' | 'selectRow' | 'selectRowRange'>,
  {
    frozenColumnCount,
    openFilterDropdown,
  }: {
    frozenColumnCount: number;
    openFilterDropdown: (columnIndex: number, anchor: HTMLElement) => void;
  },
) {
  const { translateRowIndex } = rowView;
  const { selectAll, selectColumn, selectColumnRange, selectRow, selectRowRange } = selection;

  // Header drag selection state
  const [headerDrag, setHeaderDrag] = useState<{
    type: 'row' | 'column';
    startIndex: number;
    currentIndex: number;
  } | null>(null);
  const headerDragRef = useRef(headerDrag);
  headerDragRef.current = headerDrag;

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

  return handleHeaderMouseDown;
}
