// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertGitSandbox, gitSandboxEnv, FIXTURE_AUTHOR } from '../testSupport/gitTestSandbox';

const state = vi.hoisted(() => ({
  session: null as any,
  edits: [] as Array<{ sessionId: string; filePath: string }>,
  titles: {} as Record<string, string>,
  lookups: 0,
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: {
    get: async () => state.session,
    getMany: async (ids: string[]) => ids.map(id => ({ id, title: state.titles[id] })),
  },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({
  SessionFilesRepository: {
    getSessionsByFiles: async (_workspaceIds: string[], filePaths: string[]) => {
      state.lookups += 1;
      return state.edits.filter(edit => filePaths.includes(edit.filePath));
    },
  },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: () => ({ get: async () => null }) }));
vi.mock('../../utils/store', () => ({
  getWorkspaceRoots: (root: string) => [root],
  getAttachedFolders: () => [],
}));

import { resolveGitCommitProposalTarget } from '../gitCommitProposalTarget';
import { executeGitCommit } from '../GitCommitService';

let scratch: string;
let repo: string;
let env: NodeJS.ProcessEnv;
const git = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nim-proposal-expand-')));
  repo = join(scratch, 'repo');
  env = gitSandboxEnv(scratch);
  mkdirSync(repo);
  git(['init', '-q']);
  assertGitSandbox(repo, scratch);
  for (const [k, v] of [['user.name', FIXTURE_AUTHOR.name], ['user.email', FIXTURE_AUTHOR.email], ['commit.gpgsign', 'false'], ['core.hooksPath', join(repo, '.git', 'hooks')]]) git(['config', k, v]);
  state.session = { id: 'me', workspacePath: repo };
  state.edits = [];
  state.titles = {};
  state.lookups = 0;
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function write(rel: string, content = `${rel}\n`) {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

/** 3 modified, 1 deleted, 2 untracked and 1 ignored file under design/snap/, plus another session's staged file outside it. */
function seedSnapshot() {
  write('.gitignore', '*.log\n');
  for (const name of ['a', 'b', 'c', 'd']) write(`design/snap/${name}.txt`);
  write('outside.txt');
  git(['add', '-A']);
  assertGitSandbox(repo, scratch);
  git(['commit', '-qm', 'seed']);
  for (const name of ['a', 'b', 'c']) write(`design/snap/${name}.txt`, 'changed\n');
  unlinkSync(join(repo, 'design/snap/d.txt'));
  write('design/snap/new1.txt');
  write('design/snap/nested/new2.txt');
  write('design/snap/debug.log');
  write('outside.txt', 'staged by another session\n');
  git(['add', 'outside.txt']);
}

it('expands a directory entry into its 6 changed, non-ignored files and commits exactly those', async () => {
  seedSnapshot();
  const target = await resolveGitCommitProposalTarget('me', repo, ['design/snap/']);
  assertGitSandbox(repo, scratch);
  const result = await executeGitCommit(repo, 'snapshot', target.files, { env: env as Record<string, string> });
  expect(result.error).toBeUndefined();
  expect(target.files).toEqual([
    'design/snap/a.txt', 'design/snap/b.txt', 'design/snap/c.txt', 'design/snap/d.txt',
    'design/snap/nested/new2.txt', 'design/snap/new1.txt',
  ].map(rel => join(repo, rel)));
  expect(Object.fromEntries(target.fileDetails!.map(f => [f.path.slice(repo.length + 1), f.status]))).toEqual({
    'design/snap/a.txt': 'modified', 'design/snap/b.txt': 'modified', 'design/snap/c.txt': 'modified',
    'design/snap/d.txt': 'deleted', 'design/snap/nested/new2.txt': 'added', 'design/snap/new1.txt': 'added',
  });
  expect(target.expansion?.expandedFrom).toEqual({ 'design/snap/': 6 });

  expect(git(['show', '--name-only', '--format=', 'HEAD']).split('\n').sort()).toEqual([
    'design/snap/a.txt', 'design/snap/b.txt', 'design/snap/c.txt', 'design/snap/d.txt',
    'design/snap/nested/new2.txt', 'design/snap/new1.txt',
  ]);
  // NIM-2284: another session's staged file outside the directory stays staged and uncommitted.
  expect(git(['diff', '--cached', '--name-only'])).toBe('outside.txt');
});

it('leaves an explicit file list exactly as before and skips the ownership lookup', async () => {
  seedSnapshot();
  const target = await resolveGitCommitProposalTarget('me', repo, ['design/snap/a.txt', 'outside.txt']);
  expect(target).toEqual({ workspacePath: repo, repoPath: repo, files: [join(repo, 'design/snap/a.txt'), join(repo, 'outside.txt')] });
  expect(state.lookups).toBe(0);
});

it('refuses an ignored directory, an empty directory, and an untracked nested repository by name', async () => {
  seedSnapshot();
  write('build/out.log');
  write('.gitignore', '*.log\nbuild/\n');
  await expect(resolveGitCommitProposalTarget('me', repo, ['build'])).rejects.toThrow('`build/` is ignored');

  write('clean/kept.txt');
  git(['add', 'clean/kept.txt']);
  assertGitSandbox(repo, scratch);
  git(['commit', '-qm', 'clean']);
  await expect(resolveGitCommitProposalTarget('me', repo, ['clean/'])).rejects.toThrow('`clean/` has no uncommitted changes');

  write('vendor/sub/file.txt');
  git(['init', '-q'], join(repo, 'vendor/sub'));
  await expect(resolveGitCommitProposalTarget('me', repo, ['vendor'])).rejects.toThrow('`vendor/sub/` is a separate git repository');
});

it('caps an expansion at 2000 files and asks for a split', async () => {
  seedSnapshot();
  mkdirSync(join(repo, 'bulk'));
  for (let i = 0; i <= 2000; i++) writeFileSync(join(repo, 'bulk', `f${i}.txt`), 'x');
  await expect(resolveGitCommitProposalTarget('me', repo, ['bulk'])).rejects.toThrow('expands to 2001 files, more than 2000. Split it by subdirectory');
});

it('expands a deleted directory and removes excludePaths, reporting excludes that matched nothing', async () => {
  seedSnapshot();
  rmSync(join(repo, 'design'), { recursive: true });
  const target = await resolveGitCommitProposalTarget('me', repo, ['design/snap'], undefined, {
    excludePaths: ['design/snap/b.txt', 'design/snap/c.txt/', 'design/snap/.DS_Store'],
  });
  expect(target.fileDetails).toEqual([
    { path: join(repo, 'design/snap/a.txt'), status: 'deleted', fromDirectory: 'design/snap/' },
    { path: join(repo, 'design/snap/d.txt'), status: 'deleted', fromDirectory: 'design/snap/' },
  ]);
  expect(target.expansion).toMatchObject({ expandedFrom: { 'design/snap/': 4 }, unmatchedExcludes: ['design/snap/.DS_Store'] });
  await expect(resolveGitCommitProposalTarget('me', repo, ['design/snap'], undefined, { excludePaths: [':(glob)**'] }))
    .rejects.toThrow('literal path');
});

it('flags files under an expanded directory that only another session edited, with one batched lookup', async () => {
  seedSnapshot();
  state.edits = [
    { sessionId: 'other', filePath: join(repo, 'design/snap/a.txt') },
    { sessionId: 'other', filePath: join(repo, 'design/snap/b.txt') },
    { sessionId: 'me', filePath: join(repo, 'design/snap/b.txt') },
    { sessionId: 'other', filePath: join(repo, 'outside.txt') },
  ];
  state.titles = { other: 'Refactor tokens' };
  const target = await resolveGitCommitProposalTarget('me', repo, ['design/snap/', 'outside.txt']);
  expect(state.lookups).toBe(1);
  const flagged = target.fileDetails!.filter(file => file.otherSession).map(file => [file.path, file.otherSession]);
  // b.txt was also edited here, and an explicitly listed file is never flagged.
  expect(flagged).toEqual([[join(repo, 'design/snap/a.txt'), { ownership: 'other-session', sessionId: 'other', sessionTitle: 'Refactor tokens' }]]);
});

// Review: after `git rm -r`, the index has no entries under the path, so it fell through as a file.
it('expands a directory whose deletion is fully staged', async () => {
  seedSnapshot();
  assertGitSandbox(repo, scratch);
  git(['rm', '-rq', '--cached', 'design']);
  rmSync(join(repo, 'design'), { recursive: true });
  const target = await resolveGitCommitProposalTarget('me', repo, ['design/snap']);
  expect(target.fileDetails?.map(f => [f.path.slice(repo.length + 1), f.status])).toEqual(
    ['a', 'b', 'c', 'd'].map(name => [`design/snap/${name}.txt`, 'deleted']),
  );
  const result = await executeGitCommit(repo, 'remove snapshot', target.files, { env: env as Record<string, string> });
  expect(result.error).toBeUndefined();
});

// Review: a root exclude normalized to '' matched nothing instead of everything.
it('treats a repository-root exclude as excluding every file', async () => {
  seedSnapshot();
  for (const root of ['.', './']) {
    await expect(resolveGitCommitProposalTarget('me', repo, ['design/snap'], undefined, { excludePaths: [root] }))
      .rejects.toThrow('excludePaths removed every file');
  }
});
