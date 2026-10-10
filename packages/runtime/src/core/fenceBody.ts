/**
 * Reading a fence body: a YAML mapping, or CSV rows. Read-only on purpose --
 * the node keeps the text, and a block that wants to change one key edits
 * the text rather than dumping a parsed object (which would reorder keys,
 * drop comments, and reformat values the author wrote).
 */

import yaml from 'js-yaml';

export type FenceYamlResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function parseFenceYaml(source: string): FenceYamlResult {
  let value: unknown;
  try {
    value = yaml.load(source);
  } catch (error) {
    const reason = error instanceof yaml.YAMLException ? error.reason || error.message : String(error);
    const line = error instanceof yaml.YAMLException && error.mark ? ` (line ${error.mark.line + 1})` : '';
    return { ok: false, error: `Not valid YAML${line}: ${reason}` };
  }
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Expected "key: value" lines.' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/**
 * The body with top-level `key: value` lines set, editing only those lines:
 * an unindented `key:` line is replaced, a missing one is added at the top
 * (never the end, which could land inside a `data: |` block), and a null
 * value removes the line. Numbers are rounded; strings are quoted only when
 * YAML needs it. Indented lines (block text, a nested spec) are not touched.
 * If the edit would not read back as the requested values (a flow mapping, a
 * `---` marker), the body is returned unchanged.
 */
export function setFenceYamlValues(body: string, values: Readonly<Record<string, number | string | null>>): string {
  const normalized = Object.entries(values).map(([key, value]) => [key, typeof value === 'number' ? Math.round(value) : value] as const);
  const format = (value: number | string) => (typeof value === 'number' ? String(value) : yaml.dump(value, { lineWidth: -1 }).trimEnd());
  let lines = body.split('\n');
  const added: string[] = [];
  for (const [key, value] of normalized) {
    const re = new RegExp(`^${key}\\s*:`);
    const existing = lines.findIndex((line) => re.test(line));
    if (value === null) {
      if (existing >= 0) lines = lines.filter((_, index) => index !== existing);
    } else if (existing >= 0) {
      lines[existing] = `${key}: ${format(value)}`;
    } else {
      added.push(`${key}: ${format(value)}`);
    }
  }
  const next = [...added, ...lines].join('\n');
  const check = parseFenceYaml(next);
  if (!check.ok) return body;
  for (const [key, value] of normalized) {
    if ((check.value[key] ?? null) !== value) return body;
  }
  return next;
}

/**
 * CSV with a header row: quoted cells (`"a, b"`, `""` for a quote), blank
 * lines skipped. A cell that reads as a finite number becomes a number.
 */
export function parseFenceCsv(text: string): Array<Record<string, string | number>> {
  const lines = splitCsvRecords(text).filter((cells) => cells.some((cell) => cell.trim() !== ''));
  if (lines.length === 0) return [];
  const header = lines[0].map((cell) => cell.trim());
  return lines.slice(1).map((cells) => {
    const row: Record<string, string | number> = {};
    header.forEach((name, index) => {
      if (!name) return;
      const raw = (cells[index] ?? '').trim();
      row[name] = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    });
    return row;
  });
}

function splitCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      cells.push(cell);
      records.push(cells);
      cells = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  records.push(cells);
  return records;
}
