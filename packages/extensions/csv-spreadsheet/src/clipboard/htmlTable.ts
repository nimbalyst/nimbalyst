/**
 * `text/html` clipboard tables: parse what spreadsheets and web pages put on the
 * clipboard, and write a table other spreadsheets can paste with formatting.
 */

import type { CellMatrix } from './tsv';

/** Turns an HTML string into a Document. Injectable so tests can supply jsdom's. */
export type HtmlDocumentParser = (html: string) => Document;

const MAX_SPAN = 1000;

export function defaultHtmlParser(): HtmlDocumentParser | null {
  if (typeof DOMParser === 'undefined') return null;
  const parser = new DOMParser();
  return (html) => parser.parseFromString(html, 'text/html');
}

/**
 * Parse the first `<table>` in `html` into a rectangular matrix of cell text.
 * Returns null when there is no table (or no parser), so the caller falls back
 * to `text/plain`.
 *
 * Spanned cells keep their text in the top-left slot and blank-fill the rest,
 * so the pasted grid lines up with what was copied.
 */
export function parseHtmlTable(html: string, parse: HtmlDocumentParser | null = defaultHtmlParser()): CellMatrix | null {
  if (!parse || !/<table[\s>]/i.test(html)) return null;
  const table = parse(html).querySelector('table');
  if (!table) return null;

  const grid: (string | undefined)[][] = [];
  const rows = Array.from(table.rows);
  rows.forEach((tr, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of Array.from(tr.cells)) {
      while (grid[r][c] !== undefined) c++;
      const colSpan = clampSpan(cell.colSpan);
      // rowspan="0" means "to the end of the section"; treat as the rest of the table.
      const rowSpan = cell.rowSpan === 0 ? rows.length - r : clampSpan(cell.rowSpan);
      const text = cellText(cell);
      for (let dr = 0; dr < rowSpan && r + dr < rows.length; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < colSpan; dc++) {
          grid[r + dr][c + dc] = dr === 0 && dc === 0 ? text : '';
        }
      }
      c += colSpan;
    }
  });

  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  return grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''));
}

function clampSpan(span: number): number {
  return Number.isFinite(span) && span >= 1 ? Math.min(span, MAX_SPAN) : 1;
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const SKIP_TAGS = new Set(['STYLE', 'SCRIPT', 'TEMPLATE']);

type WhitespaceMode = 'collapse' | 'preserve' | 'pre-line';

/** The `white-space` an element sets for its text, from its tag or inline style. */
function whitespaceMode(element: Element, inherited: WhitespaceMode): WhitespaceMode {
  if (element.tagName === 'PRE' || element.tagName === 'TEXTAREA') return 'preserve';
  const match = /white-space\s*:\s*([a-z-]+)/i.exec(element.getAttribute('style') ?? '');
  if (!match) return inherited;
  const value = match[1].toLowerCase();
  if (value === 'pre' || value === 'pre-wrap' || value === 'break-spaces') return 'preserve';
  if (value === 'pre-line') return 'pre-line';
  return 'collapse';
}

/**
 * Rendered-ish text of a cell: `<br>` and blocks as newlines, whitespace as the
 * cell's `white-space` renders it. Collapsing a `pre-wrap` cell turned
 * `  alpha  beta` into `alpha beta`, and HTML wins over the intact TSV.
 */
function cellText(cell: Element): string {
  let out = '';
  let collapsedText = false;
  const walk = (node: Node, mode: WhitespaceMode) => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const text = (node.textContent ?? '').replace(/\r\n?/g, '\n');
      if (mode === 'preserve') out += text;
      else if (mode === 'pre-line') out += text.replace(/[ \t\f]+/g, ' ');
      else {
        if (text !== '') collapsedText = true;
        out += text.replace(/[ \t\n\f]+/g, ' ');
      }
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const element = node as Element;
    const tag = element.tagName;
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'BR') {
      out += '\n';
      return;
    }
    const childMode = whitespaceMode(element, mode);
    const block = BLOCK_TAGS.has(tag);
    if (block && out !== '' && !out.endsWith('\n')) out += '\n';
    node.childNodes.forEach((child) => walk(child, childMode));
    if (block && out !== '' && !out.endsWith('\n')) out += '\n';
  };
  const cellMode = whitespaceMode(cell, 'collapse');
  cell.childNodes.forEach((child) => walk(child, cellMode));
  const text = out.replace(/\u00a0/g, ' ');
  // Only collapsed text gets the edge trimming a browser would give it.
  if (!collapsedText) return text;
  return text
    .split('\n')
    .map((line) => line.replace(/^ +| +$/g, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/** Inline formatting written into copied HTML. Colors are resolved CSS colors. */
export interface HtmlCellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
  backgroundColor?: string;
  align?: 'left' | 'center' | 'right';
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SAFE_CSS_VALUE = /^[#(),.%\w\s-]+$/;

/** Whitespace a collapsing reader would lose: edge or repeated spaces, tabs, indented lines. */
const NEEDS_PRESERVE = /^[ \t]|[ \t]$|[ \t]{2}|\t|\n[ \t]|[ \t]\n/;

function styleAttr(style: HtmlCellStyle | undefined, preserveWhitespace = false): string {
  const decls: string[] = [];
  if (preserveWhitespace) decls.push('white-space:pre-wrap');
  if (!style) return decls.length ? ` style="${decls.join(';')}"` : '';
  if (style.bold) decls.push('font-weight:bold');
  if (style.italic) decls.push('font-style:italic');
  const decorations = [style.underline && 'underline', style.strikethrough && 'line-through'].filter(Boolean);
  if (decorations.length) decls.push(`text-decoration:${decorations.join(' ')}`);
  if (style.color && SAFE_CSS_VALUE.test(style.color)) decls.push(`color:${style.color}`);
  if (style.backgroundColor && SAFE_CSS_VALUE.test(style.backgroundColor)) {
    decls.push(`background-color:${style.backgroundColor}`);
  }
  if (style.align) decls.push(`text-align:${style.align}`);
  return decls.length ? ` style="${decls.join(';')}"` : '';
}

/**
 * Serialize a matrix of display strings as an HTML table. `styleAt` is indexed
 * relative to the matrix (0,0 = its top-left).
 */
export function serializeHtmlTable(
  matrix: readonly (readonly string[])[],
  styleAt?: (row: number, col: number) => HtmlCellStyle | undefined,
): string {
  const body = matrix
    .map((row, r) => {
      const cells = row
        .map((value, c) => `<td${styleAttr(styleAt?.(r, c), NEEDS_PRESERVE.test(value))}>${escapeHtml(value).replace(/\r?\n/g, '<br>')}</td>`)
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<meta charset="utf-8"><table><tbody>${body}</tbody></table>`;
}
