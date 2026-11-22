// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  target: vi.fn(async (): Promise<any> => null),
  emit: vi.fn(),
  commit: vi.fn(async () => ({ success: true, commitHash: 'abc' })),
  record: { workspacePath: '/main', filesToStage: ['/main/a.txt'] } as Record<string, unknown>,
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: { emit: mocks.emit } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: async () => ({ workspacePath: '/main' }) } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: { create: async () => {} } }));
vi.mock('../../../utils/logger', () => ({ logger: { ai: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } } }));
vi.mock('../../../tray/TrayManager', () => ({ TrayManager: { getInstance: () => ({ onPromptResolved: vi.fn() }) } }));
vi.mock('../gitCommitProposalPromptUtils', () => ({
  getGitCommitProposalResponseChannel: () => 'channel',
  resolveGitCommitProposalPromptId: async (_s: string, id: string) => id,
  findGitCommitProposalWorktreeTarget: mocks.target,
  loadGitCommitProposalRecord: async () => mocks.record,
}));
vi.mock('../../gitEnv', () => ({ getGitSubprocessEnv: () => ({}) }));
vi.mock('../../SessionCommitService', () => ({ SessionCommitService: { getInstance: () => ({ recordCommit: async () => {} }) } }));
vi.mock('../../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../WorktreeStore', () => ({ createWorktreeStore: () => ({}) }));
vi.mock('../../GitCommitService', () => ({
  executeGitCommitAcrossRepos: mocks.commit,
  createGitCommitProposalResponse: () => ({ action: 'committed', commitHash: 'abc' }),
}));
vi.mock('../../workspaceRepos', () => ({ resolveExtraCommitRoots: () => [] }));
vi.mock('../CommitProposalExecution', () => ({
  runCommitProposalOnce: async (_s: string, _p: string, _i: string, run: () => Promise<unknown>) => run(),
  commitProposalIdentity: () => 'identity',
  cancelCommitProposalOnce: async () => true,
  acceptsCommitProposalResponse: () => true,
}));

import { handleGitCommitResponse } from '../MobileGitCommitResponse';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.target.mockResolvedValue(null);
  mocks.record = { workspacePath: '/main', filesToStage: ['/main/a.txt'] };
});

// #1756: mobile cannot show the target branch and path, so it must not approve a sibling-worktree commit.
it('refuses a sibling-worktree commit from mobile without closing the desktop proposal', async () => {
  mocks.target.mockResolvedValue({ path: '/main_worktrees/feature', branch: 'feature' });
  const result = await handleGitCommitResponse('session', 'proposal', { action: 'committed', files: ['/main_worktrees/feature/a.txt'], message: 'fix: x' }, () => null);
  expect(result).toMatchObject({ action: 'error', error: expect.stringContaining('desktop') });
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(mocks.emit).not.toHaveBeenCalled();
});

it('still commits an ordinary proposal from mobile', async () => {
  const result = await handleGitCommitResponse('session', 'proposal', { action: 'committed', files: ['/main/a.txt'], message: 'fix: x' }, () => null);
  expect(result.action).toBe('committed');
  expect(mocks.commit).toHaveBeenCalled();
});

// #1955: the phone may only commit files the stored proposal lists.
it('refuses a mobile commit that adds a file the proposal did not list', async () => {
  const result = await handleGitCommitResponse('session', 'proposal', { action: 'committed', files: ['/main/a.txt', '/main/b.txt'], message: 'fix: x' }, () => null);
  expect(result).toMatchObject({ action: 'error', error: expect.stringContaining('not in the proposal: /main/b.txt') });
  expect(mocks.commit).not.toHaveBeenCalled();
});

// Review blocker: the phone cannot show which files arrive unchecked, so it must not approve another session's files.
it('refuses a mobile approval of a proposal with another session\'s files, leaving it open on desktop', async () => {
  mocks.record = {
    workspacePath: '/main',
    filesToStage: ['/main/a.txt', { path: '/main/dir/b.txt', status: 'added', fromDirectory: 'dir/', otherSession: { ownership: 'other-session', sessionId: 'x' } }],
  };
  const result = await handleGitCommitResponse('session', 'proposal', { action: 'committed', files: ['/main/a.txt'], message: 'fix: x' }, () => null);
  expect(result).toMatchObject({ action: 'error', error: expect.stringContaining('desktop') });
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(mocks.emit).not.toHaveBeenCalled();
});
