// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertGitSandbox, gitSandboxEnv, FIXTURE_AUTHOR } from '../testSupport/gitTestSandbox';

const state = vi.hoisted(() => ({ session: null as any, worktree: null as any, attached: [] as string[] }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: async () => state.session } }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: () => ({ get: async () => state.worktree }) }));
vi.mock('../../utils/store', () => ({
  getWorkspaceRoots: (root: string) => [root, ...(root === state.session?.workspacePath ? state.attached : [])],
  getAttachedFolders: () => state.attached,
}));

import { resolveGitCommitProposalTarget } from '../gitCommitProposalTarget';
import { executeGitCommitAcrossRepos } from '../GitCommitService';

let scratch: string;
let parent: string;
let worktree: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nim-commit-target-')));
  parent = join(scratch, 'parent');
  worktree = join(scratch, 'worktree');
  mkdirSync(join(parent, '.git'), { recursive: true });
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), `gitdir: ${parent}/.git/worktrees/task\n`);
  for (const root of [parent, worktree]) writeFileSync(join(root, 'shared.txt'), root);
  state.session = { workspacePath: parent, worktreeId: 'task', worktreePath: worktree };
  state.worktree = { path: worktree };
  state.attached = [];
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

it('anchors overlapping relative paths to the native worktree even with a parent MCP connection', async () => {
  expect(await resolveGitCommitProposalTarget('session', parent, ['shared.txt'])).toEqual({
    workspacePath: worktree, repoPath: worktree, files: [join(worktree, 'shared.txt')],
  });
});

it('rejects an explicit workingDirectory instead of silently using the session checkout', async () => {
  await expect(resolveGitCommitProposalTarget('session', parent, ['shared.txt'], worktree)).rejects.toThrow('workingDirectory');
});

it('rejects every outside path before accepting even a partially valid proposal', async () => {
  for (const files of [[join(parent, 'shared.txt')], ['shared.txt', join(parent, 'shared.txt')]]) {
    await expect(resolveGitCommitProposalTarget('session', parent, files)).rejects.toThrow('outside');
  }
});

it('fails closed for missing sessions and incomplete or changed native bindings', async () => {
  state.worktree = null;
  await expect(resolveGitCommitProposalTarget('session', parent, ['shared.txt'])).rejects.toThrow('binding');
  state.worktree = { path: parent };
  await expect(resolveGitCommitProposalTarget('session', parent, ['shared.txt'])).rejects.toThrow('binding');
  state.session.worktreePath = undefined;
  await expect(resolveGitCommitProposalTarget('session', parent, ['shared.txt'])).rejects.toThrow('binding');
  state.session = null;
  await expect(resolveGitCommitProposalTarget('session', parent, ['shared.txt'])).rejects.toThrow('Session');
});

it('keeps attached repositories available but rejects a selection spanning two checkouts', async () => {
  const attached = join(scratch, 'attached');
  mkdirSync(join(attached, '.git'), { recursive: true });
  state.attached = [attached];
  const file = join(attached, 'new.txt');
  expect((await resolveGitCommitProposalTarget('session', parent, [file])).repoPath).toBe(attached);
  await expect(resolveGitCommitProposalTarget('session', parent, ['shared.txt', file])).rejects.toThrow('repositories');
});

it('uses the persisted workspace for ordinary sessions and refuses mismatched connection context', async () => {
  state.session = { workspacePath: parent };
  expect((await resolveGitCommitProposalTarget('session', parent, ['shared.txt'])).files).toEqual([join(parent, 'shared.txt')]);
  await expect(resolveGitCommitProposalTarget('session', worktree, ['shared.txt'])).rejects.toThrow('workspace');
});

it('commits only the worktree version of an overlapping path and preserves the parent index', async () => {
  const main = join(scratch, 'real-main');
  const linked = join(scratch, 'real-worktree');
  mkdirSync(main);
  const env = gitSandboxEnv(scratch);
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  git(main, ['init', '-q']);
  assertGitSandbox(main, scratch);
  git(main, ['config', 'user.name', FIXTURE_AUTHOR.name]);
  git(main, ['config', 'user.email', FIXTURE_AUTHOR.email]);
  git(main, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(main, 'shared.txt'), 'baseline\n');
  git(main, ['add', '--', 'shared.txt']);
  git(main, ['commit', '-qm', 'seed']);
  git(main, ['worktree', 'add', '-b', 'task', linked]);
  assertGitSandbox(linked, scratch);
  const before = git(main, ['rev-parse', 'HEAD']);
  writeFileSync(join(main, 'shared.txt'), 'parent staged\n');
  git(main, ['add', '--', 'shared.txt']);
  const indexBefore = git(main, ['diff', '--cached']);
  writeFileSync(join(linked, 'shared.txt'), 'worktree edit\n');
  state.session = { workspacePath: main, worktreeId: 'task', worktreePath: linked };
  state.worktree = { path: linked };
  const target = await resolveGitCommitProposalTarget('session', main, ['shared.txt']);
  const result = await executeGitCommitAcrossRepos(target.workspacePath, 'commit intended checkout', target.files, {
    repoPath: target.repoPath, env: env as Record<string, string>,
  });
  expect(result.success).toBe(true);
  expect(git(linked, ['show', 'HEAD:shared.txt'])).toBe('worktree edit');
  expect(git(main, ['rev-parse', 'HEAD'])).toBe(before);
  expect(git(main, ['diff', '--cached'])).toBe(indexBefore);
});
