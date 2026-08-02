import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  hasLiveWindowForWorkspaceMock,
  createWorktreeMock,
  worktreeStoreCreateMock,
  worktreeStoreListMock,
  worktreeStoreGetMock,
  worktreeStoreGetAllNamesMock,
  worktreeStoreGetSessionsMock,
  databaseQueryMock,
  queuedPromptsListMock,
  createPriorityControlPromptMock,
  reservePriorityInterruptMock,
  recordPriorityInterruptReceiptMock,
  getQueuedPromptMock,
  setMetaAgentToolFnsMock,
  resolveClaudeCodeBackendMock,
  resolveClaudeCodeBackendForConfigMock,
  preflightOllamaClaudeCodeBackendMock,
} = vi.hoisted(() => ({
  hasLiveWindowForWorkspaceMock: vi.fn(),
  createWorktreeMock: vi.fn(),
  worktreeStoreCreateMock: vi.fn(),
  worktreeStoreListMock: vi.fn(),
  worktreeStoreGetMock: vi.fn(),
  worktreeStoreGetAllNamesMock: vi.fn(),
  worktreeStoreGetSessionsMock: vi.fn(),
  databaseQueryMock: vi.fn(),
  queuedPromptsListMock: vi.fn(),
  createPriorityControlPromptMock: vi.fn(),
  reservePriorityInterruptMock: vi.fn(),
  recordPriorityInterruptReceiptMock: vi.fn(),
  getQueuedPromptMock: vi.fn(),
  setMetaAgentToolFnsMock: vi.fn(),
  resolveClaudeCodeBackendMock: vi.fn(),
  resolveClaudeCodeBackendForConfigMock: vi.fn(),
  preflightOllamaClaudeCodeBackendMock: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    create: vi.fn(),
    updateMetadata: vi.fn(),
    get: vi.fn(),
  },
  AgentMessagesRepository: {
    create: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
  },
  SessionFilesRepository: {
    getFilesBySession: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  SessionManager: class {
    async initialize() {}
  },
  resolveClaudeCodeBackend: resolveClaudeCodeBackendMock,
  resolveClaudeCodeBackendForConfig: resolveClaudeCodeBackendForConfigMock,
}));

vi.mock('../ai/OllamaClaudeCodePreflight', () => ({
  preflightOllamaClaudeCodeBackend: preflightOllamaClaudeCodeBackendMock,
}));

vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => {
      const split = id.indexOf(':');
      if (split <= 0) throw new Error(`invalid model: ${id}`);
      return { provider: id.slice(0, split), model: id.slice(split + 1), combined: id };
    },
    tryParse: (id: string) => {
      const split = typeof id === 'string' ? id.indexOf(':') : -1;
      return split > 0
        ? { provider: id.slice(0, split), model: id.slice(split + 1), combined: id }
        : null;
    },
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn(() => () => {}) }),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../window/windowState', () => ({
  hasLiveWindowForWorkspace: hasLiveWindowForWorkspaceMock,
}));

vi.mock('../../utils/workspaceDetection', () => ({
  resolveProjectPath: (workspacePath: string) => workspacePath,
}));

vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({
  getDefaultAIModel: () => 'openai-codex:gpt-5.6-terra',
  getDefaultEffortLevel: () => undefined,
}));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (value: unknown) => value }));
vi.mock('../WorktreeStore', () => ({
  createWorktreeStore: () => ({
    create: worktreeStoreCreateMock,
    list: worktreeStoreListMock,
    get: worktreeStoreGetMock,
    getAllNames: worktreeStoreGetAllNamesMock,
    getWorktreeSessions: worktreeStoreGetSessionsMock,
  }),
}));
vi.mock('../GitWorktreeService', () => ({
  GitWorktreeService: class {
    createWorktree = createWorktreeMock;
    getExistingWorktreeDirectories = vi.fn(() => []);
    getAllBranchNames = vi.fn(async () => []);
    generateUniqueWorktreeName = vi.fn(() => 'safe-route');
  },
}));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: databaseQueryMock },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../../file/GitRefWatcher', () => ({
  gitRefWatcher: { start: vi.fn(async () => undefined) },
}));
vi.mock('../RepositoryManager', () => ({
  getQueuedPromptsStore: () => ({
    listForSession: queuedPromptsListMock,
    createPriorityControlPrompt: createPriorityControlPromptMock,
    reservePriorityInterrupt: reservePriorityInterruptMock,
    recordPriorityInterruptReceipt: recordPriorityInterruptReceiptMock,
    get: getQueuedPromptMock,
  }),
}));
vi.mock('../ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: setMetaAgentToolFnsMock }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: vi.fn(),
  extractUserPrompts: vi.fn(() => []),
}));

import { AISessionsRepository } from '@nimbalyst/runtime';
import { setMetaAgentToolFns } from '../../mcp/metaAgentServer';
import { MetaAgentService } from '../MetaAgentService';

const caller = {
  id: 'caller',
  workspacePath: '/project-a',
  provider: 'openai-codex',
  model: 'openai-codex:gpt-5.6-terra',
  worktreeId: null,
  parentSessionId: null,
  sessionType: 'session',
};

const targetChild = {
  id: 'target-child',
  workspacePath: '/project-b',
  provider: 'openai-codex',
  model: 'openai-codex:gpt-5.6-terra',
  createdBySessionId: 'caller',
  worktreeId: 'target-worktree',
  worktreePath: '/project-b_worktrees/safe-route',
  title: 'Target child',
  createdAt: 1,
  updatedAt: 2,
};


describe('MetaAgentService priority delivery custody', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    databaseQueryMock.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM ai_sessions')) {
        return {
          rows: [{
            id: 'target-child',
            title: 'Target child',
            provider: 'openai-codex',
            model: 'openai-codex:gpt-5.6-terra',
            status: 'idle',
            last_activity: 10,
            updated_at: 20,
            created_by_session_id: 'caller',
            agent_role: 'standard',
          }],
        };
      }
      if (sql.includes('FROM ai_agent_messages')) return { rows: [] };
      return { rows: [] };
    });
    vi.mocked(AISessionsRepository.get).mockReset();
    createPriorityControlPromptMock.mockReset();
    reservePriorityInterruptMock.mockReset();
    recordPriorityInterruptReceiptMock.mockReset();
    getQueuedPromptMock.mockReset();
  });

  it('fails closed when the target session belongs to another workspace', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = {};
    vi.mocked(AISessionsRepository.get).mockResolvedValue(targetChild as any);

    await expect((service as any).sendPromptNowToSession('caller', '/project-a', {
      sessionId: 'target-child',
      prompt: 'priority',
      idempotencyKey: 'custody-1',
    })).rejects.toThrow('Session target-child not found');
    expect(createPriorityControlPromptMock).not.toHaveBeenCalled();
  });

  it('routes through the target workspace and replays one durable control identity', async () => {
    const service = MetaAgentService.getInstance();
    const trigger = vi.fn(async () => true);
    const releaseHandoff = vi.fn();
    (service as any).aiService = {
      interruptCurrentTurnForPriorityDelivery: vi.fn(),
      releasePriorityQueueHandoffForDelivery: releaseHandoff,
      triggerQueuedPromptProcessingForSession: trigger,
    };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(targetChild as any);

    const receipt = {
      generation: 'idle:10:20',
      attempted: false,
      success: true,
      method: 'not-required',
      error: null,
      nativeEntered: false,
      recordedAt: 30,
    };
    const row = {
      id: 'control-project-b',
      sessionId: 'target-child',
      status: 'pending',
      deliveryClass: 'control',
      priorityRank: 100,
      deliveryReady: true,
      interruptTargetGeneration: 'idle:10:20',
      interruptReservationOwner: 'owner-project-b',
      interruptReceipt: receipt,
    };
    createPriorityControlPromptMock.mockResolvedValue({ row, replayed: true });
    getQueuedPromptMock.mockResolvedValue(row);

    const result = JSON.parse(await (service as any).sendPromptNowToSession('caller', '/project-b', {
      sessionId: 'target-child',
      prompt: 'priority',
      idempotencyKey: 'custody-1',
      controlOperation: 'owner_handoff',
    }));

    expect(result).toMatchObject({
      sessionId: 'target-child',
      queuedPromptId: 'control-project-b',
      replayed: true,
      action: 'interrupt_receipt_replayed',
    });
    expect(createPriorityControlPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'target-child',
      idempotencyKey: 'custody-1',
      producer: 'send_prompt_now:caller',
      controlOperation: 'owner_handoff',
    }));
    expect(trigger).toHaveBeenCalledWith(
      'target-child',
      '/project-b_worktrees/safe-route',
      'meta-agent',
    );
    expect(releaseHandoff).toHaveBeenCalledWith('target-child');
  });
});
