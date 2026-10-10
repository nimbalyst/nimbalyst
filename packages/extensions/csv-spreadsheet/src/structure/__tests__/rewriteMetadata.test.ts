// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CellStyleRanges, ColumnFormat } from '../../types';
import { rewriteMetadataForStructuralEdit } from '../rewriteMetadata';
import { CellStyleIndex } from '../../cells/cellStyles';

const number: ColumnFormat = { type: 'number' };
const date: ColumnFormat = { type: 'date' };
const text: ColumnFormat = { type: 'text' };

describe('rewriteMetadataForStructuralEdit', () => {
  it('delete columns remaps format/width keys, shrinks or drops styles, and never mutates', () => {
    const meta = {
      headerRowCount: 1,
      frozenColumnCount: 2,
      columnCount: 4,
      columnFormats: { 0: number, 1: date, 2: text },
      columnWidths: { 2: 100 },
      cellStyles: { 'A1:C3': { bold: true }, B2: { italic: true }, D1: { underline: true }, 'A:A': { bold: true } },
      unrelated: 'kept',
    };
    const before = structuredClone(meta);

    const next = rewriteMetadataForStructuralEdit(meta, { type: 'deleteCols', at: 1, count: 1 });

    expect(next).toEqual({
      headerRowCount: 1,
      frozenColumnCount: 1,
      columnCount: 3,
      columnFormats: { 0: number, 1: text },
      columnWidths: { 1: 100 },
      cellStyles: { 'A1:B3': { bold: true }, C1: { underline: true }, 'A:A': { bold: true } },
      unrelated: 'kept',
    });
    expect(meta).toEqual(before);
  });

  it('header rows grow on insert inside, not at the boundary, and follow deletes', () => {
    const meta = { headerRowCount: 1, hasHeaders: true, cellStyles: { 'A1:B1': { bold: true } }, columnWidths: { 0: 80 } };

    const insertedInside = rewriteMetadataForStructuralEdit(meta, { type: 'insertRows', at: 0, count: 1 });
    expect(insertedInside).toMatchObject({ headerRowCount: 2, cellStyles: { 'A2:B2': { bold: true } } });
    expect(insertedInside.columnWidths).toBe(meta.columnWidths);

    expect(rewriteMetadataForStructuralEdit(meta, { type: 'insertRows', at: 1, count: 3 }).headerRowCount).toBe(1);
    expect(rewriteMetadataForStructuralEdit(meta, { type: 'deleteRows', at: 0, count: 1 }))
      .toMatchObject({ headerRowCount: 0, hasHeaders: false, cellStyles: {} });
  });

  it('moves split style ranges so styles follow cells', () => {
    const cellStyles: CellStyleRanges = { 'A1:A5': { fillColor: 'yellow' } };
    // Row 3 leaves the block for row 7.
    expect(rewriteMetadataForStructuralEdit({ cellStyles }, { type: 'moveRows', at: 2, count: 1, to: 6 }).cellStyles)
      .toEqual({ 'A1:A4': { fillColor: 'yellow' }, A7: { fillColor: 'yellow' } });
    // Row 6 moves into the block and does not pick up its style.
    expect(rewriteMetadataForStructuralEdit({ cellStyles }, { type: 'moveRows', at: 5, count: 1, to: 1 }).cellStyles)
      .toEqual({ A1: { fillColor: 'yellow' }, 'A3:A6': { fillColor: 'yellow' } });
  });

  it('merges entries that collapse onto the same key, later values winning', () => {
    const cellStyles: CellStyleRanges = { 'A1:A2': { bold: true, textColor: 'red' }, A1: { textColor: 'blue' } };
    expect(rewriteMetadataForStructuralEdit({ cellStyles }, { type: 'deleteRows', at: 1, count: 1 }).cellStyles)
      .toEqual({ A1: { bold: true, textColor: 'blue' } });
  });

  // R1-8: merging the collapsed red entry into the later bold one moved red
  // above the blue entry between them, so A1 turned red.
  it('keeps per-property precedence when collapsed entries had an overlapping entry between them', () => {
    const cellStyles: CellStyleRanges = {
      'A1:A3': { fillColor: 'red' },
      'A1:B1': { fillColor: 'blue' },
      'A1:A2': { bold: true },
    };
    const next = rewriteMetadataForStructuralEdit({ cellStyles }, { type: 'deleteRows', at: 1, count: 2 }).cellStyles!;
    const index = new CellStyleIndex(next);
    expect(index.styleAt(0, 0)).toEqual({ fillColor: 'blue', bold: true });
    expect(index.styleAt(0, 1)).toEqual({ fillColor: 'blue' });
  });
});
