// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { rewriteFormulaForStructuralEdit, shiftFormulaRelative } from '../rewriteFormula';
import { invertStructuralEdit, mapIndex, type StructuralEdit } from '../structuralEdit';

describe('rewriteFormulaForStructuralEdit', () => {
  it('insert rows grows ranges, shifts absolute refs, and keeps surrounding text', () => {
    expect(rewriteFormulaForStructuralEdit(
      '=SUM(A1:A5) + $B$4 + A2 + C:C + "A3"',
      { type: 'insertRows', at: 2, count: 2 },
    )).toBe('=SUM(A1:A7) + $B$6 + A2 + C:C + "A3"');
  });

  it('delete rows turns deleted refs into #REF! and shrinks partially deleted ranges', () => {
    expect(rewriteFormulaForStructuralEdit(
      '=A2+A4+SUM(A1:A3)+SUM(A2:A3)+sum( a5 )+SUM(B5:B1)+3:4',
      { type: 'deleteRows', at: 1, count: 2 },
    )).toBe('=#REF!+A2+SUM(A1:A1)+SUM(#REF!)+sum( A3 )+SUM(B3:B1)+2:2');
  });

  it('delete and insert columns handle multi-letter columns and whole-column refs', () => {
    expect(rewriteFormulaForStructuralEdit(
      '=$AA$1+Z1+A:C+B1:AB2+1:1+B:B',
      { type: 'deleteCols', at: 1, count: 1 },
    )).toBe('=$Z$1+Y1+A:B+B1:AA2+1:1+#REF!');
    expect(rewriteFormulaForStructuralEdit(
      '=Z1+AA1+SUM(A:AZ)',
      { type: 'insertCols', at: 26, count: 1 },
    )).toBe('=Z1+AB1+SUM(A:BA)');
  });

  it('move rows follows cells and its inverse restores the formula', () => {
    const edit: StructuralEdit = { type: 'moveRows', at: 0, count: 1, to: 2 };
    const moved = rewriteFormulaForStructuralEdit('=A1+A2+A3+A4', edit);
    expect(moved).toBe('=A3+A1+A2+A4');
    expect(rewriteFormulaForStructuralEdit(moved, invertStructuralEdit(edit))).toBe('=A1+A2+A3+A4');
  });

  it('leaves non-formulas alone and drops refs pushed past the last row', () => {
    expect(rewriteFormulaForStructuralEdit('A1 is text', { type: 'insertRows', at: 0, count: 1 })).toBe('A1 is text');
    expect(rewriteFormulaForStructuralEdit('=A1048576+LOG10(A1)', { type: 'insertRows', at: 0, count: 1 }))
      .toBe('=#REF!+LOG10(A2)');
  });
});

describe('spaced range colons (R1-2)', () => {
  it('shrinks a range written with spaces instead of splitting it into #REF!', () => {
    expect(rewriteFormulaForStructuralEdit('=SUM(A1 : A3)', { type: 'deleteRows', at: 0, count: 1 }))
      .toBe('=SUM(A1 : A2)');
    expect(shiftFormulaRelative('=SUM(A1 :B2)', 1, 1)).toBe('=SUM(B2 :C3)');
  });
});

describe('shiftFormulaRelative', () => {
  it('shifts only relative parts', () => {
    expect(shiftFormulaRelative('=A1+$A1+A$1+$A$1+SUM(B2:C3)+A:A+1:$2+Z1', 1, 1))
      .toBe('=B2+$A2+B$1+$A$1+SUM(C3:D4)+B:B+2:$2+AA2');
  });

  it('turns refs shifted off the sheet into #REF!', () => {
    expect(shiftFormulaRelative('=A1+B2+SUM(A1:B2)', -1, 0)).toBe('=#REF!+B1+SUM(#REF!)');
    expect(shiftFormulaRelative('=$A1+B1', 0, -1)).toBe('=$A1+A1');
  });
});

describe('mapIndex', () => {
  it('is undone by the inverted edit for every surviving index', () => {
    const edits: StructuralEdit[] = [
      { type: 'insertRows', at: 3, count: 2 },
      { type: 'deleteCols', at: 2, count: 3 },
      { type: 'moveRows', at: 1, count: 2, to: 5 },
      { type: 'moveCols', at: 6, count: 3, to: 0 },
    ];
    for (const edit of edits) {
      const inverse = invertStructuralEdit(edit);
      for (let i = 0; i < 12; i += 1) {
        const mapped = mapIndex(i, edit);
        if (mapped === null) continue;
        expect(mapIndex(mapped, inverse)).toBe(i);
      }
    }
  });
});
