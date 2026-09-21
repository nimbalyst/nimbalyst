import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { getDatabase } from '../database/initialize';
import { createWorktreeStore } from './WorktreeStore';
import { groupFilesByRepo, resolveExtraCommitRoots } from './workspaceRepos';

/** #1529: MCP configuration lives at the parent project; commit paths do not. */
export async function resolveGitCommitProposalTarget(
  sessionId: string | undefined,
  connectionWorkspace: string,
  filePaths: string[],
  workingDirectory?: unknown,
): Promise<{ workspacePath: string; repoPath: string; files: string[] }> {
  if (workingDirectory !== undefined) {
    throw new Error('workingDirectory is not supported. Commit proposals target the session checkout; use a session in the intended checkout.');
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
  const files = filePaths.map(file => {
    if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('Invalid commit proposal file path');
    return isAbsolute(file) ? resolve(file) : resolve(workspacePath, file);
  });
  const groups = groupFilesByRepo(workspacePath, files, resolveExtraCommitRoots(workspacePath, session.workspacePath));
  const outside = groups.get(null);
  if (outside?.length) throw new Error(`Selected files are outside the session's git repositories: ${outside.join(', ')}`);
  const repos = [...groups.keys()].filter((repo): repo is string => repo !== null);
  if (repos.length !== 1) throw new Error(`This proposal spans ${repos.length} git repositories. Call developer_git_commit_proposal once per repository.`);
  return { workspacePath, repoPath: repos[0], files };
}
