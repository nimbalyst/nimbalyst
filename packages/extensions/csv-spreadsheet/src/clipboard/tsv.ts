/**
 * Tab-separated clipboard text, RFC-4180 style.
 *
 * Spreadsheets put multi-line or tab-containing cells in double quotes with
 * inner quotes doubled. A naive `split('\n')` / `split('\t')` turns one such
 * cell into several rows, which is what the old paste path did.
 */

export type CellMatrix = string[][];

/**
 * Parse clipboard TSV into a rectangular matrix (short rows padded with '').
 *
 * - CRLF, LF and lone CR all end a row; one trailing line break is ignored.
 * - A cell is quoted only when it *starts* with `"`; a quote elsewhere is literal.
 * - A quote that never closes is treated as literal text, so one stray `"` in
 *   copied prose cannot swallow the rest of the paste.
 */
export function parseTsv(text: string): CellMatrix {
  if (text === '') return [];
  const rows: CellMatrix = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;

  const endRow = () => {
    rows.push(row);
    row = [];
  };

  while (i <= n) {
    // Start of a field.
    if (text[i] === '"') {
      const quoted = readQuoted(text, i);
      if (quoted) {
        row.push(quoted.value);
        i = quoted.end;
        if (i >= n) {
          endRow();
          break;
        }
        // `quoted.end` sits on a delimiter.
        i = consumeDelimiter(text, i, endRow);
        if (i < 0) break;
        continue;
      }
    }
    let j = i;
    while (j < n && text[j] !== '\t' && text[j] !== '\n' && text[j] !== '\r') j++;
    row.push(text.slice(i, j));
    if (j >= n) {
      endRow();
      break;
    }
    i = consumeDelimiter(text, j, endRow);
    if (i < 0) break;
  }

  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  for (const r of rows) while (r.length < width) r.push('');
  return rows;
}

/**
 * Consume the delimiter at `i`. Returns the next field start, or -1 when the
 * delimiter was the text's final line break (no row follows it).
 */
function consumeDelimiter(text: string, i: number, endRow: () => void): number {
  if (text[i] === '\t') return i + 1;
  endRow();
  const next = text[i] === '\r' && text[i + 1] === '\n' ? i + 2 : i + 1;
  return next >= text.length ? -1 : next;
}

/** Read a quoted field starting at `start`. Null when it never closes properly. */
function readQuoted(text: string, start: number): { value: string; end: number } | null {
  let value = '';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      if (text[i + 1] === '"') {
        value += '"';
        i += 2;
        continue;
      }
      const after = text[i + 1];
      if (after === undefined || after === '\t' || after === '\n' || after === '\r') {
        return { value, end: i + 1 };
      }
      // `"a"b`: not a well-formed quoted field.
      return null;
    }
    value += ch;
    i++;
  }
  return null;
}

/** Quote a cell only when a reader would otherwise split or unquote it. */
export function serializeTsvCell(cell: string): string {
  return /[\t\n\r"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function serializeTsv(matrix: readonly (readonly string[])[]): string {
  return matrix.map((row) => row.map(serializeTsvCell).join('\t')).join('\n');
}
