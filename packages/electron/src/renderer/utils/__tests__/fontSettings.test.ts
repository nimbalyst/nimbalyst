// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { toFontFamilyCss, uniqueFontFamilies } from '../fontSettings';

const FALLBACK = 'monospace';

describe('toFontFamilyCss', () => {
  it('returns the fallback for an empty or blank family', () => {
    expect(toFontFamilyCss('', FALLBACK)).toBe(FALLBACK);
    expect(toFontFamilyCss('   ', FALLBACK)).toBe(FALLBACK);
  });

  it('quotes a single family name and appends the fallback', () => {
    expect(toFontFamilyCss('JetBrains Mono', FALLBACK)).toBe('"JetBrains Mono", monospace');
  });

  it('keeps a list or an already quoted name as typed', () => {
    expect(toFontFamilyCss('Fira Code, Hack', FALLBACK)).toBe('Fira Code, Hack, monospace');
    expect(toFontFamilyCss("'Fira Code'", FALLBACK)).toBe("'Fira Code', monospace");
  });

  it('ignores input that could end the declaration', () => {
    expect(toFontFamilyCss('Hack; color: red', FALLBACK)).toBe(FALLBACK);
    expect(toFontFamilyCss('Hack}', FALLBACK)).toBe(FALLBACK);
  });
});

describe('uniqueFontFamilies', () => {
  it('lists each family once, sorted', () => {
    const faces = [{ family: 'Hack' }, { family: 'Fira Code' }, { family: 'Hack' }, { family: 'Fira Code' }];
    expect(uniqueFontFamilies(faces)).toEqual(['Fira Code', 'Hack']);
  });

  it('returns an empty list for no faces', () => {
    expect(uniqueFontFamilies([])).toEqual([]);
  });
});
