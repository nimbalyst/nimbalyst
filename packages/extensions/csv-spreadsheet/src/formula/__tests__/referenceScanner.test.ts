// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  formatReference,
  referenceAtCaret,
  scanFormulaTokens,
  scanReferences,
} from '../referenceScanner';

const refTexts = (text: string) => scanReferences(text).map((ref) => `${ref.kind}:${ref.text}@${ref.start}`);

describe('scanReferences', () => {
  it('finds cells, ranges, column-ranges and row-ranges with exact offsets', () => {
    expect(refTexts('=SUM(A1:B2, $C$3) + A:A + 2:$5 - b7')).toEqual([
      'range:A1:B2@5',
      'cell:$C$3@12',
      'column-range:A:A@20',
      'row-range:2:$5@26',
      'cell:b7@33',
    ]);
  });

  it('parses absolute flags and multi-letter columns', () => {
    const [mixed, rowAbs, wide] = scanReferences('=$AA1+B$2+XFD1048576');
    expect(mixed.from).toEqual({ col: 26, row: 0, colAbsolute: true, rowAbsolute: false });
    expect(rowAbs.from).toEqual({ col: 1, row: 1, colAbsolute: false, rowAbsolute: true });
    expect(wide.from).toMatchObject({ col: 16383, row: 1048575 });
    expect(scanReferences('=AZ10:BA$3')[0]).toMatchObject({
      from: { col: 51, row: 9 },
      to: { col: 52, row: 2, rowAbsolute: true },
    });
  });

  it('skips strings, function names, longer words and out-of-bounds shapes', () => {
    expect(refTexts('=LOG10(A1) & "B2 and ""C3""" & ATAN2 (1, 2)')).toEqual(['cell:A1@7']);
    expect(refTexts('=Item_1 + ABCD1 + A1B + XFE1 + A0 + A12345678')).toEqual([]);
    expect(refTexts('=#REF! + #DIV/0! + A1')).toEqual(['cell:A1@19']);
  });

  it('reads spaces around a range colon as part of one range (R1-2)', () => {
    expect(refTexts('=SUM(A1 : A3) + B:\tC + 2 :3')).toEqual([
      'range:A1 : A3@5', 'column-range:B:\tC@16', 'row-range:2 :3@23',
    ]);
    const [range] = scanReferences('=SUM($a1  :  B$2)');
    expect(formatReference(range)).toBe('$A1  :  B$2');
    expect(refTexts('=SUM(A1 : )')).toEqual(['cell:A1@5']);
  });

  it('tolerates incomplete formulas', () => {
    expect(refTexts('=SUM(A1:')).toEqual(['cell:A1@5']);
    expect(refTexts('=A1+"unterminated B2')).toEqual(['cell:A1@1']);
    expect(refTexts('=IF(')).toEqual([]);
    expect(refTexts('=A1:B2:C3')).toEqual(['range:A1:B2@1', 'cell:C3@7']);
  });

  it('tokens cover the text exactly and classify functions', () => {
    const text = '=ROUND( a1 ,2)>=1e3%';
    const tokens = scanFormulaTokens(text);
    expect(tokens.map((token) => token.text).join('')).toBe(text);
    expect(tokens.map((token) => token.kind)).toEqual([
      'operator', 'function', 'leftParen', 'whitespace', 'reference', 'whitespace',
      'comma', 'number', 'rightParen', 'operator', 'number', 'operator',
    ]);
    expect(scanFormulaTokens('="abc').at(-1)).toMatchObject({ kind: 'string', closed: false });
  });
});

describe('referenceAtCaret', () => {
  it('finds the reference at, inside or touching the caret', () => {
    const text = '=A1+B2:C3';
    expect(referenceAtCaret(text, 3)?.text).toBe('A1');
    expect(referenceAtCaret(text, 1)?.text).toBe('A1');
    expect(referenceAtCaret(text, 6)?.text).toBe('B2:C3');
    expect(referenceAtCaret(text, 0)).toBeNull();
    expect(referenceAtCaret('="A1"', 3)).toBeNull();
  });
});

describe('formatReference', () => {
  it('formats every kind canonically', () => {
    expect(scanReferences('=$aa$1+b2:c3+a:$C+$1:2').map(formatReference)).toEqual([
      '$AA$1', 'B2:C3', 'A:$C', '$1:2',
    ]);
  });
});
