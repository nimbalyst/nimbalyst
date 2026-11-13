// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ content: string }>,
  revalidate: vi.fn(async (_s: string, _p: string) => {}),
}));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: async () => ({ rows: mocks.rows }) } }));
vi.mock('../../gitCommitProposalTarget', () => ({
  revalidateProposalWorktree: mocks.revalidate,
  getSessionCommitCheckout: async () => '/session-worktree',
}));

import { assertFilesInStoredProposal, assertProposalIdentityPair, explainProposalCommitFailure, resolveProposalCommitPaths } from '../proposalCommitTarget';

const row = (content: Record<string, unknown>) => ({ content: JSON.stringify({ type: 'git_commit_proposal', ...content }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
});

// Review repro: a valid ordinary proposal id plus renderer-chosen paths pointed the commit at any repo.
it('takes an ordinary proposal\'s checkout and repo from its stored record', async () => {
  mocks.rows = [
    row({ proposalId: 'p1', commitTargetVersion: 2, workspacePath: '/session-worktree', repoPath: '/attached' }),
    row({ proposalId: 'p2', commitTargetVersion: 2, workspacePath: '/elsewhere', repoPath: '/elsewhere' }),
  ];
  expect(await resolveProposalCommitPaths('s1', 'p1')).toEqual({ workspacePath: '/session-worktree', repoPath: '/attached' });
  expect(mocks.revalidate).not.toHaveBeenCalled();
});

// Re-review repro: builds before the Sept 15 checkout fix stored the PARENT workspace while
// the widget committed in the session's worktree; trusting the record moved the commit to /main.
it('refuses a legacy or mismatched record instead of guessing its checkout', async () => {
  mocks.rows = [row({ proposalId: 'legacy', workspacePath: '/main', repoPath: '/main', filesToStage: ['a.ts'] })];
  await expect(resolveProposalCommitPaths('s1', 'legacy')).rejects.toThrow(/older version.*propose the commit again/);
  mocks.rows = [row({ proposalId: 'moved', commitTargetVersion: 2, workspacePath: '/main', repoPath: '/main' })];
  await expect(resolveProposalCommitPaths('s1', 'moved')).rejects.toThrow(/propose the commit again/);
});

it('revalidates a stored worktree target right before the commit runs', async () => {
  mocks.rows = [row({ proposalId: 'p1', workspacePath: '/wt', repoPath: '/wt', targetWorktree: { path: '/wt', branch: 'feature' } })];
  expect(await resolveProposalCommitPaths('s1', 'p1')).toEqual({ workspacePath: '/wt', repoPath: '/wt' });
  expect(mocks.revalidate).toHaveBeenCalledWith('s1', '/wt');
  mocks.revalidate.mockRejectedValueOnce(new Error('/wt is not a registered git worktree'));
  await expect(resolveProposalCommitPaths('s1', 'p1')).rejects.toThrow('not a registered git worktree');
});

it('refuses a proposal whose stored record has no checkout', async () => {
  await expect(resolveProposalCommitPaths('s1', 'missing')).rejects.toThrow('Refresh the session');
  mocks.rows = [row({ proposalId: 'p1' })];
  await expect(resolveProposalCommitPaths('s1', 'p1')).rejects.toThrow('Refresh the session');
});

// #1955: a proposal id used to choose only WHERE a commit landed; the caller could add any file to it.
it('refuses files the stored proposal does not list, before anything commits', async () => {
  mocks.rows = [row({
    proposalId: 'p1', commitTargetVersion: 2, workspacePath: '/session-worktree', repoPath: '/session-worktree',
    filesToStage: ['/session-worktree/a.ts', { path: '/session-worktree/dir/b.ts', status: 'added', fromDirectory: 'dir/' }],
  })];
  expect(await resolveProposalCommitPaths('s1', 'p1', ['/session-worktree/dir/b.ts', 'a.ts'])).toEqual({ workspacePath: '/session-worktree', repoPath: '/session-worktree' });
  await expect(resolveProposalCommitPaths('s1', 'p1', ['/session-worktree/a.ts', '/session-worktree/secret.env']))
    .rejects.toThrow('files not in the proposal: /session-worktree/secret.env');
  await expect(assertFilesInStoredProposal('s1', 'p1', ['dir/other.ts'], '/session-worktree')).rejects.toThrow('not in the proposal: dir/other.ts');
  mocks.rows = [row({ proposalId: 'p2', commitTargetVersion: 2, workspacePath: '/session-worktree' })];
  await expect(resolveProposalCommitPaths('s1', 'p2', ['a.ts'])).rejects.toThrow('does not record its files');
});

it('names a file that changed after the proposal instead of reporting a staging failure', () => {
  expect(explainProposalCommitFailure('Some selected files were not staged: dir/b.ts. Commit aborted.'))
    .toBe('dir/b.ts changed after the proposal (no longer has changes to commit). Nothing was committed. Ask the agent to propose the commit again.');
  expect(explainProposalCommitFailure("fatal: pathspec 'dir/gone.ts' did not match any files")).toMatch(/^dir\/gone.ts changed after the proposal/);
  expect(explainProposalCommitFailure('Unexpected files were staged: x. Commit aborted.')).toBe('Unexpected files were staged: x. Commit aborted.');
});

// Review: realpath on both sides let a proposed `link.txt -> other.txt` admit a submitted `other.txt`.
it('compares git entry paths, keeping symlink identity, and canonicalizes only the repository root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nim-proposal-symlink-'));
  try {
    writeFileSync(join(root, 'other.txt'), 'x');
    symlinkSync('other.txt', join(root, 'link.txt'));
    mocks.rows = [row({ proposalId: 'p1', commitTargetVersion: 2, workspacePath: root, repoPath: root, filesToStage: [join(root, 'link.txt')] })];
    await expect(assertFilesInStoredProposal('s1', 'p1', [join(root, 'other.txt')], root)).rejects.toThrow('not in the proposal');
    // The same entry through the canonical root (macOS /var -> /private/var) or relative is still the proposed file.
    await expect(assertFilesInStoredProposal('s1', 'p1', [join(realpathSync(root), 'link.txt'), 'link.txt'], root)).resolves.toBeUndefined();
    await expect(assertFilesInStoredProposal('s1', 'p1', [join(root, 'sub/../link.txt')], root)).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Review: a proposalId without a sessionId skipped every proposal check in git:commit.
it('rejects a commit carrying a proposal id without a session id, or the reverse', () => {
  expect(() => assertProposalIdentityPair(undefined, 'p1')).toThrow('both');
  expect(() => assertProposalIdentityPair('s1', undefined)).toThrow('both');
  expect(() => assertProposalIdentityPair('s1', 'p1')).not.toThrow();
  expect(() => assertProposalIdentityPair(undefined, undefined)).not.toThrow();
});
