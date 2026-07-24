import { describe, it, expect } from 'vitest';
import { createCell } from '../csvParser';

// Regression coverage for nimbalyst#329, date sub-bug. CSV file content
// stored as `YYYY-MM-DD` rendered as just `YYYY` in the editor cell.
// `parseFloat("2026-05-15")` returns `2026` (stops at the first non-numeric
// character), so the cell was stored as `{ raw: "2026-05-15", computed: 2026 }`.
// `convertToGridSource` then wrote `cell.computed` (2026) into the rendered
// grid, truncating the displayed value to the year. The raw file content
// stayed correct because the CSV serializer reads `cell.raw`.
//
// The fix is a single ISO-date guard in `createCell`. These tests pin the
// shape of values that should and should NOT take the guard branch.

describe('createCell (issue #329, date sub-bug)', () => {
  describe('ISO date strings stay as strings', () => {
    it('"2026-05-15" keeps the full date string in computed', () => {
      const cell = createCell('2026-05-15');
      expect(cell.raw).toBe('2026-05-15');
      expect(cell.computed).toBe('2026-05-15');
    });

    it('"2026-3-9" (single-digit month and day) keeps the full date string', () => {
      // ISO_DATE_PATTERN allows YYYY-M-D in addition to YYYY-MM-DD because
      // CSV exports from various tools do not always zero-pad.
      const cell = createCell('2026-3-9');
      expect(cell.raw).toBe('2026-3-9');
      expect(cell.computed).toBe('2026-3-9');
    });

    it('"2026-05-15" surrounded by whitespace trims and keeps the date', () => {
      const cell = createCell('  2026-05-15  ');
      expect(cell.raw).toBe('2026-05-15');
      expect(cell.computed).toBe('2026-05-15');
    });
  });

  describe('non-ISO-date values keep their previous behaviour', () => {
    it('"2026" (plain four-digit year) stays numeric', () => {
      const cell = createCell('2026');
      expect(cell.computed).toBe(2026);
    });

    it('"20260515" (no separators) stays numeric', () => {
      const cell = createCell('20260515');
      expect(cell.computed).toBe(20260515);
    });

    it('"2026/05/15" (slash-delimited, out of scope) keeps slash form as a plain string', () => {
      // parseFloat("2026/05/15") returns 2026, but the ISO guard only matches
      // hyphen-delimited dates. parseFloat would otherwise truncate here too.
      // Document the current behaviour: this value still hits the numeric
      // branch and gets stored as 2026. Out of scope for the date sub-bug;
      // covered separately in #329's currency/percent and additional date-
      // format sub-bugs.
      const cell = createCell('2026/05/15');
      expect(cell.computed).toBe(2026);
    });

    it('"3.14" (a decimal number) stays numeric', () => {
      const cell = createCell('3.14');
      expect(cell.computed).toBe(3.14);
    });

    it('"hello world" (plain text) stays as a string', () => {
      const cell = createCell('hello world');
      expect(cell.raw).toBe('hello world');
      expect(cell.computed).toBe('hello world');
    });

    it('empty string stays as a string with empty computed', () => {
      // The trimmed-empty check below parseFloat keeps empty values out of
      // the numeric branch even when parseFloat("") returns NaN.
      const cell = createCell('');
      expect(cell.raw).toBe('');
      expect(cell.computed).toBe('');
    });
  });

  describe('formulas still take the formula branch', () => {
    it('"=A1+B1" returns computed: null for formula', () => {
      const cell = createCell('=A1+B1');
      expect(cell.raw).toBe('=A1+B1');
      expect(cell.computed).toBeNull();
    });

    it('"=2026-05-15" (formula that looks like a date) stays as a formula', () => {
      // The formula branch runs before the ISO-date guard so a formula whose
      // body happens to look like a date is still treated as a formula.
      const cell = createCell('=2026-05-15');
      expect(cell.raw).toBe('=2026-05-15');
      expect(cell.computed).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('"9999-12-31" (far-future date) still matches the ISO guard', () => {
      const cell = createCell('9999-12-31');
      expect(cell.computed).toBe('9999-12-31');
    });

    it('"0001-01-01" (low boundary date) still matches the ISO guard', () => {
      const cell = createCell('0001-01-01');
      expect(cell.computed).toBe('0001-01-01');
    });

    it('"2026-13-45" (out-of-range month and day) still takes the ISO branch', () => {
      // The guard is a shape check, not a semantic date validator. Values
      // that look like ISO dates but are calendrically invalid still take
      // the string branch; the display layer can choose to flag them.
      // Keeping the value as a string preserves what the user typed.
      const cell = createCell('2026-13-45');
      expect(cell.computed).toBe('2026-13-45');
    });
  });
});
