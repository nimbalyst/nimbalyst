import { execFile, execSync } from 'child_process';
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

// `git ls-files` output is bounded by the repo's ignore rules, but an untracked
// tree of source files can still be large. 64MB matches what the previous
// per-directory implementation allowed; lowering it would silently erase
// untracked files from the changed-files UI and the commit-context prompt.
const LS_FILES_MAX_BUFFER = 64 * 1024 * 1024;

// Pathspecs are passed as argv, which the OS caps (ARG_MAX: 1MB on macOS, less
// on some platforms). A repo with thousands of untracked directories would blow
// past that and fail the whole batch, so split into chunks well under the cap.
// Normal repos have a handful of untracked directories and use a single chunk.
const LS_FILES_MAX_PATHSPEC_BYTES = 96 * 1024;
const LS_FILES_MAX_PATHSPECS_PER_CALL = 500;

function chunkPathspecs(pathspecs: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const pathspec of pathspecs) {
    const bytes = Buffer.byteLength(pathspec) + 1; // + argv NUL terminator
    if (
      current.length > 0 &&
      (currentBytes + bytes > LS_FILES_MAX_PATHSPEC_BYTES ||
        current.length >= LS_FILES_MAX_PATHSPECS_PER_CALL)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(pathspec);
    currentBytes += bytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * List untracked, non-ignored files inside a set of untracked directories,
 * honoring `.gitignore`, using ONE asynchronous `git ls-files` per repository.
 *
 * `git status --porcelain` collapses an untracked directory into a single
 * `?? dir/` entry. Callers that need the individual files (the edited-files UI,
 * the commit-context prompt) must expand it -- but a raw filesystem walk
 * descends into gitignored `node_modules`/`dist`/`out` and can explode a single
 * untracked package dir into tens of thousands of paths (NIM-1782: a worktree
 * "Commit with AI" enumerated 90k files / ~3.1M tokens). `git ls-files` applies
 * the repo's ignore rules AND stops at nested-repository boundaries, so only
 * files the user would actually commit return. Git stays the authority for
 * both; do not replace this with a filesystem walk.
 *
 * Takes every directory at once because the previous per-directory version
 * spawned a SYNCHRONOUS child process each time (NIM-2286): a repo with N
 * untracked directories blocked the Electron main thread on N subprocesses.
 * `--no-optional-locks` keeps this read-only call from touching `.git/index`
 * and contending with concurrent git writers (NIM-2285).
 *
 * @param repoRoot Absolute path to the git working-tree root (or worktree root).
 * @param dirAbsolutePaths Absolute paths of the untracked directories to expand.
 * @returns Map from each input directory path to the files inside it, relative
 *          to `repoRoot` and forward-slashed (git's native output). Directories
 *          with no git-visible files are absent from the map. Empty map on any
 *          git error.
 */
export async function getUntrackedFilesInDirectories(
  repoRoot: string,
  dirAbsolutePaths: string[]
): Promise<Map<string, string[]>> {
  const byDirectory = new Map<string, string[]>();
  if (dirAbsolutePaths.length === 0) {
    return byDirectory;
  }

  // Several input paths can normalize onto the same pathspec (duplicate entries,
  // differing separators), so keep every input that maps to a given pathspec.
  const inputsByPathspec = new Map<string, string[]>();
  for (const dirAbsolutePath of dirAbsolutePaths) {
    const relDir = relative(repoRoot, dirAbsolutePath).replace(/\\/g, '/');
    // An empty pathspec would match the whole repo; scope to the directory.
    const pathspec = relDir === '' ? '.' : relDir;
    const existing = inputsByPathspec.get(pathspec);
    if (existing) {
      existing.push(dirAbsolutePath);
    } else {
      inputsByPathspec.set(pathspec, [dirAbsolutePath]);
    }
  }

  let stdout: string;
  try {
    const chunks = chunkPathspecs(Array.from(inputsByPathspec.keys()));
    const outputs = await Promise.all(chunks.map(chunk => new Promise<string>((resolveOutput, rejectOutput) => {
      execFile(
        'git',
        ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z', '--', ...chunk],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: LS_FILES_MAX_BUFFER },
        (error, chunkStdout) => {
          if (error) {
            rejectOutput(error);
            return;
          }
          resolveOutput(chunkStdout);
        }
      );
    })));
    stdout = outputs.join('\0');
  } catch (error) {
    // Don't swallow this silently: a failure here makes untracked files vanish
    // from the changed-files UI with no other symptom.
    logEbadfDiagnostic('getUntrackedFilesInDirectories', error);
    console.error('[gitUtils] git ls-files failed while expanding untracked directories', repoRoot, error);
    return byDirectory;
  }

  // `-z` gives NUL-separated paths so filenames with spaces/newlines survive.
  for (const filePath of stdout.split('\0')) {
    if (!filePath) continue;
    // Attribute the file to the longest matching input directory. Porcelain
    // never reports nested untracked directories (the outer one collapses the
    // inner), but longest-match is the correct semantic regardless.
    const parts = filePath.split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      const prefix = i === 0 ? '.' : parts.slice(0, i).join('/');
      const inputs = inputsByPathspec.get(prefix);
      if (!inputs) continue;
      for (const input of inputs) {
        const list = byDirectory.get(input);
        if (list) {
          list.push(filePath);
        } else {
          byDirectory.set(input, [filePath]);
        }
      }
      break;
    }
  }

  return byDirectory;
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
