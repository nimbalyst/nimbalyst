import { execFile, execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { promisify } from 'util';

import { createGitRemoteCache } from './gitRemoteCache';

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
 * Repositories cloned inside `repoRoot` that its ignore rules hide (#1449).
 *
 * Keeping a clone out of the enclosing repo's history means ignoring it, and a
 * ripgrep scan of the enclosing root honors that rule, so file search never
 * reaches the clone even though the file tree shows it. `--directory` reports
 * each ignored directory once without descending into it, so this stays one
 * quick call however large the ignored trees are. Only an ignored directory
 * that is itself a checkout counts: build output stays hidden, and so do linked
 * worktrees of `repoRoot`'s own repository, which would only list its files a
 * second time. Clones nested deeper inside an ignored directory are not found.
 *
 * @returns Absolute paths in git's order. Empty when `repoRoot` is not a
 *          repository, git is unavailable, or git fails.
 */
export async function listIgnoredNestedRepositories(repoRoot: string): Promise<string[]> {
  if (!existsSync(join(repoRoot, '.git')) || !isGitAvailable()) {
    return [];
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['--no-optional-locks', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: LS_FILES_MAX_BUFFER },
    ));
  } catch (error) {
    console.error('[gitUtils] git ls-files failed while listing ignored nested repositories', repoRoot, error);
    return [];
  }

  const ownCommonDir = gitCommonDir(repoRoot);
  const repos: string[] = [];
  for (const entry of stdout.split('\0')) {
    // Ignored directories end in a slash; an ignored file cannot be a checkout.
    if (!entry.endsWith('/')) continue;
    const candidate = resolve(repoRoot, entry);
    const commonDir = gitCommonDir(candidate);
    if (commonDir === null || commonDir === ownCommonDir) continue;
    repos.push(candidate);
  }
  return repos;
}

/**
 * The shared git directory behind a checkout: its own `.git` for a clone, the
 * main repository's `.git` for a linked worktree. Null when `checkoutPath` is
 * not a checkout.
 */
function gitCommonDir(checkoutPath: string): string | null {
  const dotGit = join(checkoutPath, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return realpathSync(dotGit);
    // A linked worktree's `.git` is a file naming its private git dir, whose
    // `commondir` file points back at the main repository's `.git`.
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!match) return null;
    const gitDir = resolve(checkoutPath, match[1].trim());
    const commonDirFile = join(gitDir, 'commondir');
    return realpathSync(
      existsSync(commonDirFile) ? resolve(gitDir, readFileSync(commonDirFile, 'utf8').trim()) : gitDir,
    );
  } catch {
    return null;
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
 * Get the LEGACY normalized git remote for a workspace path -- the form that
 * existing stored hashes were computed from. See `legacyNormalizeGitRemote`.
 *
 * Runs `git remote get-url origin` asynchronously (no shell). Returns null if
 * the workspace is not a git repo or has no origin remote.
 *
 * Matching only. To mint a new identity, hash `normalizeGitRemote` instead --
 * or take both forms at once from `getGitRemoteIdentities`.
 */
export async function getNormalizedGitRemote(workspacePath: string): Promise<string | null> {
  return legacyNormalizeGitRemote(await getRawGitRemote(workspacePath));
}

/** Both identifier forms of a workspace's `origin`, from a single git spawn. */
export interface GitRemoteIdentities {
  /** Credential-free. Hash THIS for anything newly written. */
  canonical: string;
  /** The historical form every already-stored hash was computed from. */
  legacy: string;
}

/**
 * Both identifier forms of a workspace's `origin` remote, or null when it has
 * none. One `git remote get-url` spawn, because callers on the workspace-init
 * hot path need both and must not pay twice for it.
 */
export async function getGitRemoteIdentities(
  workspacePath: string,
): Promise<GitRemoteIdentities | null> {
  const raw = await getRawGitRemote(workspacePath);
  const canonical = normalizeGitRemote(raw);
  const legacy = legacyNormalizeGitRemote(raw);
  if (!canonical || !legacy) return null;
  return { canonical, legacy };
}

/**
 * The canonical identifier form of a remote URL: no scheme, no userinfo, no
 * `.git`, lowercased. Two clones of one repository normalize to the same string
 * however each was addressed -- with an embedded token, with a bare username,
 * over SCP-style SSH, or plainly over HTTPS.
 *
 * Hash THIS for every identity newly written to the server. Do not use it to
 * look up an existing row: rows written before this existed are keyed on
 * `legacyNormalizeGitRemote` and cannot be re-derived (SHA-256 is one-way).
 */
export function normalizeGitRemote(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  let identity: string;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      // `host` keeps a non-default port, which genuinely distinguishes remotes.
      // Userinfo is dropped whole: it identifies whoever configured the clone,
      // never the repository.
      identity = `${parsed.host}${parsed.pathname}`;
    } catch {
      return null;
    }
  } else {
    // SCP-style `[user@]host:org/repo.git`, which is not a parseable URL. The
    // colon-to-slash step is what makes this form agree with the URL forms.
    identity = trimmed.replace(/^[^/]*@/, '').replace(/:/, '/');
  }

  // Trailing slashes come off first so `repo.git/` still loses its suffix.
  return identity
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase() || null;
}

/**
 * The historical identifier form. It is wrong -- it mangles `user:pass@` into
 * a path segment, and leaves `git@` in place for `ssh://` remotes, so the same
 * repository yields different identifiers depending on how each teammate
 * addressed it.
 *
 * It survives because its output is a PERSISTED KEY, not because it is correct:
 * every project row, D1 discovery entry, and personal-index hash written before
 * `normalizeGitRemote` existed is a SHA-256 of this, and a one-way hash cannot
 * be migrated. Re-keying them would silently unbind those workspaces from their
 * organizations, including `ssh://git@host/...` remotes that carry no
 * credentials at all and match correctly today.
 *
 * Use it to MATCH existing rows, alongside the canonical form. Never use it to
 * mint a new identity.
 */
export function legacyNormalizeGitRemote(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  return remoteUrl
    .replace(/^https?:\/\//, '')
    .replace(/^git@/, '')
    .replace(/:/, '/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * The workspace's `origin` remote exactly as git reports it, or null when it
 * has none.
 *
 * The normalized form above is an identifier, not an address — it has lost the
 * scheme and its case. Anything that has to hand the remote back to git (the
 * post-sign-in project walk's clone step) needs this one.
 */
export async function getRawGitRemote(workspacePath: string): Promise<string | null> {
  return gitRemoteCache.get(workspacePath);
}

async function spawnGitRemote(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: workspacePath,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Callers walk every recent workspace on a hot path, so each one must not cost
 * a git spawn. See `gitRemoteCache.ts` for the measurements and for why the
 * entries expire instead of living forever.
 */
const gitRemoteCache = createGitRemoteCache(spawnGitRemote);

/**
 * Forget a cached `origin`. Call this after anything that can change a
 * workspace's remote (a clone into an existing path, `git remote set-url`
 * issued through the app), so the next lookup re-reads it.
 */
export function invalidateGitRemoteCache(workspacePath?: string): void {
  gitRemoteCache.invalidate(workspacePath);
}
