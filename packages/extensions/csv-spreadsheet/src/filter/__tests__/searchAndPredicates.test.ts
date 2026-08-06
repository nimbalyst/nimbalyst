// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ColumnFilter } from '../../types';
import { findMatches, moveFindCursor, replaceAll, replacementForMatch } from '../findReplace';
import { createRowIndexMapping } from '../rowIndexMapping';
import { deriveTrimmedRows, matchesColumnFilter } from '../predicates';

describe('filter predicates', () => {
  it.each<[unknown, ColumnFilter, boolean]>([
    ['North', { kind: 'values', values: new Set(['North', 'South']) }, true],
    ['12.5', { kind: 'number', operator: 'greaterThan', value: 10 }, true],
    ['Quarterly Report', { kind: 'text', operator: 'startsWith', value: 'quarterly' }, true],
    ['  ', { kind: 'blank', operator: 'isBlank' }, true],
    ['not a number', { kind: 'number', operator: 'lessThan', value: 10 }, false],
  ])('matches %j against %j', (value, filter, expected) => {
    expect(matchesColumnFilter(value, filter)).toBe(expected);
  });

  it('combines active columns with AND', () => {
    const rows = [
      { A: 'North', B: 12 },
      { A: 'South', B: 12 },
      { A: 'North', B: 4 },
    ];
    const filters = new Map<number, ColumnFilter>([
      [0, { kind: 'text', operator: 'equals', value: 'north' }],
      [1, { kind: 'number', operator: 'greaterThan', value: 10 }],
    ]);
    expect(deriveTrimmedRows(rows, filters)).toEqual({ 1: true, 2: true });
  });
});

describe('find and replace', () => {
  it('skips filtered rows, wraps the cursor, and scopes replace-all to a selection', () => {
    const rows = [
      { A: 'red red', B: 'keep' },
      { A: 'red hidden', B: 'red hidden' },
      { A: 'red visible', B: 'red visible' },
    ];
    const mapping = createRowIndexMapping({ rowCount: rows.length, trimmedRows: { 1: true } });
    const matches = findMatches(rows, 2, 'red', { mapping });

    expect(matches.map(({ logicalRow, columnIndex }) => [logicalRow, columnIndex])).toEqual([
      [0, 0], [0, 0], [2, 0], [2, 1],
    ]);
    expect(moveFindCursor(matches, 0, 'previous').index).toBe(3);

    const result = replaceAll(rows, 2, 'red', 'blue', {
      mapping,
      selection: { startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
    });
    expect(result.replacements).toEqual([
      { logicalRow: 0, columnIndex: 0, value: 'blue blue', replacementCount: 2 },
      { logicalRow: 2, columnIndex: 0, value: 'blue visible', replacementCount: 1 },
    ]);
  });
});

describe('replacementForMatch', () => {
  const rows = [{ A: 'foo' }];
  const match = { logicalRow: 0, columnIndex: 0, start: 0, end: 3, value: 'foo' };

  it('refuses to write when the cell changed under the stored match', () => {
    // Search `foo`, retype the cell as `bar`, then hit Replace: the stored
    // offsets now address text that never matched, so there is nothing to write.
    expect(replacementForMatch([{ A: 'bar' }], match, 'baz')).toBeNull();
    // Same cell, shortened past the match's end.
    expect(replacementForMatch([{ A: 'fo' }], match, 'baz')).toBeNull();
    // The row itself went away (deleted, or filtered out of the context).
    expect(replacementForMatch([], match, 'baz')).toBeNull();
  });

  it('writes when the cell still holds the matched text', () => {
    expect(replacementForMatch(rows, match, 'baz')).toEqual({
      logicalRow: 0, columnIndex: 0, value: 'baz', replacementCount: 1,
    });
    // A case-insensitive search matches a re-cased cell; a case-sensitive one does not.
    expect(replacementForMatch([{ A: 'FOO' }], match, 'baz')).not.toBeNull();
    expect(replacementForMatch([{ A: 'FOO' }], match, 'baz', { caseSensitive: true })).toBeNull();
  });
});
