// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createGit } from '../gitClient';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GitWorktreeService, WorkspaceHasNoCommitsError } from '../GitWorktreeService';
import { gitOperationLock } from '../GitOperationLock';
import * as operationLog from '../GitOperationLogService';
import { assertGitSandbox, createScratchRepo, FIXTURE_IDENTITY_ARGS, gitSandboxEnv } from '../testSupport/gitTestSandbox';

// createWorktree/deleteWorktree record each command in the persisted git
// activity log, which is bookkeeping these tests do not exercise.
vi.mock('../GitOperationLogService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../GitOperationLogService')>()),
  getGitOperationLogService: () => ({}),
  recordGitActivity: (_service: unknown, _workspacePath: string, _args: string[], operation: () => Promise<unknown>) =>
    operation(),
}));

describe('gitSandboxEnv', () => {
  it('strips IDE-provided SSH_ASKPASS before simple-git runs a fixture command', async () => {
    const previousAskPass = process.env.SSH_ASKPASS;
    process.env.SSH_ASKPASS = '/mock/ide/askpass';
    try {
      const sandboxEnv = gitSandboxEnv(undefined, { pinConfigPaths: false });
      expect(sandboxEnv.SSH_ASKPASS).toBeUndefined();
      await expect(createGit(os.tmpdir(), {}, sandboxEnv).raw(['--version'])).resolves.toMatch(/^git version /);
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
    createScratchRepo({ at: tmpDir });

    await expect(service.validateWorkspaceHasCommits(tmpDir))
      .rejects
      .toBeInstanceOf(WorkspaceHasNoCommitsError);
  });

  it('resolves cleanly when the repo has at least one commit', async () => {
    // The fixture's git() strips GIT_* and checks the sandbox before each command.
    // See testSupport/gitTestSandbox.ts.
    const repo = createScratchRepo({ at: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'hi');
    repo.git('add', 'README.md');
    repo.git('commit', '-q', '-m', 'initial');

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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-gws-changed-'));
    const repo = createScratchRepo({ at: tmpDir });

    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n');
    repo.git('add', '.gitignore');
    repo.git('commit', '-q', '-m', 'initial');

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
    createScratchRepo({ at: embedded });
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

describe('GitWorktreeService.rebaseFromBase input boundary', () => {
  it('rejects malformed cwd/base operands before lock, activity, preflight or storage', async () => {
    const service = new GitWorktreeService();
    const lock = vi.spyOn(gitOperationLock, 'withLock');
    const activity = vi.spyOn(operationLog, 'recordGitActivity');
    const journal = vi.spyOn(operationLog, 'getGitOperationLogService');
    const preflight = vi.spyOn(service, 'checkGitState');
    try {
      for (const value of [undefined, null, false, 0, {}, [], '', 'a\0b', '-', '--continue']) {
        await expect(service.rebaseFromBase('/fixture', value as string)).rejects.toThrow(/baseBranch/);
      }
      for (const value of [undefined, null, false, 0, {}, [], '', 'a\0b']) {
        await expect(service.rebaseFromBase(value as string, 'main')).rejects.toThrow(/worktreePath/);
      }
      expect(lock).not.toHaveBeenCalled();
      expect(activity).not.toHaveBeenCalled();
      expect(journal).not.toHaveBeenCalled();
      expect(preflight).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('passes benign operands unchanged to the existing locked activity', async () => {
    const service = new GitWorktreeService();
    const result = { success: true };
    const lock = vi.spyOn(gitOperationLock, 'withLock').mockImplementation(async (_path, _name, fn) => fn());
    const activity = vi.spyOn(operationLog, 'recordGitActivity').mockResolvedValue(result);
    vi.spyOn(operationLog, 'getGitOperationLogService').mockReturnValue({} as operationLog.GitOperationLogService);
    try {
      for (const baseBranch of ['HEAD~1', 'HEAD^', '@{-1}', 'refs/heads/topic', 'origin/topic', 'topic/日本語']) {
        await expect(service.rebaseFromBase('-relative repo', baseBranch)).resolves.toBe(result);
        expect(lock).toHaveBeenLastCalledWith('-relative repo', 'rebaseFromBase', expect.any(Function));
        expect(activity).toHaveBeenLastCalledWith({}, '-relative repo', ['rebase', baseBranch], expect.any(Function), expect.any(Function));
      }
    } finally {
      vi.restoreAllMocks();
    }
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

  const fixtureGit = (dir: string) => createGit(dir, {}, gitSandboxEnv(undefined, { pinConfigPaths: false }));
  const snapshot = async (dir: string) => ({
    branches: await fixtureGit(dir).raw(['branch', '--list']),
    worktrees: await fixtureGit(dir).raw(['worktree', 'list', '--porcelain']),
  });

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
 * Archiving trusts isMerged: a clean, merged worktree is deleted along with its
 * branch without asking. A substring match on `git branch -a --merged` output
 * counted `worktree/feat` as merged whenever `worktree/feat-1` (the `-N` suffix
 * createWorktree adds on a name collision) or `remotes/origin/worktree/feat`
 * was, and a detached worktree whenever `remotes/origin/HEAD` was, though each
 * still held commits the base lacks.
 */
describe('GitWorktreeService.getWorktreeStatus isMerged', () => {
  let tmpDir: string;
  let repo: string;
  let featPath: string;
  const service = new GitWorktreeService();

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitSandboxEnv(tmpDir) });
  }

  function commit(cwd: string, message: string): void {
    assertGitSandbox(cwd, tmpDir);
    git(cwd, [...FIXTURE_IDENTITY_ARGS, 'commit', '--allow-empty', '-q', '-m', message]);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-gws-merged-'));
    repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    commit(repo, 'initial');

    // `worktree/feat` is one commit ahead of main.
    assertGitSandbox(repo, tmpDir);
    featPath = path.join(tmpDir, 'feat');
    git(repo, ['worktree', 'add', '-q', '-b', 'worktree/feat', featPath, 'main']);
    commit(featPath, 'unmerged work');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore Windows file-lock noise during teardown
    }
  });

  it('does not report a branch merged because a longer-named sibling or its own remote-tracking ref is', async () => {
    assertGitSandbox(repo, tmpDir);
    git(repo, ['worktree', 'add', '-q', '-b', 'worktree/feat-1', path.join(tmpDir, 'feat-1'), 'main']);
    // As if the branch was pushed and merged, then committed to again locally.
    git(repo, ['update-ref', 'refs/remotes/origin/worktree/feat', 'main']);

    const status = await service.getWorktreeStatus(featPath, 'main');

    expect(status.commitsAhead).toBe(1);
    expect(status.isMerged).toBe(false);
  });

  it('does not report a detached worktree merged because origin/HEAD is', async () => {
    // simple-git names a detached HEAD `HEAD`, and every clone has origin/HEAD.
    assertGitSandbox(repo, tmpDir);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    assertGitSandbox(featPath, tmpDir);
    git(featPath, ['checkout', '-q', '--detach']);

    const status = await service.getWorktreeStatus(featPath, 'main');

    expect(status.commitsAhead).toBe(1);
    expect(status.isMerged).toBe(false);
  });

  it('reports the branch merged once the base contains it, whatever the color and column config', async () => {
    assertGitSandbox(repo, tmpDir);
    git(repo, ['merge', '-q', '--ff-only', 'worktree/feat']);
    // Both settings apply even when git writes to a pipe, and reshape the
    // `git branch` lines the merge check reads.
    git(repo, ['config', 'color.ui', 'always']);
    git(repo, ['config', 'column.ui', 'always']);

    const status = await service.getWorktreeStatus(featPath, 'main');

    expect(status.commitsAhead).toBe(0);
    expect(status.isMerged).toBe(true);
  });
});
