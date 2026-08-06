import type { FindMatch } from '../types';
import { columnIndexToLetter } from '../utils/csvParser';

/**
 * Which cells the grid should paint as find matches.
 *
 * Keyed by each row's *model object* rather than by a row index: RevoGrid hands
 * `cellProperties` pinned and body rows in separate index spaces, and an active
 * filter shifts the body one again, so an index-keyed lookup would highlight the
 * wrong row as soon as either is in play. Object identity survives both.
 *
 * The inner value is `true` for the cursor's current match and `false` for the
 * other matches in the same cell, so a cell containing both keeps the stronger
 * one.
 */
export type FindHighlight = ReadonlyMap<object, ReadonlyMap<string, boolean>>;

export const EMPTY_FIND_HIGHLIGHT: FindHighlight = new Map();

export function buildFindHighlight(
  rowsByLogicalIndex: readonly object[],
  matches: readonly FindMatch[],
  currentIndex: number,
): FindHighlight {
  const highlight = new Map<object, Map<string, boolean>>();

  matches.forEach((match, index) => {
    const row = rowsByLogicalIndex[match.logicalRow];
    if (!row) return;
    const columns = highlight.get(row) ?? new Map<string, boolean>();
    const prop = columnIndexToLetter(match.columnIndex);
    columns.set(prop, columns.get(prop) === true || index === currentIndex);
    highlight.set(row, columns);
  });

  return highlight;
}
