/**
 * Table CSVs in the Local wiki (FORMAT.md "Table types") carry no id, so the
 * page rule in `projectSyncWikiRules.ts` cannot tell a moved table from a
 * deleted one by identity alone. A CSV is a table when the current type
 * definitions name it (plural display name or `<typeId>.csv`); a CSV no
 * current table type names is a spreadsheet page, and a remote delete of it
 * keeps today's behavior.
 *
 * A same-typed file elsewhere is not proof of a move on its own: it may have
 * been created independently. The moved table must also correspond: the same
 * header, and every row of the old file present in it with identical cells
 * (rows are keyed by the `id` column). Anything less, including an empty or unparseable file,
 * keeps the old file, which the library then reports as a duplicate.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileStemForTitle, loadTypeDefs, parseCsv } from '@nimbalyst/local-wiki';
import { logger } from '../../utils/logger';
import { resolveLocalWikiLocation } from '../localWiki/localWikiLocation';

export interface WikiTableType {
  typeId: string;
  displayNamePlural: string;
  /** Name keys (`nameKey` of the file stem) that make a CSV this type's table. */
  names: Set<string>;
}

/** The library's case-insensitive name comparison (`names.ts` `nameKey`). */
const nameKey = (name: string) => name.normalize('NFC').toLowerCase();

/** `ids.ts` `isSafeId` without the namespace: the type id ends up in a trash folder name. */
const SAFE_TYPE_ID = /^[A-Za-z0-9_-]{1,190}$/;

function csvKey(filePath: string): string | null {
  const base = path.basename(filePath);
  return base.toLowerCase().endsWith('.csv') ? nameKey(base.slice(0, -4)) : null;
}

/** The table type whose current name `filePath` carries, read from the project's type definitions now. */
export async function wikiTableTypeOf(workspacePath: string, filePath: string): Promise<WikiTableType | null> {
  const key = csvKey(filePath);
  if (!key) return null;
  let typesDir: string;
  try {
    typesDir = resolveLocalWikiLocation(workspacePath).typesDir;
  } catch (err) {
    logger.main.warn(`[ProjectFileSync] Wiki location unreadable; treating ${path.basename(filePath)} as a plain file:`, err);
    return null;
  }
  const { types } = await loadTypeDefs(typesDir);
  for (const def of types.values()) {
    if (def.storage !== 'table') continue;
    const names = new Set([nameKey(fileStemForTitle(def.displayNamePlural)), nameKey(def.typeId)]);
    if (!names.has(key)) continue;
    if (!SAFE_TYPE_ID.test(def.typeId)) {
      logger.main.warn(`[ProjectFileSync] Table type id ${JSON.stringify(def.typeId)} is not a safe id; ${path.basename(filePath)} is left alone`);
      return null;
    }
    return { typeId: def.typeId, displayNamePlural: def.displayNamePlural, names };
  }
  return null;
}

/** Header and rows by id, or null when the text is empty, unparseable, or has a row without an id or a repeated one. */
function tableRows(text: string): { header: string[]; rows: Map<string, string[]> } | null {
  let parsed: string[][];
  try {
    parsed = parseCsv(text);
  } catch {
    return null;
  }
  const [header, ...body] = parsed;
  if (!header || header[0] !== 'id' || body.length === 0) return null;
  const rows = new Map<string, string[]>();
  for (const row of body) {
    const id = row[0]?.trim();
    if (!id || rows.has(id)) return null;
    rows.set(id, row);
  }
  return { header, rows };
}

const sameCells = (a: string[], b: string[]) => a.length === b.length && a.every((cell, i) => cell === b[i]);

/**
 * True when `candidate` has `old`'s header and every one of its rows with
 * identical cells. A candidate holding an older or newer version of any row
 * is a duplicate to report, not proof that `old` may go.
 */
export function tableHoldsRows(oldText: string, candidateText: string): boolean {
  const old = tableRows(oldText);
  const live = tableRows(candidateText);
  if (!old || !live || !sameCells(old.header, live.header)) return false;
  for (const [id, row] of old.rows) {
    const other = live.rows.get(id);
    if (!other || !sameCells(row, other)) return false;
  }
  return true;
}

/**
 * Another live CSV in the wiki (dot-names and trash skipped, as the library
 * does) carrying a name of `table`'s type and holding every row of `oldText`.
 * `candidates`: where it is expected; the whole wiki is searched when omitted.
 */
export async function liveTableElsewhere(
  root: string, filePath: string, table: WikiTableType, oldText: string, candidates?: string[],
): Promise<string | null> {
  const matches = (abs: string) => abs !== filePath && table.names.has(csvKey(abs) ?? '');
  for (const candidate of (candidates ?? await sameTypeFiles(root)).filter(matches)) {
    try {
      if (tableHoldsRows(oldText, await fs.readFile(candidate, 'utf-8'))) return candidate;
    } catch {
      // gone since it was found
    }
  }
  return null;
}

async function sameTypeFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile() && csvKey(abs) !== null) found.push(abs);
    }
  };
  await walk(root);
  return found;
}
