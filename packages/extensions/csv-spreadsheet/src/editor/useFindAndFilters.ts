/**
 * Find/replace and per-column filters. Both feed view state the column
 * templates sample at paint time (`findHighlightRef`, `filteredColumnsRef`),
 * so neither a search keystroke nor a filter change rebuilds the columns.
 */

import { useCallback, useEffect, useState } from 'react';
import type { EditorHost } from '@nimbalyst/extension-sdk';
import type { FilterScalar } from '../types';
import { useSpreadsheetFind, type FindContext } from '../hooks/useSpreadsheetFind';
import { useColumnFilters } from '../hooks/useColumnFilters';
import { createRowIndexMapping } from '../filter/rowIndexMapping';
import { getAppliedTrimmedRows } from '../filter/filterEngine';
import { pinnedRowCount } from '../sheetMeta/formatting';
import type { FindHighlight } from '../filter/findHighlight';
import type { EditorCore } from './editorCore';
import type { RowView } from './useRowView';
import type { Selection } from './useSelection';
import { readGridSources } from '../commands/gridCommandExecutor';

export function useFindAndFilters(
  host: EditorHost,
  core: EditorCore,
  rowView: RowView,
  { paintLogicalRange, hasRangeSelection }: Pick<Selection, 'paintLogicalRange' | 'hasRangeSelection'>,
  { headerRowCount, frozenColumnCount, displayColumnCount }: {
    headerRowCount: number;
    frozenColumnCount: number;
    displayColumnCount: number;
  },
) {
  const { revoGridRef, columnFiltersRef, filteredColumnsRef, findHighlightRef, selectionRangeRef, gridOpsRef, repaintGrid } = core;
  const { rebuildRowSpace } = rowView;

  const [filterDropdown, setFilterDropdown] = useState<{ columnIndex: number; anchor: HTMLElement } | null>(null);
  const [filterValues, setFilterValues] = useState<readonly FilterScalar[]>([]);

  const columnFilters = useColumnFilters(revoGridRef, repaintGrid, () => {
    const meta = core.spreadsheetMetaRef.current.getMetadata();
    const pinned = pinnedRowCount(meta);
    return meta.hiddenRows.filter((row) => row >= pinned).map((row) => row - pinned);
  });
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
    const { source, pinnedTop } = await readGridSources(grid);
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
      // Replace-all is one batch: one undo step, one publish.
      await gridOps.updateCells(replacements.map((replacement) => ({
        row: replacement.logicalRow,
        column: replacement.columnIndex,
        value: replacement.value,
      })));
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
          rowCount: headerRowCount + (await readGridSources(grid)).source.length,
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

  return { columnFilters, find, filterDropdown, setFilterDropdown, filterValues, openFilterDropdown };
}
