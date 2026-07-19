import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  updateSessionMetadata: vi.fn(),
  createMessage: vi.fn(),
  databaseQuery: vi.fn(),
  createWorktree: vi.fn(),
  persistWorktree: vi.fn(),
  getWorktree: vi.fn(),
  startGitRefWatcher: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    create: fixture.createSession,
    get: fixture.getSession,
    updateMetadata: fixture.updateSessionMetadata,
  },
  AgentMessagesRepository: { create: fixture.createMessage },
  SessionFilesRepository: {},
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ClaudeCodeProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexACPProvider: { setMetaAgentServerPort: vi.fn() },
  SessionManager: class {
    async initialize() {}
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => {
      const separator = id.indexOf(':');
      if (separator <= 0) throw new Error(`invalid model: ${id}`);
      const provider = id.slice(0, separator);
      const model = id.slice(separator + 1);
      return { provider, model, combined: `${provider}:${model}` };
    },
    tryParse: (id: string) => {
      const separator = typeof id === 'string' ? id.indexOf(':') : -1;
      return separator > 0
        ? { provider: id.slice(0, separator), model: id.slice(separator + 1) }
        : null;
    },
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => 'openai-codex:gpt-test' }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (value: unknown) => value }));
vi.mock('../WorktreeStore', () => ({
  createWorktreeStore: () => ({
    getAllNames: vi.fn(async () => []),
    create: fixture.persistWorktree,
    get: fixture.getWorktree,
  }),
}));
vi.mock('../GitWorktreeService', () => ({
  GitWorktreeService: class {
    getExistingWorktreeDirectories() { return []; }
    async getAllBranchNames() { return []; }
    generateUniqueWorktreeName() { return 'fresh'; }
    async createWorktree() { return fixture.createWorktree(); }
  },
}));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: fixture.databaseQuery },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../../file/GitRefWatcher', () => ({
  gitRefWatcher: { start: fixture.startGitRefWatcher },
}));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: vi.fn(),
  extractUserPrompts: vi.fn(),
}));
vi.mock('../ai/providerResolution', () => ({
  resolveExtensionAgentRef: () => null,
  isExtensionAgentProvider: () => false,
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { MetaAgentService } from '../MetaAgentService';
import {
  resolveQueuedPromptDispatchTarget,
  tryClaimAndDispatchNextQueuedPrompt,
  type ClaimedQueuedPrompt,
  type QueuedPromptStoreLike,
} from '../ai/queuedPromptDispatcher';

describe('MetaAgentService NIM-363 runtime lifecycle routing', () => {
  const canonicalWorkspace = '/repo';
  const worktreePath = '/repo_worktrees/fresh';
  const parentSessionId = 'parent-session';
  const sessions = new Map<string, any>();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    sessions.clear();
    sessions.set(parentSessionId, {
      id: parentSessionId,
      provider: 'openai-codex',
      model: 'openai-codex:gpt-test',
      workspacePath: canonicalWorkspace,
      metadata: {},
    });
    fixture.createWorktree.mockResolvedValue({
      id: 'worktree-fresh',
      name: 'fresh',
      path: worktreePath,
      branch: 'worktree/fresh',
      baseBranch: 'integration',
      projectPath: canonicalWorkspace,
    });
    fixture.startGitRefWatcher.mockResolvedValue(undefined);
    fixture.getWorktree.mockImplementation(async (id: string) =>
      id === 'worktree-fresh'
        ? {
            id,
            path: worktreePath,
            projectPath: canonicalWorkspace,
            isArchived: false,
          }
        : null,
    );
    fixture.createSession.mockImplementation(async (payload: any) => {
      sessions.set(payload.id, {
        ...payload,
        workspacePath: payload.workspaceId,
        worktreePath: payload.worktreeId === 'worktree-fresh' ? worktreePath : undefined,
        worktreeIsArchived: payload.worktreeId === 'worktree-fresh' ? false : undefined,
        metadata: {},
      });
    });
    fixture.getSession.mockImplementation(async (id: string) => sessions.get(id) ?? null);
    fixture.databaseQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SUM(CASE WHEN status')) {
        return { rows: [{ in_flight: '0', total: '0' }] };
      }
      if (sql.includes('SELECT id, title, provider, model, status')) {
        return { rows: [{ status: 'idle' }] };
      }
      return { rows: [] };
    });
  });

  it('uses canonical routing for a fresh-worktree initial prompt and follow-up and returns actual scheduling receipts', async () => {
    const service = MetaAgentService.getInstance();
    vi.spyOn(service as any, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
    const order: string[] = [];
    const rows: Array<ClaimedQueuedPrompt & {
      sessionId: string;
      status: 'pending' | 'executing' | 'completed' | 'failed';
      errorMessage: string | null;
    }> = [];
    const queuePromptForSession = vi.fn(async (sessionId: string, prompt: string) => {
      order.push(`queue:${prompt}`);
      const row = {
        id: `queued-${rows.length + 1}`,
        sessionId,
        prompt,
        status: 'pending' as const,
        errorMessage: null,
      };
      rows.push(row);
      return { id: row.id, prompt, createdAt: Date.now() };
    });
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async (sessionId) =>
        rows.filter((row) => row.sessionId === sessionId && row.status === 'pending')),
      claim: vi.fn(async (promptId) => {
        const row = rows.find((candidate) => candidate.id === promptId);
        if (!row || row.status !== 'pending') return null;
        row.status = 'executing';
        return row;
      }),
      complete: vi.fn(async (promptId) => {
        const row = rows.find((candidate) => candidate.id === promptId);
        if (row) row.status = 'completed';
      }),
      fail: vi.fn(async (promptId, errorMessage) => {
        const row = rows.find((candidate) => candidate.id === promptId);
        if (row) {
          row.status = 'failed';
          row.errorMessage = errorMessage;
        }
      }),
    };
    const processingSet = new Set<string>();
    const providerTurns = vi.fn(async (
      _event: Electron.IpcMainInvokeEvent,
      _prompt: string,
      _context?: any,
      targetSessionId?: string,
      handlerWorkspacePath?: string,
    ) => {
      const persistedSession = sessions.get(targetSessionId || '');
      expect(targetSessionId).toBeTruthy();
      expect(handlerWorkspacePath).toBe(canonicalWorkspace);
      expect(persistedSession?.worktreePath || handlerWorkspacePath).toBe(worktreePath);
      return { content: 'fake provider success' };
    });
    const startSession = vi.fn(async ({ workspacePath }: { workspacePath: string }) => {
      expect(workspacePath).toBe(canonicalWorkspace);
      return `turn-${rows.find((row) => row.status === 'executing')?.id}`;
    });
    const onChainSettled = vi.fn(async () => {});
    const triggerQueuedPromptProcessingForSession = vi.fn(async (
      targetSessionId: string,
      targetWorkspacePath: string,
    ) => {
      order.push('trigger');
      const persistedSession = sessions.get(targetSessionId) ?? null;
      return tryClaimAndDispatchNextQueuedPrompt({
        continueQueuedPromptChain: vi.fn(async () => {}),
        logError: vi.fn(),
        logInfo: vi.fn(),
        onChainSettled,
        onPromptClaimed: vi.fn(),
        processingSet,
        queueStore,
        resolveTarget: ({ sessionId, workspacePath }) =>
          resolveQueuedPromptDispatchTarget(sessionId, workspacePath, persistedSession),
        sendMessageHandler: providerTurns,
        sessionId: targetSessionId,
        source: 'MetaAgentService behavioral dispatch',
        startSession,
        targetWindow: {
          isDestroyed: () => false,
          webContents: { send: vi.fn(), mainFrame: {} },
        } as unknown as Electron.BrowserWindow,
        workspacePath: targetWorkspacePath,
      });
    });
    (service as any).aiService = {
      queuePromptForSession,
      triggerQueuedPromptProcessingForSession,
    };

    const created = await (service as any).createChildSessionInternal(
      parentSessionId,
      canonicalWorkspace,
      { useWorktree: true, prompt: 'initial prompt' },
    );

    expect(order).toEqual(['queue:initial prompt', 'trigger']);
    expect(triggerQueuedPromptProcessingForSession).toHaveBeenNthCalledWith(
      1,
      created.sessionId,
      canonicalWorkspace,
    );
    expect(triggerQueuedPromptProcessingForSession).not.toHaveBeenCalledWith(
      created.sessionId,
      worktreePath,
    );
    expect(created).toMatchObject({
      queuedInitialPrompt: true,
      processingTriggerAccepted: true,
      dispatchScheduled: true,
      worktreePath,
    });
    await vi.waitFor(() => expect(rows[0]?.status).toBe('completed'));

    const followUp = JSON.parse(await (service as any).sendPromptToSession(
      created.sessionId,
      canonicalWorkspace,
      'follow-up prompt',
    ));

    expect(order).toEqual([
      'queue:initial prompt',
      'trigger',
      'queue:follow-up prompt',
      'trigger',
    ]);
    expect(triggerQueuedPromptProcessingForSession).toHaveBeenNthCalledWith(
      2,
      created.sessionId,
      canonicalWorkspace,
    );
    expect(triggerQueuedPromptProcessingForSession).toHaveBeenCalledTimes(2);
    expect(followUp).toMatchObject({
      processingTriggered: true,
      processingTriggerAccepted: true,
      dispatchScheduled: true,
    });
    await vi.waitFor(() => expect(rows[1]?.status).toBe('completed'));

    expect(rows).toMatchObject([
      { id: 'queued-1', status: 'completed', errorMessage: null },
      { id: 'queued-2', status: 'completed', errorMessage: null },
    ]);
    expect(queueStore.claim).toHaveBeenCalledTimes(2);
    expect(queueStore.claim).toHaveBeenNthCalledWith(1, 'queued-1');
    expect(queueStore.claim).toHaveBeenNthCalledWith(2, 'queued-2');
    expect(providerTurns).toHaveBeenCalledTimes(2);
    expect(providerTurns.mock.calls.map((call) => call[1])).toEqual([
      'initial prompt',
      'follow-up prompt',
    ]);
    expect(queueStore.complete).toHaveBeenCalledTimes(2);
    expect(queueStore.fail).not.toHaveBeenCalled();
    expect(onChainSettled).toHaveBeenCalledTimes(2);
    expect(onChainSettled).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: created.sessionId,
      workspacePath: canonicalWorkspace,
      outcome: 'completed',
    }));
  });

  it('reports a rejected follow-up scheduling attempt instead of inferring success from idle state', async () => {
    const service = MetaAgentService.getInstance();
    vi.spyOn(service as any, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
    sessions.set('worktree-child', {
      id: 'worktree-child',
      provider: 'openai-codex',
      model: 'openai-codex:gpt-test',
      workspacePath: canonicalWorkspace,
      worktreeId: 'worktree-fresh',
      worktreePath,
      worktreeIsArchived: false,
      metadata: {},
    });
    const triggerQueuedPromptProcessingForSession = vi.fn(async () => false);
    (service as any).aiService = {
      queuePromptForSession: vi.fn(async (_id: string, prompt: string) => ({
        id: 'queued-follow-up',
        prompt,
        createdAt: Date.now(),
      })),
      triggerQueuedPromptProcessingForSession,
    };

    const receipt = JSON.parse(await (service as any).sendPromptToSession(
      'worktree-child',
      canonicalWorkspace,
      'follow-up prompt',
    ));

    expect(triggerQueuedPromptProcessingForSession).toHaveBeenCalledWith(
      'worktree-child',
      canonicalWorkspace,
    );
    expect(receipt).toMatchObject({
      queuedPromptId: 'queued-follow-up',
      processingTriggered: false,
      processingTriggerAccepted: false,
      dispatchScheduled: false,
    });
  });

  it.each([
    ['archived session', { isArchived: true }],
    ['retired worktree', { worktreeIsArchived: true }],
  ])('rejects follow-up dispatch to an %s before queueing', async (_label, retiredState) => {
    const service = MetaAgentService.getInstance();
    vi.spyOn(service as any, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
    sessions.set('retired-child', {
      id: 'retired-child',
      provider: 'openai-codex',
      model: 'openai-codex:gpt-test',
      workspacePath: canonicalWorkspace,
      worktreeId: 'worktree-fresh',
      worktreePath,
      isArchived: false,
      worktreeIsArchived: false,
      metadata: {},
      ...retiredState,
    });
    const queuePromptForSession = vi.fn();
    const triggerQueuedPromptProcessingForSession = vi.fn();
    (service as any).aiService = {
      queuePromptForSession,
      triggerQueuedPromptProcessingForSession,
    };

    await expect((service as any).sendPromptToSession(
      'retired-child',
      canonicalWorkspace,
      'must not run',
    )).rejects.toThrow(/not found|archived|retired/i);

    expect(queuePromptForSession).not.toHaveBeenCalled();
    expect(triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
  });

  it('keeps the ordinary non-worktree create route unchanged', async () => {
    const service = MetaAgentService.getInstance();
    vi.spyOn(service as any, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
    const triggerQueuedPromptProcessingForSession = vi.fn(async () => true);
    (service as any).aiService = {
      queuePromptForSession: vi.fn(async (_id: string, prompt: string) => ({
        id: 'queued-ordinary',
        prompt,
        createdAt: Date.now(),
      })),
      triggerQueuedPromptProcessingForSession,
    };

    const created = await (service as any).createChildSessionInternal(
      parentSessionId,
      canonicalWorkspace,
      { prompt: 'ordinary prompt' },
    );

    expect(created.worktreeId).toBeNull();
    expect(created.worktreePath).toBeNull();
    expect(triggerQueuedPromptProcessingForSession).toHaveBeenCalledWith(
      created.sessionId,
      canonicalWorkspace,
    );
    expect(created).toMatchObject({
      queuedInitialPrompt: true,
      processingTriggerAccepted: true,
      dispatchScheduled: true,
    });
  });

  it('keeps inherited-worktree spawn execution while routing through the canonical workspace', async () => {
    const service = MetaAgentService.getInstance();
    vi.spyOn(service as any, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
    sessions.set(parentSessionId, {
      id: parentSessionId,
      provider: 'openai-codex',
      model: 'openai-codex:gpt-test',
      workspacePath: canonicalWorkspace,
      worktreeId: 'worktree-fresh',
      worktreePath,
      worktreeIsArchived: false,
      metadata: {},
    });
    const triggerQueuedPromptProcessingForSession = vi.fn(async () => true);
    (service as any).aiService = {
      queuePromptForSession: vi.fn(async (_id: string, prompt: string) => ({
        id: 'queued-inherited',
        prompt,
        createdAt: Date.now(),
      })),
      triggerQueuedPromptProcessingForSession,
    };

    const spawned = JSON.parse(await (service as any).spawnSession(
      parentSessionId,
      canonicalWorkspace,
      {
        prompt: 'continue in inherited checkout',
        notifyOnComplete: true,
      },
    ));

    expect(spawned).toMatchObject({
      worktreeId: 'worktree-fresh',
      worktreePath,
      worktreeMode: 'existing',
      processingTriggerAccepted: true,
      dispatchScheduled: true,
    });
    expect(triggerQueuedPromptProcessingForSession).toHaveBeenCalledWith(
      spawned.sessionId,
      canonicalWorkspace,
    );
    expect(triggerQueuedPromptProcessingForSession).not.toHaveBeenCalledWith(
      spawned.sessionId,
      worktreePath,
    );
  });
});
