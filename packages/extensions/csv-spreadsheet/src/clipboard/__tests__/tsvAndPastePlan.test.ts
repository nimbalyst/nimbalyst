// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseTsv, serializeTsv } from '../tsv';
import { planPaste, type AdjustFormula } from '../pastePlan';

describe('parseTsv', () => {
  it.each([
    ['', []],
    ['a', [['a']]],
    ['a\tb\nc\td', [['a', 'b'], ['c', 'd']]],
    ['a\tb\r\nc\td\r\n', [['a', 'b'], ['c', 'd']]],
    ['a\rb', [['a'], ['b']]],
    ['a\t\n\tb', [['a', ''], ['', 'b']]],
    ['a\tb\tc\nd', [['a', 'b', 'c'], ['d', '', '']]],
    ['\n', [['']]],
    ['a\n\nb', [['a'], [''], ['b']]],
  ])('splits rows and cells: %j', (text, expected) => {
    expect(parseTsv(text)).toEqual(expected);
  });

  it('keeps tabs, newlines and doubled quotes inside quoted cells', () => {
    expect(parseTsv('"line 1\nline 2"\t"has\ttab"\n"say ""hi"""\tx\r\n')).toEqual([
      ['line 1\nline 2', 'has\ttab'],
      ['say "hi"', 'x'],
    ]);
    expect(parseTsv('"a\r\nb"')).toEqual([['a\r\nb']]);
    expect(parseTsv('""\tx')).toEqual([['', 'x']]);
  });

  it('treats quotes that are not field-leading or never close as literal text', () => {
    expect(parseTsv('5" screw\tok')).toEqual([['5" screw', 'ok']]);
    expect(parseTsv('"unterminated\tb\nc\td')).toEqual([['"unterminated', 'b'], ['c', 'd']]);
    expect(parseTsv('"a"b\tc')).toEqual([['"a"b', 'c']]);
  });

  it('round-trips through serializeTsv', () => {
    const matrix = [
      ['plain', 'tab\there', 'multi\nline'],
      ['"quoted"', '', 'cr\r\nlf'],
      ['5" screw', '=SUM(A1:A2)', ' spaced '],
    ];
    expect(parseTsv(serializeTsv(matrix))).toEqual(matrix);
    expect(serializeTsv([['a', 'b'], ['c', 'd']])).toBe('a\tb\nc\td');
  });
});

describe('planPaste', () => {
  const sel = (startRow: number, startCol: number, endRow = startRow, endCol = startCol) => ({
    startRow, startCol, endRow, endCol,
  });
  const target = (selection: ReturnType<typeof sel>, extra = {}) => ({ selection, rowCount: 10, colCount: 5, ...extra });

  it('anchors at the top-left of a single-cell selection', () => {
    const plan = planPaste({ values: [['a', 'b'], ['c', 'd']] }, target(sel(2, 1)));
    expect(plan).toMatchObject({
      range: sel(2, 1, 3, 2),
      values: [['a', 'b'], ['c', 'd']],
      tiled: false, growRows: 0, growCols: 0, clipped: false,
    });
  });

  it('tiles across a selection that is an exact multiple of the source', () => {
    const plan = planPaste({ values: [['a', 'b']] }, target(sel(0, 0, 2, 3)))!;
    expect(plan.tiled).toBe(true);
    expect(plan.values).toEqual([
      ['a', 'b', 'a', 'b'],
      ['a', 'b', 'a', 'b'],
      ['a', 'b', 'a', 'b'],
    ]);
    expect(planPaste({ values: [['x']] }, target(sel(1, 1, 2, 2)))!.values).toEqual([['x', 'x'], ['x', 'x']]);
  });

  it('does not tile when the selection is not a multiple in both directions', () => {
    const plan = planPaste({ values: [['a', 'b']] }, target(sel(0, 0, 2, 2)))!;
    expect(plan.tiled).toBe(false);
    expect(plan.range).toEqual(sel(0, 0, 0, 1));
  });

  it('reports growth past the sheet and clips at hard limits', () => {
    const values = [['1', '2', '3'], ['4', '5', '6']];
    expect(planPaste({ values }, target(sel(9, 3)))).toMatchObject({ growRows: 1, growCols: 1, clipped: false });
    const clipped = planPaste({ values }, target(sel(9, 3), { maxRows: 10, maxCols: 5 }))!;
    expect(clipped).toMatchObject({ range: sel(9, 3, 9, 4), values: [['1', '2']], growRows: 0, growCols: 0, clipped: true });
    expect(planPaste({ values: [] }, target(sel(0, 0)))).toBeNull();
  });

  it('adjusts formulas by their offset from the copied position, per tiled cell', () => {
    const calls: [string, number, number][] = [];
    const adjust: AdjustFormula = (f, dRow, dCol) => {
      calls.push([f, dRow, dCol]);
      return `${f}@${dRow},${dCol}`;
    };
    const plan = planPaste(
      { values: [['=A1', 'text']], origin: { row: 0, col: 0 } },
      target(sel(0, 0, 1, 3)),
      adjust,
    )!;
    expect(plan.values).toEqual([
      ['=A1', 'text', '=A1@0,2', 'text'],
      ['=A1@1,0', 'text', '=A1@1,2', 'text'],
    ]);
    // The cell landing on its own origin is not rewritten.
    expect(calls).toHaveLength(3);
  });

  it('writes formulas verbatim without an origin (external paste)', () => {
    const plan = planPaste({ values: [['=A1']] }, target(sel(4, 4)), () => 'adjusted')!;
    expect(plan.values).toEqual([['=A1']]);
  });
});
