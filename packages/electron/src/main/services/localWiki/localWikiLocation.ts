/**
 * Where a project's local wiki lives. The location is a folder inside the
 * project, named in `<project>/.nimbalyst/local-wiki.json`
 * (`{ "location": "nimbalyst-local/wiki" }`, relative to the project root).
 * `nim` reads and writes the same file, so the app and the CLI always agree.
 * Without the file the wiki is at `nimbalyst-local/wiki`.
 *
 * A git worktree resolves against its main checkout: the wiki folder is
 * usually gitignored and so is not present in the worktree.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveProjectPath } from '../../utils/workspaceDetection';

export const LOCAL_WIKI_CONFIG_FILE = path.join('.nimbalyst', 'local-wiki.json');
export const DEFAULT_LOCAL_WIKI_LOCATION = 'nimbalyst-local/wiki';

export interface LocalWikiLocation {
  /** The project root the location is relative to (the main checkout for a worktree). */
  projectRoot: string;
  /** Absolute wiki folder. */
  root: string;
  /** The location as written, relative to the project root, with `/` separators. */
  location: string;
  /** `.nimbalyst/trackers` of the project, where type definitions live. */
  typesDir: string;
  /** True when `local-wiki.json` named the location. */
  configured: boolean;
}

/**
 * A location the app accepts in v1: a relative folder inside the project.
 * Returns the normalized `/` form, or null for an absolute path or one that
 * leaves the project.
 */
export function normalizeLocalWikiLocation(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\\/g, '/');
  if (!trimmed || path.posix.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) return null;
  const normalized = path.posix.normalize(trimmed).replace(/\/+$/, '');
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

export function resolveLocalWikiLocation(workspacePath: string): LocalWikiLocation {
  if (!workspacePath || typeof workspacePath !== 'string') throw new Error('workspacePath is required');
  const projectRoot = resolveProjectPath(workspacePath) || workspacePath;
  let location = DEFAULT_LOCAL_WIKI_LOCATION;
  let configured = false;
  const configPath = path.join(projectRoot, LOCAL_WIKI_CONFIG_FILE);
  let text: string | null = null;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    // No config file: the default location.
  }
  if (text !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${configPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const named = (parsed as { location?: unknown } | null)?.location;
    if (named !== undefined) {
      const normalized = normalizeLocalWikiLocation(named);
      if (!normalized) {
        throw new Error(`${configPath}: "location" must be a folder inside the project, relative to its root`);
      }
      location = normalized;
      configured = true;
    }
  }
  return {
    projectRoot,
    root: path.join(projectRoot, ...location.split('/')),
    location,
    typesDir: path.join(projectRoot, '.nimbalyst', 'trackers'),
    configured,
  };
}

/**
 * The wiki folder relative to `workspacePath` (`/` separators), or null when
 * it is not inside it (a worktree's wiki lives in the main checkout) or the
 * location file cannot be read. Never throws.
 */
export function localWikiFolderWithin(workspacePath: string): string | null {
  try {
    const relative = path.relative(workspacePath, resolveLocalWikiLocation(workspacePath).root).split(path.sep).join('/');
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : null;
  } catch {
    return null;
  }
}

/** Whether a workspace-relative path is inside the wiki folder `localWikiFolderWithin` returned. */
export function isInLocalWikiFolder(relativePath: string, wikiFolder: string | null): boolean {
  if (!wikiFolder) return false;
  const normalized = relativePath.split(/[/\\]/).join('/');
  return normalized === wikiFolder || normalized.startsWith(`${wikiFolder}/`);
}
