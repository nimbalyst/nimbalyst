import { describe, it, expect } from 'vitest';
// Pure-utility imports only. Do NOT import from `../TableTransformer` here -
// that file transitively imports the markdown directory which has a
// pre-existing broken `@lexical/extension` resolution and would fail
// vitest's module graph. See the comment in `tableRowSizeGuard.ts` for
// the full background. The threshold + check live in their own file so
// the regression is exercisable.
import {
  MAX_TABLE_ROW_BYTES,
  isTableRowOversized,
} from '../tableRowSizeGuard';

// Regression coverage for nimbalyst#321. Reporter @aawbeck described a
// crash-on-load loop triggered by a 442KB markdown file containing one
// table with 83 rows of ~5,451 chars per row (5 cells of ~1,090 chars
// each). The TableTransformer's `$createTableCell` path recursively
// calls `$convertFromEnhancedMarkdownString` for each cell on the main
// thread inside a single Lexical `editor.update()` transaction. With
// 415 cells of ~1,090 chars each the cumulative synchronous node
// allocation exhausts the V8 heap and the main process crashes at a
// TurboFan integrity-level assertion (SIGTRAP). The next launch
// re-opens the same file (restoreTabs: true) and the loop repeats.

describe('isTableRowOversized (issue #321)', () => {
  describe('threshold sits above legitimate use and below the #321 repro', () => {
    it('is above the legitimate-wide-table bound (10 cols x 400 chars)', () => {
      const legitWide = 4_400;
      expect(MAX_TABLE_ROW_BYTES).toBeGreaterThan(legitWide);
    });

    it('is below the #321 repro row size (5,451 chars)', () => {
      const reproRow = 5_451;
      expect(MAX_TABLE_ROW_BYTES).toBeLessThan(reproRow);
    });
  });

  describe('passes legitimate row sizes', () => {
    it('returns false for an empty row', () => {
      expect(isTableRowOversized('')).toBe(false);
    });

    it('returns false for a tiny row', () => {
      expect(isTableRowOversized('| a | b | c |')).toBe(false);
    });

    it('returns false for a row right at the threshold boundary minus 1', () => {
      const row = 'X'.repeat(MAX_TABLE_ROW_BYTES);
      expect(isTableRowOversized(row)).toBe(false);
    });

    it('returns false for a 10-column row of 400-char cells (~4.4KB)', () => {
      const cell = 'a'.repeat(400);
      const row = '| ' + Array(10).fill(cell).join(' | ') + ' |';
      expect(isTableRowOversized(row)).toBe(false);
    });
  });

  describe('blocks oversized rows', () => {
    it('returns true for a row exceeding the threshold by 1', () => {
      const row = 'X'.repeat(MAX_TABLE_ROW_BYTES + 1);
      expect(isTableRowOversized(row)).toBe(true);
    });

    it('returns true for the #321 repro row shape (5 cells of 1090 chars each)', () => {
      // 1,090-char cells x 5 cells + pipes / spaces is ~5,451 chars,
      // matching the @aawbeck repro.
      const cell = 'X'.repeat(1_090);
      const row = `| ${cell} | ${cell} | ${cell} | ${cell} | ${cell} |`;
      expect(row.length).toBeGreaterThan(MAX_TABLE_ROW_BYTES);
      expect(isTableRowOversized(row)).toBe(true);
    });

    it('returns true for a very long single-cell row (10KB)', () => {
      const row = '| ' + 'Y'.repeat(10_000) + ' |';
      expect(isTableRowOversized(row)).toBe(true);
    });
  });
});
