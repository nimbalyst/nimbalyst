import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { ipcMain } from 'electron';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  isDetachedHeadState,
  normalizeBranchSelection,
  normalizeCurrentBranch,
  registerGitHandlers,
  resolveGitDiffTarget,
} from '../GitHandlers';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-git-handlers-test-'));
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
