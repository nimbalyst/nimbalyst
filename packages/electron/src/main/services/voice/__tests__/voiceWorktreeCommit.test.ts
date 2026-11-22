// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const target = vi.fn(async (_s?: string, _p?: string): Promise<any> => null);
  const files = { value: [] as unknown[] };
  return {
    target,
    files,
    record: vi.fn(async (s: string, p: string) => ({ targetWorktree: (await target(s, p)) ?? undefined, filesToStage: files.value })),
  };
});
vi.mock('../../ai/gitCommitProposalPromptUtils', () => ({
  resolveGitCommitProposalPromptId: async (_s: string, id: string) => `canonical-${id}`,
  loadGitCommitProposalRecord: mocks.record,
}));

import { refuseVoiceWorktreeCommit } from '../voiceWorktreeCommit';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.target.mockResolvedValue(null);
  mocks.files.value = [];
});

// #1756: desktop realtime voice answers by prompt id only; the proposal row says where it commits.
it('refuses a spoken approval of a commit into another worktree', async () => {
  mocks.target.mockResolvedValue({ path: '/repo_wt/feature', branch: 'feature' });
  expect(await refuseVoiceWorktreeCommit('s1', { promptId: 'p1', promptType: 'git_commit_proposal_request', answer: 'approve' }))
    .toMatch(/commit card on desktop/);
  expect(mocks.target).toHaveBeenCalledWith('s1', 'canonical-p1');
});

it('lets rejections, ordinary commits and other prompt types through', async () => {
  expect(await refuseVoiceWorktreeCommit('s1', { promptId: 'p1', promptType: 'git_commit_proposal_request', answer: 'approve' })).toBeNull();
  mocks.target.mockResolvedValue({ path: '/repo_wt/feature', branch: 'feature' });
  expect(await refuseVoiceWorktreeCommit('s1', { promptId: 'p1', promptType: 'git_commit_proposal_request', answer: 'reject' })).toBeNull();
  expect(await refuseVoiceWorktreeCommit('s1', { promptId: 'p1', promptType: 'exit_plan_mode_request', answer: 'approve' })).toBeNull();
  // Only the ordinary approval reads the proposal row; rejections and other types never touch it.
  expect(mocks.target).toHaveBeenCalledTimes(1);
});

// #1955: voice cannot show which files arrive unchecked, so it never approves another session's files.
it('refuses a spoken approval when the proposal has files another session edited', async () => {
  mocks.files.value = ['/repo/a.ts', { path: '/repo/dir/b.ts', status: 'added', fromDirectory: 'dir/' }];
  expect(await refuseVoiceWorktreeCommit('s1', { promptId: 'p1', promptType: 'git_commit_proposal_request', answer: 'approve' })).toBeNull();
  mocks.files.value = [{ path: '/repo/dir/c.ts', status: 'modified', fromDirectory: 'dir/', otherSession: { ownership: 'other-session', sessionId: 'x' } }];
  expect(await refuseVoiceWorktreeCommit('s1', { promptId: 'p1', promptType: 'git_commit_proposal_request', answer: 'approve' }))
    .toMatch(/another session edited/);
});
