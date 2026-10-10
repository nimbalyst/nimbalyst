// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { SheetMeta } from '../../commands/sheetState';
import { EMPTY_FORMATTING } from '../../sheetMeta/formatting';
import {
  adjustDecimals, applyBorders, effectiveFormat, freezeRows, hideCols, presetFormat, setCellFormat, setWrap, toggleStyle,
} from '../formatActions';
import { CellStyleIndex } from '../../cells/cellStyles';

const META: SheetMeta = {
  ...EMPTY_FORMATTING,
  headerRowCount: 1, frozenColumnCount: 0, columnCount: 4, columnFormats: { 1: { type: 'number', decimals: 2 } }, columnWidths: {}, cellStyles: {},
};
const range = (startRow: number, startCol: number, endRow = startRow, endCol = startCol) => ({ startRow, startCol, endRow, endCol });
const apply = (meta: SheetMeta, patch: Partial<SheetMeta>): SheetMeta => ({ ...meta, ...patch });

describe('format actions', () => {
  it('gives cells their own format over the column, replacing what the selection covers instead of stacking', () => {
    let meta = apply(META, setCellFormat(META, range(1, 1), presetFormat('currency')));
    meta = apply(meta, setCellFormat(meta, range(1, 1, 3, 1), presetFormat('percent')));
    expect(Object.keys(meta.cellFormats)).toEqual(['B2:B4']);
    expect(effectiveFormat(meta, { row: 2, col: 1 })?.type).toBe('percentage');
    expect(effectiveFormat(meta, { row: 5, col: 1 })?.type).toBe('number');
    // Automatic clears back to the column's format.
    expect(apply(meta, setCellFormat(meta, range(0, 0, 9, 3), null)).cellFormats).toEqual({});
  });

  it('steps decimals from the active cell, starting a plain cell at 0, clamped at 0', () => {
    const more = apply(META, adjustDecimals(META, range(1, 0, 2, 0), { row: 1, col: 0 }, 1));
    expect(effectiveFormat(more, { row: 2, col: 0 })).toMatchObject({ type: 'number', decimals: 1 });
    const fewer = apply(META, adjustDecimals(META, range(1, 1), { row: 1, col: 1 }, -1));
    expect(effectiveFormat(fewer, { row: 1, col: 1 })?.decimals).toBe(1);
    const floor = apply(META, adjustDecimals(apply(META, setCellFormat(META, range(1, 2), { type: 'number', decimals: 0 })), range(1, 2), { row: 1, col: 2 }, -1));
    expect(effectiveFormat(floor, { row: 1, col: 2 })?.decimals).toBe(0);
  });

  it('R3-4: clearing a subrange back to automatic keeps the format on the rest of the range', () => {
    const formatted = apply(META, setCellFormat(META, range(0, 0, 2, 0), presetFormat('currency')));
    const cleared = apply(formatted, setCellFormat(formatted, range(1, 0), null));
    expect(Object.keys(cleared.cellFormats)).toEqual(['A1', 'A3']);
    expect(effectiveFormat(cleared, { row: 1, col: 0 })).toBeUndefined();
    expect(effectiveFormat(cleared, { row: 2, col: 0 })?.type).toBe('currency');
  });

  it('F8: Cmd+B toggles the style the active cell actually shows, even under a later overlapping range', () => {
    // A1:A3 bold was applied after A1 (not bold), so A1 currently shows bold.
    const styled = { ...META, cellStyles: { A1: { italic: true }, 'A1:A3': { bold: true } } };
    const off = apply(styled, toggleStyle(styled, range(0, 0), { row: 0, col: 0 }, 'bold'));
    expect(new CellStyleIndex(off.cellStyles).styleAt(0, 0)?.bold).toBeFalsy();
    expect(new CellStyleIndex(off.cellStyles).styleAt(0, 0)?.italic).toBe(true);
    expect(new CellStyleIndex(off.cellStyles).styleAt(1, 0)?.bold).toBe(true);
    const on = apply(off, toggleStyle(off, range(0, 0), { row: 0, col: 0 }, 'bold'));
    expect(new CellStyleIndex(on.cellStyles).styleAt(0, 0)?.bold).toBe(true);
  });

  it('turns wrap off inside a wider wrapped range by splitting it around the selection', () => {
    const wrapped = apply(META, setWrap(META, range(0, 0, 4, 0), true));
    expect(setWrap(wrapped, range(2, 0), false).wrap).toEqual(['A1:A2', 'A4:A5']);
  });

  it('merges border presets for the same range and clears them with none', () => {
    const outer = apply(META, applyBorders(META, range(0, 0, 1, 1), 'outer', { style: 'thin' }));
    const both = apply(outer, applyBorders(outer, range(0, 0, 1, 1), 'inner', { style: 'thick' }));
    expect(both.borders['A1:B2']).toMatchObject({ top: { style: 'thin' }, innerHorizontal: { style: 'thick' } });
    expect(applyBorders(both, range(0, 0, 3, 3), 'none', { style: 'thin' }).borders).toEqual({});
  });

  it('keeps one column visible and drops hidden rows that a freeze pins', () => {
    expect(hideCols(META, 0, 3)).toEqual({});
    expect(freezeRows({ ...META, hiddenRows: [1, 4] }, 3)).toEqual({ frozenRowCount: 2, hiddenRows: [4] });
  });
});
