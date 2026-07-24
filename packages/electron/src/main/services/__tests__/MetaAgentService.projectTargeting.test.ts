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

describe('MetaAgentService project-targeted session routing (NIM-408)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    hasLiveWindowForWorkspaceMock.mockReset();
    createWorktreeMock.mockReset();
    worktreeStoreCreateMock.mockReset();
    worktreeStoreListMock.mockReset();
    worktreeStoreGetMock.mockReset();
    worktreeStoreGetAllNamesMock.mockReset().mockResolvedValue([]);
    worktreeStoreGetSessionsMock.mockReset();
    databaseQueryMock.mockReset().mockResolvedValue({ rows: [{ in_flight: '0', total: '0' }] });
    queuedPromptsListMock.mockReset().mockResolvedValue([]);
    const priorityRow = {
      id: 'control-project-b',
      sessionId: 'target-child',
      status: 'pending',
      deliveryClass: 'control',
      priorityRank: 100,
      deliveryReady: false,
      interruptTargetGeneration: null,
      interruptReservationOwner: null,
      interruptReceipt: null,
    };
    createPriorityControlPromptMock.mockReset().mockResolvedValue({
      row: priorityRow,
      replayed: false,
    });
    reservePriorityInterruptMock.mockReset().mockImplementation(
      async ({ generation, owner }) => ({
        row: {
          ...priorityRow,
          interruptTargetGeneration: generation,
          interruptReservationOwner: owner,
        },
        reserved: true,
      }),
    );
    recordPriorityInterruptReceiptMock.mockReset().mockImplementation(
      async ({ generation, receipt }) => ({
        ...priorityRow,
        status: 'executing',
        interruptTargetGeneration: generation,
        interruptReservationOwner: 'owner-project-b',
        interruptReceipt: receipt,
      }),
    );
    getQueuedPromptMock.mockReset().mockResolvedValue(priorityRow);
    setMetaAgentToolFnsMock.mockReset();
    vi.mocked(AISessionsRepository.get).mockReset();
    vi.mocked(AISessionsRepository.create).mockReset();
    vi.mocked(AISessionsRepository.updateMetadata).mockReset();
  });

  it('creates an isolated fresh worktree session in an already-loaded target project', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = {
      queuePromptForSession: vi.fn(async () => ({ id: 'queue-1', prompt: 'Do the work' })),
      triggerQueuedPromptProcessingForSession: vi.fn(async () => undefined),
    };

    vi.mocked(AISessionsRepository.get).mockImplementation(async (sessionId: string) =>
      sessionId === 'caller' ? caller as any : null,
    );
    hasLiveWindowForWorkspaceMock.mockReturnValue(true);
    createWorktreeMock.mockResolvedValue({
      id: 'target-worktree',
      name: 'safe-route',
      path: '/project-b_worktrees/safe-route',
      branch: 'worktree/safe-route',
      baseBranch: 'integration/v12',
      projectPath: '/project-b',
      createdAt: 1,
    });

    const result = JSON.parse(await (service as any).spawnSession('caller', '/project-a', {
      prompt: 'Do the work',
      title: 'Project B owner',
      isolated: true,
      useWorktree: true,
      targetWorkspacePath: '/project-b',
      baseBranch: 'integration/v12',
    }));

    expect(hasLiveWindowForWorkspaceMock).toHaveBeenCalledWith('/project-b');
    expect(createWorktreeMock).toHaveBeenCalledWith('/project-b', {
      name: 'safe-route',
      baseBranch: 'integration/v12',
    });
    expect(vi.mocked(AISessionsRepository.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: '/project-b',
        worktreeId: 'target-worktree',
        createdBySessionId: 'caller',
        parentSessionId: null,
      }),
    );
    expect(result).toMatchObject({
      isolated: true,
      sourceWorkspacePath: '/project-a',
      targetWorkspacePath: '/project-b',
      worktreeId: 'target-worktree',
      worktreePath: '/project-b_worktrees/safe-route',
      worktreeMode: 'new',
    });
  });

  it.each([
    [{ isolated: false, useWorktree: true }, 'isolated=true'],
    [{ isolated: true, useWorktree: false }, 'useWorktree=true'],
  ])('fails closed when cross-project creation omits a custody gate', async (flags, expected) => {
    const service = MetaAgentService.getInstance();
    vi.mocked(AISessionsRepository.get).mockResolvedValue(caller as any);
    hasLiveWindowForWorkspaceMock.mockReturnValue(true);

    await expect((service as any).spawnSession('caller', '/project-a', {
      prompt: 'Do the work',
      targetWorkspacePath: '/project-b',
      ...flags,
    })).rejects.toThrow(expected);
  });

  it('fails closed when the target project is not loaded in Nimbalyst', async () => {
    const service = MetaAgentService.getInstance();
    vi.mocked(AISessionsRepository.get).mockResolvedValue(caller as any);
    hasLiveWindowForWorkspaceMock.mockReturnValue(false);

    await expect((service as any).spawnSession('caller', '/project-a', {
      prompt: 'Do the work',
      isolated: true,
      useWorktree: true,
      targetWorkspacePath: '/project-b',
    })).rejects.toThrow('already-loaded target project');
  });

  it('allows the creator to supervise its cross-project child but hides unrelated sessions', async () => {
    const service = MetaAgentService.getInstance();
    vi.mocked(AISessionsRepository.get).mockImplementation(async (sessionId: string) => {
      if (sessionId === 'target-child') return targetChild as any;
      if (sessionId === 'unrelated') {
        return { ...targetChild, id: 'unrelated', createdBySessionId: 'someone-else' } as any;
      }
      return null;
    });
    databaseQueryMock.mockResolvedValueOnce({
      rows: [{
        id: 'target-child',
        title: 'Target child',
        provider: 'openai-codex',
        model: 'openai-codex:gpt-5.6-terra',
        status: 'idle',
        last_activity: 1,
        updated_at: 2,
        created_by_session_id: 'caller',
        agent_role: 'standard',
      }],
    });

    const status = JSON.parse(await (service as any).getSessionStatusJson(
      'caller',
      '/project-a',
      'target-child',
    ));
    expect(status.sessionId).toBe('target-child');
    expect(databaseQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('workspace_id = $2'),
      ['target-child', '/project-b'],
    );

    await expect((service as any).getSessionStatusJson(
      'caller',
      '/project-a',
      'unrelated',
    )).rejects.toThrow('Session unrelated not found');
  });

  it('keeps result, queue, prompt, and interactive-reply custody in the target workspace', async () => {
    const service = MetaAgentService.getInstance();
    vi.spyOn(service as any, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
    const queuePromptForSession = vi.fn(async () => ({ id: 'queue-2', prompt: 'Continue' }));
    const triggerQueuedPromptProcessingForSession = vi.fn(async () => undefined);
    const respondToInteractivePrompt = vi.fn(async () => ({ success: true }));
    (service as any).aiService = {
      queuePromptForSession,
      triggerQueuedPromptProcessingForSession,
      respondToInteractivePrompt,
    };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(targetChild as any);
    queuedPromptsListMock.mockResolvedValue([{
      id: 'queue-1',
      status: 'pending',
      prompt: 'Initial',
      createdAt: 1,
    }]);

    const buildResultSpy = vi.spyOn(service as any, 'buildSessionResultData').mockResolvedValue({
      sessionId: 'target-child',
      title: 'Target child',
      provider: 'openai-codex',
      model: 'openai-codex:gpt-5.6-terra',
      status: 'idle',
      lastActivity: 1,
      originalPrompt: 'Initial',
      userPrompts: ['Initial'],
      lastResponse: null,
      fullResponse: null,
      recentMessages: [],
      editedFiles: [],
      pendingPrompt: null,
      createdAt: 1,
      updatedAt: 2,
      worktreeId: 'target-worktree',
      toolScope: null,
    });

    await (service as any).getSessionResultJson('caller', '/project-a', 'target-child', {
      includeFullResponse: false,
    });
    expect(buildResultSpy).toHaveBeenCalledWith(
      'target-child',
      '/project-b',
      undefined,
      false,
    );

    const queue = JSON.parse(await (service as any).listQueuedPromptsJson(
      'caller',
      '/project-a',
      'target-child',
      {},
    ));
    expect(queue.prompts[0].id).toBe('queue-1');

    databaseQueryMock.mockResolvedValueOnce({
      rows: [{
        id: 'target-child',
        title: 'Target child',
        provider: 'openai-codex',
        model: 'openai-codex:gpt-5.6-terra',
        status: 'idle',
        last_activity: 1,
        updated_at: 2,
        created_by_session_id: 'caller',
        agent_role: 'standard',
      }],
    });
    const sent = JSON.parse(await (service as any).sendPromptToSession(
      'caller',
      '/project-a',
      'target-child',
      'Continue',
    ));
    expect(sent.processingTriggered).toBe(true);
    expect(triggerQueuedPromptProcessingForSession).toHaveBeenCalledWith(
      'target-child',
      '/project-b_worktrees/safe-route',
    );

    await (service as any).respondToPrompt('caller', '/project-a', {
      sessionId: 'target-child',
      promptId: 'prompt-1',
      promptType: 'ask_user_question_request',
      response: { answers: { question: 'answer' } },
    });
    expect(respondToInteractivePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'target-child', promptId: 'prompt-1' }),
    );
  });

  it('routes send_prompt_now to the creator-owned project-B child and hides unrelated sessions', async () => {
    const service = MetaAgentService.getInstance();
    const targetState = {
      status: 'idle',
      generation: 'idle:1:2',
      lastActivity: 1,
      updatedAt: 2,
    };
    const getPriorityTargetStateSpy = vi.spyOn(
      service as any,
      'getPriorityTargetState',
    ).mockResolvedValue(targetState);
    vi.spyOn(service as any, 'getPendingInteractivePrompt').mockResolvedValue(null);
    const triggerQueuedPromptProcessingForSession = vi.fn(async () => true);
    (service as any).aiService = {
      interruptCurrentTurnForSession: vi.fn(),
      triggerQueuedPromptProcessingForSession,
    };
    vi.mocked(AISessionsRepository.get).mockImplementation(async (sessionId: string) => {
      if (sessionId === 'target-child') return targetChild as any;
      if (sessionId === 'unrelated') {
        return { ...targetChild, id: 'unrelated', createdBySessionId: 'someone-else' } as any;
      }
      return null;
    });

    const receipt = JSON.parse(await (service as any).sendPromptNowToSession(
      'caller',
      '/project-a',
      {
        sessionId: 'target-child',
        prompt: 'Priority directive',
        idempotencyKey: 'project-b-priority-1',
      },
    ));

    expect(receipt).toMatchObject({
      sessionId: 'target-child',
      action: 'processing_triggered',
      processingTriggerCalled: true,
      processingTriggerAccepted: true,
    });
    expect(getPriorityTargetStateSpy).toHaveBeenCalledWith(
      'target-child',
      '/project-b',
    );
    expect(triggerQueuedPromptProcessingForSession).toHaveBeenCalledWith(
      'target-child',
      '/project-b_worktrees/safe-route',
    );

    await expect((service as any).sendPromptNowToSession(
      'caller',
      '/project-a',
      {
        sessionId: 'unrelated',
        prompt: 'Unauthorized directive',
        idempotencyKey: 'project-b-priority-2',
      },
    )).rejects.toThrow('Session unrelated not found');
  });

  it('lists creator-owned children across projects with workspace and launch provenance', async () => {
    const service = MetaAgentService.getInstance();
    const launchConfiguration = {
      requested: { model: null },
      resolved: { model: 'openai-codex:gpt-5.6-terra' },
      effectiveness: 'not-provider-confirmed',
    };
    databaseQueryMock.mockResolvedValueOnce({
      rows: [{
        id: 'target-child',
        title: 'Target child',
        provider: 'openai-codex',
        model: 'openai-codex:gpt-5.6-terra',
        status: 'idle',
        last_activity: 1,
        created_at: 1,
        updated_at: 2,
        worktree_id: 'target-worktree',
        created_by_session_id: 'caller',
        agent_role: 'standard',
        workspace_id: '/project-b',
        metadata: JSON.stringify({ launchConfiguration }),
      }],
    });
    const buildResultSpy = vi.spyOn(
      service as any,
      'buildSessionResultData',
    ).mockResolvedValue({
      sessionId: 'target-child',
      title: 'Target child',
      provider: 'openai-codex',
      model: 'openai-codex:gpt-5.6-terra',
      status: 'idle',
      lastActivity: 1,
      originalPrompt: 'Initial',
      userPrompts: ['Initial'],
      lastResponse: null,
      fullResponse: null,
      recentMessages: [],
      editedFiles: [],
      pendingPrompt: null,
      createdAt: 1,
      updatedAt: 2,
      worktreeId: 'target-worktree',
      toolScope: null,
      launchConfiguration,
    });

    const sessions = await (service as any).getSpawnedSessions('caller', '/project-a');

    expect(databaseQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('WHERE created_by_session_id = $1'),
      ['caller'],
    );
    expect(buildResultSpy).toHaveBeenCalledWith(
      'target-child',
      '/project-b',
      expect.objectContaining({
        metadata: JSON.stringify({ launchConfiguration }),
      }),
      false,
    );
    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: 'target-child',
        workspacePath: '/project-b',
        launchConfiguration,
      }),
    ]);
  });

  it('exposes creation and supervision through the injected MCP tool route', async () => {
    const service = MetaAgentService.getInstance();
    vi.spyOn(service as any, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
    const aiService = {
      queuePromptForSession: vi.fn(async (_sessionId: string, prompt: string) => ({
        id: 'queue-public',
        prompt,
      })),
      triggerQueuedPromptProcessingForSession: vi.fn(async () => undefined),
    };
    await service.start(aiService as any, vi.fn());

    const fns = vi.mocked(setMetaAgentToolFns).mock.calls[0][0];
    let createdSessionId = '';
    vi.mocked(AISessionsRepository.get).mockImplementation(async (sessionId: string) => {
      if (sessionId === 'caller') return caller as any;
      if (sessionId === createdSessionId) {
        return { ...targetChild, id: createdSessionId } as any;
      }
      return null;
    });
    vi.mocked(AISessionsRepository.create).mockImplementation(async (input: any) => {
      createdSessionId = input.id;
      return input;
    });
    hasLiveWindowForWorkspaceMock.mockReturnValue(true);
    createWorktreeMock.mockResolvedValue({
      id: 'target-worktree',
      name: 'safe-route',
      path: '/project-b_worktrees/safe-route',
      branch: 'worktree/safe-route',
      baseBranch: 'integration/v12',
      projectPath: '/project-b',
      createdAt: 1,
    });

    const spawned = JSON.parse(await fns.spawnSession('caller', '/project-a', {
      prompt: 'Do the work',
      isolated: true,
      useWorktree: true,
      targetWorkspacePath: '/project-b',
      baseBranch: 'integration/v12',
    }));
    expect(spawned.sessionId).toBe(createdSessionId);
    expect(spawned.targetWorkspacePath).toBe('/project-b');

    databaseQueryMock.mockResolvedValueOnce({
      rows: [{
        id: createdSessionId,
        title: 'Target child',
        provider: 'openai-codex',
        model: 'openai-codex:gpt-5.6-terra',
        status: 'idle',
        last_activity: 1,
        updated_at: 2,
        created_by_session_id: 'caller',
        agent_role: 'standard',
      }],
    });
    const status = JSON.parse(await fns.getSessionStatus(
      'caller',
      '/project-a',
      createdSessionId,
    ));
    expect(status).toMatchObject({ sessionId: createdSessionId, status: 'idle' });
  });
});
