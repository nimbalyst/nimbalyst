import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

/** Write to a dot-prefixed temp file beside the target, then rename over it. */
export async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Creates `file` with an exclusive open. False when it already exists; its content is left alone. */
export async function writeExclusive(file: string, content: string): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rename that refuses to overwrite, and survives a case-only change on a
 * case-insensitive file system by going through a temporary name.
 */
export async function movePath(from: string, to: string): Promise<void> {
  if (from === to) return;
  const caseOnly = from.toLowerCase() === to.toLowerCase();
  if (!caseOnly && (await pathExists(to))) throw new Error(`Refusing to overwrite ${to}`);
  await mkdir(path.dirname(to), { recursive: true });
  if (caseOnly) {
    const tmp = `${from}.${randomBytes(4).toString('hex')}.moving`;
    await rename(from, tmp);
    await rename(tmp, to);
    return;
  }
  await rename(from, to);
}

/** Posix-style wiki-relative path. */
export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

export function toAbs(root: string, rel: string): string {
  return rel === '' ? root : path.join(root, ...rel.split('/'));
}

export function relDirname(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

export function relJoin(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}
