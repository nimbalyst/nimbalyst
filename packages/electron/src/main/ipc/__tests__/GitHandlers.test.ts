import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  isDetachedHeadState,
  normalizeBranchSelection,
  normalizeCurrentBranch,
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
