/**
 * Session-only column filter state.
 *
 * Filters are view state and nothing else: they are never written to the CSV
 * metadata comment, `.csvmeta`, collab, or storage, so reopening a file shows
 * every row again (decided 2026-08-04).
 *
 * `createSpreadsheetFilterEngine` wants a synchronous row reader, but RevoGrid
 * only hands its source out asynchronously, so the rows are snapshotted into a
 * ref immediately before each apply.
 */

import { useCallback, useRef, useState } from 'react';
import type { RevoGridElement } from '../revogrid-types';
import type { ColumnFilter, ColumnFilterState, FilterScalar } from '../types';
import {
  createSpreadsheetFilterEngine,
  type SpreadsheetFilterEngine,
} from '../filter/filterEngine';
import { distinctColumnValues, type FilterRow } from '../filter/predicates';
import { readGridSources } from '../commands/gridCommandExecutor';

export interface ColumnFilters {
  filters: ColumnFilterState;
  /** Distinct values in a column, ordered for display. */
  distinctValues: (columnIndex: number) => Promise<readonly FilterScalar[]>;
  setColumnFilter: (columnIndex: number, filter: ColumnFilter | null) => Promise<void>;
  clearAll: () => Promise<void>;
  /**
   * Re-derive the hidden rows from the sheet's *current* values.
   *
   * Filters are computed from a snapshot, so any mutation invalidates them: a
   * cell edited out of a filter's match set stays visible, and a sort leaves
   * the trimmed physical indexes pointing at the old row order. Callers go
   * through the editor's single invalidation path rather than calling this
   * directly.
   */
  refresh: () => Promise<void>;
}

function compareScalars(a: FilterScalar, b: FilterScalar): number {
  const numericA = typeof a === 'number' ? a : Number(a);
  const numericB = typeof b === 'number' ? b : Number(b);
  if (Number.isFinite(numericA) && Number.isFinite(numericB)) return numericA - numericB;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

export function useColumnFilters(
  gridRef: React.RefObject<RevoGridElement | null>,
  onFiltersChanged: () => void,
  /** Body (physical) indexes of rows the user hid; trimmed along with the filtered ones. */
  getHiddenRows: () => readonly number[] = () => [],
): ColumnFilters {
  const getHiddenRowsRef = useRef(getHiddenRows);
  getHiddenRowsRef.current = getHiddenRows;
  /** Whether the last apply trimmed hidden rows, so unhiding the last one still re-applies. */
  const appliedHiddenRef = useRef(false);
  const [filters, setFilters] = useState<ColumnFilterState>(new Map());
  const rowsRef = useRef<readonly FilterRow[]>([]);
  const engineRef = useRef<SpreadsheetFilterEngine | null>(null);

  /** Snapshot the live body rows and return the engine bound to this grid. */
  const readyEngine = useCallback(async (): Promise<SpreadsheetFilterEngine | null> => {
    const grid = gridRef.current;
    if (!grid) return null;
    rowsRef.current = (await readGridSources(grid)).source as readonly FilterRow[];
    if (!engineRef.current) {
      engineRef.current = createSpreadsheetFilterEngine(
        grid as unknown as Parameters<typeof createSpreadsheetFilterEngine>[0],
        () => rowsRef.current,
        () => {
          const hidden = getHiddenRowsRef.current();
          appliedHiddenRef.current = hidden.length > 0;
          return hidden;
        },
      );
    }
    return engineRef.current;
  }, [gridRef]);

  const distinctValues = useCallback(
    async (columnIndex: number): Promise<readonly FilterScalar[]> => {
      const grid = gridRef.current;
      if (!grid) return [];
      const rows = (await readGridSources(grid)).source as readonly FilterRow[];
      return [...distinctColumnValues(rows, columnIndex)].sort(compareScalars);
    },
    [gridRef],
  );

  const apply = useCallback(
    async (run: (engine: SpreadsheetFilterEngine) => Promise<{ filters: ColumnFilterState }>) => {
      const engine = await readyEngine();
      if (!engine) return;
      setFilters((await run(engine)).filters);
      onFiltersChanged();
    },
    [readyEngine, onFiltersChanged],
  );

  // Read through a ref so `refresh` stays stable: it is wired into the editor's
  // invalidation path, which must not be rebuilt on every filter change.
  const hasFiltersRef = useRef(false);
  hasFiltersRef.current = filters.size > 0;

  return {
    filters,
    distinctValues,
    setColumnFilter: useCallback(
      (columnIndex, filter) => apply((engine) => engine.setColumnFilter(columnIndex, filter)),
      [apply],
    ),
    clearAll: useCallback(() => apply((engine) => engine.clear()), [apply]),
    refresh: useCallback(async () => {
      // Nothing is trimmed without an active filter or a hidden row, so an edit
      // on a plain sheet does no engine work.
      if (!hasFiltersRef.current && getHiddenRowsRef.current().length === 0 && !appliedHiddenRef.current) return;
      const engine = await readyEngine();
      // The filter set itself is unchanged; only the derived hidden rows move,
      // so this deliberately does not touch React state.
      await engine?.refresh();
    }, [readyEngine]),
  };
}
