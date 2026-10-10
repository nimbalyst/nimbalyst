/**
 * Cmd+K: a cell's link as the dialog edits it, and the cell text it saves.
 *
 * A link in an ordinary cell is stored as `=HYPERLINK("url","text")`, so the
 * file stays a plain CSV any spreadsheet can read. In a url-typed column the
 * cell already is the link, and the dialog edits the URL itself.
 */

export interface CellLink {
  readonly text: string;
  readonly url: string;
  /**
   * False when the cell is a formula the dialog cannot round-trip (a
   * HYPERLINK of references, any other formula): saving replaces it.
   */
  readonly editable?: boolean;
}

const STRING_ARG = '"((?:[^"]|"")*)"';
const LITERAL_HYPERLINK = new RegExp(`^=\\s*HYPERLINK\\(\\s*${STRING_ARG}\\s*(?:,\\s*${STRING_ARG}\\s*)?\\)\\s*$`, 'i');

const unquote = (value: string) => value.replace(/""/g, '"');
const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;

/** `shown` is the cell's displayed text, the label a plain cell starts from. */
export function readCellLink(raw: string, shown: string, urlColumn: boolean): CellLink {
  if (urlColumn) return { text: '', url: raw.trim(), editable: !raw.trimStart().startsWith('=') };
  const match = LITERAL_HYPERLINK.exec(raw.trim());
  if (match) return { text: unquote(match[2] ?? ''), url: unquote(match[1]), editable: true };
  return { text: shown, url: '', editable: !raw.trimStart().startsWith('=') };
}

/** The cell text for a link; an empty URL removes the link and keeps the text. */
export function writeCellLink(link: CellLink, urlColumn: boolean): string {
  const url = link.url.trim();
  if (urlColumn) return url;
  if (!url) return link.text;
  return link.text === '' || link.text === url
    ? `=HYPERLINK(${quote(url)})`
    : `=HYPERLINK(${quote(url)},${quote(link.text)})`;
}
