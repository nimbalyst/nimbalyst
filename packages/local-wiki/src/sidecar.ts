/**
 * Editor pages: a page whose file is not markdown (a drawing, mind map, data
 * model, spreadsheet...). The file keeps its own extension and content; the
 * page's `id`, `title`, `order` and plain fields live in a hidden sidecar
 * `.<file name>.wiki.yaml` beside it. See FORMAT.md "Editor pages".
 */
import * as path from 'node:path';
import yaml from 'js-yaml';

export const SIDECAR_SUFFIX = '.wiki.yaml';

/** Keys a sidecar owns; everything else in it is a plain page field. */
export const SIDECAR_RESERVED_KEYS = ['id', 'title', 'documentType', 'order'] as const;

/**
 * File suffix (leading dot, lower case) to document type, for the editor
 * types Nimbalyst ships with a shareable editor. Hosts that know the
 * installed extensions pass their own table (`OpenWikiOptions.editorTypes`).
 */
export const DEFAULT_EDITOR_TYPES: Readonly<Record<string, string>> = {
  '.excalidraw': 'excalidraw',
  '.mindmap': 'mindmap',
  '.prisma': 'datamodel',
  '.mockup.html': 'mockup.html',
  '.csv': 'csv',
  '.calc.md': 'calc.md',
  '.canvas': 'canvas',
};

/** Normalized suffix table: lower-case keys with a leading dot; markdown and empty entries dropped. */
export function normalizeEditorTypes(table: Readonly<Record<string, string>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [rawSuffix, documentType] of Object.entries(table)) {
    const trimmed = rawSuffix.trim().toLowerCase();
    if (!trimmed || !documentType || trimmed.includes('/')) continue;
    const suffix = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    if (suffix === '.md' || suffix === '.markdown' || documentType === 'markdown') continue;
    out.set(suffix, documentType);
  }
  return out;
}

/** The longest suffix of `fileName` in the table, or null. */
export function editorSuffix(fileName: string, types: ReadonlyMap<string, string>): string | null {
  const lower = fileName.toLowerCase();
  let best: string | null = null;
  for (const suffix of types.keys()) {
    if (lower.length > suffix.length && lower.endsWith(suffix) && (!best || suffix.length > best.length)) best = suffix;
  }
  return best;
}

/** A suffix table's first suffix for a document type. */
export function suffixForDocumentType(documentType: string, types: ReadonlyMap<string, string>): string | null {
  for (const [suffix, type] of types) if (type === documentType) return suffix;
  return null;
}

export function sidecarName(fileName: string): string {
  return `.${fileName}${SIDECAR_SUFFIX}`;
}

export function isSidecarName(name: string): boolean {
  return name.startsWith('.') && name.length > 1 + SIDECAR_SUFFIX.length && name.endsWith(SIDECAR_SUFFIX);
}

/** The file a sidecar describes. */
export function sidecarTarget(name: string): string {
  return name.slice(1, -SIDECAR_SUFFIX.length);
}

/** Sidecar path for a wiki-relative file path. */
export function sidecarPathFor(rel: string): string {
  const dir = path.posix.dirname(rel);
  const name = sidecarName(path.posix.basename(rel));
  return dir === '.' ? name : `${dir}/${name}`;
}

export type ParsedSidecar = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

export function parseSidecar(text: string): ParsedSidecar {
  let data: unknown;
  try {
    data = yaml.load(text, { schema: yaml.CORE_SCHEMA });
  } catch (err) {
    return { ok: false, error: `Sidecar is not valid YAML: ${(err as Error).message.split('\n')[0]}` };
  }
  if (data === undefined || data === null) return { ok: true, data: {} };
  if (typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'Sidecar is not a mapping' };
  return { ok: true, data: data as Record<string, unknown> };
}

export function serializeSidecar(data: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of SIDECAR_RESERVED_KEYS) if (data[key] !== undefined) ordered[key] = data[key];
  for (const [key, value] of Object.entries(data)) {
    if (!(SIDECAR_RESERVED_KEYS as readonly string[]).includes(key) && value !== undefined) ordered[key] = value;
  }
  return yaml.dump(ordered, { schema: yaml.CORE_SCHEMA, lineWidth: -1, noRefs: true, sortKeys: false });
}

/** Bodies larger than this are not read during a scan: no search text, and a size-and-time version in listings. */
export const SCAN_READ_LIMIT = 8 * 1024 * 1024;
/** Editor page bodies larger than this, or that look binary, are not searched. */
export const SEARCH_BODY_LIMIT = 256 * 1024;

export function looksBinary(text: string): boolean {
  return text.slice(0, 8192).includes('\u0000');
}
