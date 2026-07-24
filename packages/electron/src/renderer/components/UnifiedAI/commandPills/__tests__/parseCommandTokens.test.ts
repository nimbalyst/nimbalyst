import { describe, it, expect } from 'vitest';
import { parseCommandTokens } from '../parseCommandTokens';

const known = new Set(['commit', 'deep-research', 'planning:implement', 'review']);

describe('parseCommandTokens', () => {
  it('returns no tokens when none are known', () => {
    expect(parseCommandTokens('/unknown thing', known)).toEqual([]);
  });

  it('detects a command at the start of the value', () => {
    expect(parseCommandTokens('/commit', known)).toEqual([
      { start: 0, end: 7, name: 'commit' },
    ]);
  });

  it('detects a command mid-message after whitespace', () => {
    const value = 'please /commit now';
    expect(parseCommandTokens(value, known)).toEqual([
      { start: 7, end: 14, name: 'commit' },
    ]);
    expect(value.slice(7, 14)).toBe('/commit');
  });

  it('ignores unknown commands but keeps known ones on the same line', () => {
    expect(parseCommandTokens('/nope and /review', known)).toEqual([
      { start: 10, end: 17, name: 'review' },
    ]);
  });

  it('does not treat file paths as commands', () => {
    expect(parseCommandTokens('open /Users/me/file', known)).toEqual([]);
  });

  it('does not match a slash inside a word', () => {
    expect(parseCommandTokens('foo/commit', known)).toEqual([]);
  });

  it('stops the token at the first space so arguments are excluded', () => {
    expect(parseCommandTokens('/review src/app.ts', known)).toEqual([
      { start: 0, end: 7, name: 'review' },
    ]);
  });

  it('detects a command after a newline', () => {
    const value = 'intro\n/deep-research';
    expect(parseCommandTokens(value, known)).toEqual([
      { start: 6, end: 20, name: 'deep-research' },
    ]);
    expect(value.slice(6, 20)).toBe('/deep-research');
  });

  it('supports namespaced command names with a colon', () => {
    expect(parseCommandTokens('/planning:implement', known)).toEqual([
      { start: 0, end: 19, name: 'planning:implement' },
    ]);
  });

  it('detects multiple known commands in one value', () => {
    expect(parseCommandTokens('/commit then /review', known)).toEqual([
      { start: 0, end: 7, name: 'commit' },
      { start: 13, end: 20, name: 'review' },
    ]);
  });

  it('suppresses the token the caret is currently editing', () => {
    expect(parseCommandTokens('/commit', known, 7)).toEqual([]);
    expect(parseCommandTokens('/commit ', known, 8)).toEqual([
      { start: 0, end: 7, name: 'commit' },
    ]);
  });

  it('returns nothing for an empty value', () => {
    expect(parseCommandTokens('', known)).toEqual([]);
  });
});
