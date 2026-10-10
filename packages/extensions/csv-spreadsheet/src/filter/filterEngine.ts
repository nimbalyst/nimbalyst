import type { ColumnFilter, ColumnFilterState, TrimmedRows } from '../types';
import { deriveTrimmedRows, type FilterRow } from './predicates';

const FILTER_TRIMMED_TYPE = 'csv-spreadsheet-filter';
const appliedTrimmedRows = new WeakMap<object, TrimmedRows>();

export interface TrimmedRowsTarget {
  addTrimmed(trimmedRows: Record<number, boolean>, trimmedType?: string, type?: 'rgRow'): Promise<unknown>;
  trimmedRows?: Record<number, boolean>;
}

export interface FilterSnapshot {
  readonly filters: ColumnFilterState;
  readonly trimmedRows: TrimmedRows;
}

export interface SpreadsheetFilterEngine {
  getSnapshot(): FilterSnapshot;
  setColumnFilter(columnIndex: number, filter: ColumnFilter | null): Promise<FilterSnapshot>;
  clear(): Promise<FilterSnapshot>;
  refresh(): Promise<FilterSnapshot>;
}

export async function applyTrimmedRows(target: TrimmedRowsTarget, trimmedRows: TrimmedRows): Promise<void> {
  const mutableTrimmedRows = { ...trimmedRows };
  const result = await target.addTrimmed(mutableTrimmedRows, FILTER_TRIMMED_TYPE, 'rgRow');
  if (result && typeof result === 'object' && 'defaultPrevented' in result && result.defaultPrevented === true) {
    throw new Error('RevoGrid prevented the spreadsheet filter from applying');
  }
  appliedTrimmedRows.set(target, mutableTrimmedRows);
}

export function getAppliedTrimmedRows(target: object): TrimmedRows {
  const registered = appliedTrimmedRows.get(target);
  if (registered) return registered;
  const candidate = target as { trimmedRows?: TrimmedRows };
  return candidate.trimmedRows ?? {};
}

/**
 * Rows the user hid are trimmed the same way filtered-out rows are, so the two
 * compose: one trimmed set, one row mapping, and unhiding a row a filter also
 * excludes leaves it excluded.
 */
export function combineTrimmedRows(filtered: TrimmedRows, hidden: readonly number[]): TrimmedRows {
  if (hidden.length === 0) return filtered;
  const combined: Record<number, boolean> = { ...filtered };
  for (const row of hidden) if (row >= 0) combined[row] = true;
  return combined;
}

export function createSpreadsheetFilterEngine(
  target: TrimmedRowsTarget,
  getRows: () => readonly FilterRow[],
  /** Body (physical) indexes of rows the user hid. */
  getHiddenRows: () => readonly number[] = () => [],
): SpreadsheetFilterEngine {
  let filters = new Map<number, ColumnFilter>();
  let trimmedRows: TrimmedRows = {};

  const refresh = async (): Promise<FilterSnapshot> => {
    trimmedRows = combineTrimmedRows(deriveTrimmedRows(getRows(), filters), getHiddenRows());
    await applyTrimmedRows(target, trimmedRows);
    return { filters: new Map(filters), trimmedRows };
  };

  return {
    getSnapshot: () => ({ filters: new Map(filters), trimmedRows }),
    async setColumnFilter(columnIndex, filter) {
      const nextFilters = new Map(filters);
      if (filter) nextFilters.set(columnIndex, filter);
      else nextFilters.delete(columnIndex);
      filters = nextFilters;
      return refresh();
    },
    async clear() {
      filters = new Map();
      return refresh();
    },
    refresh,
  };
}
