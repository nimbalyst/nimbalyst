import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { toRepositoryRelativePath } from './GitCommitService';
import { sanitizeGitRepositoryEnv } from './gitRepositoryEnv';

/**
 * #1955: a commit proposal may name a directory, the way `git status` collapses
 * an untracked folder to `?? dir/`. Committing a directory as one pathspec
 * stages every changed file under it, and the commit's strict staged-set check
 * (GitCommitService) then rejects all of them as unexpected. So directories are
 * expanded here, when the proposal is made: the stored proposal, the widget and
 * the commit all work on one concrete file list, and the strict check stays as
 * the last line of defense.
 */

export type ProposalFileStatus = 'added' | 'modified' | 'deleted';

export interface ExpandedProposalFile {
  /** Absolute path. */
  path: string;
  /** Set for files that came from a directory; explicit files keep the caller's status. */
  status?: ProposalFileStatus;
  /** Repo-relative directory (with trailing slash) this file was expanded from. */
  fromDirectory?: string;
}

export interface ProposalPathExpansion {
  files: ExpandedProposalFile[];
  /** Repo-relative directory (trailing slash) to the number of files it expanded to. */
  expandedFrom: Record<string, number>;
  /** Exclude entries that matched no file; reported to the agent, not an error. */
  unmatchedExcludes: string[];
}

/** D-A3: the widget is not virtualized and the tool result has to stay readable. */
export const MAX_EXPANDED_PROPOSAL_FILES = 2000;

function runGit(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, {
      cwd: repoPath,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: sanitizeGitRepositoryEnv(process.env) as NodeJS.ProcessEnv,
    }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout)));
  });
}

/** Exit status 0 means ignored, 1 means not ignored; anything else is a real failure. */
function isIgnored(repoPath: string, relPath: string): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['check-ignore', '-q', '--', relPath], {
      cwd: repoPath,
      windowsHide: true,
      env: sanitizeGitRepositoryEnv(process.env) as NodeJS.ProcessEnv,
    }, (error) => {
      if (!error) return resolvePromise(true);
      if ((error as { code?: unknown }).code === 1) return resolvePromise(false);
      reject(error);
    });
  });
}

const splitZ = (raw: string) => raw.split('\0').filter(Boolean);

async function hasHead(repoPath: string): Promise<boolean> {
  try {
    await runGit(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** Index entries at or under `rel`, with their modes; used to spot deleted directories and submodules. */
async function indexEntries(repoPath: string, rel: string): Promise<Array<{ mode: string; path: string }>> {
  const raw = await runGit(repoPath, ['--literal-pathspecs', 'ls-files', '--cached', '--stage', '-z', '--', rel]);
  return splitZ(raw).map(entry => {
    const tab = entry.indexOf('\t');
    return { mode: entry.slice(0, entry.indexOf(' ')), path: entry.slice(tab + 1) };
  });
}

/**
 * Whether `rel` names a directory to expand rather than a file: a directory on
 * disk, or a path git tracks only entries underneath (a deleted directory). A
 * tracked submodule is a single gitlink entry and stays a file.
 */
async function isExpandableDirectory(repoPath: string, absolute: string, rel: string): Promise<boolean> {
  if (existsSync(absolute)) {
    if (!statSync(absolute).isDirectory()) return false;
    const entries = await indexEntries(repoPath, rel);
    return !entries.some(entry => entry.path === rel && entry.mode === '160000');
  }
  // Not on disk: an explicit deleted file, or a deleted directory. After a
  // staged `git rm -r` only HEAD still has entries under it, so ask both. If
  // git cannot answer, leave it an explicit file so the commit reports it as
  // it always has.
  const under = (path: string) => path.startsWith(`${rel}/`);
  try {
    if ((await indexEntries(repoPath, rel)).some(entry => under(entry.path))) return true;
  } catch {
    return false;
  }
  try {
    return splitZ(await runGit(repoPath, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', rel])).some(under);
  } catch {
    return false; // unborn HEAD
  }
}

function statusFromLetter(letter: string): ProposalFileStatus {
  if (letter.startsWith('A')) return 'added';
  if (letter.startsWith('D')) return 'deleted';
  return 'modified';
}

/** Changed files under one directory: tracked changes against HEAD plus untracked, non-ignored files. */
async function expandDirectory(repoPath: string, rel: string, headExists: boolean): Promise<Map<string, ProposalFileStatus>> {
  const files = new Map<string, ProposalFileStatus>();
  if (headExists) {
    const tokens = splitZ(await runGit(repoPath, ['--literal-pathspecs', 'diff', '--name-status', '--no-renames', '-z', 'HEAD', '--', rel]));
    for (let i = 0; i + 1 < tokens.length; i += 2) files.set(tokens[i + 1], statusFromLetter(tokens[i]));
  } else {
    for (const path of splitZ(await runGit(repoPath, ['--literal-pathspecs', 'ls-files', '--cached', '-z', '--', rel]))) files.set(path, 'added');
  }
  for (const path of splitZ(await runGit(repoPath, ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', rel]))) {
    if (path.endsWith('/')) {
      throw new Error(`\`${path}\` is a separate git repository; commit inside it or add it as a submodule deliberately.`);
    }
    files.set(path, 'added');
  }
  return files;
}

/**
 * Expand directory entries in `absolutePaths` (already resolved and grouped
 * into `repoPath`) into concrete files. Explicitly listed files pass through
 * untouched, so an all-file proposal behaves exactly as before.
 *
 * `excludePaths` are literal files or directory prefixes, relative to
 * `relativeBase` or absolute. No globs and no pathspec magic.
 */
export async function expandProposalPaths(
  repoPath: string,
  absolutePaths: string[],
  options: { excludePaths?: string[]; relativeBase?: string; maxFiles?: number } = {},
): Promise<ProposalPathExpansion> {
  const maxFiles = options.maxFiles ?? MAX_EXPANDED_PROPOSAL_FILES;
  const relativeBase = options.relativeBase ?? repoPath;
  const explicit = new Map<string, string>(); // repo-relative -> original absolute path
  const directories: Array<{ rel: string; key: string }> = [];
  let headExists: boolean | undefined;

  for (const absolute of absolutePaths) {
    const rel = toRepositoryRelativePath(repoPath, absolute);
    if (!(await isExpandableDirectory(repoPath, absolute, rel))) {
      if (!explicit.has(rel)) explicit.set(rel, absolute);
      continue;
    }
    if (await isIgnored(repoPath, rel)) {
      throw new Error(`\`${rel}/\` is ignored by .gitignore; nothing under it can be committed. List the files explicitly if you meant to force them in.`);
    }
    if (!directories.some(dir => dir.rel === rel)) directories.push({ rel, key: `${rel}/` });
  }

  const expandedStatus = new Map<string, { status: ProposalFileStatus; fromDirectory: string }>();
  const expandedFrom: Record<string, number> = {};
  for (const dir of directories) {
    headExists ??= await hasHead(repoPath);
    const files = await expandDirectory(repoPath, dir.rel, headExists);
    if (files.size === 0) throw new Error(`\`${dir.key}\` has no uncommitted changes.`);
    expandedFrom[dir.key] = files.size;
    for (const [path, status] of files) {
      if (!explicit.has(path) && !expandedStatus.has(path)) expandedStatus.set(path, { status, fromDirectory: dir.key });
    }
  }

  const excludes = (options.excludePaths ?? []).map(exclude => {
    if (typeof exclude !== 'string' || !exclude) throw new Error('Invalid excludePaths entry');
    const absolute = isAbsolute(exclude) ? resolve(exclude) : resolve(relativeBase, exclude);
    // The repository root itself excludes everything (toRepositoryRelativePath rejects an empty path).
    if (absolute === resolve(repoPath)) return { original: exclude, rel: '' };
    return { original: exclude, rel: toRepositoryRelativePath(repoPath, absolute).replace(/\/+$/, '') };
  });
  const matchesExclude = (rel: string, exclude: string) =>
    exclude === '' || rel === exclude || rel.startsWith(`${exclude}/`);
  const unmatchedExcludes = excludes
    .filter(exclude => ![...explicit.keys(), ...expandedStatus.keys()].some(rel => matchesExclude(rel, exclude.rel)))
    .map(exclude => exclude.original);
  const kept = (rel: string) => !excludes.some(exclude => matchesExclude(rel, exclude.rel));

  const files: ExpandedProposalFile[] = [
    ...[...explicit].filter(([rel]) => kept(rel)).map(([, path]) => ({ path })),
    ...[...expandedStatus].filter(([rel]) => kept(rel)).map(([rel, info]) => ({ path: join(repoPath, rel), ...info })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (files.length === 0) throw new Error('excludePaths removed every file from this proposal; nothing is left to commit.');
  if (directories.length > 0 && files.length > maxFiles) {
    throw new Error(`This proposal expands to ${files.length} files, more than ${maxFiles}. Split it by subdirectory and propose each part separately.`);
  }
  return { files, expandedFrom, unmatchedExcludes };
}
