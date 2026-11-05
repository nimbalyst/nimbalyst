import { describe, expect, it } from 'vitest';

import { flattenReplayHyperlinks } from '../terminalHyperlinks';

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`; // ESC \
const link = (uri: string, label: string, term = ST) =>
  `${ESC}]8;;${uri}${term}${label}${ESC}]8;;${term}`;

describe('flattenReplayHyperlinks', () => {
  it('keeps both the label and the file path', () => {
    expect(flattenReplayHyperlinks(link('file:///home/u/proj/src/foo.ts', 'src/foo.ts')))
      .toBe('src/foo.ts (/home/u/proj/src/foo.ts)');
  });

  it('does not duplicate when the label already is the path', () => {
    expect(flattenReplayHyperlinks(link('file:///home/u/a.txt', '/home/u/a.txt')))
      .toBe('/home/u/a.txt');
  });

  it('percent-decodes the path', () => {
    expect(flattenReplayHyperlinks(link('file:///home/u/My%20Docs/a.txt', 'a.txt')))
      .toBe('a.txt (/home/u/My Docs/a.txt)');
  });

  it('strips the host from file://host/path', () => {
    expect(flattenReplayHyperlinks(link('file://myhost/var/log/x.log', 'x.log')))
      .toBe('x.log (/var/log/x.log)');
  });

  it('normalizes a Windows drive path', () => {
    expect(flattenReplayHyperlinks(link('file:///C:/Users/me/a.txt', 'a.txt')))
      .toBe('a.txt (C:/Users/me/a.txt)');
  });

  it('leaves the label alone for non-file links', () => {
    expect(flattenReplayHyperlinks(link('https://example.com/x', 'example')))
      .toBe('example');
  });

  it('handles a BEL terminator', () => {
    expect(flattenReplayHyperlinks(link('file:///t/y.md', 'y.md', BEL)))
      .toBe('y.md (/t/y.md)');
  });

  it('ignores OSC 8 params (id=...)', () => {
    expect(flattenReplayHyperlinks(`${ESC}]8;id=42;file:///p/q.ts${ST}q.ts${ESC}]8;;${ST}`))
      .toBe('q.ts (/p/q.ts)');
  });

  it('preserves surrounding text and colors', () => {
    const color = `${ESC}[31m`;
    const reset = `${ESC}[0m`;
    expect(flattenReplayHyperlinks(`see ${color}${link('file:///a/b.ts', 'b.ts')}${reset} now`))
      .toBe(`see ${color}b.ts (/a/b.ts)${reset} now`);
  });

  it('flattens a dense stream with no OSC 8 markers left behind', () => {
    const out = flattenReplayHyperlinks(link('file:///n/f.ts', 'f.ts').repeat(3000));
    expect(out).toBe('f.ts (/n/f.ts)'.repeat(3000));
    expect(out).not.toContain(`${ESC}]8`);
  });

  it('removes a stray/unclosed OSC 8 opener (safety net)', () => {
    expect(flattenReplayHyperlinks(`x ${ESC}]8;;file:///a${ST}dangling`))
      .toBe('x dangling');
  });

  it('leaves plain text unchanged', () => {
    const input = `plain ${ESC}[32mg${ESC}[0m text`;
    expect(flattenReplayHyperlinks(input)).toBe(input);
  });

  it('passes through empty input', () => {
    expect(flattenReplayHyperlinks('')).toBe('');
  });
});
