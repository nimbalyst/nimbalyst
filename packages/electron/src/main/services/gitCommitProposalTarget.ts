import { execFile } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { SessionFilesRepository } from '@nimbalyst/runtime/storage/repositories/SessionFilesRepository';
import { getDatabase } from '../database/initialize';
import { createWorktreeStore } from './WorktreeStore';
import { groupFilesByRepo, resolveExtraCommitRoots } from './workspaceRepos';
import { sanitizeGitRepositoryEnv } from './gitRepositoryEnv';
import { expandProposalPaths, type ProposalFileStatus } from './gitProposalPathExpansion';

/** A sibling worktree named explicitly by the proposal (#1756). */
export interface CommitProposalWorktree {
  path: string;
  branch: string | null;
}

/** Another session edited this file and the proposing session did not (#1955, D-A2). */
export interface ProposalFileOwnership {
  ownership: 'other-session';
  sessionId: string;
  sessionTitle?: string;
}

/** One file of a proposal that named a directory. */
export interface ProposalFileDetail {
  path: string;
  /** From the expansion; explicit files have none, and keep whatever status the agent gave. */
  status?: ProposalFileStatus;
  /** Repo-relative directory (trailing slash) this file was expanded from. */
  fromDirectory?: string;
  otherSession?: ProposalFileOwnership;
}

export interface ProposalExpansionSummary {
  /** The paths the agent asked for, before expansion (absolute). */
  requestedPaths: string[];
  excludePaths: string[];
  expandedFrom: Record<string, number>;
  unmatchedExcludes: string[];
}

export interface GitCommitProposalTarget {
  workspacePath: string;
  repoPath: string;
  files: string[];
  /** Set only for an explicit sibling worktree; such a commit always needs manual approval. */
  worktree?: CommitProposalWorktree;
  /** #1955: set only when a directory was expanded or excludePaths were given; parallel to `files`. */
  fileDetails?: ProposalFileDetail[];
  expansion?: ProposalExpansionSummary;
}

export interface GitCommitProposalTargetOptions {
  /** Literal files or directory prefixes removed after expansion. */
  excludePaths?: unknown;
}

const WORKING_DIRECTORY_HELP =
  'Pass workingDirectory only as the absolute path of another worktree of this session\'s repository, as listed by `git worktree list`. Omit it to commit in the session checkout.';

function realpathOrNull(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    execFile('git', args, { windowsHide: true, cwd, env: sanitizeGitRepositoryEnv(process.env) as NodeJS.ProcessEnv },
      (error, stdout) => (error ? reject(error) : resolvePromise(stdout)));
  });
}

/** Every registered, non-bare worktree of the repository that owns `checkout`. */
async function listRegisteredWorktrees(checkout: string): Promise<CommitProposalWorktree[]> {
  const output = await runGit(checkout, ['worktree', 'list', '--porcelain']);
  return output.split(/\n\s*\n/).flatMap(block => {
    const lines = block.split('\n');
    const path = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length);
    if (!path || lines.includes('bare')) return [];
    const branch = lines.find(line => line.startsWith('branch '))?.slice('branch '.length).replace(/^refs\/heads\//, '') ?? null;
    return [{ path, branch }];
  });
}

/** Absolute toplevel, common dir and git dir of the repository at `dir`. */
async function repoIdentity(dir: string): Promise<{ toplevel: string; commonDir: string; gitDir: string }> {
  const [toplevel, commonDir, gitDir] = (await runGit(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir']))
    .split('\n').map(line => realpathSync(line.trim()));
  return { toplevel, commonDir, gitDir };
}

/**
 * A listed path is not proof: a worktree moved without git leaves its
 * registration behind, and an unrelated repo can sit at the old path. The
 * candidate must share the session repo's common dir, and its git dir must be
 * that repo's own (main checkout) or a registration under `worktrees/` whose
 * `gitdir` file points back at the candidate.
 */
async function isSameRepoWorktree(checkout: string, candidate: string): Promise<boolean> {
  try {
    const session = await repoIdentity(checkout);
    const target = await repoIdentity(candidate);
    if (target.toplevel !== candidate || target.commonDir !== session.commonDir) return false;
    if (target.gitDir === session.commonDir) return true;
    if (dirname(target.gitDir) !== join(session.commonDir, 'worktrees')) return false;
    const backlink = readFileSync(join(target.gitDir, 'gitdir'), 'utf8').trim();
    return realpathOrNull(isAbsolute(backlink) ? backlink : resolve(target.gitDir, backlink)) === realpathOrNull(join(candidate, '.git'));
  } catch {
    return false;
  }
}

/** The registered worktree of `checkout`'s repository at `candidate`; throws a "what to do" error otherwise. */
async function findRegisteredWorktree(checkout: string, candidate: string): Promise<CommitProposalWorktree & { path: string }> {
  const requested = realpathOrNull(candidate);
  const registered = requested
    ? (await listRegisteredWorktrees(checkout).catch(() => [])).find(w => realpathOrNull(w.path) === requested)
    : undefined;
  if (!requested || !registered || !(await isSameRepoWorktree(checkout, requested))) {
    throw new Error(`${candidate} is not a registered git worktree of this session's repository (see \`git worktree list\` in ${checkout}). ${WORKING_DIRECTORY_HELP}`);
  }
  return { path: requested, branch: registered.branch };
}

/** The checkout a session commits from: its bound worktree, else its workspace. */
export async function getSessionCommitCheckout(sessionId: string): Promise<string> {
  const session = await AISessionsRepository.get(sessionId);
  if (!session?.workspacePath) throw new Error('Session has no workspace; refusing to commit');
  return session.worktreePath || session.workspacePath;
}

/** #1756: re-check a stored worktree target right before its commit runs. */
export async function revalidateProposalWorktree(sessionId: string, worktreePath: string): Promise<void> {
  await findRegisteredWorktree(await getSessionCommitCheckout(sessionId), worktreePath);
}

/** #1529: MCP configuration lives at the parent project; commit paths do not. */
export async function resolveGitCommitProposalTarget(
  sessionId: string | undefined,
  connectionWorkspace: string,
  filePaths: string[],
  workingDirectory?: unknown,
  options: GitCommitProposalTargetOptions = {},
): Promise<GitCommitProposalTarget> {
  const excludePaths = parseExcludePaths(options.excludePaths);
  if (workingDirectory !== undefined
    && (typeof workingDirectory !== 'string' || !isAbsolute(workingDirectory) || workingDirectory.includes('\0'))) {
    throw new Error(`workingDirectory must be an absolute path. ${WORKING_DIRECTORY_HELP}`);
  }
  if (!sessionId) throw new Error('Session is required for a commit proposal');
  const session = await AISessionsRepository.get(sessionId);
  if (!session?.workspacePath) throw new Error('Session has no workspace; refusing to commit');

  let workspacePath = session.workspacePath;
  if (session.worktreeId || session.worktreePath) {
    if (!session.worktreeId || !session.worktreePath) {
      throw new Error('Incomplete worktree binding; refusing to commit');
    }
    const db = getDatabase();
    const native = db ? await createWorktreeStore(db).get(session.worktreeId) : null;
    if (!native || realpathSync(native.path) !== realpathSync(session.worktreePath)) {
      throw new Error('Worktree binding changed or is unavailable; refusing to commit');
    }
    workspacePath = session.worktreePath;
  }
  if (![session.workspacePath, workspacePath].some(p => realpathSync(p) === realpathSync(connectionWorkspace))) {
    throw new Error('Session workspace does not match the MCP connection; refusing to commit');
  }
  if (!filePaths.length) throw new Error('At least one selected file is required');
  const checkFile = (file: unknown) => {
    if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('Invalid commit proposal file path');
    return file;
  };

  // #1756: an explicit target is honored only when Git itself lists it as a
  // worktree of the session's repository, and every file must belong to it.
  if (typeof workingDirectory === 'string') {
    const registered = await findRegisteredWorktree(workspacePath, workingDirectory);
    const requested = registered.path;
    if (requested !== realpathSync(workspacePath)) {
      const files = filePaths.map(file => {
        const path = checkFile(file);
        return isAbsolute(path) ? resolve(path) : resolve(requested, path);
      });
      const groups = groupFilesByRepo(requested, files, []);
      const outside = [...groups].filter(([repo]) => !repo || realpathOrNull(repo) !== requested).flatMap(([, list]) => list);
      if (outside.length) throw new Error(`Selected files are outside the worktree ${requested}: ${outside.join(', ')}. Call developer_git_commit_proposal once per checkout.`);
      return expandTarget(
        { workspacePath: requested, repoPath: requested, files, worktree: { path: requested, branch: registered.branch } },
        sessionId, [session.workspacePath, requested], excludePaths,
      );
    }
  }

  const files = filePaths.map(file => {
    const path = checkFile(file);
    return isAbsolute(path) ? resolve(path) : resolve(workspacePath, path);
  });
  const groups = groupFilesByRepo(workspacePath, files, resolveExtraCommitRoots(workspacePath, session.workspacePath));
  const outside = groups.get(null);
  if (outside?.length) {
    throw new Error(`Selected files are outside the session's git repositories: ${outside.join(', ')}. If they are in another worktree of this repository, pass that worktree's absolute path as workingDirectory; otherwise commit from a session in that checkout.`);
  }
  const repos = [...groups.keys()].filter((repo): repo is string => repo !== null);
  if (repos.length !== 1) throw new Error(`This proposal spans ${repos.length} git repositories. Call developer_git_commit_proposal once per repository.`);
  return expandTarget({ workspacePath, repoPath: repos[0], files }, sessionId, [session.workspacePath, workspacePath], excludePaths);
}

function parseExcludePaths(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || !entry || entry.includes('\0'))) {
    throw new Error('excludePaths must be an array of literal file or directory paths');
  }
  return value as string[];
}

/**
 * Epoch ms just past each file's newest commit (git dates are whole seconds),
 * from one `git log` bounded by the oldest edit time. Files with no commit in
 * that window are absent. A failed lookup returns nothing, which keeps every
 * flag: pausing auto-commit is the safe side.
 */
async function lastCommitTimes(
  repoPath: string,
  files: ProposalFileDetail[],
  editorsByFile: Map<string, Map<string, number | undefined>>,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const editTimes = files.flatMap(file => [...editorsByFile.get(file.path)!.values()]);
  if (files.length === 0 || editTimes.some(time => time === undefined)) return result;
  const since = Math.floor(Math.min(...(editTimes as number[])) / 1000);
  const byRelative = new Map(files.map(file => [relative(repoPath, file.path).split(sep).join('/'), file.path]));
  let output: string;
  try {
    output = await runGit(repoPath, ['-c', 'core.quotePath=false', 'log', `--since=@${since}`, '--format=\x1f%ct', '--name-only', '--no-renames', '--', ...byRelative.keys()]);
  } catch (error) {
    console.warn('[gitCommitProposalTarget] git log for other-session edit check failed; keeping all flags', error);
    return result;
  }
  let commitMs = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('\x1f')) { commitMs = (Number(line.slice(1)) + 1) * 1000; continue; }
    const absolute = byRelative.get(line);
    if (absolute && commitMs > (result.get(absolute) ?? 0)) result.set(absolute, commitMs);
  }
  return result;
}

/**
 * #1955: expand directory entries into concrete files, then flag files under an
 * expanded directory that another session edited and this one did not. Those
 * arrive unchecked in the widget and stop auto-commit (D-A2). An all-file
 * proposal without excludes comes back unchanged.
 */
async function expandTarget(
  target: GitCommitProposalTarget,
  sessionId: string,
  workspaceIds: string[],
  excludePaths: string[],
): Promise<GitCommitProposalTarget> {
  const expansion = await expandProposalPaths(target.repoPath, target.files, {
    excludePaths,
    relativeBase: target.workspacePath,
  });
  if (Object.keys(expansion.expandedFrom).length === 0 && excludePaths.length === 0) return target;

  const details: ProposalFileDetail[] = expansion.files.map(file => ({ ...file }));
  const expanded = details.filter(file => file.fromDirectory);
  if (expanded.length > 0) {
    let links: Array<{ sessionId: string; filePath: string; lastLinkedAt?: number }>;
    try {
      links = await SessionFilesRepository.getSessionsByFiles(workspaceIds, expanded.map(file => file.path), 'edited');
    } catch (error) {
      throw new Error(`Could not check which sessions edited the files under ${Object.keys(expansion.expandedFrom).join(', ')}, so the directory cannot be expanded safely. List the files explicitly. (${error instanceof Error ? error.message : String(error)})`);
    }
    const editorsByFile = new Map<string, Map<string, number | undefined>>();
    for (const link of links) {
      const editors = editorsByFile.get(link.filePath) ?? new Map<string, number | undefined>();
      editors.set(link.sessionId, link.lastLinkedAt);
      editorsByFile.set(link.filePath, editors);
    }
    const candidates = expanded.filter(file => {
      const editors = editorsByFile.get(file.path);
      return !!editors && !editors.has(sessionId);
    });
    // An edit made before the file's last commit is already in history; only
    // edits newer than that commit are another session's pending work.
    const lastCommitted = await lastCommitTimes(target.repoPath, candidates, editorsByFile);
    const flagged = new Map<ProposalFileDetail, string>();
    for (const file of candidates) {
      const committedAt = lastCommitted.get(file.path);
      const pending = [...editorsByFile.get(file.path)!]
        .filter(([, editedAt]) => committedAt === undefined || editedAt === undefined || editedAt >= committedAt)
        .map(([id]) => id)
        .sort();
      if (pending.length > 0) flagged.set(file, pending[0]);
    }
    if (flagged.size > 0) {
      const titles = new Map<string, string>();
      try {
        for (const other of await AISessionsRepository.getMany([...new Set(flagged.values())])) {
          if (other?.title) titles.set(other.id, other.title);
        }
      } catch {
        // A missing title only weakens the badge text; the flag itself stands.
      }
      for (const [file, otherId] of flagged) {
        file.otherSession = { ownership: 'other-session', sessionId: otherId, ...(titles.has(otherId) ? { sessionTitle: titles.get(otherId) } : {}) };
      }
    }
  }

  return {
    ...target,
    files: details.map(file => file.path),
    fileDetails: details,
    expansion: {
      requestedPaths: target.files,
      excludePaths,
      expandedFrom: expansion.expandedFrom,
      unmatchedExcludes: expansion.unmatchedExcludes,
    },
  };
}
