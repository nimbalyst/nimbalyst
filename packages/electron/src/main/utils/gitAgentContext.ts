import path from 'path';
import { existsSync } from 'fs';
import { GIT_INHERITED_ENV_UNSAFE } from '../services/gitInheritedEnvUnsafe';
import { withTimeout } from './gitUncommittedFiles';

/**
 * Builds the git snapshot stated at the top of a Claude Agent session.
 *
 * #1177: the Claude Code CLI normally injects its own "git status at the start
 * of the conversation" block, rebuilt from the LIVE working tree by every CLI
 * process. Nimbalyst runs each user turn as a separate process, so that block
 * moved on most turns and invalidated the prompt cache behind it. We suppress it
 * (CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS) and state this instead, resolved once
 * per session and frozen by ClaudeCodeProvider.
 *
 * Deliberately excludes the working-tree file list. That is the part that goes
 * stale fastest and the part that made the CLI's block volatile; the agent can
 * run `git status` itself when it needs the current tree.
 */

// A hung `git` subprocess must never delay a turn. #929: an un-timed
// `git status` froze new agent sessions until an app restart.
const GIT_CONTEXT_TIMEOUT_MS = 5000;

// Enough to establish voice and recent history without becoming a meaningful
// share of the prompt.
const RECENT_COMMIT_COUNT = 5;

// Defensive ceiling so a repo with pathological branch/commit text cannot
// balloon the system prompt.
const MAX_CONTEXT_CHARS = 2000;

/**
 * Resolves the branch, the repository's main branch, and the most recent
 * commits. Returns null when the path is not a git repository or git did not
 * answer in time — callers freeze that "none" for the session rather than
 * retrying, since acquiring the section on a later turn is itself a cache miss.
 */
export async function getAgentGitContext(workspacePath: string): Promise<string | null> {
  if (!existsSync(path.join(workspacePath, '.git'))) {
    return null;
  }

  try {
    const simpleGit = (await import('simple-git')).default;
    // GIT_OPTIONAL_LOCKS=0 keeps these read-only commands from refreshing (and
    // so locking) .git/index, where they would contend with the commit path
    // (NIM-2285). Supplying ANY env makes simple-git scan it and refuse to spawn
    // git when the user's own environment has GIT_EDITOR/GIT_PAGER and friends,
    // hence the unsafe flags.
    const git = simpleGit(workspacePath, {
      timeout: { block: GIT_CONTEXT_TIMEOUT_MS },
      unsafe: GIT_INHERITED_ENV_UNSAFE,
    }).env({ ...process.env, GIT_OPTIONAL_LOCKS: '0' });

    // Each lookup degrades to empty on its own so a repo missing one of them
    // (no commits yet, detached HEAD) still contributes the rest. One shared
    // timeout bounds the whole set.
    const [branch, mainBranch, log] = await withTimeout(
      Promise.all([
        git.revparse(['--abbrev-ref', 'HEAD']).then(b => b.trim()).catch(() => ''),
        resolveMainBranch(git),
        git.raw(['log', `-${RECENT_COMMIT_COUNT}`, '--oneline', '--no-decorate']).catch(() => ''),
      ]),
      GIT_CONTEXT_TIMEOUT_MS,
      `git context timed out after ${GIT_CONTEXT_TIMEOUT_MS}ms for ${workspacePath}`,
    );

    const lines: string[] = [];
    if (branch) lines.push(`Current branch: ${branch}`);
    if (mainBranch) lines.push(`Main branch (usually the base for PRs): ${mainBranch}`);
    const commits = log.trim();
    if (commits) lines.push('', 'Recent commits:', commits);

    if (lines.length === 0) return null;
    const context = lines.join('\n');
    return context.length > MAX_CONTEXT_CHARS ? `${context.slice(0, MAX_CONTEXT_CHARS)}\n[truncated]` : context;
  } catch (error) {
    console.warn('[GIT-CONTEXT] Failed to resolve git context for', workspacePath, error);
    return null;
  }
}

/**
 * The repo's main branch: what `origin/HEAD` points at when the remote has been
 * probed, otherwise whichever of the conventional names actually exists.
 */
async function resolveMainBranch(git: { raw(args: string[]): Promise<string> }): Promise<string> {
  try {
    const ref = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    // "origin/main" -> "main"
    if (ref) return ref.replace(/^origin\//, '');
  } catch {
    // No origin/HEAD (never cloned, or `git remote set-head` never ran).
  }

  for (const candidate of ['main', 'master']) {
    try {
      // `--quiet` suppresses the error, so a missing ref RESOLVES with empty
      // output rather than rejecting. Test the output, not the absence of a
      // throw, or the first candidate always wins.
      const sha = (await git.raw(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`])).trim();
      if (sha) return candidate;
    } catch {
      // Not a ref this repo has.
    }
  }
  return '';
}
