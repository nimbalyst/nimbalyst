// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { Cell, FormulaEvalData, SpreadsheetData } from '../../types';
import {
  evaluateFormula,
  getSupportedFunctions,
  recalculateFormulas,
} from '../formulaEngine';

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
  ])('evaluates $formula', ({ formula, expected }) => {
    expect(evaluateFormula(formula, data, 0, 3)).toEqual(expected);
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
  };
}
