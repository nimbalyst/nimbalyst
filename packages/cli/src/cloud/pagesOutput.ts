/**
 * Rendering for `nim wiki` results. The server shapes are loose JSON, so this
 * works from a column list and an accessor rather than typed records. Every
 * value is team-written, so it goes through the same control-character and
 * spreadsheet-formula guards as `nim tracker`.
 */
import type { OutputOptions } from '../cli/output.js';
import { csvCell, safeText } from '../cli/output.js';
import { bold, dim } from '../cli/colors.js';

export interface Column {
  header: string;
  get: (row: any) => unknown;
}

function cellText(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(cellText).join(',');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** A field from a tracker-shaped record, wherever the server put it. */
export function field(row: any, key: string): unknown {
  return row?.[key] ?? row?.fields?.[key] ?? row?.data?.[key];
}

export function renderRows(rows: any[], columns: Column[], opts: OutputOptions, idOf: (row: any) => unknown): string {
  if (opts.quiet) return rows.map((r) => safeText(cellText(idOf(r)))).join('\n');
  if (opts.csv) {
    const lines = [columns.map((c) => csvCell(c.header)).join(',')];
    for (const r of rows) lines.push(columns.map((c) => csvCell(cellText(c.get(r)))).join(','));
    return lines.join('\n');
  }
  if (rows.length === 0) return dim('Nothing to show.');
  const cells = rows.map((r) => columns.map((c) => safeText(cellText(c.get(r)))));
  const widths = columns.map((c, i) => Math.max(c.header.length, ...cells.map((row) => row[i].length)));
  const header = columns.map((c, i) => bold(c.header.toUpperCase().padEnd(widths[i]))).join('  ');
  const body = cells.map((row) => row.map((v, i) => v.padEnd(widths[i])).join('  ').replace(/\s+$/, ''));
  return [header, ...body].join('\n');
}

/** Key/value block for a single object; `--json` callers never get here. */
export function renderObject(obj: Record<string, unknown>, opts: OutputOptions, idKey = 'id'): string {
  if (opts.quiet) return safeText(cellText(obj?.[idKey]));
  if (opts.csv) {
    const keys = Object.keys(obj ?? {});
    return [keys.map(csvCell).join(','), keys.map((k) => csvCell(cellText(obj[k]))).join(',')].join('\n');
  }
  const entries = Object.entries(obj ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const width = Math.max(0, ...entries.map(([k]) => k.length));
  return entries.map(([k, v]) => `${bold(safeText(k).padEnd(width))}  ${safeText(cellText(v))}`).join('\n');
}
