/**
 * RFC 4180 CSV. Reads CRLF or LF and an optional UTF-8 BOM; writes LF with no
 * BOM. A field is quoted when it holds a comma, quote, CR, LF, or leading or
 * trailing whitespace.
 */

export class CsvParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} (line ${line})`);
    this.name = 'CsvParseError';
  }
}

export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let atFieldStart = true;
  let rowHasContent = false;
  let line = 1;
  let i = 0;
  const endRow = () => {
    row.push(field);
    // A blank line is not a row with one empty field.
    if (rowHasContent) rows.push(row);
    row = [];
    field = '';
    atFieldStart = true;
    rowHasContent = false;
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        const next = text[i];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
          throw new CsvParseError('Unexpected character after closing quote', line);
        }
        continue;
      }
      if (ch === '\n') line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
      rowHasContent = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      atFieldStart = true;
      rowHasContent = true;
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRow();
      line++;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    atFieldStart = false;
    rowHasContent = true;
    i++;
  }
  if (quoted) throw new CsvParseError('Unterminated quoted field', line);
  if (rowHasContent) endRow();
  return rows;
}

function quoteField(value: string): string {
  if (/[",\r\n]/.test(value) || /^\s|\s$/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export function stringifyCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(quoteField).join(',')).join('\n') + '\n';
}

/** Multi-value cells: `;`-separated, with `\;` and `\\` for literals. */
export function joinMultiValue(values: readonly string[]): string {
  return values.map((v) => v.replace(/\\/g, '\\\\').replace(/;/g, '\\;')).join(';');
}

export function splitMultiValue(cell: string): string[] {
  if (cell === '') return [];
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < cell.length; i++) {
    const ch = cell[i];
    if (ch === '\\' && i + 1 < cell.length) {
      current += cell[i + 1];
      i++;
    } else if (ch === ';') {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out.filter((v) => v !== '');
}
