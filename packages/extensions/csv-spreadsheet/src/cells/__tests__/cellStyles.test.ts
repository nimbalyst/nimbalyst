// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  applyStyleToRange,
  CellStyleIndex,
  parseRangeKey,
  rangeKeyOf,
  styleClassNames,
} from '../cellStyles';
import type { CellStyleRanges, NormalizedSelectionRange } from '../../types';
import { reorderRowMetadata } from '../../structure/reorderMetadata';
import { EMPTY_FORMATTING } from '../../sheetMeta/formatting';
import type { SheetMeta } from '../../commands/sheetState';

const range = (
  startRow: number, startCol: number, endRow: number, endCol: number,
): NormalizedSelectionRange => ({ startRow, startCol, endRow, endCol });

describe('A1 range keys', () => {
  it.each([
    ['B2', { startRow: 1, startCol: 1, endRow: 1, endCol: 1 }],
    ['A1:C10', { startRow: 0, startCol: 0, endRow: 9, endCol: 2 }],
    // Written backwards by hand, or by a bottom-right-to-top-left drag.
    ['C10:A1', { startRow: 0, startCol: 0, endRow: 9, endCol: 2 }],
    ['AA3', { startRow: 2, startCol: 26, endRow: 2, endCol: 26 }],
  ])('%s parses to %o', (key, expected) => {
    expect(parseRangeKey(key)).toEqual(expected);
  });

  it.each(['', 'B', '2', 'B0', 'not a range', 'B2:'])('%o is not a range key', (key) => {
    expect(parseRangeKey(key)).toBeNull();
  });

  it('round-trips a selection through its key', () => {
    expect(rangeKeyOf(range(0, 0, 9, 2))).toBe('A1:C10');
    // A single cell stays a single key rather than `B2:B2`.
    expect(rangeKeyOf(range(1, 1, 1, 1))).toBe('B2');
    expect(parseRangeKey(rangeKeyOf(range(3, 4, 7, 8)))).toEqual(range(3, 4, 7, 8));
  });
});

describe('CellStyleIndex', () => {
  it('resolves a cell inside a range and leaves neighbours alone', () => {
    const index = new CellStyleIndex({ 'B2:C3': { bold: true } });
    expect(index.styleAt(1, 1)).toEqual({ bold: true });
    expect(index.styleAt(2, 2)).toEqual({ bold: true });
    expect(index.styleAt(0, 1)).toBeNull();
    expect(index.styleAt(1, 3)).toBeNull();
  });

  it('layers overlapping ranges, later winning', () => {
    const index = new CellStyleIndex({
      'A1:C3': { bold: true, textColor: 'red' },
      'B2': { textColor: 'blue' },
    });
    expect(index.styleAt(1, 1)).toEqual({ bold: true, textColor: 'blue' });
    expect(index.styleAt(0, 0)).toEqual({ bold: true, textColor: 'red' });
  });

  it('ignores unparseable keys rather than throwing', () => {
    const index = new CellStyleIndex({ 'nonsense': { bold: true }, 'A1': { italic: true } });
    expect(index.styleAt(0, 0)).toEqual({ italic: true });
  });

  it('reports empty so painting can skip the lookup entirely', () => {
    expect(new CellStyleIndex({}).isEmpty).toBe(true);
    expect(new CellStyleIndex({ 'A1': { bold: true } }).isEmpty).toBe(false);
  });
});

describe('applyStyleToRange', () => {
  it('merges into the existing entry when the selection matches it exactly', () => {
    // Otherwise toggling a style repeatedly would grow the metadata forever.
    let ranges: CellStyleRanges = {};
    ranges = applyStyleToRange(ranges, range(1, 1, 2, 2), { bold: true });
    ranges = applyStyleToRange(ranges, range(1, 1, 2, 2), { italic: true });

    expect(Object.keys(ranges)).toEqual(['B2:C3']);
    expect(ranges['B2:C3']).toEqual({ bold: true, italic: true });
  });

  it('drops an entry once nothing is set on it', () => {
    let ranges = applyStyleToRange({}, range(0, 0, 0, 0), { bold: true });
    expect(ranges).toEqual({ A1: { bold: true } });

    ranges = applyStyleToRange(ranges, range(0, 0, 0, 0), { bold: false });
    expect(ranges).toEqual({});
  });

  it('treats a default color as a reset rather than a stored value', () => {
    let ranges = applyStyleToRange({}, range(0, 0, 0, 0), { textColor: 'red' });
    ranges = applyStyleToRange(ranges, range(0, 0, 0, 0), { textColor: 'default' });
    expect(ranges).toEqual({});
  });

  it('R4-4: a split piece landing on a styled cell keeps both entries\' properties', () => {
    let ranges = applyStyleToRange({}, range(0, 0, 2, 0), { bold: true });
    ranges = applyStyleToRange(ranges, range(0, 0, 0, 0), { italic: true });
    ranges = applyStyleToRange(ranges, range(1, 0, 1, 0), { bold: false });
    const index = new CellStyleIndex(ranges);
    expect(index.styleAt(0, 0)).toEqual({ bold: true, italic: true });
    expect(index.styleAt(1, 0)).toBeNull();
    expect(index.styleAt(2, 0)).toEqual({ bold: true });
  });

  it('R4-4: sorting keeps per-property layering, and a property overridden in between stays under', () => {
    const meta = { ...EMPTY_FORMATTING, cellStyles: { 'A1:A2': { bold: true }, A1: { italic: true } } } as unknown as SheetMeta;
    const sorted = new CellStyleIndex(reorderRowMetadata(meta, 0, [0, 2, 1]).cellStyles);
    expect([sorted.styleAt(0, 0), sorted.styleAt(1, 0), sorted.styleAt(2, 0)]).toEqual([{ bold: true, italic: true }, null, { bold: true }]);

    // A1:B1 turns bold off over A1 between the two entries; moving A1's bold past it would flip that.
    const between = { ...EMPTY_FORMATTING, cellStyles: { 'A1:A2': { bold: true }, 'A1:B1': { bold: false }, A1: { italic: true } } } as unknown as SheetMeta;
    const kept = new CellStyleIndex(reorderRowMetadata(between, 0, [0, 2, 1]).cellStyles);
    expect(kept.styleAt(0, 0)).toEqual({ italic: true });
    expect(kept.styleAt(2, 0)).toEqual({ bold: true });
  });

  it('R4-4: overlapping borders keep both sides when a sort splits them onto one key', () => {
    const meta = { ...EMPTY_FORMATTING, cellStyles: {}, borders: { 'A1:A2': { left: { style: 'thin' } }, A1: { top: { style: 'thick' } } } } as unknown as SheetMeta;
    expect(reorderRowMetadata(meta, 0, [0, 2, 1]).borders.A1).toEqual({ left: { style: 'thin' }, top: { style: 'thick' } });
  });

  it('leaves other ranges untouched', () => {
    const existing: CellStyleRanges = { 'E5': { bold: true } };
    const next = applyStyleToRange(existing, range(0, 0, 0, 0), { italic: true });
    expect(next.E5).toEqual({ bold: true });
    expect(existing.A1).toBeUndefined();
  });
});

describe('styleClassNames', () => {
  it('maps a style onto its classes', () => {
    expect(styleClassNames({ bold: true, textColor: 'red', fillColor: 'blue', align: 'center' }))
      .toEqual(['csv-cell-bold', 'csv-text-red', 'csv-fill-blue', 'cell-align-center']);
  });

  it('emits nothing for a neutral style', () => {
    expect(styleClassNames({ textColor: 'default', fillColor: 'default' })).toEqual([]);
  });
});
