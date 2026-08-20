import { execFile, execFileSync } from 'child_process';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ipcMain } from 'electron';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  discardGitChanges,
  explainGitPushFailure,
  getWorkingChanges,
  isDetachedHeadState,
  normalizeBranchSelection,
  normalizeCurrentBranch,
  registerGitHandlers,
  resolveGitDiffTarget,
} from '../GitHandlers';
import { GitOperationLogService } from '../../services/GitOperationLogService';
import { assertGitSandbox, gitSandboxEnv } from '../../services/testSupport/gitTestSandbox';

const execFileAsync = promisify(execFile);

let tmpRoot: string;
const testTempRoot = process.env.NIMBALYST_TEST_TEMP_DIR ?? os.tmpdir();

beforeEach(async () => {
  await fs.mkdir(testTempRoot, { recursive: true });
  tmpRoot = await fs.mkdtemp(path.join(testTempRoot, 'nim-git-handlers-test-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function mkdirp(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
}

async function makeGitDir(target: string): Promise<void> {
  await mkdirp(path.join(target, '.git'));
  await fs.writeFile(path.join(target, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}

async function makeGitFile(target: string): Promise<void> {
  await mkdirp(target);
  await fs.writeFile(path.join(target, '.git'), 'gitdir: /tmp/shared.git/worktrees/test\n');
}

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd, env: gitSandboxEnv(testTempRoot) });
}

async function initScratchRepo(cwd: string): Promise<void> {
  await git(['init', '-q'], cwd);
  await git(['config', 'user.email', 'test@example.com'], cwd);
  await git(['config', 'user.name', 'Test User'], cwd);
  await git(['config', 'commit.gpgsign', 'false'], cwd);
  assertGitSandbox(cwd, testTempRoot);
}

describe('working tree mutations', () => {
  it('does not expand a pathspec-magic filename while discarding changes', async () => {
    await initScratchRepo(tmpRoot);
    const magicPath = path.join(tmpRoot, ':(glob)**');
    const unrelatedPath = path.join(tmpRoot, 'unrelated.txt');
    await fs.writeFile(magicPath, 'baseline magic\n');
    await fs.writeFile(unrelatedPath, 'baseline unrelated\n');
    await git(['add', '--', ':(glob)**', 'unrelated.txt'], tmpRoot);
    await git(['commit', '-q', '-m', 'baseline'], tmpRoot);

    await fs.writeFile(magicPath, 'changed magic\n');
    await fs.writeFile(unrelatedPath, 'changed unrelated\n');

    const operationLog = new GitOperationLogService({
      rootDir: path.join(tmpRoot, 'operation-logs'),
      broadcast: () => undefined,
    });
    const result = await discardGitChanges(tmpRoot, [':(glob)**'], operationLog);

    expect(result.success).toBe(false);
    expect(await fs.readFile(magicPath, 'utf8')).toBe('changed magic\n');
    expect(await fs.readFile(unrelatedPath, 'utf8')).toBe('changed unrelated\n');
  });

  it('reports a staged rename as a deletion plus an addition', async () => {
    await initScratchRepo(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'old.ts'), 'export const value = 1;\n');
    await git(['add', 'old.ts'], tmpRoot);
    await git(['commit', '-q', '-m', 'baseline'], tmpRoot);
    await git(['mv', 'old.ts', 'new.ts'], tmpRoot);

    const changes = await getWorkingChanges(tmpRoot);

    expect(changes.staged).toEqual([
      { path: 'old.ts', status: 'D' },
      { path: 'new.ts', status: 'A' },
    ]);
  });
});

describe('resolveGitDiffTarget', () => {
  it('keeps workspace-root files relative to the workspace repo', async () => {
    const workspacePath = path.join(tmpRoot, 'project');
    const filePath = path.join(workspacePath, 'src', 'index.ts');
    await makeGitDir(workspacePath);
    await mkdirp(path.dirname(filePath));
    await fs.writeFile(filePath, 'export {};\n');

    expect(resolveGitDiffTarget(workspacePath, filePath)).toEqual({
      gitWorkspacePath: workspacePath,
      gitFilePath: 'src/index.ts',
    });
  });

  it('resolves sibling worktree files to the worktree git root', async () => {
    const workspacePath = path.join(tmpRoot, 'project');
    const worktreePath = path.join(tmpRoot, 'project_worktrees', 'bright-tide');
    const filePath = path.join(worktreePath, 'packages', 'runtime', 'src', 'widget.tsx');
    await makeGitDir(workspacePath);
    await makeGitFile(worktreePath);
    await mkdirp(path.dirname(filePath));
    await fs.writeFile(filePath, 'export const widget = true;\n');

    expect(resolveGitDiffTarget(workspacePath, filePath)).toEqual({
      gitWorkspacePath: worktreePath,
      gitFilePath: 'packages/runtime/src/widget.tsx',
    });
  });
});

describe('detached HEAD helpers', () => {
  it('recognizes detached-head labels from simple-git and git', () => {
    expect(isDetachedHeadState('HEAD')).toBe(true);
    expect(isDetachedHeadState('(no branch)')).toBe(true);
    expect(isDetachedHeadState('HEAD detached at 4e7ad40')).toBe(true);
    expect(isDetachedHeadState('(HEAD detached at 4e7ad40)')).toBe(true);
    expect(isDetachedHeadState('main')).toBe(false);
  });

  it('normalizes detached current branches to HEAD', () => {
    expect(normalizeCurrentBranch('(no branch)')).toBe('HEAD');
    expect(normalizeCurrentBranch('HEAD detached at 4e7ad40')).toBe('HEAD');
    expect(normalizeCurrentBranch('feature/test')).toBe('feature/test');
  });

  it('normalizes detached branch selections before passing them to git commands', () => {
    expect(normalizeBranchSelection('(no branch)')).toBe('HEAD');
    expect(normalizeBranchSelection('HEAD')).toBe('HEAD');
    expect(normalizeBranchSelection('release/2026.05')).toBe('release/2026.05');
    expect(normalizeBranchSelection('')).toBeUndefined();
  });
});

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

type IpcHandler = (event: unknown, ...args: any[]) => Promise<any>;

function getGitIpcHandler(channel: string): IpcHandler {
  const handleMock = ipcMain.handle as unknown as { mock: { calls: [string, IpcHandler][] } };
  const registration = handleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`No handler registered for channel: ${channel}`);
  return registration[1];
}

// #124: workspacePath may be a subfolder of the git repo. git:working-changes
// and git:commit-detail paths are repo-root-relative, so absolutePath must be
// joined against gitRoot, not workspacePath.
describe('git:working-changes / git:commit-detail absolutePath (subfolder workspace, #124)', () => {
  let repoRoot: string;
  let workspacePath: string;
  let filePath: string;

  beforeAll(() => {
    registerGitHandlers();
  });

  beforeEach(async () => {
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-git-handlers-abspath-'));
    // git rev-parse returns physical paths; normalize the fixture the same way
    // GitContextService.test.ts does, so comparisons don't trip over macOS's
    // /tmp -> /private/tmp symlink.
    repoRoot = await fs.realpath(raw);
    workspacePath = path.join(repoRoot, 'sub');
    await fs.mkdir(workspacePath, { recursive: true });
    filePath = path.join(workspacePath, 'foo.ts');

    runGit(['init', '-q'], repoRoot);
    runGit(['config', 'user.email', 'test@example.com'], repoRoot);
    runGit(['config', 'user.name', 'Test User'], repoRoot);

    await fs.writeFile(filePath, 'export const a = 1;\n');
    runGit(['add', '.'], repoRoot);
    runGit(['commit', '-q', '-m', 'initial'], repoRoot);

    // Second commit modifying the subfolder file, so diff-tree (which needs a
    // parent) has something to report -- the handler doesn't pass --root.
    await fs.writeFile(filePath, 'export const a = 2;\n');
    runGit(['add', '.'], repoRoot);
    runGit(['commit', '-q', '-m', 'update foo'], repoRoot);
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('joins git:working-changes absolutePath against the repo root, not workspacePath', async () => {
    // Uncommitted edit -- shows up as an unstaged change.
    await fs.writeFile(filePath, 'export const a = 3;\n');

    const handler = getGitIpcHandler('git:working-changes');
    const result = await handler({}, workspacePath);

    expect(result.unstaged).toEqual([
      { path: 'sub/foo.ts', status: 'M', absolutePath: filePath },
    ]);
  });

  it('joins git:commit-detail absolutePath against the repo root, not workspacePath', async () => {
    const commitHash = runGit(['rev-parse', 'HEAD'], repoRoot).trim();

    const handler = getGitIpcHandler('git:commit-detail');
    const detail = await handler({}, workspacePath, commitHash);

    expect(detail.files).toEqual([
      { status: 'M', path: 'sub/foo.ts', added: 1, deleted: 1, absolutePath: filePath },
    ]);
  });
});

// #124: resolveGitDiffTarget must resolve a RELATIVE filePath against the git
// root (the boundary used by findGitRootForFile), not against workspacePath,
// when workspacePath is a subfolder of the repo. git:working-changes emits
// repo-root-relative paths, so a workspace opened at `<repo>/home` with a
// changed file `home/inner.txt` must not double up to `home/home/inner.txt`.
describe('resolveGitDiffTarget / git:file-diff (subfolder workspace, repo-root-relative path, #124)', () => {
  let repoRoot: string;
  let workspacePath: string;
  let innerFilePath: string;

  beforeAll(() => {
    registerGitHandlers();
  });

  beforeEach(async () => {
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-git-handlers-diff-target-'));
    repoRoot = await fs.realpath(raw);
    workspacePath = path.join(repoRoot, 'home');
    await fs.mkdir(workspacePath, { recursive: true });
    innerFilePath = path.join(workspacePath, 'inner.txt');

    runGit(['init', '-q'], repoRoot);
    runGit(['config', 'user.email', 'test@example.com'], repoRoot);
    runGit(['config', 'user.name', 'Test User'], repoRoot);

    await fs.writeFile(innerFilePath, 'line one\n');
    runGit(['add', '.'], repoRoot);
    runGit(['commit', '-q', '-m', 'initial'], repoRoot);

    // Uncommitted modification, so the diff peek has content.
    await fs.writeFile(innerFilePath, 'line one changed\n');
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('resolves a repo-root-relative filePath against the git root, not workspacePath', () => {
    const target = resolveGitDiffTarget(workspacePath, 'home/inner.txt');

    expect(target).toEqual({
      gitWorkspacePath: repoRoot,
      gitFilePath: 'home/inner.txt',
    });
  });

  it('produces a non-empty diff via git:file-diff for the repo-root-relative path', async () => {
    const handler = getGitIpcHandler('git:file-diff');
    const result = await handler({}, workspacePath, { path: 'home/inner.txt', group: 'unstaged' });

    expect(result.unifiedDiff).toContain('inner.txt');
    expect(result.unifiedDiff).toContain('line one changed');
    expect(result.unifiedDiff.length).toBeGreaterThan(0);
  });
});

describe('explainGitPushFailure', () => {
  const context = { remote: 'origin', branch: 'main' };

  // Verbatim `git push` output from a diverged branch.
  const FETCH_FIRST = [
    'To github.com:nimbalyst/nimbalyst.git',
    ' ! [rejected]        main -> main (fetch first)',
    "error: failed to push some refs to 'github.com:nimbalyst/nimbalyst.git'",
    'hint: Updates were rejected because the remote contains work that you do not',
    'hint: have locally. This is usually caused by another repository pushing to',
    'hint: the same ref. If you want to integrate the remote changes, use',
    "hint: 'git pull' before pushing again.",
    "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
  ].join('\n');

  it('leads with a pull-first summary when the remote has commits we lack', () => {
    const explained = explainGitPushFailure(FETCH_FIRST, context);

    expect(explained?.split('\n')[0]).toBe(
      "Push rejected: origin/main has commits you don't have locally. Pull first, then push again.",
    );
    // The raw output stays underneath — the menu tooltip shows the full text.
    expect(explained).toContain(FETCH_FIRST);
  });

  it('summarizes a non-fast-forward rejection the same way', () => {
    const raw = [
      ' ! [rejected]        main -> main (non-fast-forward)',
      "error: failed to push some refs to 'github.com:nimbalyst/nimbalyst.git'",
      'hint: Updates were rejected because the tip of your current branch is behind',
    ].join('\n');

    expect(explainGitPushFailure(raw, context)?.split('\n')[0]).toBe(
      "Push rejected: origin/main has commits you don't have locally. Pull first, then push again.",
    );
  });

  it('tells the user to fetch when --force-with-lease sees stale info', () => {
    const raw = [
      ' ! [rejected]        main -> main (stale info)',
      "error: failed to push some refs to 'github.com:nimbalyst/nimbalyst.git'",
    ].join('\n');

    expect(explainGitPushFailure(raw, context)?.split('\n')[0]).toBe(
      'Push rejected: origin/main moved since your last fetch. Pull first, then push again.',
    );
  });

  // A failing pre-push hook prints the SAME `failed to push some refs` tail as a
  // diverged push, so keying on that line alone would mislabel a red test suite
  // as "you need to pull".
  it('leaves a pre-push hook failure untouched', () => {
    const raw = [
      '[pre-push] Running non-provider unit tests...',
      ' FAIL  packages/electron/src/main/services/ai/__tests__/example.test.ts',
      "error: failed to push some refs to 'github.com:nimbalyst/nimbalyst.git'",
    ].join('\n');

    expect(explainGitPushFailure(raw, context)).toBe(raw);
  });

  it('passes through empty and missing errors', () => {
    expect(explainGitPushFailure(undefined, context)).toBeUndefined();
    expect(explainGitPushFailure('', context)).toBe('');
  });
});
