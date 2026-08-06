import type { ColumnFilter, ColumnFilterState, FilterScalar, TrimmedRows } from '../types';
import { columnIndexToLetter } from '../utils/csvParser';

export type FilterRow = Readonly<Record<string, unknown>>;

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function asFilterScalar(value: unknown): FilterScalar {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value ?? '');
}

export function matchesColumnFilter(value: unknown, filter: ColumnFilter): boolean {
  if (filter.kind === 'values') {
    return filter.values.has(asFilterScalar(value));
  }

  if (filter.kind === 'blank') {
    return filter.operator === 'isBlank' ? isBlank(value) : !isBlank(value);
  }

  if (filter.kind === 'number') {
    if (isBlank(value)) return false;
    const numericValue = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(numericValue)) return false;
    switch (filter.operator) {
      case 'equals': return numericValue === filter.value;
      case 'notEquals': return numericValue !== filter.value;
      case 'greaterThan': return numericValue > filter.value;
      case 'greaterThanOrEqual': return numericValue >= filter.value;
      case 'lessThan': return numericValue < filter.value;
      case 'lessThanOrEqual': return numericValue <= filter.value;
    }
  }

  const source = String(value ?? '');
  const query = filter.value;
  const comparableSource = filter.caseSensitive ? source : source.toLocaleLowerCase();
  const comparableQuery = filter.caseSensitive ? query : query.toLocaleLowerCase();
  switch (filter.operator) {
    case 'contains': return comparableSource.includes(comparableQuery);
    case 'equals': return comparableSource === comparableQuery;
    case 'startsWith': return comparableSource.startsWith(comparableQuery);
  }
}

export function rowMatchesFilters(row: FilterRow, filters: ColumnFilterState): boolean {
  for (const [columnIndex, filter] of filters) {
    if (!matchesColumnFilter(row[columnIndexToLetter(columnIndex)], filter)) return false;
  }
  return true;
}

export function deriveTrimmedRows(rows: readonly FilterRow[], filters: ColumnFilterState): TrimmedRows {
  if (filters.size === 0) return {};
  const trimmedRows: Record<number, boolean> = {};
  rows.forEach((row, physicalRow) => {
    if (!rowMatchesFilters(row, filters)) trimmedRows[physicalRow] = true;
  });
  return trimmedRows;
}

export function distinctColumnValues(rows: readonly FilterRow[], columnIndex: number): ReadonlySet<FilterScalar> {
  const values = new Set<FilterScalar>();
  const prop = columnIndexToLetter(columnIndex);
  rows.forEach((row) => values.add(asFilterScalar(row[prop])));
  return values;
}
