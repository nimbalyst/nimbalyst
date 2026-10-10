// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { evaluateConditionalFormats, matchesDiscreteRule, prepareConditionalFormats } from '../evaluate';
import { shiftConditionalFormatsForStructuralEdit } from '../shift';
import type { ConditionalCellSnapshot, ConditionalFormat, GetConditionalCell } from '../types';

/** Grid of raw strings; display mirrors raw. */
function grid(rows: string[][]): GetConditionalCell {
  return (row, col) => {
    const raw = rows[row]?.[col];
    return raw === undefined ? null : { raw, display: raw };
  };
}

const all = { startRow: 0, startCol: 0, endRow: 99, endCol: 9 };

describe('evaluateConditionalFormats', () => {
  it('applies the first matching format per cell and only inside its ranges', () => {
    const formats: ConditionalFormat[] = [
      { id: 'big', ranges: ['A2:A5'], rule: { kind: 'valueCompare', operator: '>', value: 10 }, style: { fillColor: 'green' } },
      { id: 'any', ranges: ['A2:A5'], rule: { kind: 'notEmpty' }, style: { bold: true } },
      { id: 'mid', ranges: ['A2:A5'], rule: { kind: 'valueCompare', operator: 'between', value: 8, value2: 3 }, style: { italic: true } },
    ];
    const cells = grid([['Header'], ['20'], ['5'], [''], ['abc'], ['99']]);
    const { styles } = evaluateConditionalFormats(formats, cells, all);
    expect(Object.fromEntries(styles)).toEqual({
      '1:0': { fillColor: 'green' },
      '2:0': { bold: true },
      '4:0': { bold: true },
    });
  });

  it('color scales interpolate over stats from the whole range, not just the visible slice', () => {
    const rows = [['0'], ['50'], ['100'], ['text'], ['']];
    const formats: ConditionalFormat[] = [{
      id: 'scale',
      ranges: ['A1:A5'],
      rule: { kind: 'colorScale', min: { type: 'min', color: '#000000' }, max: { type: 'max', color: '#ffffff' } },
    }, { id: 'fallback', ranges: ['A1:A5'], rule: { kind: 'notEmpty' }, style: { italic: true } }];
    const { styles } = evaluateConditionalFormats(formats, grid(rows), { startRow: 1, startCol: 0, endRow: 4, endCol: 0 });
    // Row 0 is not visible but still sets the minimum; text falls through to the next format.
    expect(Object.fromEntries(styles)).toEqual({
      '1:0': { fillColor: '#808080' },
      '2:0': { fillColor: '#ffffff' },
      '3:0': { italic: true },
    });
  });

  it('three-point scales use number, percent and percentile stops and clamp outside them', () => {
    const rows = [['0'], ['10'], ['20'], ['30'], ['40']];
    const at = (rule: ConditionalFormat['rule']) => {
      const { styles } = evaluateConditionalFormats([{ id: 's', ranges: ['A1:A5'], rule }], grid(rows), all);
      return rows.map((_, row) => styles.get(`${row}:0`)?.fillColor);
    };
    expect(at({
      kind: 'colorScale',
      min: { type: 'number', value: 10, color: '#ff0000' },
      mid: { type: 'percentile', value: 50, color: '#ffffff' },
      max: { type: 'percent', value: 75, color: '#0000ff' },
    })).toEqual(['#ff0000', '#ff0000', '#ffffff', '#0000ff', '#0000ff']);
    expect(at({
      kind: 'colorScale',
      min: { type: 'min', color: '#000' },
      max: { type: 'max', color: 'not-a-color' as `#${string}` },
    })).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('reports custom formulas as skipped and reuses prepared stats across repaints', () => {
    let reads = 0;
    const cells: GetConditionalCell = (row) => { reads++; return { raw: String(row), display: String(row) }; };
    const formats: ConditionalFormat[] = [
      { id: 'f', ranges: ['A1:A100000'], rule: { kind: 'customFormula', formula: '=A1>3' }, style: { bold: true } },
      { id: 's', ranges: ['A1:A100000'], rule: { kind: 'colorScale', min: { type: 'min', color: '#000000' }, max: { type: 'max', color: '#ffffff' } } },
    ];
    const prepared = prepareConditionalFormats(formats, cells, { rowCount: 1000, colCount: 1 });
    expect(reads).toBe(1000);
    expect(prepared.skipped.map((s) => s.id)).toEqual(['f']);
    reads = 0;
    const { styles, skipped } = evaluateConditionalFormats(formats, cells, { startRow: 990, startCol: 0, endRow: 2000, endCol: 0 }, { prepared });
    expect(reads).toBe(10);
    expect(styles.get('999:0')).toEqual({ fillColor: '#ffffff' });
    expect(styles.has('1000:0')).toBe(false);
    expect(skipped).toHaveLength(1);
  });
});

describe('matchesDiscreteRule', () => {
  const cell = (raw: string, extra: Partial<ConditionalCellSnapshot> = {}): ConditionalCellSnapshot => ({ raw, display: raw, ...extra });

  it('compares numbers numerically, text case-insensitively, and never matches blanks', () => {
    expect(matchesDiscreteRule({ kind: 'valueCompare', operator: '>=', value: '1,000' }, cell('=A1', { numeric: 1000, display: '1,000' }))).toBe(true);
    expect(matchesDiscreteRule({ kind: 'valueCompare', operator: '<', value: 5 }, cell('abc'))).toBe(false);
    expect(matchesDiscreteRule({ kind: 'valueCompare', operator: '=', value: 'Done' }, cell(' done '))).toBe(true);
    expect(matchesDiscreteRule({ kind: 'valueCompare', operator: '!=', value: 'Done' }, cell(''))).toBe(false);
    expect(matchesDiscreteRule({ kind: 'valueCompare', operator: 'notBetween', value: 1, value2: 5 }, cell('6'))).toBe(true);
    expect(matchesDiscreteRule({ kind: 'isEmpty' }, cell('=IF(1,"","x")', { display: '' }))).toBe(true);
  });

  it('matches text on the displayed value', () => {
    const shown = cell('=B1', { display: 'Overdue Invoice' });
    expect(matchesDiscreteRule({ kind: 'textContains', value: 'DUE' }, shown)).toBe(true);
    expect(matchesDiscreteRule({ kind: 'textStartsWith', value: 'over' }, shown)).toBe(true);
    expect(matchesDiscreteRule({ kind: 'textEndsWith', value: 'voice' }, shown)).toBe(true);
    expect(matchesDiscreteRule({ kind: 'textNotContains', value: 'B1' }, shown)).toBe(true);
  });

  it('matches dates by local calendar day relative to now', () => {
    const now = new Date(2026, 9, 9, 15, 30).getTime();
    const day = (y: number, m: number, d: number) => cell('x', { date: new Date(y, m, d, 9).getTime() });
    expect(matchesDiscreteRule({ kind: 'dateIs', when: 'today' }, day(2026, 9, 9), now)).toBe(true);
    expect(matchesDiscreteRule({ kind: 'dateIs', when: 'yesterday' }, day(2026, 9, 8), now)).toBe(true);
    expect(matchesDiscreteRule({ kind: 'dateIs', when: 'pastWeek' }, day(2026, 9, 2), now)).toBe(true);
    expect(matchesDiscreteRule({ kind: 'dateIs', when: 'pastWeek' }, day(2026, 9, 1), now)).toBe(false);
    expect(matchesDiscreteRule({ kind: 'dateIs', when: 'pastMonth' }, day(2026, 8, 9), now)).toBe(true);
    expect(matchesDiscreteRule({ kind: 'dateIs', when: 'pastMonth' }, day(2026, 9, 10), now)).toBe(false);
    expect(matchesDiscreteRule({ kind: 'dateIs', when: 'before', date: '2026-10-09' }, day(2026, 9, 8), now)).toBe(true);
    expect(matchesDiscreteRule({ kind: 'dateIs', when: 'on', date: '2026-10-09' }, cell('2026-10-09'), now)).toBe(true);
    expect(matchesDiscreteRule({ kind: 'dateIs', when: 'today' }, cell('not a date'), now)).toBe(false);
  });

  it('R2-5 never reads an impossible date as the day it rolls over to', () => {
    const now = new Date(2026, 9, 9, 15, 30).getTime();
    expect(matchesDiscreteRule({ kind: 'dateIs', when: 'on', date: '2026-03-03' }, cell('2026-02-31'), now)).toBe(false);
    expect(matchesDiscreteRule({ kind: 'dateIs', when: 'on', date: '2026-02-31' }, cell('2026-03-03'), now)).toBe(false);
  });
});

describe('shiftConditionalFormatsForStructuralEdit', () => {
  it('grows, shrinks, splits and drops ranges, keeping untouched formats by identity', () => {
    const untouched: ConditionalFormat = { id: 'u', ranges: ['A1:A2'], rule: { kind: 'notEmpty' } };
    const formats: ConditionalFormat[] = [
      untouched,
      { id: 'grow', ranges: ['B2:B5'], rule: { kind: 'notEmpty' } },
      { id: 'gone', ranges: ['C4:C5'], rule: { kind: 'notEmpty' } },
    ];
    const inserted = shiftConditionalFormatsForStructuralEdit(formats, { type: 'insertRows', at: 3, count: 2 });
    expect(inserted[0]).toBe(untouched);
    expect(inserted.map((f) => f.ranges)).toEqual([['A1:A2'], ['B2:B7'], ['C6:C7']]);

    const deleted = shiftConditionalFormatsForStructuralEdit(formats, { type: 'deleteRows', at: 3, count: 2 });
    expect(deleted.map((f) => [f.id, f.ranges])).toEqual([['u', ['A1:A2']], ['grow', ['B2:B3']]]);

    const moved = shiftConditionalFormatsForStructuralEdit([formats[1]], { type: 'moveRows', at: 2, count: 1, to: 7 });
    expect(moved[0].ranges).toEqual(['B2:B4', 'B8']);

    const cols = shiftConditionalFormatsForStructuralEdit([{ id: 'c', ranges: ['A1:C3', 'bad key'], rule: { kind: 'isEmpty' } }], { type: 'deleteCols', at: 1, count: 1 });
    expect(cols[0].ranges).toEqual(['A1:B3', 'bad key']);
  });
});
