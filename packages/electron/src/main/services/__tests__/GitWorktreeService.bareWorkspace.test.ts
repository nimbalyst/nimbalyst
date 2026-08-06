import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitWorktreeService } from '../GitWorktreeService';

const temporaryRoots: string[] = [];

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function createBareWorkspace(): { root: string; workspace: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-bare-worktree-'));
  temporaryRoots.push(root);
  const seed = path.join(root, 'seed');
  const workspace = path.join(root, 'workspace');

  fs.mkdirSync(seed, { recursive: true });
  git(['init', '--initial-branch=main'], seed);
  git(['config', 'user.email', 'test@nimbalyst.local'], seed);
  git(['config', 'user.name', 'Nimbalyst Test'], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  git(['add', 'README.md'], seed);
  git(['commit', '-m', 'seed'], seed);

  fs.mkdirSync(workspace, { recursive: true });
  git(['init', '--bare', path.join(workspace, '.git')], root);
  git(['remote', 'add', 'origin', seed], path.join(workspace, '.git'));
  git(['fetch', 'origin', 'main:main'], path.join(workspace, '.git'));
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], path.join(workspace, '.git'));

  return { root, workspace };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('GitWorktreeService bare workspace support', () => {
  it('creates a worktree from an explicit base ref when .git is intentionally bare', async () => {
    const { workspace } = createBareWorkspace();
    const service = new GitWorktreeService();

    const worktree = await service.createWorktree(workspace, {
      name: 'explicit-base',
      baseBranch: 'main',
    });

    expect(worktree.baseBranch).toBe('main');
    expect(worktree.branch).toBe('worktree/explicit-base');
    expect(fs.existsSync(path.join(worktree.path, '.git'))).toBe(true);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], worktree.path).trim()).toBe('worktree/explicit-base');
  });

  it('fails closed without an explicit base ref for a bare workspace', async () => {
    const { workspace } = createBareWorkspace();
    const service = new GitWorktreeService();

    await expect(service.createWorktree(workspace, { name: 'missing-base' }))
      .rejects.toThrow(`baseBranch is required for bare Git workspace: ${workspace}`);
  });
});
