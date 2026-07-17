import { describe, it, expect } from 'vitest';
import { parseMentionTokens } from '../parseMentionTokens';
import { parseCommandTokens } from '../parseCommandTokens';
import type { OverlayToken } from '../HighlightOverlay';

describe('parseMentionTokens', () => {
  it('detects a session mention in markdown form', () => {
    const value = '@@[Long Title With Spaces](abc123)';
    expect(parseMentionTokens(value)).toEqual([
      { start: 0, end: value.length, kind: 'sessionMention' },
    ]);
  });

  it('detects a bare file mention', () => {
    const value = '@src/app.ts';
    expect(parseMentionTokens(value)).toEqual([
      { start: 0, end: value.length, kind: 'fileMention' },
    ]);
  });

  it('detects a file mention with dots and dashes in the path', () => {
    const value = '@packages/my-pkg/foo.bar.test.ts';
    expect(parseMentionTokens(value)).toEqual([
      { start: 0, end: value.length, kind: 'fileMention' },
    ]);
  });

  it('detects a file mention after whitespace', () => {
    const value = 'see @src/app.ts please';
    expect(parseMentionTokens(value)).toEqual([
      { start: 4, end: 15, kind: 'fileMention' },
    ]);
    expect(value.slice(4, 15)).toBe('@src/app.ts');
  });

  it('detects a mention after a newline', () => {
    const value = 'intro\n@src/app.ts';
    expect(parseMentionTokens(value)).toEqual([
      { start: 6, end: 17, kind: 'fileMention' },
    ]);
    expect(value.slice(6, 17)).toBe('@src/app.ts');
  });

  it('does not match an email address', () => {
    expect(parseMentionTokens('ping me at greg@stravu.com today')).toEqual([]);
  });

  it('does not match a lone @ with no path', () => {
    expect(parseMentionTokens('a @ b')).toEqual([]);
    expect(parseMentionTokens('trailing @')).toEqual([]);
  });

  it('does not treat a bare @@ without markdown form as a mention', () => {
    expect(parseMentionTokens('@@notmarkdown')).toEqual([]);
  });

  it('suppresses the token the caret is currently editing', () => {
    const value = '@src/app.ts';
    expect(parseMentionTokens(value, value.length)).toEqual([]);
    expect(parseMentionTokens(value + ' ', value.length + 1)).toEqual([
      { start: 0, end: value.length, kind: 'fileMention' },
    ]);
  });

  it('detects a session mention after whitespace', () => {
    const value = 'ref @@[Title](xyz789) here';
    expect(parseMentionTokens(value)).toEqual([
      { start: 4, end: 21, kind: 'sessionMention' },
    ]);
    expect(value.slice(4, 21)).toBe('@@[Title](xyz789)');
  });

  it('detects both a file and a session mention in one value, sorted by start', () => {
    const value = '@src/app.ts and @@[Title](abc)';
    expect(parseMentionTokens(value)).toEqual([
      { start: 0, end: 11, kind: 'fileMention' },
      { start: 16, end: 30, kind: 'sessionMention' },
    ]);
    expect(value.slice(0, 11)).toBe('@src/app.ts');
    expect(value.slice(16, 30)).toBe('@@[Title](abc)');
  });

  it('returns nothing for an empty value', () => {
    expect(parseMentionTokens('')).toEqual([]);
  });

  // Mirrors the merge AIInput performs: command + mention tokens combined and
  // sorted by start. They never overlap (leading `/` vs `@`).
  it('merges a command, a file mention, and a session mention in sorted order', () => {
    const known = new Set(['review']);
    const value = '/review @src/app.ts vs @@[Title](abc)';
    const merged: OverlayToken[] = [
      ...parseCommandTokens(value, known).map(
        (t): OverlayToken => ({ kind: 'command', ...t })
      ),
      ...parseMentionTokens(value),
    ].sort((a, b) => a.start - b.start);

    expect(merged).toEqual([
      { kind: 'command', start: 0, end: 7, name: 'review' },
      { kind: 'fileMention', start: 8, end: 19 },
      { kind: 'sessionMention', start: 23, end: 37 },
    ]);
    expect(value.slice(0, 7)).toBe('/review');
    expect(value.slice(8, 19)).toBe('@src/app.ts');
    expect(value.slice(23, 37)).toBe('@@[Title](abc)');
  });
});
