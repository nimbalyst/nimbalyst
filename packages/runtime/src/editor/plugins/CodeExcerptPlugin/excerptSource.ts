/**
 * The code excerpt fence body: a YAML header, a `---` line, then the quoted
 * lines verbatim.
 *
 *   ```excerpt
 *   path: packages/runtime/src/auth/jwtScopes.ts
 *   lines: 10-40
 *   commit: 749eca9a4
 *   ---
 *   <lines 10-40 as they were at that commit>
 *   ```
 *
 * The snapshot is what makes the block readable on GitHub and on machines
 * without the repo; the header is what lets a machine with the repo check it.
 * Edits rewrite only the lines they change, so header keys this version does
 * not read survive.
 *
 * React-free.
 */

import { parseFenceYaml } from '../../../core/fenceBody';

import { EXCERPT_SEPARATOR as SEPARATOR } from './excerptFence';

export { CODE_EXCERPT_FENCE_LANGUAGE } from './excerptFence';

export interface LineRange {
  start: number;
  end: number;
}

export interface ParsedExcerpt {
  path: string;
  range: LineRange | null;
  commit: string | null;
  /** The quoted lines, verbatim. Empty when the fence has no `---` section. */
  snapshot: string;
  /** Header problem to show in the block, if any. */
  error: string | null;
}

/** `10-40`, `10`, `L10-L40` or `10..40`; 1-based and inclusive. */
export function parseLineRange(raw: unknown): LineRange | null {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? { start: raw, end: raw } : null;
  if (typeof raw !== 'string') return null;
  const match = /^\s*L?(\d+)\s*(?:(?:-|\.\.|–)\s*L?(\d+))?\s*$/i.exec(raw);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  if (start < 1 || end < start) return null;
  return { start, end };
}

export function formatLineRange(range: LineRange): string {
  return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
}

/** `path#L10-L40` (also `path:10-40`), the form people paste. */
export function parseExcerptRef(raw: string): { path: string; range: LineRange | null } | null {
  const text = raw.trim();
  if (!text) return null;
  const hash = /^(.+?)#(L?\d+(?:-L?\d+)?)$/i.exec(text);
  if (hash) return { path: hash[1], range: parseLineRange(hash[2]) };
  const colon = /^(.+?):(\d+(?:-\d+)?)$/.exec(text);
  if (colon) return { path: colon[1], range: parseLineRange(colon[2]) };
  return { path: text, range: null };
}

function splitBody(source: string): { header: string; snapshot: string; hasSnapshot: boolean } {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => line.trimEnd() === SEPARATOR);
  if (index === -1) return { header: source, snapshot: '', hasSnapshot: false };
  return { header: lines.slice(0, index).join('\n'), snapshot: lines.slice(index + 1).join('\n'), hasSnapshot: true };
}

export function parseExcerptSource(source: string): ParsedExcerpt {
  const { header, snapshot } = splitBody(source);
  const parsed = parseFenceYaml(header);
  if (!parsed.ok) return { path: '', range: null, commit: null, snapshot, error: parsed.error };
  const { path, lines, commit } = parsed.value;
  const range = parseLineRange(lines);
  let error: string | null = null;
  if (typeof path !== 'string' || !path.trim()) error = 'Missing "path:".';
  else if (lines !== undefined && !range) error = `"lines: ${String(lines)}" is not a line range like 10-40.`;
  return {
    path: typeof path === 'string' ? path.trim() : '',
    range,
    commit: commit === undefined || commit === null ? null : String(commit),
    snapshot,
    error,
  };
}

export function buildExcerptSource(input: { path: string; range: LineRange; commit?: string | null; snapshot: string }): string {
  const header = [`path: ${input.path}`, `lines: ${formatLineRange(input.range)}`];
  if (input.commit) header.push(`commit: ${input.commit}`);
  return [...header, SEPARATOR, input.snapshot].join('\n');
}

/**
 * Rewrite `lines`, `commit` and the snapshot in place, keeping every other
 * header line as written. A key that is missing is appended to the header.
 */
export function updateExcerptSource(source: string, next: { range: LineRange; commit?: string | null; snapshot: string }): string {
  const { header } = splitBody(source);
  const headerLines = header === '' ? [] : header.split('\n');
  const setKey = (key: string, value: string | null | undefined) => {
    const index = headerLines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
    if (value === null || value === undefined) return;
    if (index === -1) headerLines.push(`${key}: ${value}`);
    else headerLines[index] = `${key}: ${value}`;
  };
  setKey('lines', formatLineRange(next.range));
  setKey('commit', next.commit);
  return [...headerLines, SEPARATOR, next.snapshot].join('\n');
}

/**
 * The source with the header's `width:` / `height:` set (the block's width and
 * the code area's height, from the resize grip), every other line as written.
 * A null value removes the key.
 */
export function setExcerptSize(source: string, size: Readonly<Record<'width' | 'height', string | null | undefined>>): string {
  const { header, snapshot, hasSnapshot } = splitBody(source);
  let headerLines = header === '' ? [] : header.split('\n');
  for (const key of ['width', 'height'] as const) {
    if (size[key] === undefined) continue;
    const index = headerLines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
    const value = size[key];
    if (value === null) {
      if (index !== -1) headerLines = headerLines.filter((_, i) => i !== index);
    } else if (index === -1) headerLines.push(`${key}: ${value}`);
    else headerLines[index] = `${key}: ${value}`;
  }
  return hasSnapshot ? [...headerLines, SEPARATOR, snapshot].join('\n') : headerLines.join('\n');
}

/** The header's saved size, as the resize frame's attrs. */
export function excerptSizeAttrs(source: string): Record<string, string> {
  const parsed = parseFenceYaml(splitBody(source).header);
  const attrs: Record<string, string> = {};
  if (!parsed.ok) return attrs;
  for (const key of ['width', 'height'] as const) {
    const value = parsed.value[key];
    if (typeof value === 'number' && value > 0) attrs[key] = String(value);
  }
  return attrs;
}

/** The lines a range covers, from a file's text. Out-of-range lines are dropped. */
export function sliceLines(fileText: string, range: LineRange): string {
  return splitLines(fileText).slice(range.start - 1, range.end).join('\n');
}

export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  // A trailing newline ends the last line; it does not start another one.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
