import type { ColumnFilter, ColumnFilterState, FilterScalar, TrimmedRows } from '../types';
import { columnIndexToLetter } from '../utils/csvParser';
import { parseDateTime, parseNumber } from '../utils/formatters';

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

  if (filter.kind === 'date') {
    if (isBlank(value)) return false;
    const parsed = parseDateTime(
      typeof value === 'number' || typeof value === 'string' ? value : String(value),
    );
    if (parsed === null) return false;
    const time = parsed.getTime();
    switch (filter.operator) {
      case 'before': return time < filter.value;
      case 'after': return time > filter.value;
      case 'between': return time >= filter.value && time <= (filter.valueEnd ?? filter.value);
      case 'on': {
        // `on` means the whole calendar day the bound falls in, so a datetime
        // cell still matches the date the user picked.
        const dayStart = new Date(filter.value);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        return time >= dayStart.getTime() && time < dayEnd.getTime();
      }
    }
  }

  if (filter.kind === 'number') {
    if (isBlank(value)) return false;
    // `parseNumber`, not `Number(...)`: a currency column holds `$1,200`, which
    // `Number` reads as NaN and would drop from every numeric filter.
    const numericValue = typeof value === 'number'
      ? value
      : parseNumber(String(value).trim());
    if (numericValue === null || !Number.isFinite(numericValue)) return false;
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
