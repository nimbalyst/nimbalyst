import { tokenizeCalcSheetLine } from '../calcSheetSyntax';

function tokenTexts(line: string) {
  return tokenizeCalcSheetLine(line).map((token) => ({
    kind: token.kind,
    text: line.slice(token.start, token.end),
  }));
}

describe('calc sheet syntax tokenization', () => {
  it('colors markdown-style headings and comment lines', () => {
    expect(tokenTexts('## Mission Inputs')).toEqual([
      { kind: 'heading-marker', text: '##' },
      { kind: 'heading-text', text: 'Mission Inputs' },
    ]);

    expect(tokenTexts('// Change payload to see the burn')).toEqual([
      { kind: 'comment', text: '// Change payload to see the burn' },
    ]);
  });

  it('colors bindings, units, and formatters', () => {
    expect(tokenTexts('payload = 15500 kg')).toEqual([
      { kind: 'variable-definition', text: 'payload' },
      { kind: 'operator', text: '=' },
      { kind: 'number', text: '15500' },
      { kind: 'unit', text: 'kg' },
    ]);

    expect(tokenTexts('stage2_burn_fraction = stage2_propellant_burned / stage2_propellant -> percent(1)')).toEqual([
      { kind: 'variable-definition', text: 'stage2_burn_fraction' },
      { kind: 'operator', text: '=' },
      { kind: 'variable', text: 'stage2_propellant_burned' },
      { kind: 'operator', text: '/' },
      { kind: 'variable', text: 'stage2_propellant' },
      { kind: 'operator', text: '->' },
      { kind: 'formatter', text: 'percent' },
      { kind: 'number', text: '1' },
    ]);
  });

  it('colors assertion keywords and builtin functions separately from variables', () => {
    expect(tokenTexts('assert stage2_propellant_remaining > 0 kg')).toEqual([
      { kind: 'keyword', text: 'assert' },
      { kind: 'variable', text: 'stage2_propellant_remaining' },
      { kind: 'operator', text: '>' },
      { kind: 'number', text: '0' },
      { kind: 'unit', text: 'kg' },
    ]);

    expect(tokenTexts('stage1_delta_v = to(stage1_isp * g0 * log(stage1_initial_mass / stage1_final_mass), "m / s")')).toEqual([
      { kind: 'variable-definition', text: 'stage1_delta_v' },
      { kind: 'operator', text: '=' },
      { kind: 'function', text: 'to' },
      { kind: 'variable', text: 'stage1_isp' },
      { kind: 'operator', text: '*' },
      { kind: 'variable', text: 'g0' },
      { kind: 'operator', text: '*' },
      { kind: 'function', text: 'log' },
      { kind: 'variable', text: 'stage1_initial_mass' },
      { kind: 'operator', text: '/' },
      { kind: 'variable', text: 'stage1_final_mass' },
    ]);
  });
});
