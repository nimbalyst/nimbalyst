import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';

import { gitCommonDir, isGitAvailable } from './gitUtils';

const execFileAsync = promisify(execFile);

/**
 * The excludes file git reads for every repository: `core.excludesFile` as git
 * resolves it in `checkoutPath`, so a repository's own config applies too, or
 * git's default `$XDG_CONFIG_HOME/git/ignore` (`~/.config/git/ignore`) when it
 * is unset. Null when git is unavailable or fails; no excludes file applies.
 */
export async function resolveGlobalExcludesFile(checkoutPath: string): Promise<string | null> {
  if (!isGitAvailable()) return null;
  try {
    const { stdout } = await execFileAsync('git', ['config', '--path', '--get', 'core.excludesFile'], {
      windowsHide: true,
      cwd: checkoutPath,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const configured = stdout.replace(/\r?\n$/, '');
    return configured ? resolve(checkoutPath, configured) : defaultGlobalExcludesFile();
  } catch (error) {
    // `git config --get` exits 1 when the key is unset; git then reads its default.
    return (error as { code?: unknown }).code === 1 ? defaultGlobalExcludesFile() : null;
  }
}

function defaultGlobalExcludesFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME;
  return configHome
    ? join(configHome, 'git', 'ignore')
    : join(process.env.HOME || homedir(), '.config', 'git', 'ignore');
}

/**
 * The files git takes ignore rules from besides `.gitignore`, lowest precedence
 * first. None when `checkoutPath` is not a checkout: git applies no rules there.
 */
function excludeFiles(checkoutPath: string, globalExcludesFile: string | null): string[] {
  const commonDir = gitCommonDir(checkoutPath);
  if (commonDir === null) return [];
  // Linked worktrees share the main repository's info/exclude.
  const infoExclude = join(commonDir, 'info', 'exclude');
  return globalExcludesFile ? [globalExcludesFile, infoExclude] : [infoExclude];
}

/**
 * A checkout's ignore rules from outside its `.gitignore` files: the global
 * excludes file, then `info/exclude`, as ignore-file text in git's precedence
 * order. Add the `.gitignore` after it so its negations win, as in git. A
 * missing file contributes nothing.
 */
export async function readGitExcludeRules(checkoutPath: string, globalExcludesFile: string | null): Promise<string> {
  const texts = await Promise.all(
    excludeFiles(checkoutPath, globalExcludesFile).map(file => readFile(file, 'utf8').catch(() => '')),
  );
  return texts.join('\n');
}

/**
 * `readGitExcludeRules` for chokidar's synchronous `ignored` callback. It only
 * reads files; the global excludes path must already be resolved.
 */
export function readGitExcludeRulesSync(checkoutPath: string, globalExcludesFile: string | null): string {
  return excludeFiles(checkoutPath, globalExcludesFile).map(file => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }).join('\n');
}
