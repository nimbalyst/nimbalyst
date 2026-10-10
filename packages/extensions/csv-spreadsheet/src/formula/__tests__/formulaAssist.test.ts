// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  applyAutocomplete,
  cycleReferenceAbsolute,
  getAutocompleteCandidates,
  getFormulaAutocomplete,
  getSignatureHelp,
} from '../formulaAssist';

/** Split `=SUM(A1|)` into text and the caret offset marked by `|`. */
function at(marked: string): [string, number] {
  const caret = marked.indexOf('|');
  return [marked.slice(0, caret) + marked.slice(caret + 1), caret];
}

describe('function autocomplete', () => {
  it('ranks an exact name, then common functions, then the rest alphabetically', () => {
    expect(getAutocompleteCandidates('s', 4).map((entry) => entry.name)).toEqual(['SUM', 'SUMIF', 'SEARCH', 'SEC']);
    expect(getAutocompleteCandidates('count', 3).map((entry) => entry.name)).toEqual(['COUNT', 'COUNTA', 'COUNTIF']);
    expect(getAutocompleteCandidates('MIN')[0].name).toBe('MIN');
  });

  it('completes the name token at the caret, including one shaped like a cell', () => {
    const [text, caret] = at('=ROUND(vl|, 2)');
    const completion = getFormulaAutocomplete(text, caret)!;
    expect(completion.candidates[0].name).toBe('VLOOKUP');
    expect(applyAutocomplete(text, completion, 'VLOOKUP')).toEqual({ text: '=ROUND(VLOOKUP(, 2)', caret: 15 });

    const [logText, logCaret] = at('=LOG1|');
    expect(getFormulaAutocomplete(logText, logCaret)!.candidates.map((entry) => entry.name)).toEqual(['LOG10']);
  });

  it('reuses an existing paren and replaces the whole token', () => {
    const [text, caret] = at('=SU|M(A1)');
    const completion = getFormulaAutocomplete(text, caret)!;
    expect(applyAutocomplete(text, completion, 'SUMIF')).toEqual({ text: '=SUMIF(A1)', caret: 7 });
  });

  it('offers named ranges first and inserts them without a paren', () => {
    const [text, caret] = at('=SUM(s|');
    const completion = getFormulaAutocomplete(text, caret, 3, { Sales: 'B2:B9', Rate: 'D1' })!;
    expect(completion.candidates.map((entry) => entry.name)).toEqual(['Sales', 'SUM', 'SUMIF']);
    expect(applyAutocomplete(text, completion, 'Sales', false)).toEqual({ text: '=SUM(Sales', caret: 10 });
    expect(getFormulaAutocomplete(...at('=sa|'), 3, { Sales: 'B2:B9' })!.candidates.map((entry) => entry.name)).toEqual(['Sales']);
  });

  it('stays quiet inside strings, on references and outside formulas', () => {
    expect(getFormulaAutocomplete(...at('="su|'))).toBeNull();
    expect(getFormulaAutocomplete(...at('=$A|1'))).toBeNull();
    expect(getFormulaAutocomplete(...at('su|'))).toBeNull();
    expect(getFormulaAutocomplete(...at('=1+|'))).toBeNull();
  });
});

describe('signature help', () => {
  it.each([
    ['=SUM(|', 'SUM', 0, 'number1'],
    ['=SUM(A1, B|', 'SUM', 1, 'number2'],
    ['=SUM(A1, B2, C|', 'SUM', 2, 'number2'],
    ['=IF(A1>0, "a,b", |', 'IF', 2, 'value_if_false'],
    ['=IF(A1, ROUND(B1, |), 3)', 'ROUND', 1, 'num_digits'],
    ['=IF(A1, ROUND(B1, 2), |3)', 'IF', 2, 'value_if_false'],
    ['=SUM((A1+|', 'SUM', 0, 'number1'],
    ['=SUMIFS(A:A, B:B, ">1", C:C, |', 'SUMIFS', 4, 'criterion2'],
  ])('%s is in %s argument %i (%s)', (marked, name, argIndex, paramName) => {
    const help = getSignatureHelp(...at(marked))!;
    expect(help.entry.name).toBe(name);
    expect(help.argIndex).toBe(argIndex);
    expect(help.entry.params[help.paramIndex].name).toBe(paramName);
  });

  it('reports no parameter once a fixed signature runs out', () => {
    expect(getSignatureHelp(...at('=ROUND(1, 2, |'))!.paramIndex).toBe(-1);
  });

  it('returns null outside a call or for an unknown function', () => {
    expect(getSignatureHelp(...at('=SUM(A1)|'))).toBeNull();
    expect(getSignatureHelp(...at('=NOPE(|'))).toBeNull();
    expect(getSignatureHelp(...at('=(1+|'))).toBeNull();
  });
});

describe('F4 absolute-reference cycling', () => {
  it('cycles a cell reference through all four forms', () => {
    const seen: string[] = [];
    let [text, caret] = at('=A1|+1');
    for (let step = 0; step < 4; step += 1) {
      ({ text, caret } = cycleReferenceAbsolute(text, caret)!);
      seen.push(text);
    }
    expect(seen).toEqual(['=$A$1+1', '=A$1+1', '=$A1+1', '=A1+1']);
    expect(caret).toBe(3);
  });

  it('cycles a range from its first endpoint and puts the caret after it', () => {
    expect(cycleReferenceAbsolute(...at('=SUM(|a1:$B$2)'))).toEqual({ text: '=SUM($A$1:$B$2)', caret: 14 });
    expect(cycleReferenceAbsolute(...at('=SUM(A:B|)'))).toEqual({ text: '=SUM($A:$B)', caret: 10 });
    expect(cycleReferenceAbsolute(...at('=SUM($2:$3|)'))).toEqual({ text: '=SUM(2:3)', caret: 8 });
  });

  it('does nothing away from a reference', () => {
    expect(cycleReferenceAbsolute(...at('=SUM(|'))).toBeNull();
    expect(cycleReferenceAbsolute(...at('="A1|"'))).toBeNull();
  });
});
