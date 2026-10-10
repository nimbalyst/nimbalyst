// @vitest-environment node
/**
 * Every named-fence block through the headless pipeline: it must become its
 * own node (not a code block), and the file must come back byte-identical,
 * including keys this version does not read. A new fenced block adds its
 * fence here.
 */

import { describe, expect, it } from 'vitest';

import { fenceRoundTrip } from './fenceRoundTrip';
import { parseFenceCsv } from '../../../../core/fenceBody';

const CHART = `Weekly numbers.

\`\`\`chart
type: bar
title: Sessions per week
x: week
y: [desktop, web]
# a comment and a key this version does not read
palette: warm
data: |
  week,desktop,web
  W36,120,14
  W37,131,22
\`\`\`

After the chart.`;

const QUADRANT = `\`\`\`2x2
x: Low -> High
y: Low -> High
- First: 0.25, 0.75
future: kept
\`\`\``;

/** Top-level blocks, without the empty paragraphs blank separator lines import as. */
function blocks(trip: ReturnType<typeof fenceRoundTrip>): Array<[string, string]> {
  return trip.blockTypes
    .map((type, index): [string, string] => [type, trip.blockTexts[index]])
    .filter(([type, text]) => !(type === 'paragraph' && text === ''));
}

describe('fenced blocks', () => {
  it.each([
    ['chart', CHART],
    ['quadrant', QUADRANT],
  ])('%s survives a headless round trip byte-for-byte', (type, markdown) => {
    const trip = fenceRoundTrip(markdown);
    expect(trip.errors).toEqual([]);
    expect(trip.blockTypes).toContain(type);
    expect(trip.blockTypes).not.toContain('code');
    expect(trip.exported.trim()).toBe(markdown);
    expect(trip.reexported).toBe(trip.exported);
  });

  it('keeps an unterminated fence at end of file as the block', () => {
    const trip = fenceRoundTrip('```chart\ntype: pie\nx: a\ny: b');
    expect(trip.blockTypes).toEqual(['chart']);
    expect(trip.exported.trim()).toBe('```chart\ntype: pie\nx: a\ny: b\n```');
  });

  it('closes on a same-character fence at least as long as the opener, as CommonMark does', () => {
    const longerCloser = fenceRoundTrip('```chart\ntype: bar\n````\n\nAFTER');
    expect(blocks(longerCloser)).toEqual([['chart', 'type: bar'], ['paragraph', 'AFTER']]);

    // A longer opener holds shorter fences and tildes in its body.
    const body = 'type: bar\nnote: |\n  ```\n  ~~~\n  ```';
    const longerOpener = fenceRoundTrip(`\`\`\`\`chart\n${body}\n\`\`\`\`\n\nAFTER`);
    expect(blocks(longerOpener)).toEqual([['chart', body], ['paragraph', 'AFTER']]);
    expect(longerOpener.reexported).toBe(longerOpener.exported);

    const tilde = fenceRoundTrip('~~~chart\ntype: pie\n```\n~~~\nAFTER');
    expect(blocks(tilde)).toEqual([['chart', 'type: pie\n```'], ['paragraph', 'AFTER']]);
  });

  it('exports with a delimiter longer than any backtick run in the body', () => {
    const trip = fenceRoundTrip('~~~~chart\nnote: "````"\n~~~~');
    expect(trip.exported.trim()).toBe('`````chart\nnote: "````"\n`````');
    expect(trip.reexported).toBe(trip.exported);
  });

  it('keeps the body verbatim, including leading and trailing blank lines', () => {
    const trip = fenceRoundTrip('```chart\ntext: |+\n  hello\n\n\n```\n\nAFTER');
    expect(blocks(trip)).toEqual([['chart', 'text: |+\n  hello\n\n'], ['paragraph', 'AFTER']]);
    expect(trip.reexported).toBe(trip.exported);
    expect(fenceRoundTrip('```chart\n\ntype: bar\n```').blockTexts).toEqual(['\ntype: bar']);
  });

  it('reads CSV with quoted cells, escaped quotes, CRLF and numbers', () => {
    expect(parseFenceCsv('name,n\r\n"Smith, J",3\r\n"say ""hi""",-1.5\n\n,')).toEqual([
      { name: 'Smith, J', n: 3 },
      { name: 'say "hi"', n: -1.5 },
    ]);
  });
});
