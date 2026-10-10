// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { autoFitWidth, rowDefinitionsFor, rowHeightsFor, wrapLineCount } from '../rowSizing';
import { createRowIndexMapping } from '../../filter/rowIndexMapping';

/** Every character is 10px wide. */
const measure = (text: string) => text.length * 10;

describe('row sizing', () => {
  it('word-wraps, keeps explicit line breaks, and breaks a word wider than the cell', () => {
    expect(wrapLineCount('aaa bbb ccc', 70, measure)).toBe(2);
    expect(wrapLineCount('one\ntwo', 500, measure)).toBe(2);
    expect(wrapLineCount('abcdefghijklmnopqrst', 50, measure)).toBe(4);
    expect(wrapLineCount('', 50, measure)).toBe(1);
  });

  it('takes the tallest wrapped cell per row unless the user set the height', () => {
    const heights = rowHeightsFor({ 3: 60 }, [
      { row: 1, text: 'aaa bbb ccc ddd', width: 86 },
      { row: 1, text: 'x', width: 86 },
      { row: 3, text: 'aaa bbb ccc ddd eee fff', width: 86 },
      { row: 2, text: 'short', width: 200 },
    ], measure);
    expect(heights.get(1)).toBe(2 * 16 + 8);
    expect(heights.get(3)).toBe(60);
    expect(heights.has(2)).toBe(false);
  });

  it('maps logical heights to section indexes and skips hidden or filtered rows', () => {
    // Header row 0 pinned; body rows 1..5 with physical row 1 (logical 2) trimmed.
    const mapping = createRowIndexMapping({ rowCount: 6, headerRowCount: 1, trimmedRows: { 1: true } });
    const definitions = rowDefinitionsFor(new Map([[0, 30], [2, 50], [4, 40], [5, 24]]), 1, (row) => mapping.logicalToVisible(row));
    expect(definitions).toEqual([
      { type: 'rowPinStart', index: 0, size: 30 },
      { type: 'rgRow', index: 2, size: 40 },
    ]);
  });

  it('auto-fits a column to its widest line within bounds', () => {
    expect(autoFitWidth(['ab', 'abcdef\nx'], measure)).toBe(80);
    expect(autoFitWidth([''], measure)).toBe(40);
    expect(autoFitWidth(['a'.repeat(200)], measure)).toBe(600);
  });
});
