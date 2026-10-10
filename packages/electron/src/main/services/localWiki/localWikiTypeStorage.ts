/**
 * A type is a Local wiki type only when its YAML declares `storage: pages` or
 * `storage: table` (local-wiki FORMAT.md, "Type definitions"). Placing a type
 * in the Local section makes it one by adding that key; nothing else in the
 * file is touched, so comments and formatting survive.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import yaml from 'js-yaml';

export type WikiStorage = 'pages' | 'table';

interface TypeFile {
  file: string;
  text: string;
  storage: WikiStorage | null;
}

async function findTypeFile(typesDir: string, typeId: string): Promise<TypeFile | null> {
  let names: string[];
  try {
    names = await fs.readdir(typesDir);
  } catch {
    return null;
  }
  // The conventional name first, then any definition that declares the type.
  const ordered = [`${typeId}.yaml`, `${typeId}.yml`, ...names.filter((name) => name !== `${typeId}.yaml` && name !== `${typeId}.yml`)];
  for (const name of ordered) {
    if (!names.includes(name) || !/\.ya?ml$/.test(name) || /\.patch\.ya?ml$/.test(name)) continue;
    const file = path.join(typesDir, name);
    const text = await fs.readFile(file, 'utf8');
    let data: Record<string, unknown> | null = null;
    try {
      data = yaml.load(text, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown> | null;
    } catch {
      continue;
    }
    if (data?.type !== typeId) continue;
    const storage = data.storage === 'pages' || data.storage === 'table' ? data.storage : null;
    return { file, text, storage };
  }
  return null;
}

/** The type's declared storage; null when it is not a wiki type (or has no definition file). */
export async function readTypeStorage(typesDir: string, typeId: string): Promise<WikiStorage | null> {
  return (await findTypeFile(typesDir, typeId))?.storage ?? null;
}

/**
 * Makes the type a wiki type with `storage` unless it already is one, and
 * returns the storage it ends up with. Throws when there is no definition
 * file to write (a built-in type with no project YAML).
 */
export async function ensureWikiTypeStorage(typesDir: string, typeId: string, storage: WikiStorage = 'pages'): Promise<WikiStorage> {
  const found = await findTypeFile(typesDir, typeId);
  if (!found) throw new Error(`The type "${typeId}" has no definition in ${typesDir}; define it in the project before placing it in the Local wiki`);
  if (found.storage) return found.storage;
  const next = `${found.text}${found.text.endsWith('\n') ? '' : '\n'}storage: ${storage}\n`;
  const temp = path.join(path.dirname(found.file), `.${path.basename(found.file)}.${process.pid}.tmp`);
  await fs.writeFile(temp, next, 'utf8');
  await fs.rename(temp, found.file);
  return storage;
}
