import log from 'electron-log/main';
import { existsSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import { gitOperationLock } from './GitOperationLock';

export interface GitCommitExecutionResult {
  success: boolean;
  commitHash?: string;
  commitDate?: string;
  error?: string;
}

export interface GitCommitProposalResponse {
  action: 'committed' | 'cancelled' | 'error';
  commitHash?: string;
  commitDate?: string;
  error?: string;
  filesCommitted?: string[];
  commitMessage?: string;
}

function isGitRepository(workspacePath: string): boolean {
  try {
    return existsSync(join(workspacePath, '.git'));
  } catch {
    return false;
  }
}

async function hasCommits(git: SimpleGit): Promise<boolean> {
  try {
    await git.revparse(['HEAD']);
    return true;
  } catch {
    return false;
  }
}

function getGitCommitErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

export async function executeGitCommit(
  workspacePath: string,
  message: string,
  filesToStage: string[],
  options?: {
    logContext?: string;
  }
): Promise<GitCommitExecutionResult> {
  const logContext = options?.logContext || '[git:commit]';

  if (!workspacePath) {
    return { success: false, error: 'workspacePath is required' };
  }
  if (!message) {
    return { success: false, error: 'message is required' };
  }
  if (!isGitRepository(workspacePath)) {
    return { success: false, error: 'Not a git repository' };
  }

  return gitOperationLock.withLock(workspacePath, 'git:commit', async () => {
    try {
      const git: SimpleGit = simpleGit(workspacePath);
      const repoHasCommits = await hasCommits(git);
      // log.info(`${logContext} Starting commit in ${workspacePath} with ${filesToStage?.length || 0} files (hasCommits: ${repoHasCommits})`);

      const toGitPath = (f: string) => {
        const rel = isAbsolute(f) ? relative(workspacePath, f) : f;
        return rel.replace(/\\/g, '/');
      };

      if (!filesToStage || filesToStage.length === 0) {
        const preStatus = await git.status();
        const stagedCount = preStatus.staged.length + preStatus.created.length;
        if (stagedCount === 0) {
          return {
            success: false,
            error: 'No files are staged for commit.',
          };
        }
        log.info(`${logContext} Index-as-is mode: committing ${stagedCount} staged files`);

        const result = await git.commit(message);
        if (!result.commit) {
          return {
            success: false,
            error: 'No changes were committed.',
          };
        }

        // log.info(`${logContext} Successfully committed: ${result.commit}`);
        let commitDate: string | undefined;
        try {
          const showResult = await git.show([result.commit, '--no-patch', '--format=%aI']);
          commitDate = showResult.trim();
        } catch {
          // Non-critical
        }

        return { success: true, commitHash: result.commit, commitDate };
      }

      const initialStatus = await git.status();
      const originallyStaged = new Set([...initialStatus.staged, ...initialStatus.created]);
      // log.info(`${logContext} Originally staged files: ${originallyStaged.size}`);

      // log.info(`${logContext} Resetting staging area before staging selected files`);
      if (repoHasCommits) {
        await git.reset(['HEAD']);
      } else if (originallyStaged.size > 0) {
        await git.raw(['rm', '--cached', '-r', '.']);
      }

      const filesToStageRelative = filesToStage.map(toGitPath);
      // log.info(`${logContext} Staging files (raw): ${filesToStage.join(', ')}`);
      // log.info(`${logContext} Staging files (git-relative): ${filesToStageRelative.join(', ')}`);

      await git.add(['--all', '--', ...filesToStage]);

      const status = await git.status();
      const stagedFiles = new Set([...status.staged, ...status.created]);
      // log.info(`${logContext} After staging - staged files: [${[...status.staged].join(', ')}], created files: [${[...status.created].join(', ')}]`);

      if (stagedFiles.size === 0) {
        log.warn(`${logContext} No files were staged despite add() succeeding. Requested: [${filesToStage.join(', ')}], git-relative: [${filesToStageRelative.join(', ')}]`);
        if (originallyStaged.size > 0) {
          await git.add(Array.from(originallyStaged));
        }
        return {
          success: false,
          error: 'No files were staged. The files may not exist or have no changes.',
        };
      }

      const filesToStageRelSet = new Set(filesToStageRelative);
      const unexpectedFiles = Array.from(stagedFiles).filter((f) => !filesToStageRelSet.has(f));
      const missingFiles = filesToStageRelative.filter((f) => !stagedFiles.has(f));

      if (unexpectedFiles.length > 0) {
        log.error(`${logContext} Unexpected files staged: ${unexpectedFiles.join(', ')}`);
        if (repoHasCommits) {
          await git.reset(['HEAD']);
        } else {
          await git.raw(['rm', '--cached', '-r', '.']);
        }
        if (originallyStaged.size > 0) {
          await git.add(Array.from(originallyStaged));
        }
        return {
          success: false,
          error: `Unexpected files were staged: ${unexpectedFiles.join(', ')}. Commit aborted.`,
        };
      }

      if (missingFiles.length > 0) {
        log.warn(`${logContext} Some selected files were not staged: ${missingFiles.join(', ')}`);
      }

      const result = await git.commit(message);
      // log.info(`${logContext} Commit result: hash=${result.commit || 'empty'}, changes=${result.summary?.changes || 0}`);

      if (!result.commit) {
        log.warn(`${logContext} Commit returned empty hash - nothing was committed`);
        if (originallyStaged.size > 0) {
          await git.add(Array.from(originallyStaged));
        }
        return {
          success: false,
          error: 'No changes were committed. Files may not have been staged correctly.',
        };
      }

      const committedFilesSet = new Set((filesToStage || []).map(toGitPath));
      const filesToRestage = Array.from(originallyStaged).filter((f) => !committedFilesSet.has(f));
      if (filesToRestage.length > 0) {
        log.info(`${logContext} Restoring ${filesToRestage.length} originally staged files`);
        await git.add(filesToRestage);
      }

      // log.info(`${logContext} Successfully committed: ${result.commit}`);

      let commitDate: string | undefined;
      try {
        const showResult = await git.show([result.commit, '--no-patch', '--format=%aI']);
        commitDate = showResult.trim();
      } catch {
        // Non-critical
      }

      return {
        success: true,
        commitHash: result.commit,
        commitDate,
      };
    } catch (error) {
      log.error(`${logContext} Failed to commit:`, error);
      return {
        success: false,
        error: getGitCommitErrorMessage(error),
      };
    }
  });
}

export function createGitCommitProposalResponse(
  result: GitCommitExecutionResult,
  files: string[],
  commitMessage: string
): GitCommitProposalResponse {
  if (result.success) {
    return {
      action: 'committed',
      commitHash: result.commitHash,
      commitDate: result.commitDate,
      filesCommitted: files,
      commitMessage,
    };
  }

  return {
    action: 'error',
    error: result.error || 'No changes were committed',
  };
}
