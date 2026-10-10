/**
 * The filtered-view row space: invalidation after mutations, whole-source
 * loads, grid attachment, and the visible <-> logical row conversions every
 * DOM/event entry point goes through. See `EditorCore.rowSpaceRef`.
 */

import { useCallback, useRef } from 'react';
import type { RevoGridElement } from '../revogrid-types';
import type { GridSourceData } from '../utils/gridOperations';
import { createRowIndexMapping, logicalRowForGridRow } from '../filter/rowIndexMapping';
import { getAppliedTrimmedRows } from '../filter/filterEngine';
import type { EditorCore } from './editorCore';
import { readGridSources } from '../commands/gridCommandExecutor';

export function useRowView(core: EditorCore, headerRowCount: number) {
  const { revoGridRef, spreadsheetMetaRef, rowSpaceRef, columnFiltersRef, hydration, dataLoadedRef, pendingDataRef } = core;

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
    const { source, pinnedTop } = await readGridSources(grid);
    // Pinned rows (header plus frozen) are never trimmed; the grid's own
    // section is the truth even before React commits a metadata change.
    const headerRows = pinnedTop.length;
    rowSpaceRef.current = createRowIndexMapping({
      rowCount: headerRows + (source?.length ?? 0),
      headerRowCount: headerRows,
      trimmedRows: getAppliedTrimmedRows(grid),
    });
    for (const listener of core.rowSpaceListeners) listener();
  }, [revoGridRef, spreadsheetMetaRef, rowSpaceRef, core]);

  const runRowViewInvalidation = useCallback(async () => {
    await columnFiltersRef.current?.refresh();
    await rebuildRowSpace();
  }, [columnFiltersRef, rebuildRowSpace]);

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

  const attachGrid = useCallback((grid: RevoGridElement | null) => {
    revoGridRef.current = grid;
    if (!grid) {
      // RevoGrid's React wrapper creates a new merged ref on every render,
      // calling null then the SAME element. That is not a new hydration: a
      // readiness state update would otherwise reset itself forever and
      // reapply old content over edits. Confirm detach after the commit.
      queueMicrotask(() => {
        if (!revoGridRef.current) {
          hydration.attach(null);
          dataLoadedRef.current = false;
        }
      });
      return;
    }
    hydration.attach(grid);
    if (!dataLoadedRef.current && pendingDataRef.current) {
      applyGridSource(grid, pendingDataRef.current);
      dataLoadedRef.current = true;
    }
  }, [revoGridRef, hydration, dataLoadedRef, pendingDataRef, applyGridSource]);

  const toLogicalRow = useCallback(
    (visibleRow: number) => rowSpaceRef.current.visibleToLogical(visibleRow) ?? visibleRow,
    [rowSpaceRef],
  );
  const toVisibleRow = useCallback(
    (logicalRow: number) => rowSpaceRef.current.logicalToVisible(logicalRow) ?? logicalRow,
    [rowSpaceRef],
  );

  const translateRowIndex = useCallback((gridRowIndex: number, isPinned: boolean): number => (
    logicalRowForGridRow(rowSpaceRef.current, gridRowIndex, isPinned, headerRowCount)
  ), [rowSpaceRef, headerRowCount]);

  return {
    rebuildRowSpace,
    invalidateRowView,
    applyGridSource,
    attachGrid,
    toLogicalRow,
    toVisibleRow,
    translateRowIndex,
  };
}

export type RowView = ReturnType<typeof useRowView>;
