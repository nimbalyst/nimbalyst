// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readTerminalOutput, renderTerminalText } from '../terminalText';

describe('renderTerminalText', () => {
  it('strips color, OSC titles and cursor sequences', () => {
    const raw =
      '\x1b]0;vite\x07\x1b[32m  VITE v7.0.0\x1b[39m  ready in \x1b[1m312\x1b[22m ms\r\n' +
      '\x1b]7;file://host/tmp\x1b\\\x1b[?25l  Local: http://localhost:5173/\r\n';
    expect(renderTerminalText(raw)).toBe('  VITE v7.0.0  ready in 312 ms\n  Local: http://localhost:5173/');
  });

  it('collapses a carriage-return progress bar to its last frame', () => {
    const raw = 'Building 10%\rBuilding 55%\rBuilding 100%\r\ndone\r\n';
    expect(renderTerminalText(raw)).toBe('Building 100%\ndone');
  });

  it('applies erase-in-line and backspace so a shorter frame leaves no tail', () => {
    expect(renderTerminalText('downloading packages\r\x1b[Kdone\n')).toBe('done');
    expect(renderTerminalText('abcd\b\bXY\n')).toBe('abXY');
    expect(renderTerminalText('spinner one\x1b[2K\x1b[1Gok\n')).toBe('ok');
  });

  it('drops alternate-screen output and says so', () => {
    const raw = 'before\r\n\x1b[?1049h\x1b[2J lots of htop \x1b[?1049lafter\r\n';
    expect(renderTerminalText(raw)).toBe('before\n[full-screen program output omitted]\nafter');
  });

  // A tab inside a full-screen program's output used to loop forever: the
  // column never advances while that output is being dropped. This runs in
  // the main process, so the loop froze the app.
  it('returns for a tab inside alternate-screen output', () => {
    expect(renderTerminalText('before\n\x1b[?1049h\tmenu\titem\x1b[?1049l\nafter\tdone\n')).toBe(
      'before\n[full-screen program output omitted]\n\nafter   done'
    );
  });

  it('caps a cursor-column jump so one sequence cannot pad a line without bound', () => {
    const rendered = renderTerminalText('\x1b[999999999Gx\n');
    expect(rendered.length).toBeLessThanOrEqual(2001);
    expect(rendered.endsWith('x')).toBe(true);
  });

  it('ignores an escape sequence cut off at the end of the buffer', () => {
    expect(renderTerminalText('ready\r\n\x1b[3')).toBe('ready');
    expect(renderTerminalText('ready\r\n\x1b]0;half a title')).toBe('ready');
  });
});

describe('readTerminalOutput', () => {
  it('returns the last N rendered lines and a cursor at the end of the output', () => {
    const buffer = 'one\r\ntwo\r\nthree\r\n';
    expect(readTerminalOutput({ buffer, base: 0 }, { tail: 2 })).toEqual({
      text: 'two\nthree',
      cursor: buffer.length,
      truncated: false,
      gap: false,
    });
  });

  it('reads only what was written after a cursor', () => {
    const first = 'listening on 3000\r\n';
    const cursor = readTerminalOutput({ buffer: first, base: 0 }).cursor;
    const next = readTerminalOutput({ buffer: first + 'GET / 200\r\n', base: 0 }, { since: cursor });
    expect(next.text).toBe('GET / 200');
    expect(next.gap).toBe(false);
  });

  it('keeps cursors valid after the scrollback is trimmed and flags a cursor that fell off the front', () => {
    // 100 units were written; the first 40 have been trimmed away.
    const state = { buffer: 'x'.repeat(59) + '\n', base: 40 };
    const inRange = readTerminalOutput(state, { since: 90 });
    expect(inRange.text).toBe('x'.repeat(9));
    expect(inRange.gap).toBe(false);
    expect(inRange.cursor).toBe(100);

    const lost = readTerminalOutput(state, { since: 10 });
    expect(lost.gap).toBe(true);
    expect(lost.text).toBe('x'.repeat(59));
  });

  it('reads from the start when the cursor is from a longer, earlier run', () => {
    const result = readTerminalOutput({ buffer: 'fresh start\n', base: 0 }, { since: 5000 });
    expect(result.text).toBe('fresh start');
  });

  it('caps the text at maxChars, keeping the end', () => {
    const result = readTerminalOutput({ buffer: 'a'.repeat(50) + 'END\n', base: 0 }, { maxChars: 10 });
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('a'.repeat(7) + 'END');
  });
});
