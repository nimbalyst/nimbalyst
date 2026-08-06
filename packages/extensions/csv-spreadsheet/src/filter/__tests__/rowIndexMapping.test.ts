// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TrimmedRows } from '../../types';
import { createRowIndexMapping, logicalRowForGridRow, logicalToVisible, visibleToLogical } from '../rowIndexMapping';
import { snapRowsToVisible } from '../visibleRange';

interface MappingCase {
  name: string;
  rowCount: number;
  trimmedRows: TrimmedRows;
  visibleRange: readonly [number, number];
  expected: number[];
}

describe('row index mapping', () => {
  it.each<MappingCase>([
    {
      name: 'expands a visible range across hidden rows into ordered logical rows',
      rowCount: 8,
      trimmedRows: { 2: true, 3: true, 5: true },
      visibleRange: [1, 3] as const,
      expected: [1, 4, 6],
    },
    {
      name: 'is identity when no rows are filtered',
      rowCount: 5,
      trimmedRows: {},
      visibleRange: [1, 3] as const,
      expected: [1, 2, 3],
    },
  ])('$name', ({ rowCount, trimmedRows, visibleRange, expected }) => {
    const mapping = createRowIndexMapping({ rowCount, trimmedRows });
    expect(mapping.expandVisibleRange(...visibleRange).logicalRows).toEqual(expected);
  });

  it('round-trips visible logical rows and has no visible position for hidden rows', () => {
    const mapping = createRowIndexMapping({ rowCount: 7, trimmedRows: { 1: true, 4: true } });

    for (const logicalRow of mapping.logicalRows) {
      const visibleRow = logicalToVisible(mapping, logicalRow);
      expect(visibleRow).toBeDefined();
      expect(visibleToLogical(mapping, visibleRow!)).toBe(logicalRow);
    }
    expect(logicalToVisible(mapping, 1)).toBeUndefined();
    expect(logicalToVisible(mapping, 4)).toBeUndefined();
  });
});

describe('snapRowsToVisible', () => {
  // rowCount 8, hiding 1, 4 and 7 leaves visible logical rows 0, 2, 3, 5, 6.
  const mapping = createRowIndexMapping({ rowCount: 8, trimmedRows: { 1: true, 4: true, 7: true } });

  it.each([
    // Both endpoints hidden: narrow inward rather than returning nothing.
    { name: 'narrows both endpoints inward', span: [1, 4] as const, expected: { startRow: 2, endRow: 3 } },
    { name: 'keeps a span whose endpoints are visible', span: [2, 5] as const, expected: { startRow: 2, endRow: 5 } },
    { name: 'narrows a trailing hidden endpoint', span: [5, 7] as const, expected: { startRow: 5, endRow: 6 } },
    { name: 'accepts a reversed span', span: [6, 2] as const, expected: { startRow: 2, endRow: 6 } },
    { name: 'covers a single visible row', span: [3, 3] as const, expected: { startRow: 3, endRow: 3 } },
  ])('$name', ({ span, expected }) => {
    expect(snapRowsToVisible(mapping, span[0], span[1])).toEqual(expected);
  });

  it('returns null when the span covers only hidden rows', () => {
    expect(snapRowsToVisible(mapping, 4, 4)).toBeNull();
    expect(snapRowsToVisible(createRowIndexMapping({ rowCount: 3, trimmedRows: { 0: true, 1: true, 2: true } }), 0, 2)).toBeNull();
  });
});

describe('logicalRowForGridRow', () => {
  // One pinned header row plus five body rows, with the first body row (logical
  // row 1) filtered out. RevoGrid renumbers what is left, so body `data-rgrow`
  // 0 is the row the user sees first -- logical row 2.
  const mapping = createRowIndexMapping({ rowCount: 6, headerRowCount: 1, trimmedRows: { 0: true } });

  it('resolves a row-header action on the first visible body row to the row the user sees', () => {
    expect(logicalRowForGridRow(mapping, 0, false, 1)).toBe(2);
    expect(logicalRowForGridRow(mapping, 1, false, 1)).toBe(3);
    // Pinned header rows are never trimmed, so they map straight through.
    expect(logicalRowForGridRow(mapping, 0, true, 1)).toBe(0);
  });

  it('is the identity shift with nothing filtered', () => {
    const unfiltered = createRowIndexMapping({ rowCount: 6, headerRowCount: 1 });
    expect(logicalRowForGridRow(unfiltered, 0, false, 1)).toBe(1);
    // Past the end of the mapping, fall back rather than resolving a wrong row.
    expect(logicalRowForGridRow(unfiltered, 99, false, 1)).toBe(100);
  });
});
