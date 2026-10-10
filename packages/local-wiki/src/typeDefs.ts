import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import yaml from 'js-yaml';
import type { WikiIssue } from './types.js';

/**
 * The slice of a tracker type definition (`.nimbalyst/trackers/*.yaml`) the
 * library needs. The full model lives in `@nimbalyst/tracker-schema`; this
 * reader stays dependency-free so `nim` can load it without the app.
 */
export interface WikiFieldDef {
  name: string;
  /** Tracker field type: string, text, number, select, multiselect, relationship, ... */
  type: string;
  itemType?: string;
  multiValue?: boolean;
}

export type WikiTypeStorage = 'pages' | 'table';

export interface WikiTypeDef {
  typeId: string;
  displayName: string;
  displayNamePlural: string;
  storage: WikiTypeStorage;
  /**
   * True when the YAML declares `storage:` explicitly. Only these types keep
   * their items in the wiki; every other type in `.nimbalyst/trackers` (bugs,
   * tasks, app-database types) is readable here but its items live in the app.
   */
  wikiType: boolean;
  fields: WikiFieldDef[];
  /** Field holding the item title (`roles.title`, default `title`). */
  titleField: string;
  /** Absolute path of the YAML file. */
  sourcePath: string;
}

interface RawType {
  type?: unknown;
  extends?: unknown;
  displayName?: unknown;
  displayNamePlural?: unknown;
  storage?: unknown;
  fields?: unknown;
  roles?: unknown;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readFields(raw: unknown): WikiFieldDef[] {
  if (!Array.isArray(raw)) return [];
  const out: WikiFieldDef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = str(e.name);
    if (!name) continue;
    out.push({
      name,
      type: str(e.type) ?? 'string',
      ...(str(e.itemType) ? { itemType: str(e.itemType)! } : {}),
      ...(e.multiValue === true ? { multiValue: true } : {}),
    });
  }
  return out;
}

/**
 * Loads every `*.yaml` type definition in `typesDir`. Patch files
 * (`*.patch.yaml`) and backups are skipped. `extends` is resolved one level:
 * the parent's fields, then the child's, a child field replacing a parent field
 * of the same name.
 */
export async function loadTypeDefs(typesDir: string | null | undefined): Promise<{ types: Map<string, WikiTypeDef>; issues: WikiIssue[] }> {
  const types = new Map<string, WikiTypeDef>();
  const issues: WikiIssue[] = [];
  if (!typesDir) return { types, issues };
  let names: string[];
  try {
    names = await readdir(typesDir);
  } catch {
    return { types, issues };
  }
  const raws = new Map<string, { raw: RawType; sourcePath: string }>();
  for (const name of names.sort()) {
    if (!name.endsWith('.yaml') || name.includes('.patch.')) continue;
    const sourcePath = path.join(typesDir, name);
    try {
      const raw = yaml.load(await readFile(sourcePath, 'utf8'), { schema: yaml.CORE_SCHEMA }) as RawType;
      const typeId = raw && typeof raw === 'object' ? str(raw.type) : null;
      if (!typeId) continue;
      raws.set(typeId, { raw, sourcePath });
    } catch (err) {
      issues.push({ code: 'malformed-type', path: sourcePath, message: (err as Error).message.split('\n')[0] });
    }
  }
  for (const [typeId, { raw, sourcePath }] of raws) {
    const parentId = str(raw.extends);
    const parent = parentId ? raws.get(parentId)?.raw : undefined;
    const fields = new Map<string, WikiFieldDef>();
    for (const field of readFields(parent?.fields)) fields.set(field.name, field);
    for (const field of readFields(raw.fields)) fields.set(field.name, field);
    const displayName = str(raw.displayName) ?? str(parent?.displayName) ?? typeId;
    const roles = (raw.roles && typeof raw.roles === 'object' ? raw.roles : parent?.roles) as Record<string, unknown> | undefined;
    types.set(typeId, {
      typeId,
      displayName,
      displayNamePlural: str(raw.displayNamePlural) ?? `${displayName}s`,
      storage: str(raw.storage) === 'table' ? 'table' : 'pages',
      wikiType: str(raw.storage) === 'table' || str(raw.storage) === 'pages',
      fields: [...fields.values()],
      titleField: str(roles?.title) ?? 'title',
      sourcePath,
    });
  }
  return { types, issues };
}
