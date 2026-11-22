import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Walks a workspace for the files project file sync might carry. Node builtins
 * only: it runs inside projectManifestWorker, and inline on the main process
 * when the worker cannot start. The caller applies the sync path rules (wiki
 * location, trash, size cap) to what comes back.
 */

export interface ProjectSyncScanRequest {
  root: string;
  /** File name endings to return, e.g. `.md`. */
  extensions: string[];
  /** Exact file names to return regardless of extension. */
  names: string[];
}

export interface ProjectSyncScanCandidate {
  filePath: string;
  size: number;
  mtime: number;
}

// Non-content directories (the report folders hold generated .html).
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.nimbalyst', 'dist', 'build', '.build',
  'out', '.next', '.nuxt', '.svelte-kit', 'coverage', '.cache',
  'playwright-report', 'test-results', 'htmlcov', 'storybook-static',
  '.turbo', '.vercel', '.output', '__pycache__', '.venv', 'venv',
  'target', 'Pods', '.gradle', 'DerivedData',
]);

export async function scanProjectSyncCandidatesInline(request: ProjectSyncScanRequest): Promise<ProjectSyncScanCandidate[]> {
  const results: ProjectSyncScanCandidate[] = [];
  const names = new Set(request.names);
  const wanted = (name: string) => names.has(name) || request.extensions.some((ext) => name.endsWith(ext));
  await walk(request.root, request.root, wanted, results);
  return results;
}

async function walk(
  dir: string,
  root: string,
  wanted: (name: string) => boolean,
  results: ProjectSyncScanCandidate[],
): Promise<void> {
  const basename = path.basename(dir);
  if (SKIP_DIRS.has(basename) || basename.startsWith('.build')) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // Permission denied or other error
  }
  if (dir !== root && await isGitWorktree(dir, entries)) return;

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, root, wanted, results);
    } else if (entry.isFile() && wanted(entry.name)) {
      try {
        const stats = await stat(fullPath);
        results.push({ filePath: fullPath, size: stats.size, mtime: Math.floor(stats.mtimeMs) });
      } catch {
        // Skip files we can't stat
      }
    }
  }
}

/**
 * A git worktree is another checkout of a repository, so its files duplicate
 * ones synced elsewhere, and agent sessions create them by the dozen. Its root
 * has a `.git` file (not a directory) pointing into `<repo>/.git/worktrees/`. A
 * submodule's `.git` file points into `.git/modules/` and is kept.
 */
async function isGitWorktree(dir: string, entries: Array<{ name: string; isFile(): boolean }>): Promise<boolean> {
  if (!entries.some((e) => e.name === '.git' && e.isFile())) return false;
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(await readFile(path.join(dir, '.git'), 'utf8'))?.[1];
    return gitdir !== undefined && /[\\/]worktrees[\\/]/.test(gitdir);
  } catch {
    return false;
  }
}
