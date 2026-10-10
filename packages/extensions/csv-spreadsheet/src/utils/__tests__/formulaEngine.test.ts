// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { Cell, FormulaEvalData, SpreadsheetData } from '../../types';
import {
  evaluateFormula,
  getSupportedFunctions,
  recalculateFormulas,
} from '../formulaEngine';
import { parseUrlCell } from '../formatters';
import { rewriteFormulaForStructuralEdit } from '../../structure/rewriteFormula';

const cell = (raw: string, computed: Cell['computed']): Cell => ({ raw, computed });

const data: FormulaEvalData = {
  rows: [
    [cell('1', 1), cell('10', 10), cell('', ''), cell('', '')],
    [cell('2', 2), cell('20', 20), cell('', ''), cell('', '')],
    [cell('3', 3), cell('30', 30), cell('', ''), cell('', '')],
  ],
  columnCount: 4,
};

describe('formula engine', () => {
  it.each([
    { formula: '=SUM(1,2,3)', expected: { value: 6 } },
    { formula: '=SUM(A1:A3)', expected: { value: 6 } },
    { formula: '=A1*2', expected: { value: 2 } },
    { formula: '=UNKNOWN(A1)', expected: { value: null, error: '#NAME?' } },
    { formula: '=1+', expected: { value: null, error: '#VALUE!' } },
    { formula: '=SUM(A1:A3)*2', expected: { value: 12 } },
    { formula: '=SUM(A1:A100)', expected: { value: 6 } },
    { formula: '=COUNT(A1:A100)', expected: { value: 3 } },
    { formula: '=AVERAGE(A1:A100)', expected: { value: 2 } },
    { formula: '=IF(A1>0,SUM(B1:B3),0)', expected: { value: 60 } },
    { formula: '=IF(A1=1,"yes","no")', expected: { value: 'yes' } },
    { formula: '=IF(FALSE,1/0,42)', expected: { value: 42 } },
    { formula: '=IFERROR(1/0,42)', expected: { value: 42 } },
    { formula: '=SUM($A$1:$A$3)', expected: { value: 6 } },
    { formula: '=SUM(A$1,$A1,$A$1)', expected: { value: 3 } },
    { formula: '=sum(a1:a3)', expected: { value: 6 } },
    { formula: '=STDEV.S(A1:A3)', expected: { value: 1 } },
    { formula: '=STDEV(A1:A3)', expected: { value: 1 } },
    { formula: '=VLOOKUP(2,A1:B3,2,FALSE)', expected: { value: 20 } },
    { formula: '=2+3*4^2', expected: { value: 50 } },
    { formula: '=-2^2', expected: { value: -4 } },
    { formula: '=-5+10%', expected: { value: -4.9 } },
    { formula: '="Hello "&"World"', expected: { value: 'Hello World' } },
    {
      formula: '=AND(A1<>2,A1<2,A1<=1,A1>0,A1>=1,A1=1)',
      expected: { value: 'TRUE' },
    },
    { formula: '=1/0', expected: { value: null, error: '#DIV/0!' } },
    { formula: '=Z99', expected: { value: null, error: '#REF!' } },
    { formula: '=D1', expected: { value: null, error: '#CIRC!' } },
    { formula: '=SUM(1,)', expected: { value: null, error: '#VALUE!' } },
    // Function names shaped like cell refs: a name followed by `(` is a call.
    { formula: '=LOG10(100)', expected: { value: 2 } },
    { formula: '=ATAN2(1,1)', expected: { value: Math.PI / 4 } },
    // Excel's argument order is (x_num, y_num); formula.js takes (y, x).
    { formula: '=ATAN2(1,0)', expected: { value: 0 } },
    { formula: '=ATAN2(0,1)', expected: { value: Math.PI / 2 } },
    { formula: '=DEC2BIN(5)', expected: { value: '101' } },
    { formula: '=LOG10 (A1)', expected: { value: 0 } },
    { formula: '=DAYS360("2026-01-01","2026-02-01")', expected: { value: 30 } },
  ])('evaluates $formula', ({ formula, expected }) => {
    expect(evaluateFormula(formula, data, 0, 3)).toEqual(expected);
  });

  /**
   * `Date` results used to be truncated with `toISOString().slice(0, 10)`,
   * which made time-of-day unreachable and shifted the day east of Greenwich.
   * formula.js is not consistent about which midnight it returns, so both
   * conventions have to survive the round trip.
   */
  describe('date and time results', () => {
    it('keeps the time of day on a result that has one', () => {
      // The whole point of the change: this used to come back as a bare date.
      expect(evaluateFormula('=NOW()', data, 0, 3).value).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
      );
    });

    it('still renders a midnight result as a bare date', () => {
      expect(evaluateFormula('=TODAY()', data, 0, 3).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('renders a local-midnight date as a bare calendar date', () => {
      // DATE() returns local midnight; reading it as UTC would move the day.
      expect(evaluateFormula('=DATE(2026,8,18)', data, 0, 3)).toEqual({ value: '2026-08-18' });
    });

    it('renders a UTC-midnight date as the same calendar date', () => {
      // DATEVALUE() returns UTC midnight; reading it locally would move the day.
      expect(evaluateFormula('=DATEVALUE("2026-08-18")', data, 0, 3)).toEqual({ value: '2026-08-18' });
    });

  });

  /**
   * Every spreadsheet models a date as a number of days, which is what makes
   * `=A1+7` and `=B1-A1` work at all. A date column here stores *text*, so
   * reaching that number means parsing the cell — strictly, or `="March"+1`
   * would quietly become arithmetic.
   */
  describe('date arithmetic', () => {
    const dates: FormulaEvalData = {
      rows: [[
        cell('2026-08-18', '2026-08-18'),
        cell('2026-08-25', '2026-08-25'),
        cell('March', 'March'),
        cell('', ''),
      ]],
      columnCount: 4,
    };

    it('counts the days between two dates', () => {
      expect(evaluateFormula('=B1-A1', dates, 0, 3)).toEqual({ value: 7 });
    });

    it('offsets a date by a number of days', () => {
      // The result is a serial; a date-formatted column renders it as a date.
      const serial = evaluateFormula('=A1+7', dates, 0, 3).value as number;
      expect(evaluateFormula('=B1', dates, 0, 3).value).toBe('2026-08-25');
      expect(serial).toBe(evaluateFormula('=B1+0', dates, 0, 3).value);
    });

    it('compares dates chronologically rather than as text', () => {
      expect(evaluateFormula('=A1<B1', dates, 0, 3)).toEqual({ value: 'TRUE' });
      expect(evaluateFormula('=B1<A1', dates, 0, 3)).toEqual({ value: 'FALSE' });
    });

    it('refuses to do arithmetic on a word that merely parses as a date', () => {
      // `new Date("March")` is a valid date, which is why the strict parser
      // exists — this has to stay an error.
      expect(evaluateFormula('=C1+1', dates, 0, 3).error).toBe('#VALUE!');
    });

    it('concatenates a date result as its rendered form', () => {
      expect(evaluateFormula('="Due "&A1', dates, 0, 3)).toEqual({ value: 'Due 2026-08-18' });
    });

    it('leaves date text alone in an untyped column', () => {
      // Without a date format the column is text, and formula.js ignores text.
      expect(evaluateFormula('=MAX(A1:B1)', dates, 0, 3)).toEqual({ value: 0 });
    });
  });

  /**
   * A date-typed column stores text, so MAX/MIN/SUM over it used to see only
   * strings and return 0. Numeric aggregates read those cells as serials; lookup
   * and criteria functions still see the text they compare against.
   */
  describe('aggregates over date-typed columns', () => {
    const typed = {
      rows: [
        [cell('2026-08-18', '2026-08-18'), cell('2026-08-18 06:00:00', '2026-08-18 06:00:00'), cell('a', 'a')],
        [cell('2026-08-25', '2026-08-25'), cell('', ''), cell('b', 'b')],
        [cell('2026-08-20', '2026-08-20'), cell('2026-08-19 18:00:00', '2026-08-19 18:00:00'), cell('c', 'c')],
      ],
      columnCount: 3,
      columnFormats: { 0: { type: 'date' as const }, 1: { type: 'datetime' as const } },
    };
    const serial = (formula: string) => evaluateFormula(formula, typed, 0, 9).value as number;

    it('takes MAX and MIN of a date column as serials', () => {
      expect(serial('=MAX(A1:A3)')).toBe(serial('=A2+0'));
      expect(serial('=MIN(A1:A3)')).toBe(serial('=A1+0'));
    });

    it('sums, averages and counts date and datetime cells', () => {
      expect(serial('=SUM(A1:A2)')).toBe(serial('=A1+A2'));
      expect(serial('=AVERAGE(B1:B3)')).toBe((serial('=B1+0') + serial('=B3+0')) / 2);
      expect(serial('=COUNT(A1:B3)')).toBe(5);
    });

    // R2-4: formula dates were cached as Date objects and scalar refs skipped
    // the range conversion, so formula.js ignored both and returned 0.
    it('R2-4 reads formula dates and scalar date refs as serials, leaving cached values alone', () => {
      const formulaDates: SpreadsheetData = {
        rows: [
          [cell('=DATE(2026,8,18)', null), cell('2026-08-18', '2026-08-18')],
          [cell('=DATE(2026,8,25)', null), cell('2026-08-25', '2026-08-25')],
          [cell('=MAX(A1:A2)', null), cell('=MAX(B1,B2)', null)],
          [cell('="d "&A1', null), cell('=MIN(A1,B2)', null)],
        ],
        columnCount: 2,
        hasHeaders: false,
        headerRowCount: 0,
        frozenColumnCount: 0,
        columnFormats: { 0: { type: 'date' }, 1: { type: 'date' } },
        cellStyles: {},
      };
      const expected = serial('=A2+0');
      const rows = recalculateFormulas(formulaDates).rows;
      expect(rows[2][0].computed).toBe(expected);
      expect(rows[2][1].computed).toBe(expected);
      expect(rows[3][1].computed).toBe(serial('=A1+0'));
      // A1's cached Date still reads as a date to text functions.
      expect(rows[3][0].computed).toBe('d 2026-08-18');
      expect(evaluateFormula('=MAX(DATE(2026,8,18),DATE(2026,8,25))', typed, 0, 9).value).toBe(expected);
    });

    it('keeps lookup keys as the text the column stores', () => {
      expect(evaluateFormula('=VLOOKUP("2026-08-25",A1:C3,3,FALSE)', typed, 0, 9)).toEqual({ value: 'b' });
      expect(evaluateFormula('=COUNTIF(A1:A3,"2026-08-20")', typed, 0, 9)).toEqual({ value: 1 });
    });
  });

  describe('whole-column and whole-row references', () => {
    it('aggregates a whole column bounded by the used range', () => {
      expect(evaluateFormula('=SUM(A:A)', data, 0, 3)).toEqual({ value: 6 });
      expect(evaluateFormula('=SUM(A:B)', data, 0, 3)).toEqual({ value: 66 });
      expect(evaluateFormula('=SUM($A:$A)', data, 0, 3)).toEqual({ value: 6 });
    });

    it('aggregates a whole row bounded by the used range', () => {
      expect(evaluateFormula('=SUM(2:2)', data, 0, 3)).toEqual({ value: 22 });
      expect(evaluateFormula('=SUM(1:$2)', data, 2, 3)).toEqual({ value: 33 });
    });

    it('recalculates a dependent of a whole-column reference', () => {
      const sheet = makeSpreadsheet([
        [cell('1', 1), cell('=SUM(A:A)', null)],
        [cell('=A1*5', null), cell('', '')],
      ]);
      expect(recalculateFormulas(sheet).rows[0][1].computed).toBe(6);
    });

    it('flags a whole-column reference that includes its own cell as circular', () => {
      const sheet = makeSpreadsheet([[cell('1', 1)], [cell('=SUM(A:A)', null)]]);
      expect(recalculateFormulas(sheet).rows[1][0].error).toBe('#CIRC!');
    });
  });

  /** Structural rewrites leave `#REF!` in formula text; it has to evaluate as an error value. */
  describe('error literals (R1-3)', () => {
    it.each([
      ['=IFERROR(#REF!,42)', { value: 42 }],
      ['=#REF!+1', { value: null, error: '#REF!' }],
      ['=SUM(1,#DIV/0!)', { value: null, error: '#DIV/0!' }],
      ['=IFNA(#N/A,1)', { value: 1 }],
      ['=IFNA(#name?,1)', { value: null, error: '#NAME?' }],
      ['=ISERROR(#NUM!)', { value: 'TRUE' }],
      ['=ISERROR(1/0)', { value: 'TRUE' }],
      ['=ISERROR(A1)', { value: 'FALSE' }],
      ['=ISERR(#N/A)', { value: 'FALSE' }],
      ['=ISERR(#VALUE!)', { value: 'TRUE' }],
      ['=ISNA(#N/A)', { value: 'TRUE' }],
      ['=ISNA(#NULL!)', { value: 'FALSE' }],
    ])('evaluates %s', (formula, expected) => {
      expect(evaluateFormula(formula, data, 0, 3)).toEqual(expected);
    });

    it('evaluates a formula after a structural delete turned its reference into #REF!', () => {
      const rewritten = rewriteFormulaForStructuralEdit('=IFERROR(A2*2,42)', { type: 'deleteRows', at: 1, count: 1 });
      expect(rewritten).toBe('=IFERROR(#REF!*2,42)');
      expect(evaluateFormula(rewritten, data, 0, 3)).toEqual({ value: 42 });
    });
  });

  describe('HYPERLINK', () => {
    it('packs the label and the target into one value', () => {
      const result = evaluateFormula('=HYPERLINK("https://example.com","Report")', data, 0, 3);
      expect(result.error).toBeUndefined();
      expect(parseUrlCell(result.value as string)).toEqual({
        href: 'https://example.com',
        label: 'Report',
      });
    });

    it('falls back to the target when no label is given', () => {
      const result = evaluateFormula('=HYPERLINK("https://example.com")', data, 0, 3);
      expect(parseUrlCell(result.value as string)).toEqual({
        href: 'https://example.com',
        label: 'https://example.com',
      });
    });

    it('rejects an empty target', () => {
      expect(evaluateFormula('=HYPERLINK("")', data, 0, 3).error).toBe('#VALUE!');
    });
  });

  it('rejects ranges and references that exceed formula budgets', () => {
    expect(evaluateFormula('=SUM(A1:XFD1048576)', data, 0, 3)).toEqual({
      value: null,
      error: '#LIMIT!',
    });
    expect(evaluateFormula(`=A${'9'.repeat(200)}`, data, 0, 3)).toEqual({
      value: null,
      error: '#REF!',
    });
  });

  it('rejects deeply nested formulas before evaluation', () => {
    const nestedFormula = `=${'ABS('.repeat(80)}1${')'.repeat(80)}`;

    expect(evaluateFormula(nestedFormula, data, 0, 3)).toEqual({
      value: null,
      error: '#LIMIT!',
    });
  });

  it('uses linear wildcard matching for MATCH', () => {
    const wildcardData: FormulaEvalData = {
      rows: [[cell('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac')]],
      columnCount: 1,
    };

    expect(evaluateFormula(
      '=MATCH("*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b",A1:A1,0)',
      wildcardData,
      0,
      1
    )).toEqual({ value: null, error: '#N/A' });
  });

  it('recalculates formula dependencies correctly on the first pass', () => {
    const spreadsheet = makeSpreadsheet([
      [cell('2', 2), cell('', ''), cell('=A1*3', null), cell('=C1', null)],
    ]);

    const result = recalculateFormulas(spreadsheet);

    expect(result.rows[0][2]).toMatchObject({ computed: 6, error: undefined });
    expect(result.rows[0][3]).toMatchObject({ computed: 6, error: undefined });
  });

  it('marks every formula in a dependency cycle as circular', () => {
    const spreadsheet = makeSpreadsheet([
      [cell('', ''), cell('', ''), cell('=C2', null)],
      [cell('', ''), cell('', ''), cell('=C1', null)],
    ]);

    const result = recalculateFormulas(spreadsheet);

    expect(result.rows[0][2]).toMatchObject({ computed: null, error: '#CIRC!' });
    expect(result.rows[1][2]).toMatchObject({ computed: null, error: '#CIRC!' });
  });

  it('propagates errors from referenced cells', () => {
    const errorData: FormulaEvalData = {
      rows: [[{ raw: '=1/0', computed: null, error: '#DIV/0!' }, cell('', '')]],
      columnCount: 2,
    };

    expect(evaluateFormula('=A1+1', errorData, 0, 1)).toEqual({
      value: null,
      error: '#DIV/0!',
    });
  });

  it('preserves typed formula results across dependencies', () => {
    const spreadsheet = makeSpreadsheet([
      [cell('=FALSE', null), cell('=IF(A1,1,0)', null)],
    ]);

    const result = recalculateFormulas(spreadsheet);

    expect(result.rows[0][0]).toMatchObject({ computed: 'FALSE', error: undefined });
    expect(result.rows[0][1]).toMatchObject({ computed: 0, error: undefined });
  });

  it('exposes representative audited formula functions', () => {
    const supported = getSupportedFunctions();

    expect(supported).toContain('VLOOKUP');
    expect(supported).toContain('STDEV.S');
    expect(supported).toContain('MATCH');
  });
});

function makeSpreadsheet(rows: Cell[][]): SpreadsheetData {
  return {
    rows,
    columnCount: Math.max(...rows.map((row) => row.length)),
    hasHeaders: false,
    headerRowCount: 0,
    frozenColumnCount: 0,
    columnFormats: {},
    cellStyles: {},
  };
}
