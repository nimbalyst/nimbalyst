import simpleGit, { SimpleGit, SimpleGitOptions } from 'simple-git';
import { getEnhancedPath, getShellEnvironment } from './CLIManager';
import { GIT_INHERITED_ENV_UNSAFE } from './gitInheritedEnvUnsafe';

/**
 * Build the environment for git subprocesses that may run hooks (commit, merge,
 * rebase, etc.).
 *
 * GUI-launched apps on macOS/Linux do not inherit the login shell's PATH, so
 * husky hooks invoking nvm/Homebrew-managed binaries (e.g. `yarn lint`) fail with
 * "command not found" (exit 127) and the operation aborts. Layering in the
 * detected shell environment and enhanced PATH makes those binaries resolve the
 * same way they do in a normal terminal.
 *
 * simple-git's `.env(object)` REPLACES the child environment, so we spread
 * process.env first to preserve everything else git relies on.
 */
export function getGitSubprocessEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      base[key] = value;
    }
  }
  return {
    ...base,
    ...(getShellEnvironment() ?? {}),
    PATH: getEnhancedPath(),
  };
}

/**
 * Create a simple-git instance whose subprocesses run with the enhanced shell
 * environment. Use this for any operation that may fire git hooks (commit, merge,
 * rebase, pull, cherry-pick) so husky hooks resolve nvm/Homebrew binaries.
 */
export function simpleGitWithHookEnv(
  baseDir: string,
  options?: Partial<SimpleGitOptions>
): SimpleGit {
  // The unsafe flags are required because .env() makes simple-git scan the
  // supplied (trusted, user-owned) environment for vars like GIT_EDITOR.
  const git = simpleGit(baseDir, { ...options, unsafe: GIT_INHERITED_ENV_UNSAFE });
  return git.env(getGitSubprocessEnv());
}
