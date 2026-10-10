/**
 * Where the project's local wiki folder is.
 *
 * Resolution order: an explicit location (`--location`), else the project's
 * setting file `.nimbalyst/local-wiki.json` (`{ "location": "nimbalyst-local/wiki" }`,
 * which the desktop app reads too), else the default `nimbalyst-local/wiki`.
 * A relative setting is relative to the project root.
 *
 * The project root is the MAIN checkout, also from inside a git worktree:
 * `nimbalyst-local/` is gitignored, so a worktree has no copy of it, and every
 * worktree of a project shares one local wiki.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { usageError } from '../cli/exitCodes.js';

export const DEFAULT_LOCATION = 'nimbalyst-local/wiki';
/** The folder whose contents are local-only by convention (gitignored). */
const LOCAL_ONLY_DIR = 'nimbalyst-local';

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The main checkout's root; the start dir itself outside git. */
export function projectRoot(startDir: string): string {
  const start = path.resolve(startDir);
  const common = git(start, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  // A worktree's common dir is the main checkout's `.git`. A bare repository has
  // no main checkout, so its worktrees fall through to their own toplevel.
  if (common && path.basename(common) === '.git') return path.dirname(common);
  return git(start, ['rev-parse', '--show-toplevel']) ?? start;
}

export function settingPath(root: string): string {
  return path.join(root, '.nimbalyst', 'local-wiki.json');
}

export function readLocationSetting(root: string): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(settingPath(root), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw usageError(`${settingPath(root)} is not valid JSON: ${(err as Error).message}`);
  }
  const location = (parsed as { location?: unknown } | null)?.location;
  if (location === undefined) return undefined;
  if (typeof location !== 'string' || !location.trim()) {
    throw usageError(`${settingPath(root)}: "location" must be a non-empty path`);
  }
  return location;
}

/** Writes the setting, keeping any other keys. Relative to the root when the folder is inside it. */
export function writeLocationSetting(root: string, dir: string): void {
  const file = settingPath(root);
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // missing or unreadable: start fresh
  }
  const rel = path.relative(root, dir);
  const location = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : dir;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...existing, location }, null, 2) + '\n');
}

export interface WikiLocation {
  projectRoot: string;
  /** Absolute wiki folder. */
  dir: string;
  source: 'flag' | 'setting' | 'default';
}

/**
 * `location` (from a flag) is relative to the current directory, like any path
 * a person types; the setting is relative to the project root.
 */
export function resolveWikiLocation(startDir: string, location?: string): WikiLocation {
  const root = projectRoot(startDir);
  if (location) return { projectRoot: root, dir: path.resolve(location), source: 'flag' };
  const setting = readLocationSetting(root);
  if (setting) return { projectRoot: root, dir: path.resolve(root, setting), source: 'setting' };
  return { projectRoot: root, dir: path.join(root, DEFAULT_LOCATION), source: 'default' };
}

/**
 * Makes sure a wiki under `nimbalyst-local/` is gitignored, by adding
 * `nimbalyst-local/` to the root `.gitignore` when git does not already ignore
 * it. A wiki anywhere else is meant to be checked in and is left alone, as is a
 * folder outside git. Returns whether `.gitignore` changed.
 */
export function ensureLocalOnlyIgnored(root: string, dir: string): boolean {
  const rel = path.relative(root, dir).split(path.sep).join('/');
  if (rel !== LOCAL_ONLY_DIR && !rel.startsWith(`${LOCAL_ONLY_DIR}/`)) return false;
  if (git(root, ['rev-parse', '--show-toplevel']) === undefined) return false;
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: root, stdio: 'ignore' });
    return false; // exit 0: already ignored
  } catch {
    // exit 1: not ignored
  }
  const gitignore = path.join(root, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(gitignore, 'utf8');
  } catch {
    // no .gitignore yet
  }
  const prefix = text && !text.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gitignore, `${text}${prefix}${LOCAL_ONLY_DIR}/\n`);
  return true;
}
