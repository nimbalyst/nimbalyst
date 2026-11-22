// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

import { resolveGitCommitProposalTarget, revalidateProposalWorktree } from '../gitCommitProposalTarget';
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

it('rejects a workingDirectory that is not a registered worktree instead of silently using the session checkout', async () => {
  await expect(resolveGitCommitProposalTarget('session', parent, ['shared.txt'], worktree)).rejects.toThrow('git worktree list');
  await expect(resolveGitCommitProposalTarget('session', parent, ['shared.txt'], 'relative/dir')).rejects.toThrow('absolute');
});

/** #1756: a real main checkout with a sibling worktree on branch `feature`, plus an unrelated repo. */
function realRepos() {
  const env = gitSandboxEnv(scratch);
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const init = (dir: string) => {
    mkdirSync(dir);
    git(dir, ['init', '-q']);
    assertGitSandbox(dir, scratch);
    for (const [k, v] of [['user.name', FIXTURE_AUTHOR.name], ['user.email', FIXTURE_AUTHOR.email], ['commit.gpgsign', 'false']]) git(dir, ['config', k, v]);
    writeFileSync(join(dir, 'shared.txt'), 'baseline\n');
    git(dir, ['add', '--', 'shared.txt']);
    git(dir, ['commit', '-qm', 'seed']);
  };
  const main = join(scratch, 'real-main');
  const sibling = join(scratch, 'real-sibling');
  const other = join(scratch, 'other-repo');
  init(main);
  init(other);
  git(main, ['worktree', 'add', '-q', '-b', 'feature', sibling]);
  assertGitSandbox(sibling, scratch);
  state.session = { workspacePath: main };
  return { env, git, main, sibling, other };
}

it('accepts a registered sibling worktree as an explicit target and commits only there', async () => {
  const { env, git, main, sibling } = realRepos();
  writeFileSync(join(sibling, 'shared.txt'), 'sibling edit\n');
  const before = git(main, ['rev-parse', 'HEAD']);
  const target = await resolveGitCommitProposalTarget('session', main, ['shared.txt'], sibling);
  expect(target).toEqual({
    workspacePath: sibling, repoPath: sibling, files: [join(sibling, 'shared.txt')],
    worktree: { path: sibling, branch: 'feature' },
  });
  expect((await resolveGitCommitProposalTarget('session', main, [join(sibling, 'shared.txt')], sibling)).files).toEqual([join(sibling, 'shared.txt')]);
  const result = await executeGitCommitAcrossRepos(target.workspacePath, 'commit sibling', target.files, {
    repoPath: target.repoPath, env: env as Record<string, string>,
  });
  expect(result.success).toBe(true);
  expect(git(sibling, ['show', 'feature:shared.txt'])).toBe('sibling edit');
  expect(git(main, ['rev-parse', 'HEAD'])).toBe(before);
});

// Review repro: move the worktree without git, then `git init` an unrelated repo at the old path.
// The stale registration still lists the path; only the repo's real identity tells them apart.
it('refuses an unrelated repository sitting at a stale worktree registration, at proposal time and before execution', async () => {
  const { git, main, sibling } = realRepos();
  const target = await resolveGitCommitProposalTarget('session', main, ['shared.txt'], sibling);
  await expect(revalidateProposalWorktree('session', target.worktree!.path)).resolves.toBeUndefined();

  renameSync(sibling, `${sibling}-moved`);
  mkdirSync(sibling);
  git(sibling, ['init', '-q']);
  assertGitSandbox(sibling, scratch);
  writeFileSync(join(sibling, 'shared.txt'), 'unrelated\n');
  expect(git(main, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${sibling}`);

  await expect(resolveGitCommitProposalTarget('session', main, ['shared.txt'], sibling)).rejects.toThrow('not a registered git worktree');
  await expect(revalidateProposalWorktree('session', sibling)).rejects.toThrow('not a registered git worktree');
});

it('treats the session checkout itself as an ordinary target', async () => {
  const { main } = realRepos();
  expect(await resolveGitCommitProposalTarget('session', main, ['shared.txt'], main)).toEqual({
    workspacePath: main, repoPath: main, files: [join(main, 'shared.txt')],
  });
});

// #1968: a session opened on a subfolder that names its own checkout root is
// not "another worktree", so it must not lose auto-approval. The record keeps
// the session checkout (what execution re-checks) and commits in the root.
it('treats its own checkout root as the same checkout when the session workspace is a subfolder', async () => {
  const { env, git, main, sibling } = realRepos();
  const sub = join(main, 'packages', 'app');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'inner.txt'), 'inner\n');
  writeFileSync(join(main, 'shared.txt'), 'root edit\n');
  state.session = { workspacePath: sub };

  const target = await resolveGitCommitProposalTarget('session', sub, ['packages/app/inner.txt', 'shared.txt'], main);
  expect(target).toEqual({
    workspacePath: sub, repoPath: main, files: [join(sub, 'inner.txt'), join(main, 'shared.txt')],
  });
  const result = await executeGitCommitAcrossRepos(target.workspacePath, 'commit from subfolder', target.files, {
    repoPath: target.repoPath, env: env as Record<string, string>,
  });
  expect(result.success).toBe(true);
  expect(git(main, ['show', '--name-only', '--format=', 'HEAD']).split('\n').sort()).toEqual(['packages/app/inner.txt', 'shared.txt']);

  // A real sibling named from the subfolder session still needs manual approval.
  expect((await resolveGitCommitProposalTarget('session', sub, ['shared.txt'], sibling)).worktree).toEqual({ path: sibling, branch: 'feature' });
});

it('refuses other repositories, plain folders and files outside the named worktree, saying what to do', async () => {
  const { main, sibling, other } = realRepos();
  await expect(resolveGitCommitProposalTarget('session', main, [join(other, 'shared.txt')], other)).rejects.toThrow(/not a registered git worktree.*git worktree list/);
  await expect(resolveGitCommitProposalTarget('session', main, ['x.txt'], scratch)).rejects.toThrow('not a registered git worktree');
  await expect(resolveGitCommitProposalTarget('session', main, [join(main, 'shared.txt')], sibling)).rejects.toThrow(`outside the worktree ${sibling}`);
  await expect(resolveGitCommitProposalTarget('session', main, [join(sibling, 'shared.txt')])).rejects.toThrow('workingDirectory');
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
