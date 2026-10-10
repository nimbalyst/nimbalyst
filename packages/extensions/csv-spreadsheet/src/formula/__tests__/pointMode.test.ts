// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  applyPointPick,
  beginPointSession,
  parseNameBoxReference,
  referenceHighlights,
  referenceOutlines,
  resolvePointTarget,
} from '../pointMode';
import { asFormulaErrorCode, describeFormulaError } from '../formulaErrors';

/** Split `=SUM(A1|)` into text and the caret offset marked by `|`. */
function at(marked: string): [string, number] {
  const caret = marked.indexOf('|');
  return [marked.slice(0, caret) + marked.slice(caret + 1), caret];
}

const cell = (row: number, col: number) => ({ startRow: row, endRow: row, startCol: col, endCol: col });

describe('resolvePointTarget', () => {
  it.each([
    ['=|', { kind: 'insert', at: 1 }],
    ['=SUM(|', { kind: 'insert', at: 5 }],
    ['=SUM(|)', { kind: 'insert', at: 5 }],
    ['=A1+|', { kind: 'insert', at: 4 }],
    ['=SUM(A1, |', { kind: 'insert', at: 9 }],
    ['=A1:|', { kind: 'insert', at: 4 }],
    ['=A1>=|', { kind: 'insert', at: 5 }],
    ['=A1|', { kind: 'replace', start: 1, end: 3 }],
    ['=SUM(B2:B4|)', { kind: 'replace', start: 5, end: 10 }],
    ['=SUM($A|$1)', { kind: 'replace', start: 5, end: 9 }],
    ['=A1+B|2*3', { kind: 'replace', start: 4, end: 6 }],
  ])('%s points at %o', (marked, expected) => {
    const [text, caret] = at(marked);
    expect(resolvePointTarget(text, caret)).toEqual(expected);
  });

  it.each([
    'A1|',          // not a formula
    '|=A1',         // before the `=`
    '=5|',          // a number: `=5B2` would be nonsense
    '=SUM|',        // a function name being typed
    '=SUM(|A1)',    // a reference right after the caret would fuse
    '="a|"',        // inside a string
    '=A1%|',        // `%` is postfix
    '=A1 B2|',      // a reference not at an insertion point
    '=SUM(A1|B)',   // the reference continues into a name
  ])('declines %s', (marked) => {
    const [text, caret] = at(marked);
    expect(resolvePointTarget(text, caret)).toEqual({ kind: 'none' });
  });

  it('accepts a selection only when it is exactly one reference at an insertion point', () => {
    expect(resolvePointTarget('=A1+B2', 4, 6)).toEqual({ kind: 'replace', start: 4, end: 6 });
    expect(resolvePointTarget('=A1+B2', 3, 6)).toEqual({ kind: 'none' });
  });
});

describe('point session', () => {
  it('inserts a pick at the caret, then a drag rewrites the same span rather than appending', () => {
    const session = beginPointSession('=SUM()', 5)!;
    expect(applyPointPick(session, cell(1, 1))).toEqual({ text: '=SUM(B2)', caret: 7 });
    expect(applyPointPick(session, { startRow: 1, endRow: 3, startCol: 1, endCol: 1 }))
      .toEqual({ text: '=SUM(B2:B4)', caret: 10 });
  });

  it('replaces the reference just pointed, so a second click swaps it', () => {
    const session = beginPointSession('=SUM(B2:B4)', 10)!;
    expect(applyPointPick(session, cell(0, 2)).text).toBe('=SUM(C1)');
  });

  it('is null where pointing is declined', () => {
    expect(beginPointSession('=5', 2)).toBeNull();
  });
});

describe('reference colors', () => {
  it('gives repeats of a reference one color and distinct references the next colors', () => {
    const highlights = referenceHighlights('=A1+$a$1+B2:C3');
    expect(highlights.map((h) => [h.start, h.end])).toEqual([[1, 3], [4, 8], [9, 14]]);
    expect(highlights[0].color).toBe(highlights[1].color);
    expect(highlights[2].color).not.toBe(highlights[0].color);
    expect(referenceHighlights('A1+B2')).toEqual([]);
  });

  it('outlines each distinct reference once, normalized, with open axes for whole columns', () => {
    const outlines = referenceOutlines('=SUM(C5:A1)+A1+B:B');
    expect(outlines.map(({ color: _color, ...range }) => range)).toEqual([
      { startRow: 0, endRow: 4, startCol: 0, endCol: 2 },
      { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
      { startRow: null, endRow: null, startCol: 1, endCol: 1 },
    ]);
  });
});

describe('name box', () => {
  it.each([
    ['b7', cell(6, 1)],
    [' =$A$1 ', cell(0, 0)],
    ['C5:a1', { startRow: 0, endRow: 4, startCol: 0, endCol: 2 }],
  ])('jumps to %s', (input, expected) => {
    expect(parseNameBoxReference(input)).toEqual(expected);
  });

  it('jumps to a named range, case-insensitively', () => {
    expect(parseNameBoxReference('sales', { Sales: 'B2:C4' })).toEqual({ startRow: 1, endRow: 3, startCol: 1, endCol: 2 });
  });

  it.each(['', 'hello', 'A1+B2', 'A:A', 'SUM(A1)'])('rejects %s', (input) => {
    expect(parseNameBoxReference(input)).toBeNull();
  });
});

describe('formula errors', () => {
  it('recognizes displayed error values only', () => {
    expect(asFormulaErrorCode(' #div/0! ')).toBe('#DIV/0!');
    expect(asFormulaErrorCode('#HASHTAG')).toBeNull();
    expect(asFormulaErrorCode(5)).toBeNull();
  });

  it('names the unknown function or name behind #NAME?', () => {
    expect(describeFormulaError('#NAME?', '=SUMM(A1)+foo+TRUE').detail).toContain('SUMM, foo.');
  });

  it('tells a deleted reference apart from an out-of-sheet one', () => {
    expect(describeFormulaError('#REF!', '=#REF!+1').detail).toMatch(/deleted/);
    expect(describeFormulaError('#REF!').detail).not.toMatch(/deleted/);
  });
});
