/**
 * Open the project's local wiki through `@nimbalyst/local-wiki`, the one
 * implementation of the file format (see that package's FORMAT.md). Nothing in
 * `nim` reads or writes wiki files any other way.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initWiki, LocalWikiError, MARKER_FILE, openWiki, type LocalWiki } from '@nimbalyst/local-wiki';
import { CliError, ExitCode } from '../cli/exitCodes.js';
import { ensureLocalOnlyIgnored, resolveWikiLocation, writeLocationSetting, type WikiLocation } from './locate.js';

export class NoLocalWikiError extends CliError {
  constructor(readonly dir: string) {
    super(ExitCode.NOT_FOUND, `No local wiki at ${dir}. Run \`nim wiki init\` to create one.`);
    this.name = 'NoLocalWikiError';
  }
}

export interface OpenedWiki extends WikiLocation {
  wiki: LocalWiki;
}

function actor(): string {
  try {
    const name = execFileSync('git', ['config', '--get', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (name) return name;
  } catch {
    // no git identity
  }
  return os.userInfo().username;
}

export function typesDir(projectRoot: string): string {
  return path.join(projectRoot, '.nimbalyst', 'trackers');
}

export function hasLocalWiki(startDir: string, location?: string): boolean {
  try {
    return existsSync(path.join(resolveWikiLocation(startDir, location).dir, MARKER_FILE));
  } catch {
    return false;
  }
}

/**
 * Open (or, for a long-lived caller passing `cache`, re-scan) the wiki. A
 * re-scan picks up edits made by people, editors and the app since last call.
 */
export async function openLocalWiki(
  startDir: string,
  location?: string,
  cache?: Map<string, LocalWiki>,
): Promise<OpenedWiki> {
  const where = resolveWikiLocation(startDir, location);
  const cached = cache?.get(where.dir);
  if (cached && existsSync(path.join(where.dir, MARKER_FILE))) {
    await cached.rescan();
    return { ...where, wiki: cached };
  }
  if (!existsSync(path.join(where.dir, MARKER_FILE))) throw new NoLocalWikiError(where.dir);
  try {
    const wiki = await openWiki(where.dir, { typesDir: typesDir(where.projectRoot), actor: actor() });
    cache?.set(where.dir, wiki);
    return { ...where, wiki };
  } catch (err) {
    if (err instanceof LocalWikiError && err.code === 'not-a-wiki') throw new NoLocalWikiError(where.dir);
    throw err;
  }
}

const HOME_BODY = `This is the project's local wiki. Its pages are markdown files in this folder; Nimbalyst, \`nim\` and agents read and edit them.\n`;

export interface InitResult extends OpenedWiki {
  created: boolean;
  homeId: string | null;
  gitignoreUpdated: boolean;
}

/**
 * Create the wiki: the folder and its marker, the location setting, a Home page
 * when the wiki is empty, and the `.gitignore` entry for a local-only location.
 * Running it again on an existing wiki changes nothing but the setting.
 */
export async function initLocalWiki(startDir: string, location?: string): Promise<InitResult> {
  const where = resolveWikiLocation(startDir, location);
  const created = !existsSync(path.join(where.dir, MARKER_FILE));
  await initWiki(where.dir);
  writeLocationSetting(where.projectRoot, where.dir);
  const gitignoreUpdated = ensureLocalOnlyIgnored(where.projectRoot, where.dir);
  const wiki = await openWiki(where.dir, { typesDir: typesDir(where.projectRoot), actor: actor() });
  let homeId: string | null = null;
  const snapshot = await wiki.snapshot();
  if (!snapshot.pages.some((page) => page.trashedAt === null)) {
    homeId = (await wiki.command({ type: 'register-document', title: 'Home', parentFolderId: null, body: HOME_BODY })).id ?? null;
  }
  return { ...where, wiki, created, homeId, gitignoreUpdated };
}
