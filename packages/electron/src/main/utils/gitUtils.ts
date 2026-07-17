import { execFile, execFileSync, execSync } from 'child_process';
import { readdirSync } from 'fs';
import { relative } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Cached result of git availability check.
 * null = not checked yet
 */
let gitAvailableCache: boolean | null = null;

/**
 * Check if git is available on the system without triggering the macOS
 * "install command line developer tools" dialog.
 *
 * On macOS, /usr/bin/git is a shim that triggers an installation dialog if
 * Xcode CLI tools aren't installed. We avoid this by first checking if the
 * tools are installed using xcode-select.
 *
 * The result is cached for the lifetime of the application.
 *
 * @returns true if git is available, false otherwise
 */
export function isGitAvailable(): boolean {
  if (gitAvailableCache !== null) {
    return gitAvailableCache;
  }

  gitAvailableCache = checkGitAvailable();
  return gitAvailableCache;
}

/**
 * Internal function to check git availability.
 */
function checkGitAvailable(): boolean {
  // On macOS, check if Xcode CLI tools are installed first to avoid
  // triggering the installation dialog
  if (process.platform === 'darwin') {
    try {
      // xcode-select -p returns the developer directory path if tools are installed,
      // or exits with code 2 if not installed. It never shows a dialog.
      execSync('xcode-select -p', {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      // Tools are installed, git should be available
    } catch {
      // xcode-select failed - CLI tools not installed, git is not available
      return false;
    }
  }

  // Now try to run git --version
  // On macOS this is safe because we already verified CLI tools are installed
  // On other platforms this is the primary check
  try {
    execSync('git --version', {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset the git availability cache.
 * Primarily used for testing.
 */
export function resetGitAvailableCache(): void {
  gitAvailableCache = null;
}

/**
 * List untracked, non-ignored files inside an untracked directory, honoring
 * `.gitignore`.
 *
 * `git status --porcelain` collapses an untracked directory into a single
 * `?? dir/` entry. Callers that need the individual files (the edited-files UI,
 * the commit-context prompt) must expand it -- but a raw filesystem walk
 * descends into gitignored `node_modules`/`dist`/`out` and can explode a single
 * untracked package dir into tens of thousands of paths (NIM-1782: a worktree
 * "Commit with AI" enumerated 90k files / ~3.1M tokens). `git ls-files` applies
 * the repo's ignore rules, so only files the user would actually commit return.
 *
 * @param repoRoot Absolute path to the git working-tree root (or worktree root).
 * @param dirAbsolutePath Absolute path to the untracked directory to expand.
 * @returns File paths relative to `repoRoot`, forward-slashed (git's native
 *          output). Empty array on any git error.
 */
export function getUntrackedFilesInDirectory(repoRoot: string, dirAbsolutePath: string): string[] {
  try {
    const relDir = relative(repoRoot, dirAbsolutePath);
    // An empty pathspec would match the whole repo; scope to the directory.
    const pathspec = relDir === '' ? '.' : relDir;
    const stdout = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z', '--', pathspec],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    // `-z` gives NUL-separated paths so filenames with spaces/newlines survive.
    return stdout.split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Returns the number of open file descriptors in the current process,
 * or null if unavailable (Windows or read error).
 *
 * Useful for diagnosing EBADF errors: if this number is climbing toward
 * the OS limit (ulimit -n, typically 256 soft / 10240 hard on macOS),
 * that indicates a file descriptor leak somewhere in the process.
 */
export function getOpenFdCount(): number | null {
  if (process.platform === 'win32') return null;
  try {
    // /dev/fd lists one entry per open fd. readdirSync itself opens a
    // temporary fd, so subtract 1 to get the count before this call.
    return readdirSync('/dev/fd').length - 1;
  } catch {
    return null;
  }
}

/**
 * If the error is EBADF, logs the current open fd count to help diagnose
 * whether the error stems from fd exhaustion or a corrupted fd table.
 */
export function logEbadfDiagnostic(context: string, error: unknown): void {
  const message = (error as any)?.message ?? String(error);
  if (!message.includes('EBADF')) return;

  const fdCount = getOpenFdCount();
  console.error(
    `[${context}] EBADF detected - open fd count: ${fdCount ?? 'unknown'}`,
    '(system soft limit is typically 256 on macOS; run `ulimit -n` to check)'
  );
}

/**
 * Get the normalized git remote URL for a workspace path.
 *
 * Runs `git remote get-url origin` asynchronously (no shell), then normalizes
 * the result by stripping protocol, git@ prefix, .git suffix, and lowercasing.
 * Returns null if the workspace is not a git repo or has no origin remote.
 */
export async function getNormalizedGitRemote(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: workspacePath,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const remoteUrl = stdout.trim();

    if (!remoteUrl) return null;

    // Normalize: strip protocol, .git suffix, trailing slashes
    return remoteUrl
      .replace(/^https?:\/\//, '')
      .replace(/^git@/, '')
      .replace(/:/, '/')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  } catch {
    return null;
  }
}
