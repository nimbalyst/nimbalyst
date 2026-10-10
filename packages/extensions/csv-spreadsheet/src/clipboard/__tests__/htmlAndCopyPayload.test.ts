// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseHtmlTable, serializeHtmlTable } from '../htmlTable';
import { buildCopyPayload, parseInternalPayload, resolvePasteSource } from '../copyPayload';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('parseHtmlTable', () => {
  it('reads a spreadsheet-style table with styles, entities, <br> and paragraphs', () => {
    const html = `<meta charset="utf-8"><style>td{color:red}</style>
      <google-sheets-html-origin><table data-sheets-root="1"><colgroup><col></colgroup><tbody>
        <tr><td>  Name </td><td><b>Qty</b></td></tr>
        <tr><td>a&amp;b&nbsp;c</td><td>line 1<br>line 2</td></tr>
        <tr><td><p>para 1</p><p>para 2</p></td><td><span>  x\n  y </span></td></tr>
      </tbody></table>`;
    expect(parseHtmlTable(html, parse)).toEqual([
      ['Name', 'Qty'],
      ['a&b c', 'line 1\nline 2'],
      ['para 1\npara 2', 'x y'],
    ]);
  });

  it('blank-fills colspan and rowspan so columns stay aligned', () => {
    const html = `<table>
      <tr><td colspan="2">wide</td><td rowspan="2">tall</td><td>d</td></tr>
      <tr><td>e</td><td>f</td><td>g</td></tr>
      <tr><td>h</td></tr>
    </table>`;
    expect(parseHtmlTable(html, parse)).toEqual([
      ['wide', '', 'tall', 'd'],
      ['e', 'f', '', 'g'],
      ['h', '', '', ''],
    ]);
  });

  it('includes header rows and returns null when there is no table or parser', () => {
    expect(parseHtmlTable('<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>', parse))
      .toEqual([['H'], ['1']]);
    expect(parseHtmlTable('<p>no table</p>', parse)).toBeNull();
    expect(parseHtmlTable('<table><tr><td>x</td></tr></table>', null)).toBeNull();
  });
});

describe('serializeHtmlTable', () => {
  it('escapes content, turns newlines into <br>, writes inline styles, and parses back', () => {
    const html = serializeHtmlTable([['<b>&', 'two\nlines']], (_r, c) =>
      c === 0 ? { bold: true, italic: true, underline: true, strikethrough: true, color: '#c00', backgroundColor: 'rgb(1, 2, 3)' } : undefined,
    );
    const cell = parse(html).querySelector('td')!;
    expect(cell.style.fontWeight).toBe('bold');
    expect(cell.style.fontStyle).toBe('italic');
    expect(cell.style.textDecoration).toBe('underline line-through');
    expect(cell.style.backgroundColor).toBe('rgb(1, 2, 3)');
    expect(parseHtmlTable(html, parse)).toEqual([['<b>&', 'two\nlines']]);
  });

  // R1-4: a pre-wrap cell collapsed to "alpha beta gamma", and HTML wins over
  // the intact TSV, so the paste silently lost the spacing and line break.
  it('honors preserved whitespace when parsing and round-trips spaces and newlines', () => {
    const cell = '  alpha  beta\n gamma  ';
    expect(parseHtmlTable(`<table><tr><td style="white-space: pre-wrap">${cell}</td><td><pre>a  b</pre></td></tr></table>`, parse))
      .toEqual([[cell, 'a  b']]);
    expect(parseHtmlTable(serializeHtmlTable([[cell, 'plain']]), parse)).toEqual([[cell, 'plain']]);
  });

  it('drops color values that could break out of the style attribute', () => {
    const html = serializeHtmlTable([['x']], () => ({ color: 'red;background:url(x)"><script>' }));
    expect(parse(html).querySelector('td')!.getAttribute('style')).toBeNull();
  });
});

describe('copy payload and paste source', () => {
  const payload = buildCopyPayload({
    range: { startRow: 3, startCol: 1, endRow: 4, endCol: 2 },
    raw: [['=B1*2', 'x'], ['10', 'multi\nline']],
    display: [['4', 'x'], ['$10.00', 'multi\nline']],
  });

  it('puts display values in text/plain and raw formulas with their origin in the internal payload', () => {
    expect(payload.text).toBe('4\tx\n$10.00\t"multi\nline"');
    expect(parseInternalPayload(payload.internalJson)).toEqual({
      version: 1,
      origin: { row: 3, col: 1 },
      raw: [['=B1*2', 'x'], ['10', 'multi\nline']],
      display: [['4', 'x'], ['$10.00', 'multi\nline']],
    });
    expect(parseHtmlTable(payload.html, parse)).toEqual(payload.internal.display);
  });

  it('prefers the internal payload (MIME or embedded in html) and keeps formulas', () => {
    const viaMime = resolvePasteSource({ text: payload.text, internalJson: payload.internalJson }, { parseHtml: parse });
    expect(viaMime).toEqual({ kind: 'internal', values: payload.internal.raw, origin: { row: 3, col: 1 } });
    // Clipboard APIs may rewrite line endings; the embedded payload still matches.
    const viaHtml = resolvePasteSource({ text: payload.text.replace(/\n/g, '\r\n') + '\r\n', html: payload.html }, { parseHtml: parse });
    expect(viaHtml?.kind).toBe('internal');
  });

  it('paste values only uses display values and no origin', () => {
    expect(resolvePasteSource({ text: payload.text, internalJson: payload.internalJson }, { valuesOnly: true, parseHtml: parse }))
      .toEqual({ kind: 'internal', values: payload.internal.display });
  });

  it('ignores an internal payload that no longer matches the plain text, then falls back html -> TSV', () => {
    const stale = resolvePasteSource({ text: 'other\tdata', internalJson: payload.internalJson }, { parseHtml: parse });
    expect(stale).toEqual({ kind: 'text', values: [['other', 'data']] });
    const html = resolvePasteSource({ text: 'ignored', html: '<table><tr><td>h</td></tr></table>' }, { parseHtml: parse });
    expect(html).toEqual({ kind: 'html', values: [['h']] });
    expect(resolvePasteSource({ html: '<p>x</p>' }, { parseHtml: parse })).toBeNull();
  });

  it('rejects malformed internal payloads', () => {
    for (const json of ['nope', '{}', '{"version":1,"origin":{"row":0,"col":0},"raw":[[1]],"display":[["1"]]}']) {
      expect(parseInternalPayload(json)).toBeNull();
    }
  });
});
