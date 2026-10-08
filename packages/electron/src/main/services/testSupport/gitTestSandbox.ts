/**
 * Shared hardening for tests that drive a REAL `git` binary.
 *
 * Two incidents motivate every line here:
 *   - 2026-07-22: a vitest git fixture escaped its sandbox during a release and
 *     pushed ten fixture commits to public main.
 *   - 2026-07-24: the pre-push hook ran the guard's own test suite, and the
 *     hook's inherited GIT_DIR redirected the fixture commits onto the
 *     developer's live branch. They landed on GitHub as unverified commits
 *     attributed to a maintainer who never wrote them (PR #973).
 *
 * The rules that fall out of those:
 *   1. Never inherit GIT_* from the parent. A git hook exports GIT_DIR /
 *      GIT_INDEX_FILE / GIT_WORK_TREE pointing at the real checkout, and those
 *      OVERRIDE the `cwd` passed to execFile.
 *   2. Never let the developer's global config supply an identity. Repo-local
 *      `git config user.email` is not enough — GIT_AUTHOR_* outranks it, and a
 *      commit that runs before the local config is written falls through to
 *      ~/.gitconfig, i.e. a real person's name.
 *   3. Always commit as an identity that `scripts/check-push-authors.mjs`
 *      rejects, so an escape is caught at push time instead of shipping.
 *   4. Assert the resolved toplevel before every mutation, not just at init.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Deliberately on the guard's denylist (`FORBIDDEN_NAMES` /
 * `FORBIDDEN_EMAIL_PATTERN`). If a fixture commit ever escapes again, the
 * pre-push hook blocks it instead of attributing it to a human.
 */
export const FIXTURE_AUTHOR = { name: 'Test User', email: 'test@example.com' } as const;

/**
 * A process env with every GIT_* variable stripped and repo discovery pinned
 * below the temp dir. Pass this to every spawn of the git binary.
 */
export function gitSandboxEnv(
  ceilingDir: string = os.tmpdir(),
  /**
   * simple-git refuses to run when GIT_CONFIG_GLOBAL/SYSTEM are forwarded
   * (`allowUnsafeConfigPaths`), so its callers opt out. Stripping GIT_* and
   * asserting the toplevel are the load-bearing protections; the config-path
   * pins are defense in depth against a global identity leaking in.
   */
  { pinConfigPaths = true }: { pinConfigPaths?: boolean } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  // A test must never launch an interactive editor (it would hang the suite),
  // pager, askpass helper, or visual tool. simple-git also rejects these
  // inherited variables unless callers enable unsafe flags, which sandboxed
  // fixtures should not. JetBrains IDEs export SSH_ASKPASS separately from the
  // GIT_* namespace when running hooks.
  delete env.EDITOR;
  delete env.PAGER;
  delete env.SSH_ASKPASS;
  delete env.VISUAL;
  if (pinConfigPaths) {
    // A path that does not exist reads as an empty config, so the developer's
    // global identity, signing key, and core.hooksPath cannot apply.
    const missingConfig = path.join(os.tmpdir(), 'nimbalyst-absent-gitconfig');
    env.GIT_CONFIG_GLOBAL = missingConfig;
    env.GIT_CONFIG_SYSTEM = missingConfig;
  }
  // Stop upward repo discovery from ever reaching the enclosing checkout.
  env.GIT_CEILING_DIRECTORIES = fs.realpathSync(ceilingDir);
  return env;
}

/**
 * Throw unless git resolves `repo` to itself. Call before any mutating command:
 * a hijacked resolution is only observable at the moment git actually runs.
 */
export function assertGitSandbox(repo: string, ceilingDir?: string): void {
  const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: repo,
    encoding: 'utf8',
    env: gitSandboxEnv(ceilingDir),
  }).trim();
  if (fs.realpathSync(toplevel) !== fs.realpathSync(repo)) {
    throw new Error(
      `[gitTestSandbox] git resolved "${toplevel}" instead of the scratch repo "${repo}" — ` +
      'refusing to run a mutating git command outside the sandbox.',
    );
  }
}

export interface ScratchRepoOptions {
  /** First branch name. Default `main`. */
  initialBranch?: string;
  /** Make the repo in this existing folder. The caller's own cleanup removes it. */
  at?: string;
}

export interface ScratchRepo {
  /** Real path (macOS `/var` resolved to `/private/var`). */
  path: string;
  /** The sandbox env the fixture's own git calls use. */
  env: NodeJS.ProcessEnv;
  /** Run git in `path` and return its output. Throws on a non-zero exit. */
  git(...args: string[]): string;
  /** Delete the temp folder. Does nothing when `at` was given. */
  cleanup(): void;
}

/**
 * A fresh `git init` repo with no commits. Its repo-local config pins the
 * identity, turns signing off, and blanks the hook path and global ignore list.
 * Repo-local config outranks the developer's global config, so these values
 * also hold for git calls the code under test makes with the inherited
 * `process.env`, which this fixture cannot sandbox.
 */
export function createScratchRepo(options: ScratchRepoOptions = {}): ScratchRepo {
  const tempRoot = process.env.NIMBALYST_TEST_TEMP_DIR ?? os.tmpdir();
  fs.mkdirSync(tempRoot, { recursive: true });
  const repoPath = fs.realpathSync(
    options.at ?? fs.mkdtempSync(path.join(tempRoot, 'nimbalyst-scratch-repo-')),
  );
  const env = gitSandboxEnv(tempRoot);
  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: repoPath, env, encoding: 'utf8' });

  run(['init', '-q', '-b', options.initialBranch ?? 'main']);
  for (const [key, value] of [
    ['user.name', FIXTURE_AUTHOR.name],
    ['user.email', FIXTURE_AUTHOR.email],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
    ['core.hooksPath', path.join(repoPath, '.git', 'hooks')],
    ['core.excludesFile', ''],
  ]) {
    run(['config', key, value]);
  }

  return {
    path: repoPath,
    env,
    git: (...args) => {
      assertGitSandbox(repoPath, tempRoot);
      return run(args);
    },
    cleanup: () => {
      if (!options.at) fs.rmSync(repoPath, { recursive: true, force: true });
    },
  };
}
