import yaml from 'js-yaml';

/** Keys the format owns; everything else in frontmatter is a field. */
export const RESERVED_KEYS = ['id', 'title', 'type', 'order'] as const;
const RESERVED = new Set<string>(RESERVED_KEYS);

export type ParsedFile =
  | {
      ok: true;
      /** Raw frontmatter mapping; empty when the file has none. */
      data: Record<string, unknown>;
      /** The frontmatter block exactly as written, delimiters included; '' when none. */
      block: string;
      body: string;
    }
  | { ok: false; error: string };

const OPEN = /^﻿?---[ \t]*\r?\n/;

export function parseMarkdownFile(text: string): ParsedFile {
  const open = OPEN.exec(text);
  if (!open) return { ok: true, data: {}, block: '', body: text };
  const rest = text.slice(open[0].length);
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close) return { ok: false, error: 'Frontmatter has no closing --- line' };
  const yamlText = rest.slice(0, close.index);
  let data: unknown;
  try {
    data = yaml.load(yamlText, { schema: yaml.CORE_SCHEMA });
  } catch (err) {
    return { ok: false, error: `Frontmatter is not valid YAML: ${(err as Error).message.split('\n')[0]}` };
  }
  if (data === undefined || data === null) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'Frontmatter is not a mapping' };
  }
  const blockEnd = open[0].length + close.index + close[0].length;
  return { ok: true, data: data as Record<string, unknown>, block: text.slice(0, blockEnd), body: text.slice(blockEnd) };
}

export function serializeFrontmatter(data: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of RESERVED_KEYS) if (data[key] !== undefined) ordered[key] = data[key];
  for (const [key, value] of Object.entries(data)) {
    if (!RESERVED.has(key) && value !== undefined) ordered[key] = value;
  }
  if (Object.keys(ordered).length === 0) return '';
  const dumped = yaml.dump(ordered, { schema: yaml.CORE_SCHEMA, lineWidth: -1, noRefs: true, sortKeys: false });
  return `---\n${dumped}---\n`;
}

export function composeMarkdownFile(data: Record<string, unknown>, body: string): string {
  return serializeFrontmatter(data) + body;
}

/**
 * Adds `id` to an existing frontmatter block without re-serializing it, so a
 * hand-written file keeps its comments and formatting when it is adopted.
 */
export function insertIdIntoFile(text: string, id: string): string {
  const open = OPEN.exec(text);
  if (!open) return `---\nid: ${id}\n---\n${text}`;
  return text.slice(0, open[0].length) + `id: ${id}\n` + text.slice(open[0].length);
}

export interface PageMeta {
  id: string | null;
  title: string | null;
  type: string | null;
  order: number | null;
  /** Every non-reserved key, with a legacy `trackerStatus` block flattened in. */
  fields: Record<string, unknown>;
  /** True when the type or fields came from a legacy `trackerStatus` block. */
  legacyTrackerStatus: boolean;
}

function scalarString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function readPageMeta(data: Record<string, unknown>): PageMeta {
  const fields: Record<string, unknown> = {};
  let type = scalarString(data.type);
  let legacy = false;
  const block = data.trackerStatus;
  if (block && typeof block === 'object' && !Array.isArray(block)) {
    legacy = true;
    const legacyFields = block as Record<string, unknown>;
    if (!type) type = scalarString(legacyFields.type);
    for (const [key, value] of Object.entries(legacyFields)) {
      if (key !== 'type' && !RESERVED.has(key)) fields[key] = value;
    }
  }
  for (const [key, value] of Object.entries(data)) {
    if (RESERVED.has(key) || key === 'trackerStatus') continue;
    fields[key] = value;
  }
  const order = typeof data.order === 'number' && Number.isFinite(data.order) ? data.order : null;
  return { id: scalarString(data.id), title: scalarString(data.title), type, order, fields, legacyTrackerStatus: legacy };
}

/** Flattens a legacy `trackerStatus` block into top-level keys. */
export function flattenLegacy(data: Record<string, unknown>): Record<string, unknown> {
  const block = data.trackerStatus;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return { ...data };
  const { trackerStatus: _legacy, ...rest } = data;
  const out: Record<string, unknown> = { ...rest };
  for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
    if (key === 'type') {
      if (out.type === undefined) out.type = value;
    } else if (out[key] === undefined) {
      out[key] = value;
    }
  }
  return out;
}
