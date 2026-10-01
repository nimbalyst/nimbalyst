// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import simpleGit from 'simple-git';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GitWorktreeService, WorkspaceHasNoCommitsError } from '../GitWorktreeService';
import { assertGitSandbox, gitSandboxEnv } from '../testSupport/gitTestSandbox';
import {
  isWorktreePathInside,
  parseWorktreePorcelain,
  planWorktreeCreateRollback,
  planWorktreeRemoval,
  readWorktreeGitLink,
  worktreePathKey,
  WorktreeRemovalRefusedError,
} from '../worktreeOwnership';
import { removeDirectoryTree } from '../directoryRemoval';

// createWorktree/deleteWorktree record each command in the persisted git
// activity log, which is bookkeeping these tests do not exercise.
vi.mock('../GitOperationLogService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../GitOperationLogService')>()),
  getGitOperationLogService: () => ({}),
  recordGitActivity: (_service: unknown, _workspacePath: string, _args: string[], operation: () => Promise<unknown>) =>
    operation(),
}));

// Every removal still deletes for real; the spy shows which delete ran. In
// Electron's main process `fs.promises.rm` never settles on a tree holding an
// `.asar` file, which a plain Node test run cannot show.
vi.mock('../directoryRemoval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../directoryRemoval')>();
  return { ...actual, removeDirectoryTree: vi.fn(actual.removeDirectoryTree) };
});

const fixtureGit = (dir: string) => simpleGit(dir).env(gitSandboxEnv(undefined, { pinConfigPaths: false }));

/** A repository with one commit, created through the sandboxed env. */
async function initRepo(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const git = fixtureGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  await git.addConfig('user.name', 'Test', false, 'local');
  await git.addConfig('commit.gpgsign', 'false', false, 'local');
  assertGitSandbox(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi');
  await git.add('README.md');
  await git.commit('initial');
}

describe('gitSandboxEnv', () => {
  it('strips IDE-provided SSH_ASKPASS before simple-git runs a fixture command', async () => {
    const previousAskPass = process.env.SSH_ASKPASS;
    process.env.SSH_ASKPASS = '/mock/ide/askpass';
    try {
      const sandboxEnv = gitSandboxEnv(undefined, { pinConfigPaths: false });
      expect(sandboxEnv.SSH_ASKPASS).toBeUndefined();
      await expect(simpleGit(os.tmpdir()).env(sandboxEnv).raw(['--version'])).resolves.toMatch(/^git version /);
    } finally {
      if (previousAskPass === undefined) delete process.env.SSH_ASKPASS;
      else process.env.SSH_ASKPASS = previousAskPass;
    }
  });
});

/**
 * Regression coverage for the empty-repo silent-failure case: when a Blitz
 * is run against a `git init`-ed-but-never-committed workspace, the worktree
 * service used to throw the raw "fatal: ambiguous argument 'HEAD'" stderr and
 * the renderer dismissed the dialog as if the call succeeded. The service now
 * pre-flights with `git rev-parse --verify HEAD` and throws a typed error.
 */
describe('GitWorktreeService.validateWorkspaceHasCommits', () => {
  let tmpDir: string;
  const service = new GitWorktreeService();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-gws-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore Windows file-lock noise during teardown
    }
  });

  it('throws WorkspaceHasNoCommitsError for a `git init`-ed repo with no commits', async () => {
    // Never let a pre-push hook's GIT_DIR redirect this mutating init into the
    // developer's shared repository.
    const git = simpleGit(tmpDir).env(gitSandboxEnv(undefined, { pinConfigPaths: false }));
    await git.init();

    await expect(service.validateWorkspaceHasCommits(tmpDir))
      .rejects
      .toBeInstanceOf(WorkspaceHasNoCommitsError);
  });

  it('resolves cleanly when the repo has at least one commit', async () => {
    // .env() strips GIT_* — without it a hook-inherited GIT_DIR redirects this
    // commit onto the developer's live branch. See testSupport/gitTestSandbox.ts.
    const git = simpleGit(tmpDir).env(gitSandboxEnv(undefined, { pinConfigPaths: false }));
    await git.init();
    await git.addConfig('user.email', 'test@example.com', false, 'local');
    await git.addConfig('user.name', 'Test', false, 'local');
    await git.addConfig('commit.gpgsign', 'false', false, 'local');
    assertGitSandbox(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'hi');
    await git.add('README.md');
    await git.commit('initial');

    await expect(service.validateWorkspaceHasCommits(tmpDir)).resolves.toBeUndefined();
  });

  it('throws when workspacePath is empty', async () => {
    await expect(service.validateWorkspaceHasCommits(''))
      .rejects
      .toThrow('workspacePath is required');
  });

  it('throws "Not a git repository" for a folder that was never `git init`-ed', async () => {
    // tmpDir exists but has no .git. Differentiates from the empty-repo case
    // so callers can show a remediation message that matches the real cause.
    await expect(service.validateWorkspaceHasCommits(tmpDir))
      .rejects
      .toThrow(/Not a git repository/);
  });
});

/**
 * getChangedFiles goes through simple-git, which runs `git status --porcelain -b
 * -u --null` -- `-u` is `--untracked-files=all`, so ordinary untracked
 * directories are already reported file-by-file and never need re-expanding.
 * The one entry git still collapses is an EMBEDDED REPOSITORY, which it will not
 * look inside. That is the case the expansion handles, now batched into a single
 * async git call for the whole worktree instead of a synchronous child process
 * per entry (NIM-2286).
 *
 * Either way git stays the authority on directory contents, so gitignored files
 * stay out of the changed-files list and the "Commit with AI" context (NIM-1782).
 */
describe('GitWorktreeService.getChangedFiles untracked-directory expansion', () => {
  let tmpDir: string;
  const service = new GitWorktreeService();

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-gws-changed-'));
    const git = simpleGit(tmpDir).env(gitSandboxEnv(undefined, { pinConfigPaths: false }));
    await git.init();
    await git.addConfig('user.email', 'test@example.com', false, 'local');
    await git.addConfig('user.name', 'Test', false, 'local');
    await git.addConfig('commit.gpgsign', 'false', false, 'local');
    assertGitSandbox(tmpDir);

    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n');
    await git.add('.gitignore');
    await git.commit('initial');

    // Three collapsed `?? dir/` entries, one holding a gitignored install.
    for (const name of ['pkg-a', 'pkg-b', 'pkg-c']) {
      fs.mkdirSync(path.join(tmpDir, name, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, name, 'src', 'index.ts'), 'export {};\n');
    }
    fs.writeFileSync(path.join(tmpDir, 'pkg-a', 'src', 'with spaces.ts'), 'export {};\n');
    fs.mkdirSync(path.join(tmpDir, 'pkg-b', 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'pkg-b', 'node_modules', 'left-pad', 'index.js'),
      'module.exports = () => {};\n',
    );

    // An embedded repository: the one untracked entry git still collapses, and
    // whose contents belong to IT rather than to the outer worktree.
    const embedded = path.join(tmpDir, 'embedded-repo');
    fs.mkdirSync(embedded);
    const embeddedGit = simpleGit(embedded).env(gitSandboxEnv(undefined, { pinConfigPaths: false }));
    await embeddedGit.init();
    await embeddedGit.addConfig('user.email', 'test@example.com', false, 'local');
    await embeddedGit.addConfig('user.name', 'Test', false, 'local');
    await embeddedGit.addConfig('commit.gpgsign', 'false', false, 'local');
    fs.writeFileSync(path.join(embedded, 'inner.ts'), 'export {};\n');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore Windows file-lock noise during teardown
    }
  });

  it('reports untracked files individually and keeps gitignored ones out', async () => {
    const changed = await service.getChangedFiles(tmpDir);
    const paths = changed.map((file) => file.path).sort();

    expect(paths).toContain('pkg-a/src/index.ts');
    expect(paths).toContain('pkg-b/src/index.ts');
    expect(paths).toContain('pkg-c/src/index.ts');
    // NUL-separated parsing keeps filenames with spaces intact.
    expect(paths).toContain('pkg-a/src/with spaces.ts');

    // Gitignored, so it must not reach the commit context (NIM-1782).
    expect(paths.filter((p) => p.includes('node_modules'))).toEqual([]);

    // Untracked directories are not reported as entries of their own.
    expect(paths).not.toContain('pkg-a/');
    expect(paths).not.toContain('pkg-a');

    // Every untracked path is reported as a new, unstaged file.
    expect(changed.every((file) => file.status === 'added' && !file.staged)).toBe(true);
  });

  it('still runs when the environment contains vars simple-git treats as unsafe', async () => {
    // The read-only status is spawned with an explicit env (to set
    // GIT_OPTIONAL_LOCKS), which makes simple-git scan that env and refuse to
    // spawn git at all unless the unsafe flags are opted into. A developer with
    // GIT_EDITOR exported would otherwise see every changed-files read fail.
    const previousEditor = process.env.GIT_EDITOR;
    process.env.GIT_EDITOR = 'vim';
    try {
      const paths = (await service.getChangedFiles(tmpDir)).map((file) => file.path);
      expect(paths).toContain('pkg-a/src/index.ts');
    } finally {
      if (previousEditor === undefined) delete process.env.GIT_EDITOR;
      else process.env.GIT_EDITOR = previousEditor;
    }
  });

  it('keeps an embedded repository as one entry without enumerating its contents', async () => {
    const paths = (await service.getChangedFiles(tmpDir)).map((file) => file.path);

    // This entry only survives the collapsed-directory branch: git reports
    // `embedded-repo/` and the expansion asks git what is inside, which returns
    // the embedded repo itself rather than descending into it.
    expect(paths).toContain('embedded-repo/');

    // The embedded repo owns its own untracked file; the outer worktree must
    // not claim it.
    expect(paths).not.toContain('embedded-repo/inner.ts');
  });
});

/**
 * A git hook exports GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE, and git honors
 * them over the working directory. Worktree creation and removal must still act
 * on the repository they were given, not on the one the environment names.
 */
describe('GitWorktreeService under an inherited repository-selection env', () => {
  const service = new GitWorktreeService();
  const inheritedKeys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const;
  let root: string;
  let repo: string;
  let decoy: string;
  let previousEnv: Map<string, string | undefined>;

  const snapshot = async (dir: string) => ({
    branches: await fixtureGit(dir).raw(['branch', '--list']),
    worktrees: await fixtureGit(dir).raw(['worktree', 'list', '--porcelain']),
  });

  beforeEach(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-gws-env-')));
    repo = path.join(root, 'repo');
    decoy = path.join(root, 'decoy');
    await initRepo(repo);
    await initRepo(decoy);
    previousEnv = new Map(inheritedKeys.map((key) => [key, process.env[key]]));
  });

  afterEach(() => {
    for (const key of inheritedKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  // A hook may export GIT_DIR alone, which redirects every command to its
  // repository, or together with the work tree and index.
  it.each([
    ['GIT_DIR only', false],
    ['GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE', true],
  ])('creates and deletes the worktree in the requested repository only (%s)', async (_label, withWorkTree) => {
    process.env.GIT_DIR = path.join(decoy, '.git');
    if (withWorkTree) {
      process.env.GIT_WORK_TREE = decoy;
      process.env.GIT_INDEX_FILE = path.join(decoy, '.git', 'index');
    }
    const decoyBefore = await snapshot(decoy);

    const worktree = await service.createWorktree(repo, { name: 'env-check' });
    expect(path.dirname(worktree.path)).toBe(path.join(root, 'repo_worktrees'));
    expect(await fixtureGit(repo).raw(['branch', '--list', worktree.branch])).toContain(worktree.branch);
    expect(await snapshot(decoy)).toEqual(decoyBefore);

    await service.deleteWorktree(worktree.path, repo);
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(await fixtureGit(repo).raw(['branch', '--list', worktree.branch])).toBe('');
    expect(await snapshot(decoy)).toEqual(decoyBefore);
  });
});

/**
 * A name the user typed becomes the branch exactly (`worktree/feat/x`) in a
 * one-segment folder (`feat-x`); suggested and generated names keep folder and
 * branch on the final `-N` name. A failed creation leaves nothing it created.
 */
describe('GitWorktreeService.createWorktree naming and rollback', () => {
  const service = new GitWorktreeService();
  let root: string;
  let repo: string;
  let worktreesDir: string;

  const localBranches = async (dir: string) =>
    (await fixtureGit(dir).raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean);
  const registeredPaths = async (dir: string) =>
    parseWorktreePorcelain(await fixtureGit(dir).raw(['worktree', 'list', '--porcelain'])).map((entry) => entry.path);

  beforeEach(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-gws-create-')));
    repo = path.join(root, 'repo');
    worktreesDir = path.join(root, 'repo_worktrees');
    await initRepo(repo);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Installs a hook in the repository; a global core.hooksPath would otherwise hide it */
  const installHook = (name: string, script: string) => {
    const hooksDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    // simple-git refuses to set core.hooksPath, so plain git sets it
    assertGitSandbox(repo);
    execFileSync('git', ['config', 'core.hooksPath', hooksDir], {
      cwd: repo,
      env: gitSandboxEnv(undefined, { pinConfigPaths: false }),
    });
  };

  it('creates a typed name as one folder on exactly that branch, numbering only the folder', async () => {
    const typed = await service.createWorktree(repo, { branchSuffix: 'feat/x' });
    // `worktree/feat-x` is another branch, but the folder `feat-x` is taken
    const sibling = await service.createWorktree(repo, { branchSuffix: 'feat-x' });

    expect(typed).toMatchObject({ name: 'feat-x', path: path.join(worktreesDir, 'feat-x'), branch: 'worktree/feat/x' });
    expect(sibling).toMatchObject({ name: 'feat-x-1', path: path.join(worktreesDir, 'feat-x-1'), branch: 'worktree/feat-x' });
    expect(fs.readdirSync(worktreesDir).sort()).toEqual(['feat-x', 'feat-x-1']);
    expect((await fixtureGit(typed.path).raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('worktree/feat/x');
  });

  // Git refuses a branch at, above or below an existing one before it creates
  // anything; the check names the conflict instead of git's raw error, and a
  // typed name is never renamed around it. Where git reports core.ignorecase,
  // a branch differing only in case conflicts too, which git itself would
  // create on a case-sensitive disk.
  it.each([
    ['the same branch', 'worktree/feat/x', false],
    ['a branch at its parent', 'worktree/feat', false],
    ['a branch below it', 'worktree/feat/x/y', false],
    ['a bare worktree branch', 'worktree', false],
    ['a branch differing only in case where git ignores case', 'worktree/Feat/X', true],
  ])('refuses a typed name whose branch conflicts with %s, creating no folder and no branch', async (_label, existing, ignoreCase) => {
    assertGitSandbox(repo);
    if (ignoreCase) await fixtureGit(repo).addConfig('core.ignorecase', 'true', false, 'local');
    await fixtureGit(repo).raw(['branch', existing]);
    const branchesBefore = await localBranches(repo);

    const outcome = await service.createWorktree(repo, { branchSuffix: 'feat/x' }).catch((error: Error) => error);

    expect(await localBranches(repo)).toEqual(branchesBefore);
    expect(await registeredPaths(repo)).toEqual([repo]);
    expect(fs.existsSync(path.join(worktreesDir, 'feat-x'))).toBe(false);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(`'${existing}' already exists in ${repo}`);
  });

  // `worktree add` leaves the registration and the branch when the hook
  // fails, and used to have only its folder removed.
  it.each([
    ['a suggested name', { name: 'hooked' }],
    ['a typed name', { branchSuffix: 'hooked/x' }],
  ])('removes the folder, registration and branch a failing post-checkout hook leaves (%s)', async (_label, options) => {
    installHook('post-checkout', 'exit 3');
    const branchesBefore = await localBranches(repo);

    const outcome = await service.createWorktree(repo, options).catch((error: Error) => error);

    expect(await localBranches(repo)).toEqual(branchesBefore);
    expect(await registeredPaths(repo)).toEqual([repo]);
    expect(fs.readdirSync(worktreesDir)).toEqual([]);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/^Failed to create worktree: /);
  });

  // `git branch <new> <base>` reads a base starting with '-' as an option:
  // `-m` renames the repository's checked-out branch to the new name, which
  // no rollback can undo, since the renamed branch is checked out there.
  it.each(['-m', '--force'])('refuses the base %s before git can read it as an option', async (baseBranch) => {
    const outcome = await service.createWorktree(repo, { name: 'opt', baseBranch }).catch((error: Error) => error);

    expect(await localBranches(repo)).toEqual(['main']);
    expect((await fixtureGit(repo).raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('main');
    expect(fs.existsSync(path.join(worktreesDir, 'opt'))).toBe(false);
    expect((outcome as Error).message).toBe(`Invalid base branch '${baseBranch}': a branch name cannot start with '-'`);
  });

  // A worktree on an unmounted drive: git still registers its missing folder
  // and would create the new branch before refusing the path, leaving the
  // branch behind. The folder counts as taken instead.
  it.each([
    ['a suggested name', { name: 'offline' }, 'worktree/offline-1'],
    ['a typed name', { branchSuffix: 'offline' }, 'worktree/offline'],
  ])('numbers past a folder git still registers though it is missing (%s)', async (_label, options, branch) => {
    const target = path.join(worktreesDir, 'offline');
    assertGitSandbox(repo);
    await fixtureGit(repo).raw(['worktree', 'add', '-b', 'feature/offline', target]);
    fs.renameSync(target, path.join(root, 'unmounted'));

    const created = await service.createWorktree(repo, options);

    expect(created).toMatchObject({ name: 'offline-1', path: path.join(worktreesDir, 'offline-1'), branch });
    expect(await registeredPaths(repo)).toEqual([repo, target, created.path]);
  });

  // An archived worktree's folder, registration and branch are gone, but its
  // row keeps the path and the store refuses a second row with it. A name used
  // again after an archive (typed again, or a tracker item re-launched) moves
  // on to the next folder.
  it.each([
    ['a suggested name', { name: 'shelved' }, 'worktree/shelved-1'],
    ['a typed name', { branchSuffix: 'shelved' }, 'worktree/shelved'],
  ])('numbers past a folder an archived worktree still records (%s)', async (_label, options, branch) => {
    const recorded = path.join(worktreesDir, 'shelved');

    const created = await service.createWorktree(repo, { ...options, takenPaths: [recorded] });

    expect(created).toMatchObject({ name: 'shelved-1', path: path.join(worktreesDir, 'shelved-1'), branch });
    expect(fs.existsSync(recorded)).toBe(false);
    expect(await localBranches(repo)).toEqual(['main', branch]);
  });

  // Another app or a terminal can act between the checks and `worktree add`;
  // the repository lock holds off only this process. The hook stands in for
  // it: once the attempt has made its branch, it registers someone else's
  // worktree at the target, which a rollback must not remove.
  it('leaves a worktree someone else registers at the target meanwhile, deleting only its own new branch', async () => {
    const target = path.join(worktreesDir, 'race');
    const marker = path.join(root, 'raced');
    installHook('reference-transaction', [
      '[ "$1" = committed ] || exit 0',
      "grep -q ' refs/heads/worktree/race$' || exit 0",
      `[ -e '${marker}' ] && exit 0`,
      `touch '${marker}'`,
      'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
      `git -C '${repo}' worktree add -q -b theirs '${target}' main`,
      `echo work > '${target}/precious.txt'`,
    ].join('\n'));

    const outcome = await service.createWorktree(repo, { name: 'race' }).catch((error: Error) => error);

    expect((outcome as Error).message).toContain('already exists');
    expect(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8')).toBe('work\n');
    expect(await registeredPaths(repo)).toEqual([repo, target]);
    expect(await localBranches(repo)).toEqual(['main', 'theirs']);
  });

  it('leaves a registration a hook locked, with its branch, and names both in the error', async () => {
    installHook('post-checkout', 'git worktree lock --reason test "$PWD"\nexit 3');
    const target = path.join(worktreesDir, 'lk');

    const outcome = await service.createWorktree(repo, { name: 'lk' }).catch((error: Error) => error);

    expect(await registeredPaths(repo)).toEqual([repo, target]);
    expect(await localBranches(repo)).toEqual(['main', 'worktree/lk']);
    expect(fs.existsSync(path.join(target, 'README.md'))).toBe(true);
    expect((outcome as Error).message).toContain(`a worktree registered at ${target} and the branch 'worktree/lk'`);
  });

  it('names what the rollback tried when git cannot be asked what it left', async () => {
    installHook('post-checkout', 'exit 3');
    const target = path.join(worktreesDir, 'unread');
    const internals = service as unknown as {
      readCreateOutcome: (...args: unknown[]) => Promise<unknown>;
    };
    const readOutcome = internals.readCreateOutcome.bind(service);
    let reads = 0;
    // The first read plans the rollback and the second follows the
    // unregister; the last one, after every step, fails
    const spy = vi.spyOn(internals, 'readCreateOutcome').mockImplementation(async (...args) =>
      (++reads >= 3 ? null : readOutcome(...args)));
    let outcome: unknown;
    try {
      outcome = await service.createWorktree(repo, { name: 'unread' }).catch((error: Error) => error);
    } finally {
      spy.mockRestore();
    }

    expect(await localBranches(repo)).toEqual(['main']);
    expect(await registeredPaths(repo)).toEqual([repo]);
    expect((outcome as Error).message).toContain(
      `Git could not be asked what the failed attempt left at ${target} after unregistering the worktree there ` +
      "and deleting the branch 'worktree/unread'; they may not all have taken effect."
    );
  });

  it('keeps folder and branch on the final -N name for suggested and generated names', async () => {
    // A PR review opened twice relies on this
    await service.createWorktree(repo, { name: 'pr-12' });
    const again = await service.createWorktree(repo, { name: 'pr-12' });
    const generated = await service.createWorktree(repo);

    expect(again).toMatchObject({ name: 'pr-12-1', path: path.join(worktreesDir, 'pr-12-1'), branch: 'worktree/pr-12-1' });
    expect(generated.name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(generated).toMatchObject({
      path: path.join(worktreesDir, generated.name),
      branch: `worktree/${generated.name}`,
    });
  });
});

/**
 * deleteWorktree removes a directory, a registration and a branch, so it first
 * asks the repository it was given whether the directory is one of its
 * worktrees: git must list it, and its `.git` file must point back into the
 * repository. Git lists worktrees by their real paths, so the stored path is
 * compared with symlinks resolved.
 */
describe('GitWorktreeService.deleteWorktree ownership', () => {
  const service = new GitWorktreeService();
  let root: string;
  let repo: string;

  const hasBranch = async (dir: string, branch: string) =>
    (await fixtureGit(dir).raw(['branch', '--list', branch])).trim() !== '';
  const registrations = (dir: string) => fixtureGit(dir).raw(['worktree', 'list', '--porcelain']);

  beforeEach(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-gws-delete-')));
    repo = path.join(root, 'repo');
    await initRepo(repo);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses a worktree of another repository, leaving it and the same-named branch here untouched', async () => {
    // An attached folder's worktree removed through the workspace's primary
    // repository. That repository does not know the directory, and the old
    // fallback deleted it anyway, then ran `branch -D` on the primary's branch
    // of the same name.
    const other = path.join(root, 'other');
    await initRepo(other);
    const worktree = await service.createWorktree(other, { name: 'shared' });
    fs.writeFileSync(path.join(worktree.path, 'work.txt'), 'uncommitted');
    assertGitSandbox(repo);
    await fixtureGit(repo).raw(['branch', worktree.branch]);

    const refusal = service.deleteWorktree(worktree.path, repo, { expectedBranch: worktree.branch });
    await expect(refusal).rejects.toThrow(`it is a worktree of ${other}`);
    // A caller restores what it hid before the removal only for a refusal
    await expect(refusal).rejects.toBeInstanceOf(WorktreeRemovalRefusedError);

    expect(fs.readFileSync(path.join(worktree.path, 'work.txt'), 'utf8')).toBe('uncommitted');
    expect(await hasBranch(repo, worktree.branch)).toBe(true);
    expect(await hasBranch(other, worktree.branch)).toBe(true);
    expect(await registrations(other)).toContain(worktree.path);
  });

  // A checkout deleted without a prune leaves its registration, and the path
  // can then hold something else. Git refuses to remove it and `prune` keeps
  // the entry, so the old fallback deleted the newcomer.
  it.each([
    ['another repository\'s worktree', async (dir: string, other: string) => {
      assertGitSandbox(other);
      await fixtureGit(other).raw(['worktree', 'add', '-b', 'feature/user-work', dir]);
    }],
    ['a repository of its own', async (dir: string) => {
      await initRepo(dir);
    }],
  ])('refuses a registered path that now holds %s', async (_label, occupy) => {
    const other = path.join(root, 'other');
    await initRepo(other);
    const worktree = await service.createWorktree(repo, { name: 'reused' });
    fs.rmSync(worktree.path, { recursive: true, force: true });
    await occupy(worktree.path, other);
    fs.writeFileSync(path.join(worktree.path, 'work.txt'), 'uncommitted');

    await expect(service.deleteWorktree(worktree.path, repo, { expectedBranch: worktree.branch }))
      .rejects.toThrow(/nothing was deleted/);

    expect(fs.readFileSync(path.join(worktree.path, 'work.txt'), 'utf8')).toBe('uncommitted');
    expect(await hasBranch(repo, worktree.branch)).toBe(true);
    expect(await registrations(repo)).toContain(worktree.path);
  });

  it('removes a worktree with unmerged commits, untracked and ignored files, and deletes its branch', async () => {
    // The everyday archive. The branch goes with `branch -D`, so its commits
    // need not be merged.
    const worktree = await service.createWorktree(repo, { name: 'everyday' });
    assertGitSandbox(worktree.path);
    fs.writeFileSync(path.join(worktree.path, 'feature.txt'), 'work');
    await fixtureGit(worktree.path).add('feature.txt');
    await fixtureGit(worktree.path).commit('unmerged work');
    fs.writeFileSync(path.join(worktree.path, 'untracked.txt'), 'scratch');
    fs.writeFileSync(path.join(worktree.path, '.gitignore'), 'node_modules/\n');
    fs.mkdirSync(path.join(worktree.path, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(worktree.path, 'node_modules', 'x', 'i.js'), 'ignored');
    vi.mocked(removeDirectoryTree).mockClear();

    await service.deleteWorktree(worktree.path, repo, { expectedBranch: worktree.branch });

    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(await registrations(repo)).not.toContain(worktree.path);
    expect(await hasBranch(repo, worktree.branch)).toBe(false);
    expect(removeDirectoryTree).toHaveBeenCalledWith(worktree.path);
  });

  it('unregisters a worktree whose directory is gone and deletes its merged branch', async () => {
    const worktree = await service.createWorktree(repo, { name: 'gone' });
    fs.rmSync(worktree.path, { recursive: true, force: true });

    await service.deleteWorktree(worktree.path, repo, { expectedBranch: worktree.branch });

    expect(await registrations(repo)).not.toContain(worktree.path);
    expect(await hasBranch(repo, worktree.branch)).toBe(false);
  });

  it('keeps the unmerged branch of a worktree whose directory is gone, as a checkout moved by hand still uses it', async () => {
    const worktree = await service.createWorktree(repo, { name: 'moved' });
    assertGitSandbox(worktree.path);
    await fixtureGit(worktree.path).raw(['commit', '--allow-empty', '-m', 'unmerged work']);
    fs.renameSync(worktree.path, path.join(root, 'moved'));

    await service.deleteWorktree(worktree.path, repo, { expectedBranch: worktree.branch });

    expect(await registrations(repo)).not.toContain(worktree.path);
    expect(await hasBranch(repo, worktree.branch)).toBe(true);
  });

  it('treats a worktree that is gone and already pruned as removed, and keeps its branch', async () => {
    // Nothing left in the repository ties the branch to this worktree any
    // more, and it may hold the only copy of unmerged work.
    const worktree = await service.createWorktree(repo, { name: 'pruned' });
    fs.rmSync(worktree.path, { recursive: true, force: true });
    assertGitSandbox(repo);
    await fixtureGit(repo).raw(['worktree', 'prune']);

    await expect(service.deleteWorktree(worktree.path, repo, { expectedBranch: worktree.branch }))
      .resolves.toBeUndefined();

    expect(await hasBranch(repo, worktree.branch)).toBe(true);
  });

  it('finishes a removal interrupted after the .git file was deleted, unregistering only that worktree', async () => {
    // The directory is deleted first, then only this entry is unregistered.
    // A sibling whose drive is unmounted for now keeps its registration,
    // which a repository-wide `worktree prune` would drop for good.
    const worktree = await service.createWorktree(repo, { name: 'partial' });
    const offline = await service.createWorktree(repo, { name: 'offline' });
    fs.renameSync(offline.path, path.join(root, 'unmounted'));
    fs.rmSync(path.join(worktree.path, '.git'));

    await service.deleteWorktree(worktree.path, repo, { expectedBranch: worktree.branch });

    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(await registrations(repo)).not.toContain(worktree.path);
    expect(await registrations(repo)).toContain(offline.path);
    expect(await hasBranch(repo, worktree.branch)).toBe(false);
  });

  // A file held open (Windows) or a directory without write permission stops
  // the delete part way. `git worktree remove` drops the registration even
  // then, which left a folder the next attempt could not tell from anyone's.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'finishes on a second attempt a removal that could not delete every file the first time',
    async () => {
      const worktree = await service.createWorktree(repo, { name: 'held' });
      const held = path.join(worktree.path, 'node_modules', 'pkg');
      fs.mkdirSync(held, { recursive: true });
      fs.writeFileSync(path.join(held, 'index.js'), 'x');
      fs.chmodSync(held, 0o555);
      try {
        await expect(service.deleteWorktree(worktree.path, repo, { expectedBranch: worktree.branch }))
          .rejects.toThrow(/still exists/);
        // Still registered, whichever files went first, so the next attempt
        // does not depend on the `.git` file having survived
        expect(await registrations(repo)).toContain(worktree.path);
      } finally {
        fs.chmodSync(held, 0o755);
      }

      await service.deleteWorktree(worktree.path, repo, { expectedBranch: worktree.branch });

      expect(fs.existsSync(worktree.path)).toBe(false);
      expect(await registrations(repo)).not.toContain(worktree.path);
      expect(await hasBranch(repo, worktree.branch)).toBe(false);
    },
  );

  // Git no longer tracks such a checkout and cannot check it for changes.
  it.each([
    // What `git worktree remove` that failed part way, or a prune while the
    // checkout was offline, leaves: its `.git` file points into this
    // repository's worktrees area, at an admin dir that no longer exists.
    ['git already deleted its admin dir', async (adminDir: string) => {
      fs.rmSync(adminDir, { recursive: true, force: true });
    }],
    // The same shape after a re-clone, where the folder holds the only copy
    // of its commits and the new repository has no such branch
    ['the repository was created again at its path', async () => {
      fs.rmSync(repo, { recursive: true, force: true });
      await initRepo(repo);
    }],
  ])('refuses a checkout git no longer tracks, where %s', async (_label, untrack) => {
    const worktree = await service.createWorktree(repo, { name: 'orphan' });
    assertGitSandbox(worktree.path);
    await fixtureGit(worktree.path).raw(['commit', '--allow-empty', '-m', 'unmerged work']);
    fs.writeFileSync(path.join(worktree.path, 'uncommitted.txt'), 'mine');
    const adminDir = fs.readFileSync(path.join(worktree.path, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim();
    await untrack(adminDir);
    expect(await registrations(repo)).not.toContain(worktree.path);

    const refusal = service.deleteWorktree(worktree.path, repo, { expectedBranch: worktree.branch });
    await expect(refusal).rejects.toThrow(/no longer tracks it.*nothing was deleted.*once nothing is left/);
    await expect(refusal).rejects.not.toThrow(/repair/);

    expect(fs.readFileSync(path.join(worktree.path, 'uncommitted.txt'), 'utf8')).toBe('mine');
    expect(fs.existsSync(path.join(worktree.path, '.git'))).toBe(true);
  });

  it('refuses a copy of a live worktree, without the repair that would take its registration', async () => {
    // `git worktree repair` run in the copy points the live worktree's admin
    // dir at the copy, and archiving the copy afterwards would unregister
    // the live worktree.
    const worktree = await service.createWorktree(repo, { name: 'live' });
    fs.writeFileSync(path.join(worktree.path, 'live.txt'), 'uncommitted');
    const copy = path.join(`${repo}_worktrees`, 'copy');
    fs.cpSync(worktree.path, copy, { recursive: true });

    const refusal = service.deleteWorktree(copy, repo, { expectedBranch: worktree.branch });
    await expect(refusal).rejects.toThrow(`names the worktree that git tracks at ${worktree.path}`);
    await expect(refusal).rejects.not.toThrow(/repair/);

    expect(fs.readFileSync(path.join(copy, 'live.txt'), 'utf8')).toBe('uncommitted');
    expect(await registrations(repo)).toContain(worktree.path);
    expect(await registrations(repo)).not.toContain(copy);
    expect(await hasBranch(repo, worktree.branch)).toBe(true);
  });

  // A hard-linked copy (`cp -al`, snapshot tools) shares the live worktree's
  // `.git` file, and a symlinked `.git` reads through to it. Neither makes
  // the copy the directory git registered, and removing the copy must not
  // unregister and delete the live worktree.
  it.each([
    ['a hard link to', (target: string, link: string) => fs.linkSync(target, link)],
    ...(process.platform === 'win32'
      ? []
      : [['a symlink to', (target: string, link: string) => fs.symlinkSync(target, link)] as const]),
  ] as const)('refuses a checkout whose .git is %s the live worktree\'s, and leaves the live worktree', async (_label, linkGitFile) => {
    const worktree = await service.createWorktree(repo, { name: 'live' });
    assertGitSandbox(worktree.path);
    await fixtureGit(worktree.path).raw(['commit', '--allow-empty', '-m', 'unmerged work']);
    fs.writeFileSync(path.join(worktree.path, 'uncommitted.txt'), 'mine');
    const copy = path.join(`${repo}_worktrees`, 'copy');
    fs.mkdirSync(copy);
    fs.writeFileSync(path.join(copy, 'notes.txt'), 'copy');
    linkGitFile(path.join(worktree.path, '.git'), path.join(copy, '.git'));

    expect(readWorktreeGitLink(copy, path.join(repo, '.git'))).toEqual({ kind: 'copy', livePath: worktree.path });
    await expect(service.deleteWorktree(copy, repo, { expectedBranch: worktree.branch }))
      .rejects.toThrow(`names the worktree that git tracks at ${worktree.path}`);

    expect(fs.readFileSync(path.join(copy, 'notes.txt'), 'utf8')).toBe('copy');
    expect(fs.readFileSync(path.join(worktree.path, 'uncommitted.txt'), 'utf8')).toBe('mine');
    expect(await registrations(repo)).toContain(worktree.path);
    expect(await hasBranch(repo, worktree.branch)).toBe(true);
  });

  it('refuses a worktree that holds another worktree, and leaves both', async () => {
    // An agent working in a worktree can add its own linked worktree inside
    // the checkout (often under a gitignored folder, so the archive dialog
    // sees nothing to warn about). Deleting the outer directory would take
    // the inner one with it, locked or not.
    const outer = await service.createWorktree(repo, { name: 'outer' });
    const nested = path.join(outer.path, '.claude', 'worktrees', 'sub');
    assertGitSandbox(outer.path);
    await fixtureGit(outer.path).raw(['worktree', 'add', '-b', 'agent/sub', nested]);
    fs.writeFileSync(path.join(nested, 'work.txt'), 'uncommitted agent work');

    await expect(service.checkWorktreeRemovable(outer.path, repo, { expectedBranch: outer.branch }))
      .resolves.toMatchObject({ reason: 'contains-worktree' });
    const refusal = service.deleteWorktree(outer.path, repo, { expectedBranch: outer.branch });
    await expect(refusal).rejects.toThrow(`it contains the worktree at ${nested}`);
    await expect(refusal).rejects.toThrow(/`git worktree remove` deletes that one, or `git worktree move`/);

    expect(fs.readFileSync(path.join(nested, 'work.txt'), 'utf8')).toBe('uncommitted agent work');
    expect(fs.existsSync(path.join(outer.path, 'README.md'))).toBe(true);
    expect(await registrations(repo)).toContain(nested);
    expect(await hasBranch(repo, outer.branch)).toBe(true);
    expect(await hasBranch(repo, 'agent/sub')).toBe(true);
  });

  it('answers whether a removal would go ahead, without changing anything', async () => {
    const worktree = await service.createWorktree(repo, { name: 'checked' });
    const locked = await service.createWorktree(repo, { name: 'checked-locked' });
    assertGitSandbox(repo);
    await fixtureGit(repo).raw(['worktree', 'lock', '--reason', 'removable drive', locked.path]);

    await expect(service.checkWorktreeRemovable(worktree.path, repo, { expectedBranch: worktree.branch }))
      .resolves.toBeNull();
    const refusal = await service.checkWorktreeRemovable(locked.path, repo, { expectedBranch: locked.branch });
    expect(refusal).toBeInstanceOf(WorktreeRemovalRefusedError);
    expect(refusal).toMatchObject({ reason: 'locked', message: expect.stringMatching(/removable drive.*unlock/) });

    for (const checked of [worktree, locked]) {
      expect(fs.existsSync(path.join(checked.path, 'README.md'))).toBe(true);
      expect(await registrations(repo)).toContain(checked.path);
      expect(await hasBranch(repo, checked.branch)).toBe(true);
    }
  });

  it('refuses an unregistered folder without a .git file, without suggesting a repair', async () => {
    const folder = path.join(`${repo}_worktrees`, 'leftover');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'mine');

    const refusal = service.deleteWorktree(folder, repo, { expectedBranch: 'worktree/leftover' });
    await expect(refusal).rejects.toThrow(/has no \.git file and git does not list it.*nothing was deleted.*once nothing is left/);
    await expect(refusal).rejects.not.toThrow(/repair/);

    expect(fs.readFileSync(path.join(folder, 'notes.txt'), 'utf8')).toBe('mine');
  });

  it('refuses a locked worktree whose .git file is gone on a git that does not print locks', async () => {
    // Git before 2.31 prints no `locked` line in the porcelain list, so only
    // the admin dir records the lock.
    const worktree = await service.createWorktree(repo, { name: 'old-git-locked' });
    assertGitSandbox(repo);
    await fixtureGit(repo).raw(['worktree', 'lock', '--reason', 'removable drive', worktree.path]);
    fs.rmSync(path.join(worktree.path, '.git'));
    fs.writeFileSync(path.join(worktree.path, 'notes.txt'), 'mine');
    const internals = service as unknown as {
      readWorktreeRegistrations: (git: unknown) => Promise<Array<{ locked: boolean; lockReason?: string }>>;
    };
    const readRegistrations = internals.readWorktreeRegistrations.bind(service);
    const spy = vi.spyOn(internals, 'readWorktreeRegistrations').mockImplementation(async (git) =>
      (await readRegistrations(git)).map(({ lockReason: _reason, ...entry }) => ({ ...entry, locked: false })));
    try {
      await expect(service.deleteWorktree(worktree.path, repo, { expectedBranch: worktree.branch }))
        .rejects.toThrow(/locked \(removable drive\).*nothing was deleted/);
    } finally {
      spy.mockRestore();
    }

    expect(fs.readFileSync(path.join(worktree.path, 'notes.txt'), 'utf8')).toBe('mine');
    expect(await hasBranch(repo, worktree.branch)).toBe(true);
  });

  it('refuses a locked worktree, also after it was moved, and leaves its directory and branch', async () => {
    // `worktree remove --force` refuses a locked worktree, and the old
    // fallback then deleted the directory regardless.
    const worktree = await service.createWorktree(repo, { name: 'locked' });
    assertGitSandbox(repo);
    await fixtureGit(repo).raw(['worktree', 'lock', '--reason', 'on a removable drive', worktree.path]);

    await expect(service.deleteWorktree(worktree.path, repo, { expectedBranch: worktree.branch }))
      .rejects.toThrow(/unlock.*nothing was deleted/);
    expect(fs.existsSync(path.join(worktree.path, 'README.md'))).toBe(true);

    // Moved by hand, it no longer matches its registration, and its `.git`
    // file still points into the repository.
    const moved = path.join(root, 'moved-locked');
    fs.renameSync(worktree.path, moved);
    await expect(service.deleteWorktree(moved, repo, { expectedBranch: worktree.branch }))
      .rejects.toThrow(/git worktree repair/);

    expect(fs.existsSync(path.join(moved, 'README.md'))).toBe(true);
    expect(await hasBranch(repo, worktree.branch)).toBe(true);
  });

  it('reads what a directory\'s .git entry says about its repository', async () => {
    const commonDir = path.join(repo, '.git');
    const worktree = await service.createWorktree(repo, { name: 'linked' });
    assertGitSandbox(repo);
    await fixtureGit(repo).raw(['worktree', 'lock', worktree.path]);
    const other = path.join(root, 'other');
    await initRepo(other);
    const foreign = await service.createWorktree(other, { name: 'foreign' });
    const copy = path.join(root, 'copy');
    fs.cpSync(worktree.path, copy, { recursive: true });
    const away = await service.createWorktree(repo, { name: 'away' });
    const moved = path.join(root, 'moved');
    fs.renameSync(away.path, moved);
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);

    expect(readWorktreeGitLink(worktree.path, commonDir)).toEqual({
      kind: 'this-repository', registeredPath: worktree.path, branch: worktree.branch, locked: true,
    });
    expect(readWorktreeGitLink(copy, commonDir)).toEqual({ kind: 'copy', livePath: worktree.path });
    expect(readWorktreeGitLink(moved, commonDir)).toEqual({ kind: 'moved' });
    expect(readWorktreeGitLink(foreign.path, commonDir)).toEqual({ kind: 'other-repository', owner: other });
    expect(readWorktreeGitLink(other, commonDir)).toEqual({ kind: 'not-linked' });
    expect(readWorktreeGitLink(plain, commonDir)).toEqual({ kind: 'missing' });
  });

  it('reads no branch from an admin dir HEAD that is a reftable stub', async () => {
    // On the reftable ref format git keeps a linked worktree's HEAD in
    // `<admin>/reftable` and writes this stub to `<admin>/HEAD`. Git 2.45+
    // can create such a repository; the stub is written here by hand.
    const worktree = await service.createWorktree(repo, { name: 'reftable' });
    const commonDir = path.join(repo, '.git');
    const adminDir = path.resolve(
      worktree.path,
      fs.readFileSync(path.join(worktree.path, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim()
    );
    fs.writeFileSync(path.join(adminDir, 'HEAD'), 'ref: refs/heads/.invalid\n');

    expect(readWorktreeGitLink(worktree.path, commonDir)).toEqual({
      kind: 'this-repository', registeredPath: worktree.path, branch: null, locked: false,
    });
  });

  it('follows relative .git pointers on disk, as git does, when a symlinked parent sits at another depth', async () => {
    // Relative worktree paths (git 2.48+) are computed between real paths, so
    // `..` must be applied to the real directory, not to the spelling passed in.
    const home = path.join(root, 'home');
    const homeRepo = path.join(home, 'repo');
    await initRepo(homeRepo);
    const deep = path.join(root, 'mnt', 'a', 'b', 'big');
    fs.mkdirSync(deep, { recursive: true });
    fs.symlinkSync(deep, path.join(home, 'repo_worktrees'), 'junction');
    const realDir = path.join(deep, 'z');
    assertGitSandbox(homeRepo);
    await fixtureGit(homeRepo).raw(['worktree', 'add', '-b', 'worktree/z', realDir]);
    const adminDir = path.join(homeRepo, '.git', 'worktrees', 'z');
    fs.writeFileSync(path.join(realDir, '.git'), `gitdir: ${path.relative(realDir, adminDir)}\n`);
    fs.writeFileSync(path.join(adminDir, 'gitdir'), `${path.relative(adminDir, path.join(realDir, '.git'))}\n`);

    expect(readWorktreeGitLink(path.join(home, 'repo_worktrees', 'z'), path.join(homeRepo, '.git'))).toMatchObject({
      kind: 'this-repository', branch: 'worktree/z',
    });
  });

  // The stored path goes through the link; git lists the real one. A checkout
  // that is already gone resolves through its nearest existing ancestor.
  it.each([
    ['still on disk', false],
    ['already gone', true],
  ])('removes a worktree created through a symlinked path (%s)', async (_label, removedFirst) => {
    const realRepo = path.join(root, 'real', 'repo');
    await initRepo(realRepo);
    const link = path.join(root, 'link');
    fs.symlinkSync(path.join(root, 'real'), link, 'junction');
    const linkedRepo = path.join(link, 'repo');
    const worktree = await service.createWorktree(linkedRepo, { name: 'via-link' });
    expect(worktree.path).toBe(path.join(link, 'repo_worktrees', 'via-link'));
    if (removedFirst) fs.rmSync(worktree.path, { recursive: true, force: true });

    await service.deleteWorktree(worktree.path, linkedRepo, { expectedBranch: worktree.branch });

    expect(fs.existsSync(path.join(root, 'real', 'repo_worktrees', 'via-link'))).toBe(false);
    expect(await registrations(realRepo)).not.toContain('via-link');
    expect(await hasBranch(realRepo, worktree.branch)).toBe(false);
  });
});

describe('worktree ownership decisions', () => {
  it('compares win32 paths regardless of separators, trailing separators and case', () => {
    const key = (p: string) => worktreePathKey(p, 'win32');
    expect(key('C:\\Users\\Dev\\proj_worktrees\\Swift-Falcon\\')).toBe(key('c:/users/dev/PROJ_worktrees/swift-falcon'));
    expect(isWorktreePathInside(key('C:\\Proj\\.git\\worktrees\\x'), key('c:/proj/.git/worktrees'))).toBe(true);
    expect(isWorktreePathInside(key('C:\\Proj\\.git\\worktrees-old\\x'), key('c:/proj/.git/worktrees'))).toBe(false);
    // Elsewhere two directories differing only in case are distinct.
    expect(worktreePathKey('/home/dev/Proj', 'linux')).not.toBe(worktreePathKey('/home/dev/proj', 'linux'));
  });

  it('parses the porcelain list with -z, where a field may hold a newline', () => {
    const output = [
      'worktree /r', 'HEAD 1', 'branch refs/heads/main', '',
      'worktree /w/new\nline', 'HEAD 2', 'branch refs/heads/worktree/x', 'locked two\nlines', '',
      'worktree /w/d', 'HEAD 3', 'detached', 'prunable gitdir file points to non-existent location', '',
    ].join('\0');
    expect(parseWorktreePorcelain(output)).toEqual([
      { path: '/r', branch: 'main', locked: false, isMain: true },
      { path: '/w/new\nline', branch: 'worktree/x', locked: true, lockReason: 'two\nlines', isMain: false },
      { path: '/w/d', branch: null, locked: false, isMain: false },
    ]);
    expect(parseWorktreePorcelain('worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /w\nHEAD 2\nlocked\n'))
      .toEqual([
        { path: '/r', branch: 'main', locked: false, isMain: true },
        { path: '/w', branch: null, locked: true, isMain: false },
      ]);
  });

  // The real-git cases above cover a foreign directory, a reused path, a
  // missing worktree with and without a registration, and a locked one.
  const registered = { path: '/w/x', branch: 'worktree/x', locked: false, isMain: false };
  const linked = { kind: 'this-repository', registeredPath: '/w/x', branch: 'worktree/x', locked: false } as const;
  const removal = (branch: string | null, forceBranchDelete = true) =>
    ({ action: 'remove', registeredPath: '/w/x', branch, forceBranchDelete });
  it.each([
    ['the main working tree', { registration: { ...registered, branch: 'main', isMain: true }, gitLink: { kind: 'not-linked' } },
      { action: 'refuse', reason: 'main-worktree' }],
    ['a locked worktree whose directory is gone, as on an unmounted drive',
      { existsOnDisk: false, gitLink: null, registration: { ...registered, locked: true } },
      { action: 'refuse', reason: 'locked' }],
    ['a worktree locked in its admin dir that git does not report as locked',
      { gitLink: { ...linked, locked: true } }, { action: 'refuse', reason: 'locked' }],
    ['a directory when the worktree list cannot be read', { registryReadable: false },
      { action: 'refuse', reason: 'unverifiable' }],
    ['a directory whose .git link cannot be checked', { registration: registered, gitLink: null },
      { action: 'refuse', reason: 'unverifiable' }],
    ['a gone directory when the worktree list cannot be read',
      { existsOnDisk: false, registryReadable: false, gitLink: null }, { action: 'already-removed' }],
    ['a gone directory that is still registered', { existsOnDisk: false, gitLink: null, registration: registered },
      removal('worktree/x', false)],
    ['a registered path that now holds another repository\'s worktree',
      { registration: registered, gitLink: { kind: 'other-repository', owner: '/other' } },
      { action: 'refuse', reason: 'not-owned' }],
    ['a checkout whose .git file points into the repository, but not back from it',
      { gitLink: { kind: 'moved' } }, { action: 'refuse', reason: 'moved' }],
    ['a copy of a worktree that git tracks elsewhere',
      { gitLink: { kind: 'copy', livePath: '/w/live' } }, { action: 'refuse', reason: 'copy' }],
    // Its admin dir is shared with any copy of the checkout moved elsewhere
    ['a registered checkout whose .git file is gone', { registration: registered, gitLink: { kind: 'missing' } },
      removal('worktree/x', false)],
    ['a checkout whose admin dir git already deleted', { gitLink: { kind: 'orphaned' } },
      { action: 'refuse', reason: 'untracked' }],
    ['an orphaned checkout at a path git lists for another admin dir',
      { registration: registered, gitLink: { kind: 'orphaned' } }, { action: 'refuse', reason: 'unverifiable' }],
    ['an unregistered folder without a .git file', { gitLink: { kind: 'missing' } },
      { action: 'refuse', reason: 'untracked' }],
    ['a worktree git lists under another spelling of its path', { gitLink: linked }, removal('worktree/x')],
    ['a worktree switched to another branch',
      { registration: { ...registered, branch: 'feature' }, gitLink: { ...linked, branch: 'feature' } }, removal(null)],
    ['a worktree on a detached HEAD',
      { registration: { ...registered, branch: null }, gitLink: { ...linked, branch: null } }, removal(null)],
    // The list reads HEAD through git; on the reftable format the admin dir's
    // HEAD file is a stub that names no branch
    ['a worktree of a reftable repository', { registration: registered, gitLink: { ...linked, branch: null } },
      removal('worktree/x')],
    ['a worktree whose list entry and admin dir HEAD name different branches',
      { registration: { ...registered, branch: 'feature' }, gitLink: linked }, removal(null)],
    ['a registered worktree when the caller names no branch',
      { registration: registered, gitLink: linked, expectedBranch: undefined }, removal('worktree/x')],
    ['a worktree that holds another registered worktree',
      { registration: registered, gitLink: linked, nestedWorktreePath: '/w/x/.claude/worktrees/sub' },
      { action: 'refuse', reason: 'contains-worktree' }],
    ['a registered checkout without its .git file that holds another registered worktree',
      { registration: registered, gitLink: { kind: 'missing' }, nestedWorktreePath: '/w/x/sub' },
      { action: 'refuse', reason: 'contains-worktree' }],
  ] as const)('plans %s', (_label, facts, plan) => {
    expect(planWorktreeRemoval({
      existsOnDisk: true,
      registryReadable: true,
      registration: null,
      gitLink: null,
      nestedWorktreePath: null,
      expectedBranch: 'worktree/x',
      ...facts,
    })).toEqual(plan);
  });

  // A failed creation removes only what it provably created: the branch its
  // own `git branch` made, and a registration with that branch checked out.
  // The real-git cases above cover a failing hook, a locked registration and
  // another worktree registered at the target meanwhile.
  const attempt = { branch: 'worktree/x', branchCreated: true };
  const nothingBefore = { pathExisted: false, registered: false };
  const created = {
    pathExists: true, registered: true, registeredBranch: 'worktree/x', locked: false, holdsOtherWorktree: false,
    branchExists: true,
  };
  const rollback = (unregister: boolean, removeFolder: boolean, deleteBranch: boolean) =>
    ({ unregister, removeFolder, deleteBranch });
  it.each([
    ['everything a failing post-checkout hook leaves', {}, rollback(true, true, true)],
    ['a branch git created before refusing the path',
      { after: { ...created, pathExists: false, registered: false, registeredBranch: null } }, rollback(false, false, true)],
    ['a branch someone else created first, so its own `git branch` failed', { branchCreated: false },
      rollback(false, false, false)],
    ['a registration at the target on another branch, someone else\'s or one a hook switched',
      { after: { ...created, registeredBranch: 'theirs' } }, rollback(false, false, true)],
    ['a folder that appeared without a registration, which may be anyone\'s',
      { after: { ...created, registered: false, registeredBranch: null, branchExists: false } }, rollback(false, false, false)],
    ['a registration that existed before the attempt',
      { before: { ...nothingBefore, registered: true }, after: { ...created, registeredBranch: 'feature/offline' } },
      rollback(false, false, true)],
    ['an empty folder that existed before the attempt, which unregistering deletes anyway',
      { before: { ...nothingBefore, pathExisted: true } },
      rollback(true, false, true)],
    ['a registration something locked', { after: { ...created, locked: true } }, rollback(false, false, false)],
    ['a folder that holds another worktree', { after: { ...created, holdsOtherWorktree: true } },
      rollback(false, false, false)],
    ['an attempt git cannot be asked about afterwards', { after: null }, rollback(false, false, false)],
  ] as const)('rolls back %s', (_label, facts, plan) => {
    expect(planWorktreeCreateRollback({ ...attempt, before: nothingBefore, after: created, ...facts })).toEqual(plan);
  });
});
