/**
 * Output rendering: table (TTY default), --json (the stable agent contract,
 * shape = TrackerRecord), --csv, and --quiet (ids only).
 */
import type { TrackerRecord } from '../vendor/trackerRecord.js';
import type {
  ImporterInfo,
  ImporterSearchResult,
  ImportResult,
  ResnapshotResult,
} from '../gateway/types.js';
import { bold, dim, colorStatus, gray } from './colors.js';
import { relativeFromNow } from './time.js';

export interface OutputOptions {
  json?: boolean;
  csv?: boolean;
  quiet?: boolean;
  columns?: string[];
}

const DEFAULT_COLUMNS = ['key', 'type', 'status', 'title', 'updated'];

/** Field accessor for a column name, returning a display string. */
function columnValue(r: TrackerRecord, col: string): string {
  switch (col) {
    case 'key':
      return r.issueKey ?? shortId(r.id);
    case 'id':
      return r.id;
    case 'type':
      return r.primaryType;
    case 'status':
      return String(r.fields.status ?? '');
    case 'title':
      return String(r.fields.title ?? '');
    case 'priority':
      return String(r.fields.priority ?? '');
    case 'owner':
      return String(r.fields.owner ?? '');
    case 'updated':
      return relativeFromNow(r.system.updatedAt);
    case 'created':
      return relativeFromNow(r.system.createdAt);
    case 'archived':
      return r.archived ? 'yes' : '';
    default: {
      const v = r.fields[col];
      if (v == null) return '';
      return Array.isArray(v) ? v.join(',') : String(v);
    }
  }
}

function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id;
}

export function renderList(records: TrackerRecord[], opts: OutputOptions): string {
  if (opts.json) {
    return JSON.stringify({ items: records, count: records.length }, null, 2);
  }
  if (opts.quiet) {
    return records.map((r) => r.issueKey ?? r.id).join('\n');
  }
  if (opts.csv) {
    return renderCsv(records, opts.columns ?? DEFAULT_COLUMNS);
  }
  return renderTable(records, opts.columns ?? DEFAULT_COLUMNS);
}

export function renderRecord(record: TrackerRecord, body: string | undefined, opts: OutputOptions): string {
  if (opts.json) {
    return JSON.stringify(body !== undefined ? { ...record, body } : record, null, 2);
  }
  if (opts.quiet) {
    return record.issueKey ?? record.id;
  }
  return renderDetail(record, body);
}

function renderTable(records: TrackerRecord[], columns: string[]): string {
  if (records.length === 0) return dim('No items.');

  const headers = columns.map((c) => c.toUpperCase());
  const rows = records.map((r) => columns.map((c) => columnValue(r, c)));

  // Compute widths from plain (uncolored) text.
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length)),
  );

  const maxWidth = process.stdout.columns && process.stdout.columns > 20 ? process.stdout.columns : 200;
  const titleIdx = columns.indexOf('title');

  const fmtCell = (text: string, i: number, colorize: (s: string) => string): string => {
    let cell = text;
    // Truncate the title column if the line would overflow the terminal.
    if (i === titleIdx) {
      const otherWidth = widths.reduce((sum, w, idx) => (idx === titleIdx ? sum : sum + w + 2), 0);
      const budget = Math.max(10, maxWidth - otherWidth - 1);
      if (cell.length > budget) cell = cell.slice(0, budget - 1) + '…';
    }
    const padded = cell.padEnd(widths[i]);
    return colorize(padded);
  };

  const headerLine = headers.map((h, i) => bold(h.padEnd(widths[i]))).join('  ');
  const bodyLines = rows.map((row, ri) =>
    row
      .map((cell, i) => {
        const col = columns[i];
        if (col === 'status') return fmtCell(cell, i, () => colorStatus(records[ri].fields.status as string));
        if (col === 'key' || col === 'id') return fmtCell(cell, i, dim);
        if (col === 'updated' || col === 'created') return fmtCell(cell, i, gray);
        return fmtCell(cell, i, (s) => s);
      })
      .join('  ')
      .replace(/\s+$/, ''),
  );

  return [headerLine, ...bodyLines].join('\n');
}

function renderCsv(records: TrackerRecord[], columns: string[]): string {
  const esc = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [columns.join(',')];
  for (const r of records) {
    lines.push(columns.map((c) => esc(rawColumnValue(r, c))).join(','));
  }
  return lines.join('\n');
}

/** CSV wants the raw value (no relative-time prettifying). */
function rawColumnValue(r: TrackerRecord, col: string): string {
  switch (col) {
    case 'key':
      return r.issueKey ?? r.id;
    case 'updated':
      return r.system.updatedAt ?? '';
    case 'created':
      return r.system.createdAt ?? '';
    default:
      return columnValue(r, col);
  }
}

function renderDetail(record: TrackerRecord, body: string | undefined): string {
  const lines: string[] = [];
  const key = record.issueKey ?? record.id;
  lines.push(`${bold(key)}  ${dim(record.primaryType)}`);
  lines.push('');
  lines.push(`${bold('Title')}    ${record.fields.title ?? ''}`);
  lines.push(`${bold('Status')}   ${colorStatus(record.fields.status as string)}`);
  if (record.fields.priority) lines.push(`${bold('Priority')} ${record.fields.priority}`);
  if (record.fields.owner) lines.push(`${bold('Owner')}    ${record.fields.owner}`);
  if (record.typeTags.length > 1) lines.push(`${bold('Types')}    ${record.typeTags.join(', ')}`);
  if (Array.isArray(record.fields.tags) && record.fields.tags.length) {
    lines.push(`${bold('Tags')}     ${(record.fields.tags as string[]).join(', ')}`);
  }
  lines.push(`${bold('Updated')}  ${record.system.updatedAt ?? ''} ${dim(`(${relativeFromNow(record.system.updatedAt)})`)}`);
  if (record.system.origin) {
    const urn = (record.system.origin as any)?.external?.urn;
    if (urn) lines.push(`${bold('URN')}      ${urn}`);
  }

  // Remaining custom fields. `description` is rendered as a body block below,
  // not inline. Empty objects/arrays/null are skipped as noise.
  const shown = new Set(['title', 'status', 'priority', 'owner', 'tags', 'description']);
  const extras = Object.entries(record.fields).filter(([k, v]) => !shown.has(k) && !isEmptyValue(v));
  if (extras.length) {
    lines.push('');
    lines.push(dim('Fields'));
    for (const [k, v] of extras) {
      lines.push(`  ${k}: ${formatFieldValue(v)}`);
    }
  }

  // Body: prefer the cached markdown body; fall back to the description field.
  // Either source can be double-encoded (a JSON-quoted string), so unwrap.
  const rawBody = (body && body.trim()) || (typeof record.fields.description === 'string' ? record.fields.description.trim() : '');
  const bodyText = unwrapJsonString(rawBody);
  if (bodyText) {
    lines.push('');
    lines.push(dim('────────────────────────────'));
    lines.push(bodyText);
  }
  return lines.join('\n');
}

/** Some stored text fields are double-encoded (a JSON-quoted string). If the
 *  value looks like `"...\n..."`, decode it so the body renders as real text. */
function unwrapJsonString(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === 'string') return parsed;
  } catch {
    // Tolerant fallback for malformed double-encoding (mixed real/escaped
    // newlines): strip outer quotes and unescape the common sequences.
    return s
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return s;
}

function isEmptyValue(v: unknown): boolean {
  if (v == null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

function formatFieldValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function renderTypes(
  types: { type: string; displayName?: string; builtin?: boolean; count?: number }[],
  opts: OutputOptions,
): string {
  if (opts.json) return JSON.stringify({ types }, null, 2);
  if (opts.quiet) return types.map((t) => t.type).join('\n');
  if (types.length === 0) return dim('No tracker types found.');
  const lines = types.map((t) => {
    const parts = [bold(t.type)];
    if (t.displayName) parts.push(dim(t.displayName));
    if (t.builtin !== undefined) parts.push(gray(t.builtin ? 'builtin' : 'custom'));
    if (t.count !== undefined) parts.push(gray(`${t.count} item${t.count === 1 ? '' : 's'}`));
    return parts.join('  ');
  });
  return lines.join('\n');
}

// ---- importers -------------------------------------------------------------

export function renderImporters(importers: ImporterInfo[], opts: OutputOptions): string {
  if (opts.json) return JSON.stringify({ importers }, null, 2);
  if (opts.quiet) return importers.map((i) => i.id).join('\n');
  if (importers.length === 0) {
    return dim('No importers installed. Install an importer extension (e.g. GitHub Issues) first.');
  }
  return importers
    .map((i) => {
      const parts = [bold(i.id)];
      if (i.displayName && i.displayName !== i.id) parts.push(dim(i.displayName));
      if (i.urnScheme) parts.push(gray(`${i.urnScheme}://`));
      if (i.importsAs?.length) parts.push(gray(`imports as ${i.importsAs.join(', ')}`));
      return parts.join('  ');
    })
    .join('\n');
}

export function renderImporterSearch(result: ImporterSearchResult, opts: OutputOptions): string {
  if (opts.json) return JSON.stringify(result, null, 2);
  if (opts.quiet) return result.items.map((i) => i.externalId).join('\n');
  if (result.items.length === 0) return dim('No matching items.');

  const rows = result.items.map((i) => [i.externalId, i.state, i.title, i.urn]);
  const headers = ['ID', 'STATE', 'TITLE', 'URN'];
  const widths = headers.map((h, idx) =>
    Math.max(h.length, ...rows.map((r) => r[idx].length)),
  );
  const maxWidth = process.stdout.columns && process.stdout.columns > 20 ? process.stdout.columns : 200;
  const titleIdx = 2;
  const otherWidth = widths.reduce((sum, w, idx) => (idx === titleIdx ? sum : sum + w + 2), 0);
  const titleBudget = Math.max(10, maxWidth - otherWidth - 1);

  const fmt = (row: string[]): string =>
    row
      .map((cell, idx) => {
        let c = cell;
        if (idx === titleIdx && c.length > titleBudget) c = c.slice(0, titleBudget - 1) + '…';
        const padded = c.padEnd(widths[idx]);
        return idx === 0 ? dim(padded) : idx === 3 ? gray(padded) : padded;
      })
      .join('  ')
      .replace(/\s+$/, '');

  const header = headers.map((h, idx) => bold(h.padEnd(widths[idx]))).join('  ');
  const body = rows.map(fmt);
  const footer = result.nextCursor ? [dim('(more results available)')] : [];
  return [header, ...body, ...footer].join('\n');
}

export function renderImportResult(result: ImportResult, opts: OutputOptions): string {
  if (opts.json) return JSON.stringify(result, null, 2);
  if (opts.quiet) return result.id ?? '';
  const verb = result.created ? 'Imported' : 'Already imported';
  return `${verb} ${result.urn} → ${bold(result.id)}`;
}

export function renderResnapshot(result: ResnapshotResult, opts: OutputOptions): string {
  if (opts.json) return JSON.stringify(result, null, 2);
  if (opts.quiet) return result.id ?? '';
  const flags: string[] = [];
  if (result.titleUpdated) flags.push('title');
  if (result.statusUpdated) flags.push('status');
  if (result.bodyChanged) flags.push(dim('body changed (flagged for review)'));
  const suffix = flags.length ? ` (${flags.join(', ')})` : '';
  return `Re-snapshotted ${result.urn}${suffix}`;
}
