/**
 * Copy payload and paste-source resolution.
 *
 * Other apps get what the user sees: `text/plain` is TSV of *display* values and
 * `text/html` is a formatted table. Nimbalyst also gets the raw cells (formulas
 * included) plus where they were copied from, so an internal paste can keep
 * formulas and shift their relative refs. The internal JSON rides both as its
 * own MIME type and as an attribute on the HTML table, because the async
 * Clipboard API only round-trips `text/plain` and `text/html` reliably.
 */

import type { CellCoord, CellRange } from '../keyboard/types';
import { defaultHtmlParser, parseHtmlTable, serializeHtmlTable, type HtmlCellStyle, type HtmlDocumentParser } from './htmlTable';
import { parseTsv, serializeTsv, type CellMatrix } from './tsv';

export const INTERNAL_CLIPBOARD_MIME = 'web application/x-nimbalyst-sheet+json';
const HTML_PAYLOAD_ATTR = 'data-nimbalyst-sheet';

export interface InternalClipboardPayload {
  readonly version: 1;
  /** Top-left sheet cell of the copied range. */
  readonly origin: CellCoord;
  /** Sheet row of each copied row; a filtered copy skips hidden rows, so they need not be contiguous. */
  readonly rows?: readonly number[];
  /** Cell contents as stored (formulas start with `=`). */
  readonly raw: CellMatrix;
  /** What the grid showed; used for Paste values only. */
  readonly display: CellMatrix;
}

export interface CopyPayload {
  readonly text: string;
  readonly html: string;
  readonly internal: InternalClipboardPayload;
  /** `internal` serialized, for `INTERNAL_CLIPBOARD_MIME`. */
  readonly internalJson: string;
}

export interface CopyInput {
  readonly range: CellRange;
  /** Matrices sized to `range`, indexed relative to its top-left. */
  readonly raw: CellMatrix;
  readonly display: CellMatrix;
  /** Sheet row of each copied row, when not `range.startRow + i`. */
  readonly rows?: readonly number[];
  readonly styleAt?: (row: number, col: number) => HtmlCellStyle | undefined;
}

export function buildCopyPayload(input: CopyInput): CopyPayload {
  const { range, raw, display } = input;
  const rows = range.endRow - range.startRow + 1;
  const cols = range.endCol - range.startCol + 1;
  const fit = (m: CellMatrix) =>
    Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => m[r]?.[c] ?? ''));
  const internal: InternalClipboardPayload = {
    version: 1,
    origin: { row: range.startRow, col: range.startCol },
    ...(input.rows ? { rows: input.rows.slice(0, rows) } : {}),
    raw: fit(raw),
    display: fit(display),
  };
  const internalJson = JSON.stringify(internal);
  const table = serializeHtmlTable(internal.display, input.styleAt);
  const html = table.replace('<table>', `<table ${HTML_PAYLOAD_ATTR}="${escapeAttr(internalJson)}">`);
  return { text: serializeTsv(internal.display), html, internal, internalJson };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function parseInternalPayload(json: string | null | undefined): InternalClipboardPayload | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<InternalClipboardPayload>;
    const isMatrix = (m: unknown): m is CellMatrix =>
      Array.isArray(m) && m.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'));
    if (
      value?.version !== 1 ||
      !Number.isInteger(value.origin?.row) ||
      !Number.isInteger(value.origin?.col) ||
      !isMatrix(value.raw) ||
      !isMatrix(value.display) ||
      value.raw.length !== value.display.length ||
      (value.rows !== undefined && (
        !Array.isArray(value.rows) || value.rows.length !== value.raw.length || !value.rows.every(Number.isInteger)
      ))
    ) {
      return null;
    }
    return value as InternalClipboardPayload;
  } catch {
    return null;
  }
}

export interface ClipboardInput {
  readonly text?: string | null;
  readonly html?: string | null;
  readonly internalJson?: string | null;
}

export interface ResolvedPasteSource {
  readonly kind: 'internal' | 'html' | 'text';
  readonly values: CellMatrix;
  /** Present only for internal pastes that keep formulas. */
  readonly origin?: CellCoord;
  /** Sheet row each source row was copied from (internal pastes that keep formulas). */
  readonly rows?: readonly number[];
}

/**
 * Pick what to paste: our own payload when it is present and still matches the
 * plain text (so a clipboard another app rewrote is not trusted), then an HTML
 * table, then TSV. `valuesOnly` (Cmd+Shift+V) pastes display values and drops
 * the origin so no formula is written or adjusted.
 */
export function resolvePasteSource(
  input: ClipboardInput,
  options: { valuesOnly?: boolean; parseHtml?: HtmlDocumentParser | null } = {},
): ResolvedPasteSource | null {
  const parse = options.parseHtml === undefined ? defaultHtmlParser() : options.parseHtml;
  const internal =
    parseInternalPayload(input.internalJson) ??
    parseInternalPayload(input.html ? extractHtmlPayload(input.html, parse) : null);
  const text = input.text ?? '';
  if (internal && (text === '' || normalizeNewlines(text) === normalizeNewlines(serializeTsv(internal.display)))) {
    return options.valuesOnly
      ? { kind: 'internal', values: internal.display }
      : { kind: 'internal', values: internal.raw, origin: internal.origin, rows: internal.rows };
  }
  if (input.html) {
    const table = parseHtmlTable(input.html, parse);
    if (table && table.length > 0) return { kind: 'html', values: table };
  }
  if (text !== '') return { kind: 'text', values: parseTsv(text) };
  return null;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
}

function extractHtmlPayload(html: string, parse: HtmlDocumentParser | null): string | null {
  if (!parse || !html.includes(HTML_PAYLOAD_ATTR)) return null;
  return parse(html).querySelector(`table[${HTML_PAYLOAD_ATTR}]`)?.getAttribute(HTML_PAYLOAD_ATTR) ?? null;
}
