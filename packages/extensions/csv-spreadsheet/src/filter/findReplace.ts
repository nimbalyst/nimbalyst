import type { CellReplacement, FindCursor, FindMatch, NormalizedSelectionRange } from '../types';
import { columnIndexToLetter } from '../utils/csvParser';
import { logicalRowsForSelection, type RowIndexMapping } from './rowIndexMapping';

export type SearchRow = Readonly<Record<string, unknown>>;

export interface FindOptions {
  /** Required so search cannot silently ignore the active filtered view. */
  mapping: RowIndexMapping;
  caseSensitive?: boolean;
  wholeCell?: boolean;
  selection?: NormalizedSelectionRange;
}

function searchRows(
  rowCount: number,
  mapping: RowIndexMapping,
  selection?: NormalizedSelectionRange,
): readonly number[] {
  if (selection) return logicalRowsForSelection(mapping, selection).logicalRows;
  return mapping.logicalRows.filter((logicalRow) => logicalRow < rowCount);
}

export function findMatches(
  rows: readonly SearchRow[],
  columnCount: number,
  query: string,
  options: FindOptions,
): FindMatch[] {
  if (query === '') return [];
  const mapping = options.mapping;
  const comparableQuery = options.caseSensitive ? query : query.toLocaleLowerCase();
  const matches: FindMatch[] = [];

  for (const logicalRow of searchRows(rows.length, mapping, options.selection)) {
    const row = rows[logicalRow];
    if (!row) continue;
    const startColumn = Math.max(0, options.selection?.startCol ?? 0);
    const endColumn = Math.min(columnCount - 1, options.selection?.endCol ?? columnCount - 1);
    for (let columnIndex = Math.min(startColumn, endColumn); columnIndex <= Math.max(startColumn, endColumn); columnIndex += 1) {
      const value = String(row[columnIndexToLetter(columnIndex)] ?? '');
      const comparableValue = options.caseSensitive ? value : value.toLocaleLowerCase();
      if (options.wholeCell) {
        if (comparableValue === comparableQuery) {
          matches.push({ logicalRow, columnIndex, start: 0, end: value.length, value });
        }
        continue;
      }

      let start = 0;
      while (start <= comparableValue.length - comparableQuery.length) {
        const matchStart = comparableValue.indexOf(comparableQuery, start);
        if (matchStart === -1) break;
        matches.push({
          logicalRow,
          columnIndex,
          start: matchStart,
          end: matchStart + query.length,
          value,
        });
        start = matchStart + Math.max(1, comparableQuery.length);
      }
    }
  }
  return matches;
}

export function createFindCursor(matches: readonly FindMatch[], index = 0): FindCursor {
  if (matches.length === 0) return { index: -1, count: 0, match: null };
  const wrappedIndex = ((index % matches.length) + matches.length) % matches.length;
  return { index: wrappedIndex, count: matches.length, match: matches[wrappedIndex] };
}

export function moveFindCursor(
  matches: readonly FindMatch[],
  currentIndex: number,
  direction: 'next' | 'previous',
): FindCursor {
  return createFindCursor(matches, currentIndex + (direction === 'next' ? 1 : -1));
}

export function replaceMatches(
  rows: readonly SearchRow[],
  matches: readonly FindMatch[],
  replacement: string,
): CellReplacement[] {
  const matchesByCell = new Map<string, FindMatch[]>();
  matches.forEach((match) => {
    const key = `${match.logicalRow}:${match.columnIndex}`;
    const cellMatches = matchesByCell.get(key) ?? [];
    cellMatches.push(match);
    matchesByCell.set(key, cellMatches);
  });

  return [...matchesByCell.values()].map((cellMatches) => {
    const first = cellMatches[0];
    const sourceValue = String(rows[first.logicalRow]?.[columnIndexToLetter(first.columnIndex)] ?? '');
    const value = [...cellMatches]
      .sort((a, b) => b.start - a.start)
      .reduce((current, match) => `${current.slice(0, match.start)}${replacement}${current.slice(match.end)}`, sourceValue);
    return {
      logicalRow: first.logicalRow,
      columnIndex: first.columnIndex,
      value,
      replacementCount: cellMatches.length,
    };
  });
}

export function replaceMatch(
  rows: readonly SearchRow[],
  match: FindMatch,
  replacement: string,
): CellReplacement {
  return replaceMatches(rows, [match], replacement)[0];
}

/** Whether a stored match still describes the cell it was found in. */
function matchIsCurrent(
  rows: readonly SearchRow[],
  match: FindMatch,
  options: Pick<FindOptions, 'caseSensitive' | 'wholeCell'>,
): boolean {
  const row = rows[match.logicalRow];
  if (!row) return false;
  const value = String(row[columnIndexToLetter(match.columnIndex)] ?? '');
  if (options.wholeCell) return value === match.value;
  if (match.start < 0 || match.end > value.length) return false;
  const slice = value.slice(match.start, match.end);
  const expected = match.value.slice(match.start, match.end);
  return options.caseSensitive ? slice === expected : slice.toLocaleLowerCase() === expected.toLocaleLowerCase();
}

/**
 * The write "Replace" should perform, or `null` when there is nothing safe to
 * write.
 *
 * A match is a `(row, column, start, end)` slice captured when the search ran.
 * Any edit to that cell in between -- by the user, a collaborator, or the AI --
 * leaves those offsets addressing different characters, so applying them would
 * overwrite text that never matched the query (search `foo`, retype the cell as
 * `bar`, hit Replace, and part of `bar` is rewritten). Returning `null` tells
 * the caller to re-search instead of writing.
 */
export function replacementForMatch(
  rows: readonly SearchRow[],
  match: FindMatch,
  replacement: string,
  options: Pick<FindOptions, 'caseSensitive' | 'wholeCell'> = {},
): CellReplacement | null {
  if (!matchIsCurrent(rows, match, options)) return null;
  return replaceMatch(rows, match, replacement);
}

export function replaceAll(
  rows: readonly SearchRow[],
  columnCount: number,
  query: string,
  replacement: string,
  options: FindOptions,
): { matches: FindMatch[]; replacements: CellReplacement[] } {
  const matches = findMatches(rows, columnCount, query, options);
  return { matches, replacements: replaceMatches(rows, matches, replacement) };
}
