/**
 * Output rendering: table (TTY default), --json (the stable agent contract,
 * shape = TrackerRecord), --csv, and --quiet (ids only).
 */
import type { IssueKeyStatus, TrackerRecord } from '@nimbalyst/tracker-core';
import type {
  ImporterInfo,
  ImporterSearchResult,
  ImportResult,
  ResnapshotResult,
} from '../gateway/types.js';
import {
  isLocalIssueKey,
  resolveDisplayIssueKey,
  TRACKER_LOCAL_ISSUE_KEY_MESSAGE,
  TRACKER_UNASSIGNED_ISSUE_KEY_MESSAGE,
} from '@nimbalyst/tracker-core';
import { bold, dim, colorStatus, gray } from './colors.js';
import { relativeFromNow } from './time.js';

export interface OutputOptions {
  json?: boolean;
  csv?: boolean;
  quiet?: boolean;
  columns?: string[];
}

const DEFAULT_COLUMNS = ['key', 'type', 'status', 'title', 'updated'];
export const UNASSIGNED_ISSUE_KEY_MESSAGE = TRACKER_UNASSIGNED_ISSUE_KEY_MESSAGE;

type IssueKeyRef = Pick<TrackerRecord, 'issueKey' | 'localKey'>;

/** Legacy provisional LC keys remain stored but are not stable identifiers. */
export function getAssignedIssueKey(record: Pick<TrackerRecord, 'issueKey'>): string | undefined {
  const issueKey = record.issueKey?.trim();
  return issueKey && !isLocalIssueKey(issueKey) ? issueKey : undefined;
}

export function issueKeyStatus(record: IssueKeyRef): IssueKeyStatus {
  if (getAssignedIssueKey(record)) return 'assigned';
  return record.localKey ? 'local' : 'unassigned';
}

export function getTrackerDisplayRef(record: Pick<TrackerRecord, 'id' | 'issueKey' | 'localKey'>): string {
  return resolveDisplayIssueKey(record) ?? record.id;
}

function hasLocalRef(records: IssueKeyRef[]): boolean {
  return records.some((r) => issueKeyStatus(r) === 'local');
}

/**
 * The machine-private-number caveat for the two modes whose stdout is not prose,
 * or `undefined` when there is nothing to warn about.
 *
 * `-q` exists to be piped and `--csv` is opened as a spreadsheet, so neither can
 * carry a sentence on stdout without corrupting what the consumer parses --
 * hence stderr, which reaches the person at the terminal and costs a piped
 * consumer nothing. The other two modes already say it on stdout (a table
 * footnote, `issueKeyMessage` in JSON) and must not say it twice.
 *
 * One sentence per response, never per row: a ready queue with the caveat on
 * every line is a queue nobody reads.
 */
export function localRefNotice(records: IssueKeyRef[], opts: OutputOptions): string | undefined {
  if (opts.json) return undefined; // renderList/renderRecord check json first
  if (!opts.quiet && !opts.csv) return undefined;
  return hasLocalRef(records) ? TRACKER_LOCAL_ISSUE_KEY_MESSAGE : undefined;
}

function recordForJson(record: TrackerRecord): TrackerRecord & {
  issueKeyStatus: IssueKeyStatus;
  issueKeyMessage?: string;
} {
  const status = issueKeyStatus(record);
  const message = status === 'local'
    ? TRACKER_LOCAL_ISSUE_KEY_MESSAGE
    : status === 'unassigned' ? UNASSIGNED_ISSUE_KEY_MESSAGE : undefined;
  return {
    ...record,
    issueKey: getAssignedIssueKey(record),
    issueKeyStatus: status,
    ...(message ? { issueKeyMessage: message } : {}),
  };
}

// ---- untrusted text --------------------------------------------------------

/**
 * ESC-introduced sequences: CSI (`ESC [ … final byte`), OSC (`ESC ] … BEL/ST`,
 * matched to the end of the value when unterminated, which is how an OSC
 * swallows everything printed after it), and the single-character forms such as
 * `ESC c`, which resets the terminal.
 */

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_SEQUENCE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\|$)|[@-_])`,
  'g',
);

/**
 * C0 and C1, assembled from code points rather than written as literal escapes:
 * a raw control byte in a tracked source file is its own hazard, and the
 * pre-push hook rejects them. The second form keeps tab and newline, which real
 * multi-line text uses.
 */
const controlRange = (from: number, to: number): string =>
  `${String.fromCharCode(from)}-${String.fromCharCode(to)}`;
const CONTROL_CHARS = new RegExp(`[${controlRange(0x00, 0x1f)}${controlRange(0x7f, 0x9f)}]`, 'g');
const CONTROL_CHARS_KEEPING_WHITESPACE = new RegExp(
  `[${controlRange(0x00, 0x08)}${controlRange(0x0b, 0x1f)}${controlRange(0x7f, 0x9f)}]`,
  'g',
);

/**
 * Terminal control sequences removed from a value before it reaches a screen.
 *
 * A tracker title is written by whoever created the item -- in a shared tracker,
 * anyone on the team -- and `ESC [ 2 J` in one clears the terminal of everyone
 * who runs `nim tracker list`. The colors this module emits are applied after
 * this point, so stripping here costs no formatting.
 *
 * This removes *control* characters, not non-ASCII ones: everything from U+00A0
 * up is passed through unchanged, so a title in any language survives intact.
 * The C1 block just below it (U+0080-U+009F) has no printable characters to
 * lose. A filter like `[^\x20-\x7E]` would have eaten the text instead of the
 * attack.
 */
export function safeText(value: string): string {
  return value.replace(ANSI_SEQUENCE, '').replace(CONTROL_CHARS, '');
}

/** As `safeText`, keeping the tabs and newlines a multi-line block needs. */
export function safeBlock(value: string): string {
  return value.replace(ANSI_SEQUENCE, '').replace(CONTROL_CHARS_KEEPING_WHITESPACE, '');
}

/** An arbitrary field value as one safe line. */
function safeField(value: unknown): string {
  return safeText(String(value ?? ''));
}

/** Field accessor for a column name, returning a display string. */
function columnValue(r: TrackerRecord, col: string): string {
  switch (col) {
    case 'key':
      // The local number belongs here. Printing the literal word "unassigned"
      // beside a row the tracker grid labels `NIM.75` is how the CLI came to
      // contradict the database it reads from.
      return resolveDisplayIssueKey(r) ?? 'unassigned';
    case 'keyStatus':
      // Same three values as `issueKeyStatus` in the --json shape; named for
      // the `key` column it qualifies rather than for the JSON field.
      return issueKeyStatus(r);
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

export function renderList(records: TrackerRecord[], opts: OutputOptions): string {
  if (opts.json) {
    return JSON.stringify({ items: records.map(recordForJson), count: records.length }, null, 2);
  }
  if (opts.quiet) {
    // Sanitizing quiet output protects the pipe rather than threatening it: it
    // only ever removes control characters, never adds one, so a ref that
    // smuggled a newline can no longer desync a line-oriented consumer.
    return records.map((r) => safeText(getTrackerDisplayRef(r))).join('\n');
  }
  if (opts.csv) {
    return renderCsv(records, csvColumns(records, opts));
  }
  const table = renderTable(records, opts.columns ?? DEFAULT_COLUMNS);
  // Two different footnotes, because the rows they explain are different. A
  // keyless row genuinely has nothing; a numbered row has a reference that is
  // real but must not leave this machine. One sentence covering both would have
  // to be vague about the part that matters.
  const statuses = new Set(records.map(issueKeyStatus));
  const footnotes = [
    ...(statuses.has('unassigned') ? [UNASSIGNED_ISSUE_KEY_MESSAGE] : []),
    ...(statuses.has('local') ? [TRACKER_LOCAL_ISSUE_KEY_MESSAGE] : []),
  ];
  return footnotes.length > 0 ? `${table}\n\n${dim(footnotes.join('\n'))}` : table;
}

export function renderRecord(record: TrackerRecord, body: string | undefined, opts: OutputOptions): string {
  if (opts.json) {
    const jsonRecord = recordForJson(record);
    return JSON.stringify(body !== undefined ? { ...jsonRecord, body } : jsonRecord, null, 2);
  }
  if (opts.quiet) {
    return safeText(getTrackerDisplayRef(record));
  }
  return renderDetail(record, body);
}

function renderTable(records: TrackerRecord[], columns: string[]): string {
  if (records.length === 0) return dim('No items.');

  const headers = columns.map((c) => c.toUpperCase());
  // Sanitized here rather than in `columnValue`, so the width arithmetic below
  // measures exactly the characters that reach the screen.
  const rows = records.map((r) => columns.map((c) => safeText(columnValue(r, c))));

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
        if (col === 'status') {
          const status = records[ri].fields.status;
          return fmtCell(cell, i, () => colorStatus(status ? safeField(status) : undefined));
        }
        if (col === 'key' || col === 'id') return fmtCell(cell, i, dim);
        if (col === 'updated' || col === 'created') return fmtCell(cell, i, gray);
        return fmtCell(cell, i, (s) => s);
      })
      .join('  ')
      .replace(/\s+$/, ''),
  );

  return [headerLine, ...bodyLines].join('\n');
}

/**
 * A CSV file outlives the terminal that produced it, so for this one mode the
 * caveat also has to travel *in the data*: an export carrying dotted numbers
 * gains the `keyStatus` column, which is the same three-state marker the --json
 * shape exposes as `issueKeyStatus`. A trailing prose row would be read as a
 * record by every spreadsheet that opens the file.
 *
 * An explicit --columns is honoured exactly as asked for, and a fully-shared
 * corpus keeps the plain default shape.
 */
function csvColumns(records: TrackerRecord[], opts: OutputOptions): string[] {
  if (opts.columns) return opts.columns;
  if (!hasLocalRef(records)) return DEFAULT_COLUMNS;
  const columns = [...DEFAULT_COLUMNS];
  columns.splice(columns.indexOf('key') + 1, 0, 'keyStatus');
  return columns;
}

/**
 * A spreadsheet evaluates a cell that opens with `=`, `+`, `-`, `@`, or a
 * leading tab, so `=WEBSERVICE("https://…")` in an item title fires the moment
 * someone opens the export -- and it fires as *them*. Such a cell is prefixed
 * with an apostrophe and force-quoted, which every spreadsheet reads back as
 * literal text.
 *
 * A cell that is entirely a number is exempt, so an ordinary `-3` stays the
 * number -3 instead of turning into text. The exemption is deliberately narrow:
 * the classic `-2+3+cmd|' /C calc'!A0` payload is not a number by that test and
 * is neutralised. Where the two conflict, inert wins over pretty.
 *
 * The leading control characters some spreadsheets also honour are already gone
 * by this point (`safeBlock`); `\r` stays in the pattern because being wrong
 * about that would be silent.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;

export function csvCell(value: string): string {
  const text = safeBlock(value);
  const escaped = text.replace(/"/g, '""');
  if (FORMULA_LEAD.test(text) && !PLAIN_NUMBER.test(text)) return `"'${escaped}"`;
  return /[",\n]/.test(text) ? `"${escaped}"` : text;
}

function renderCsv(records: TrackerRecord[], columns: string[]): string {
  const lines = [columns.join(',')];
  for (const r of records) {
    lines.push(columns.map((c) => csvCell(rawColumnValue(r, c))).join(','));
  }
  return lines.join('\n');
}

/** CSV wants the raw value (no relative-time prettifying). */
function rawColumnValue(r: TrackerRecord, col: string): string {
  switch (col) {
    case 'key':
      return resolveDisplayIssueKey(r) ?? 'unassigned';
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
  const status = issueKeyStatus(record);
  const key = safeText(resolveDisplayIssueKey(record) ?? record.id);
  lines.push(`${bold(key)}  ${dim(safeText(record.primaryType))}`);
  if (status === 'unassigned') lines.push(`${bold('Issue key')}  ${UNASSIGNED_ISSUE_KEY_MESSAGE}`);
  if (status === 'local') lines.push(`${bold('Issue key')}  ${TRACKER_LOCAL_ISSUE_KEY_MESSAGE}`);
  lines.push('');
  lines.push(`${bold('Title')}    ${safeField(record.fields.title)}`);
  lines.push(`${bold('Status')}   ${colorStatus(record.fields.status ? safeField(record.fields.status) : undefined)}`);
  if (record.fields.priority) lines.push(`${bold('Priority')} ${safeField(record.fields.priority)}`);
  if (record.fields.owner) lines.push(`${bold('Owner')}    ${safeField(record.fields.owner)}`);
  if (record.typeTags.length > 1) lines.push(`${bold('Types')}    ${record.typeTags.map((t) => safeText(t)).join(', ')}`);
  if (Array.isArray(record.fields.tags) && record.fields.tags.length) {
    lines.push(`${bold('Tags')}     ${(record.fields.tags as string[]).map((t) => safeField(t)).join(', ')}`);
  }
  lines.push(`${bold('Updated')}  ${safeField(record.system.updatedAt)} ${dim(`(${relativeFromNow(record.system.updatedAt)})`)}`);
  if (record.system.origin) {
    const urn = (record.system.origin as any)?.external?.urn;
    if (urn) lines.push(`${bold('URN')}      ${safeField(urn)}`);
  }

  // Remaining custom fields. `description` is rendered as a body block below,
  // not inline. Empty objects/arrays/null are skipped as noise.
  const shown = new Set(['title', 'status', 'priority', 'owner', 'tags', 'description']);
  const extras = Object.entries(record.fields).filter(([k, v]) => !shown.has(k) && !isEmptyValue(v));
  if (extras.length) {
    lines.push('');
    lines.push(dim('Fields'));
    for (const [k, v] of extras) {
      lines.push(`  ${safeText(k)}: ${safeText(formatFieldValue(v))}`);
    }
  }

  // Body: prefer the cached markdown body; fall back to the description field.
  // Either source can be double-encoded (a JSON-quoted string), so unwrap.
  const rawBody = (body && body.trim()) || (typeof record.fields.description === 'string' ? record.fields.description.trim() : '');
  // The block form: a markdown body is meant to have newlines and tabs.
  const bodyText = safeBlock(unwrapJsonString(rawBody));
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
  if (opts.quiet) return types.map((t) => safeText(t.type)).join('\n');
  if (types.length === 0) return dim('No tracker types found.');
  const lines = types.map((t) => {
    const parts = [bold(safeText(t.type))];
    if (t.displayName) parts.push(dim(safeText(t.displayName)));
    if (t.builtin !== undefined) parts.push(gray(t.builtin ? 'builtin' : 'custom'));
    if (t.count !== undefined) parts.push(gray(`${t.count} item${t.count === 1 ? '' : 's'}`));
    return parts.join('  ');
  });
  return lines.join('\n');
}

// ---- importers -------------------------------------------------------------

export function renderImporters(importers: ImporterInfo[], opts: OutputOptions): string {
  if (opts.json) return JSON.stringify({ importers }, null, 2);
  if (opts.quiet) return importers.map((i) => safeText(i.id)).join('\n');
  if (importers.length === 0) {
    return dim('No importers installed. Install an importer extension (e.g. GitHub Issues) first.');
  }
  return importers
    .map((i) => {
      const parts = [bold(safeText(i.id))];
      if (i.displayName && i.displayName !== i.id) parts.push(dim(safeText(i.displayName)));
      if (i.urnScheme) parts.push(gray(`${safeText(i.urnScheme)}://`));
      if (i.importsAs?.length) parts.push(gray(`imports as ${i.importsAs.map((a) => safeText(a)).join(', ')}`));
      return parts.join('  ');
    })
    .join('\n');
}

export function renderImporterSearch(result: ImporterSearchResult, opts: OutputOptions): string {
  if (opts.json) return JSON.stringify(result, null, 2);
  if (opts.quiet) return result.items.map((i) => safeText(i.externalId)).join('\n');
  if (result.items.length === 0) return dim('No matching items.');

  // Every one of these four comes off a remote issue tracker, so none of them
  // is any more trustworthy than a local title.
  const rows = result.items.map((i) => [i.externalId, i.state, i.title, i.urn].map((v) => safeField(v)));
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
  if (opts.quiet) return safeField(result.id);
  const verb = result.created ? 'Imported' : 'Already imported';
  return `${verb} ${safeField(result.urn)} → ${bold(safeField(result.id))}`;
}

export function renderResnapshot(result: ResnapshotResult, opts: OutputOptions): string {
  if (opts.json) return JSON.stringify(result, null, 2);
  if (opts.quiet) return safeField(result.id);
  const flags: string[] = [];
  if (result.titleUpdated) flags.push('title');
  if (result.statusUpdated) flags.push('status');
  if (result.bodyChanged) flags.push(dim('body changed (flagged for review)'));
  const suffix = flags.length ? ` (${flags.join(', ')})` : '';
  return `Re-snapshotted ${safeField(result.urn)}${suffix}`;
}
