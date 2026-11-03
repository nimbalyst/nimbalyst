import { execFile } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { getDatabase } from '../database/initialize';
import { createWorktreeStore } from './WorktreeStore';
import { groupFilesByRepo, resolveExtraCommitRoots } from './workspaceRepos';
import { sanitizeGitRepositoryEnv } from './gitRepositoryEnv';

/** A sibling worktree named explicitly by the proposal (#1756). */
export interface CommitProposalWorktree {
  path: string;
  branch: string | null;
}

export interface GitCommitProposalTarget {
  workspacePath: string;
  repoPath: string;
  files: string[];
  /** Set only for an explicit sibling worktree; such a commit always needs manual approval. */
  worktree?: CommitProposalWorktree;
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
): Promise<GitCommitProposalTarget> {
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
      return { workspacePath: requested, repoPath: requested, files, worktree: { path: requested, branch: registered.branch } };
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
  return { workspacePath, repoPath: repos[0], files };
}
