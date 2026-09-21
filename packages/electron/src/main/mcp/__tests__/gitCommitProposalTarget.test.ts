// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  target: vi.fn(),
  commit: vi.fn(async () => ({ success: false, error: 'test stopped at Git boundary' })),
  create: vi.fn(async (_row: any) => {}),
  send: vi.fn(),
}));
vi.mock('electron', () => ({ BrowserWindow: { fromId: () => ({ isDestroyed: () => false, webContents: { send: mocks.send } }) }, ipcMain: {} }));
vi.mock('../../utils/privateSettingsStore', () => ({ default: class { get() { return true; } } }));
vi.mock('../../services/gitCommitProposalTarget', () => ({ resolveGitCommitProposalTarget: mocks.target }));
vi.mock('../../services/GitCommitService', () => ({ executeGitCommitAcrossRepos: mocks.commit, createGitCommitProposalResponse: (r: any) => ({ action: 'error', error: r.error }) }));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: { create: mocks.create } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: async () => ({ rows: [] }) } }));
vi.mock('../mcpWorkspaceResolver', () => ({ findWindowIdForWorkspacePath: async () => 1 }));
vi.mock('../tools/codexToolCallResolver', () => ({ resolveToolUseIdFromMcpRequest: async () => 'tool-1' }));
vi.mock('../../services/gitEnv', () => ({ getGitSubprocessEnv: () => ({}) }));
vi.mock('../../services/ai/pendingPromptPersistence', () => ({ setSessionPendingPrompt: async () => {} }));
vi.mock('../tools/askUserQuestionHandler', () => ({}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({}));
vi.mock('../../services/NotificationService', () => ({}));
vi.mock('../tools/interactivePromptTranscript', () => ({}));
vi.mock('../tools/interactivePromptSettleState', () => ({}));
vi.mock('../../services/ai/claudeCliToolResultSeen', () => ({}));
vi.mock('../../services/ai/claudeCliToolPermission', () => ({}));
vi.mock('../../services/ai/claudeCliPermissionCache', () => ({}));
vi.mock('../../services/ai/claudeCliUserPromptLog', () => ({}));
vi.mock('../../services/ClaudeSettingsManager', () => ({}));
vi.mock('../../services/PermissionService', () => ({}));
vi.mock('../../services/SessionCommitService', () => ({}));

import { handleGitCommitProposal } from '../tools/interactiveToolHandlers';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.target.mockResolvedValue({ workspacePath: '/worktree', repoPath: '/worktree', files: ['/worktree/shared.txt'] });
});

it('uses the resolved checkout for auto-commit, durable proposals, and voice events', async () => {
  await handleGitCommitProposal({ filesToStage: ['shared.txt'], commitMessage: 'test', reasoning: 'test' }, 'session', '/parent', {});
  expect(mocks.target).toHaveBeenCalledWith('session', '/parent', ['shared.txt'], undefined);
  expect(mocks.commit).toHaveBeenCalledWith('/worktree', 'test', ['/worktree/shared.txt'], expect.objectContaining({ repoPath: '/worktree' }));
  const proposals = mocks.create.mock.calls.map(([row]) => JSON.parse(row.content));
  expect(proposals.find(row => row.type === 'git_commit_proposal')).toMatchObject({ workspacePath: '/worktree', repoPath: '/worktree', filesToStage: ['/worktree/shared.txt'] });
  expect(proposals.find(row => row.type === 'nimbalyst_tool_use').input).toMatchObject({ repoPath: '/worktree', filesToStage: ['/worktree/shared.txt'] });
  expect(mocks.send).toHaveBeenCalledWith('ai:gitCommitProposal', expect.objectContaining({ workspacePath: '/worktree', filesToStage: ['/worktree/shared.txt'] }));
});

it('does not publish or execute a proposal when target validation fails', async () => {
  mocks.target.mockRejectedValue(new Error('workingDirectory is unsupported'));
  const result = await handleGitCommitProposal({ workingDirectory: '/other', filesToStage: ['shared.txt'], commitMessage: 'test' }, 'session', '/parent', {});
  expect(result.isError).toBe(true);
  expect(mocks.target).toHaveBeenCalledWith('session', '/parent', ['shared.txt'], '/other');
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.commit).not.toHaveBeenCalled();
});
