// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  target: vi.fn(),
  commit: vi.fn(async (..._args: any[]): Promise<any> => ({ success: false, error: 'test stopped at Git boundary' })),
  create: vi.fn(async (_row: any) => {}),
  send: vi.fn(),
  auto: true,
  ipcOn: vi.fn(),
  outcome: vi.fn(async (_opts: any): Promise<any> => ({ kind: 'not-committed' })),
  cancel: vi.fn(async (_s: string, _p: string) => true),
}));
vi.mock('electron', () => ({ BrowserWindow: { fromId: () => ({ isDestroyed: () => false, webContents: { send: mocks.send } }) }, ipcMain: { on: mocks.ipcOn, removeListener: vi.fn() } }));
vi.mock('../../utils/privateSettingsStore', () => ({ default: class { get() { return mocks.auto; } } }));
vi.mock('../../services/gitCommitProposalTarget', () => ({ resolveGitCommitProposalTarget: mocks.target }));
vi.mock('../../services/GitCommitService', () => ({
  executeGitCommitAcrossRepos: mocks.commit,
  createGitCommitProposalResponse: (r: any) => r.success ? { action: 'committed', commitHash: r.commitHash } : { action: 'error', error: r.error },
}));
vi.mock('../../services/ai/CommitProposalExecution', () => ({
  runCommitProposalOnce: async (_s: string, _p: string, _i: string, run: () => Promise<unknown>) => run(),
  commitProposalIdentity: () => 'identity',
  commitProposalOutcome: mocks.outcome,
  cancelCommitProposalOnce: mocks.cancel,
}));
vi.mock('../tools/promptResponsePoll', () => ({ findGitCommitProposalResponse: async () => null, findToolPermissionResponse: async () => null }));
vi.mock('../../services/CommitTrackerLinker', () => ({ commitTrackerLinker: { linkBySession: async () => ({ closedItemIds: [] }) } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: { create: mocks.create } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: async () => ({ title: 'Session' }) } }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: async () => ({ rows: [] }) } }));
vi.mock('../mcpWorkspaceResolver', () => ({ findWindowIdForWorkspacePath: async () => 1 }));
vi.mock('../tools/codexToolCallResolver', () => ({ resolveToolUseIdFromMcpRequest: async () => 'tool-1' }));
vi.mock('../../services/gitEnv', () => ({ getGitSubprocessEnv: () => ({}) }));
vi.mock('../../services/ai/pendingPromptPersistence', () => ({ setSessionPendingPrompt: async () => {} }));
vi.mock('../tools/askUserQuestionHandler', () => ({}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({}));
vi.mock('../../services/NotificationService', () => ({ notificationService: { showBlockedNotification: vi.fn() } }));
vi.mock('../tools/interactivePromptTranscript', () => ({}));
vi.mock('../tools/interactivePromptSettleState', () => ({}));
vi.mock('../../services/ai/claudeCliToolResultSeen', () => ({}));
vi.mock('../../services/ai/claudeCliToolPermission', () => ({}));
vi.mock('../../services/ai/claudeCliPermissionCache', () => ({}));
vi.mock('../../services/ai/claudeCliUserPromptLog', () => ({}));
vi.mock('../../services/ClaudeSettingsManager', () => ({}));
vi.mock('../../services/PermissionService', () => ({}));
vi.mock('../../services/SessionCommitService', () => ({ SessionCommitService: { getInstance: () => ({ recordCommit: async () => {} }) } }));

import { handleGitCommitProposal } from '../tools/interactiveToolHandlers';
import { closeWaitingCommitProposals, isCommitProposalInFlight } from '@nimbalyst/runtime/ai/server/commitProposalInFlight';

const LOCK_TIMEOUT = "Git operation 'git:commit' timed out waiting for lock on /worktree";
const text = (result: any) => result.content.map((c: any) => c.text).join('\n');
const proposalRow = () => mocks.create.mock.calls.map(([row]) => JSON.parse(row.content)).find(row => row.type === 'git_commit_proposal');
/** Answers the manual widget's IPC channel once the handler has registered it. */
async function answerWidget(response: Record<string, unknown>) {
  await vi.waitFor(() => expect(mocks.ipcOn).toHaveBeenCalled());
  const [, listener] = mocks.ipcOn.mock.calls[0];
  listener(null, response);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auto = true;
  mocks.outcome.mockResolvedValue({ kind: 'not-committed' });
  mocks.cancel.mockResolvedValue(true);
  mocks.target.mockResolvedValue({ workspacePath: '/worktree', repoPath: '/worktree', files: ['/worktree/shared.txt'] });
});

it('uses the resolved checkout for auto-commit, durable proposals, and voice events', async () => {
  await handleGitCommitProposal({ filesToStage: ['shared.txt'], commitMessage: 'test', reasoning: 'test' }, 'session', '/parent', {});
  expect(mocks.target).toHaveBeenCalledWith('session', '/parent', ['shared.txt'], undefined);
  expect(mocks.commit).toHaveBeenCalledWith('/worktree', 'test', ['/worktree/shared.txt'], expect.objectContaining({ repoPath: '/worktree' }));
  const proposals = mocks.create.mock.calls.map(([row]) => JSON.parse(row.content));
  expect(proposals.find(row => row.type === 'git_commit_proposal')).toMatchObject({ workspacePath: '/worktree', repoPath: '/worktree', filesToStage: ['/worktree/shared.txt'], commitTargetVersion: 2 });
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

// #1682: the outcome is the proposal's own execution record, keyed by its proposal id.
it('reports a commit after an auto-commit lock timeout only when this proposal recorded one', async () => {
  mocks.commit.mockResolvedValue({ success: false, error: LOCK_TIMEOUT });
  mocks.outcome.mockResolvedValue({ kind: 'committed', commitHash: 'abc1234', commitDate: '2026-10-16T00:00:00Z' });
  const result = await handleGitCommitProposal({ filesToStage: ['shared.txt'], commitMessage: 'fix: x' }, 'session', '/parent', {});
  expect(result.isError).toBe(false);
  expect(text(result)).toContain('abc1234');
  expect(mocks.outcome).toHaveBeenCalledWith('session', 'tool-1');
});

it('says plainly that this call made no commit after an auto-commit lock timeout', async () => {
  mocks.commit.mockResolvedValue({ success: false, error: LOCK_TIMEOUT });
  const result = await handleGitCommitProposal({ filesToStage: ['shared.txt'], commitMessage: 'fix: x' }, 'session', '/parent', {});
  expect(result.isError).toBe(true);
  expect(text(result)).toMatch(/timed out waiting for lock[\s\S]*No commit was made by this call\. It is safe to retry/);
});

// #1682: send-now, meta-agent and teammate interrupts consult this while the call runs.
it('marks the commit call in flight for exactly as long as the auto-commit runs', async () => {
  let duringCommit = false;
  mocks.commit.mockImplementation(async () => {
    duringCommit = isCommitProposalInFlight('session');
    return { success: true, commitHash: 'abc1234' };
  });
  await handleGitCommitProposal({ filesToStage: ['shared.txt'], commitMessage: 'fix: x' }, 'session', '/parent', {});
  expect(duringCommit).toBe(true);
  expect(isCommitProposalInFlight('session')).toBe(false);
});

it('hands the auto-commit an abort signal tied to the MCP call so a real Stop is honored', async () => {
  const controller = new AbortController();
  mocks.commit.mockImplementation(async (_ws: string, _msg: string, _files: string[], options: any) => {
    controller.abort();
    return { success: false, error: options.signal?.aborted ? 'Commit cancelled before it started' : 'signal not wired' };
  });
  await handleGitCommitProposal({ filesToStage: ['shared.txt'], commitMessage: 'fix: x' }, 'session', '/parent', {}, { signal: controller.signal } as any);
  expect(mocks.commit.mock.calls[0][3].signal?.aborted).toBe(true);
});

// #1682: the manual path reconciles cancelled/error answers against the proposal's execution record too.
it('reports a landed commit when the manual widget answers with an error', async () => {
  mocks.auto = false;
  mocks.outcome.mockResolvedValue({ kind: 'committed', commitHash: 'def5678', commitDate: '2026-10-16T00:00:00Z' });
  const pending = handleGitCommitProposal({ filesToStage: ['shared.txt'], commitMessage: 'fix: x' }, 'session', '/parent', {});
  await vi.waitFor(() => expect(mocks.ipcOn).toHaveBeenCalled());
  expect(isCommitProposalInFlight('session')).toBe(true);
  await answerWidget({ action: 'error', error: LOCK_TIMEOUT });
  const result = await pending;
  expect(result.isError).toBe(false);
  expect(text(result)).toContain('def5678');
  expect(isCommitProposalInFlight('session')).toBe(false);
});

it('says no commit was made when the manual widget is cancelled and nothing landed', async () => {
  mocks.auto = false;
  const pending = handleGitCommitProposal({ filesToStage: ['shared.txt'], commitMessage: 'fix: x' }, 'session', '/parent', {});
  await answerWidget({ action: 'cancelled' });
  expect(text(await pending)).toMatch(/cancelled[\s\S]*No commit was made by this call\./);
});

// NIM-7642: the user's send-now goes through a proposal still waiting on them.
it('closes a waiting proposal for good when the user sends a new message instead', async () => {
  mocks.auto = false;
  const pending = handleGitCommitProposal({ filesToStage: ['shared.txt'], commitMessage: 'fix: x' }, 'session', '/parent', {});
  await vi.waitFor(() => expect(mocks.ipcOn).toHaveBeenCalled());
  expect(await closeWaitingCommitProposals('session')).toBe(1);
  const result = await pending;
  expect(mocks.cancel).toHaveBeenCalledWith('session', 'tool-1');
  expect(text(result)).toMatch(/sent a new message[\s\S]*No commit was made by this call\./);
  const rows = mocks.create.mock.calls.map(([row]) => JSON.parse(row.content));
  expect(rows).toContainEqual(expect.objectContaining({ type: 'git_commit_proposal_response', proposalId: 'tool-1', action: 'cancelled' }));
  expect(isCommitProposalInFlight('session')).toBe(false);
  expect(await closeWaitingCommitProposals('session')).toBe(0);
});

it('leaves a proposal to the commit the user already confirmed', async () => {
  mocks.auto = false;
  mocks.cancel.mockResolvedValue(false);
  const pending = handleGitCommitProposal({ filesToStage: ['shared.txt'], commitMessage: 'fix: x' }, 'session', '/parent', {});
  await vi.waitFor(() => expect(mocks.ipcOn).toHaveBeenCalled());
  expect(await closeWaitingCommitProposals('session')).toBe(0);
  expect(isCommitProposalInFlight('session')).toBe(true);
  await answerWidget({ action: 'committed', commitHash: 'abc1234' });
  expect(text(await pending)).toContain('abc1234');
});

// Re-review: a throwing outcome lookup (ENOSPC) left the call pending and interrupts held forever.
it('still settles both paths and releases the in-flight mark when the outcome lookup fails', async () => {
  mocks.outcome.mockRejectedValue(new Error('ENOSPC: no space left on device'));
  mocks.commit.mockResolvedValue({ success: false, error: LOCK_TIMEOUT });
  const auto = await handleGitCommitProposal({ filesToStage: ['shared.txt'], commitMessage: 'fix: x' }, 'session', '/parent', {});
  expect(auto.isError).toBe(true);
  expect(text(auto)).toMatch(/Could not read this proposal's execution record/);
  expect(isCommitProposalInFlight('session')).toBe(false);

  mocks.auto = false;
  const pending = handleGitCommitProposal({ filesToStage: ['shared.txt'], commitMessage: 'fix: x' }, 'session', '/parent', {});
  await answerWidget({ action: 'cancelled' });
  expect(text(await pending)).toMatch(/cancelled[\s\S]*Could not read this proposal's execution record/);
  expect(isCommitProposalInFlight('session')).toBe(false);
});

// #1756: an explicit sibling worktree is never committed automatically.
it('always asks for manual approval for a sibling worktree target, even with auto-commit on', async () => {
  mocks.target.mockResolvedValue({
    workspacePath: '/sibling', repoPath: '/sibling', files: ['/sibling/shared.txt'],
    worktree: { path: '/sibling', branch: 'feature' },
  });
  const pending = handleGitCommitProposal({ workingDirectory: '/sibling', filesToStage: ['shared.txt'], commitMessage: 'fix: x' }, 'session', '/parent', {});
  await vi.waitFor(() => expect(mocks.ipcOn).toHaveBeenCalled());
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(proposalRow()).toMatchObject({ autoApproved: false, targetWorktree: { path: '/sibling', branch: 'feature' } });
  const toolUse = mocks.create.mock.calls.map(([row]) => JSON.parse(row.content)).find(row => row.type === 'nimbalyst_tool_use');
  // The widget reads only this row's input, so the approval mode must ride on it.
  expect(toolUse.input).toMatchObject({ targetWorktree: { path: '/sibling', branch: 'feature' }, autoApproved: false });
  expect(mocks.send).toHaveBeenCalledWith('ai:gitCommitProposal', expect.objectContaining({ autoApproved: false }));
  await answerWidget({ action: 'cancelled' });
  await pending;
});
