import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  getSession: vi.fn(),
  databaseQuery: vi.fn(),
  getQueuedPromptsStore: vi.fn(),
  priorityFactoryCalled: vi.fn(),
  setMetaAgentToolFns: vi.fn(),
  sessionStates: new Map<string, { status: 'idle' | 'running' | 'waiting_for_input' | 'error'; attentionGeneration?: string }>(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    create: vi.fn(),
    get: fixture.getSession,
    updateMetadata: vi.fn(),
  },
  AgentMessagesRepository: { create: vi.fn() },
  SessionFilesRepository: {},
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  SessionManager: class {
    async initialize() {}
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {},
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({
    subscribe: vi.fn(() => () => {}),
    getSessionState: (sessionId: string) => fixture.sessionStates.get(sessionId),
  }),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (value: unknown) => value }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: fixture.databaseQuery },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({
  setMetaAgentToolFns: fixture.setMetaAgentToolFns,
}));
vi.mock('../RepositoryManager', () => ({
  getQueuedPromptsStore: fixture.getQueuedPromptsStore,
}));
vi.mock('../PriorityPromptDeliveryService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../PriorityPromptDeliveryService')>();
  return {
    ...actual,
    createPriorityPromptDeliveryService: (...args: Parameters<typeof actual.createPriorityPromptDeliveryService>) => {
      fixture.priorityFactoryCalled(...args);
      return actual.createPriorityPromptDeliveryService(...args);
    },
  };
});
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: vi.fn(),
  extractUserPrompts: vi.fn(),
}));

import { MetaAgentService } from '../MetaAgentService';

type ToolFns = {
  sendPromptNow: (
    callerSessionId: string,
    workspaceId: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
  sendPrompt: (
    callerSessionId: string,
    workspaceId: string,
    targetSessionId: string,
    prompt: string,
  ) => Promise<string>;
  listQueuedPrompts: (
    callerSessionId: string,
    workspaceId: string,
    targetSessionId: string,
    options?: { includeCompleted?: boolean; includePromptText?: boolean },
  ) => Promise<string>;
};

describe('MetaAgentService send_prompt_now delivery', () => {
  const workspaceId = 'D:\\repo';
  const callerSessionId = 'caller-session';
  const targetSessionId = 'target-session';
  let service: MetaAgentService;
  let toolFns: ToolFns;
  let rowsByIdempotencyKey: Map<string, any>;
  let queueStore: Record<string, ReturnType<typeof vi.fn>>;
  let aiService: {
    queuePromptForSession: ReturnType<typeof vi.fn>;
    interruptCurrentTurnForSession: ReturnType<typeof vi.fn>;
    triggerQueuedPromptProcessingForSession: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    fixture.sessionStates.clear();
    fixture.sessionStates.set(targetSessionId, {
      status: 'idle',
      attentionGeneration: 'generation-1',
    });
    const sessions = new Map<string, any>([
      [callerSessionId, {
        id: callerSessionId,
        workspacePath: workspaceId,
        metadata: {},
      }],
      [targetSessionId, {
        id: targetSessionId,
        workspacePath: workspaceId,
        createdBySessionId: callerSessionId,
        metadata: {},
      }],
    ]);
    fixture.getSession.mockImplementation(async (sessionId: string) => sessions.get(sessionId) ?? null);
    fixture.databaseQuery.mockResolvedValue({ rows: [{ status: 'idle' }] });

    rowsByIdempotencyKey = new Map();
    queueStore = {
      listForSession: vi.fn(async () => []),
      createPriorityControlQueuedPrompt: vi.fn(async (input: any) => {
        const existing = rowsByIdempotencyKey.get(input.idempotencyKey);
        if (existing) return existing;
        const row = {
          id: `control-row-${rowsByIdempotencyKey.size + 1}`,
          sessionId: input.sessionId,
          prompt: input.prompt,
          status: 'pending',
          createdAt: 1,
          deliveryClass: 'control',
          priorityRank: 100,
          producer: input.producer,
          idempotencyKey: input.idempotencyKey,
          controlOperation: input.controlOperation,
        };
        rowsByIdempotencyKey.set(input.idempotencyKey, row);
        return row;
      }),
      reserveInterrupt: vi.fn(async ({ id, expectedGeneration, reservationOwner }: any) => {
        const row = [...rowsByIdempotencyKey.values()].find((candidate) => candidate.id === id);
        if (row.interruptTargetGeneration) {
          return { reserved: false, row };
        }
        row.interruptTargetGeneration = expectedGeneration;
        row.interruptReservationOwner = reservationOwner;
        row.interruptOperationId = `interrupt:${id}:${expectedGeneration}`;
        row.interruptFence = 1;
        row.interruptApplicationState = 'not_started';
        return { reserved: true, row };
      }),
      beginInterruptApplication: vi.fn(async ({ id }: any) => ({
        started: true,
        row: [...rowsByIdempotencyKey.values()].find((candidate) => candidate.id === id),
      })),
      verifyInterruptApplication: vi.fn(async () => true),
      recordInterruptApplication: vi.fn(async ({ id, certainty, receipt }: any) => {
        const row = [...rowsByIdempotencyKey.values()].find((candidate) => candidate.id === id);
        row.interruptApplicationState = certainty;
        row.interruptApplicationReceipt = receipt;
        return row;
      }),
      claimInterruptCleanup: vi.fn(async ({ id }: any) => {
        const row = [...rowsByIdempotencyKey.values()].find((candidate) => candidate.id === id);
        row.interruptCleanupState = 'complete';
        return true;
      }),
      recordInterruptReceipt: vi.fn(async ({ id, receipt }: any) => {
        const row = [...rowsByIdempotencyKey.values()].find((candidate) => candidate.id === id);
        row.interruptReceipt = receipt;
        return row;
      }),
      get: vi.fn(async (id: string) =>
        [...rowsByIdempotencyKey.values()].find((candidate) => candidate.id === id) ?? null),
    };
    fixture.getQueuedPromptsStore.mockReturnValue(queueStore);

    aiService = {
      queuePromptForSession: vi.fn(async (_sessionId: string, prompt: string) => ({
        id: 'fifo-row-1',
        prompt,
        createdAt: 1,
      })),
      interruptCurrentTurnForSession: vi.fn(async () => ({
        success: true,
        method: 'provider-interrupt',
        nativeCertainty: 'applied',
        nativeEntered: true,
      })),
      triggerQueuedPromptProcessingForSession: vi.fn(async () => true),
    };

    service = MetaAgentService.getInstance();
    vi.spyOn(service as any, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
    await service.start(aiService as any);
    toolFns = fixture.setMetaAgentToolFns.mock.calls[0][0] as ToolFns;
  });

  afterEach(async () => {
    await service.shutdown();
  });

  it.each([
    ['prompt', undefined],
    ['prompt', '   '],
    ['idempotencyKey', undefined],
    ['idempotencyKey', '   '],
    ['controlOperation', undefined],
    ['controlOperation', '   '],
  ])('rejects invalid %s before priority service construction or queue-store access', async (field, value) => {
    const args: Record<string, unknown> = {
      sessionId: targetSessionId,
      prompt: 'Act now',
      idempotencyKey: 'control:key-1',
      controlOperation: 'operator_directive',
      [field]: value,
    };

    await expect(toolFns.sendPromptNow(callerSessionId, workspaceId, args))
      .rejects.toThrow(`${field} is required`);
    expect(fixture.priorityFactoryCalled).not.toHaveBeenCalled();
    expect(fixture.getQueuedPromptsStore).not.toHaveBeenCalled();
    expect(queueStore.createPriorityControlQueuedPrompt).not.toHaveBeenCalled();
  });

  it.each([
    ['unauthorized caller', {
      caller: { id: callerSessionId, workspacePath: workspaceId, metadata: {} },
      target: { id: targetSessionId, workspacePath: workspaceId, metadata: {} },
      message: `Session ${callerSessionId} is not authorized to target ${targetSessionId}`,
    }],
    ['nonexistent caller', {
      caller: null,
      target: { id: targetSessionId, workspacePath: workspaceId, metadata: {} },
      message: `Caller session ${callerSessionId} not found`,
    }],
    ['nonexistent target', {
      caller: { id: callerSessionId, workspacePath: workspaceId, metadata: {} },
      target: null,
      message: `Session ${targetSessionId} not found`,
    }],
  ])('authorizes before delivery and creates no row for an %s', async (_label, setup) => {
    fixture.getSession.mockImplementation(async (sessionId: string) =>
      sessionId === callerSessionId ? setup.caller : setup.target);
    const authorize = vi.spyOn(service as any, 'assertCallerCanTarget');

    await expect(toolFns.sendPromptNow(callerSessionId, workspaceId, {
      sessionId: targetSessionId,
      prompt: 'Must not be queued',
      idempotencyKey: 'control:unauthorized',
      controlOperation: 'operator_directive',
    })).rejects.toThrow(setup.message);

    expect(authorize).toHaveBeenCalledWith(callerSessionId, targetSessionId, workspaceId);
    expect(fixture.priorityFactoryCalled).not.toHaveBeenCalled();
    expect(fixture.getQueuedPromptsStore).not.toHaveBeenCalled();
    expect(queueStore.createPriorityControlQueuedPrompt).not.toHaveBeenCalled();
    expect(aiService.interruptCurrentTurnForSession).not.toHaveBeenCalled();
    expect(aiService.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
  });

  it('creates a host-ranked control row and ignores forged producer or rank fields', async () => {
    const authorize = vi.spyOn(service as any, 'assertCallerCanTarget');
    const receiptText = await toolFns.sendPromptNow(callerSessionId, workspaceId, {
      sessionId: targetSessionId,
      prompt: '  Carry out the control directive.  ',
      idempotencyKey: '  control:key-1  ',
      controlOperation: '  operator_directive  ',
      producer: 'forged-producer',
      rank: -999,
      priorityRank: 1,
      deliveryClass: 'ordinary',
    });
    const receipt = JSON.parse(receiptText);

    expect(authorize.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.priorityFactoryCalled.mock.invocationCallOrder[0]);
    expect(queueStore.createPriorityControlQueuedPrompt).toHaveBeenCalledWith({
      sessionId: targetSessionId,
      prompt: 'Carry out the control directive.',
      idempotencyKey: 'control:key-1',
      producer: `send_prompt_now:${callerSessionId}`,
      controlOperation: 'operator_directive',
    });
    expect(rowsByIdempotencyKey.get('control:key-1')).toMatchObject({
      deliveryClass: 'control',
      priorityRank: 100,
      producer: `send_prompt_now:${callerSessionId}`,
    });
    expect(receipt).toMatchObject({
      controlRowId: 'control-row-1',
      routingWorkspacePath: workspaceId,
      action: 'idle_dispatch_triggered',
      processingTriggerCalled: true,
      processingTriggerAccepted: true,
      interrupt: null,
      verification: {
        row: {
          deliveryClass: 'control',
          priorityRank: 100,
        },
      },
    });
    expect(receipt).not.toHaveProperty('prompt');
    expect(receipt).not.toHaveProperty('producer');
    expect(receiptText).not.toContain('Carry out the control directive.');
    expect(receiptText).not.toContain('forged-producer');
  });

  it('replays the original control row without creating another row or re-interrupting', async () => {
    fixture.sessionStates.set(targetSessionId, {
      status: 'running',
      attentionGeneration: 'generation-1',
    });
    const args = {
      sessionId: targetSessionId,
      prompt: 'Interrupt once',
      idempotencyKey: 'control:replay',
      controlOperation: 'operator_directive',
    };

    const first = JSON.parse(await toolFns.sendPromptNow(callerSessionId, workspaceId, args));
    const replay = JSON.parse(await toolFns.sendPromptNow(callerSessionId, workspaceId, args));

    expect(rowsByIdempotencyKey).toHaveLength(1);
    expect(first.controlRowId).toBe('control-row-1');
    expect(replay.controlRowId).toBe(first.controlRowId);
    expect(first.action).toBe('interrupt_attempted');
    expect(replay.action).toBe('interrupt_already_reserved');
    expect(first.verification.row).toEqual(replay.verification.row);
    expect(aiService.interruptCurrentTurnForSession).toHaveBeenCalledTimes(1);
    expect(queueStore.recordInterruptReceipt).toHaveBeenCalledTimes(1);
  });

  it('propagates idempotency conflicts without returning a success receipt', async () => {
    queueStore.createPriorityControlQueuedPrompt.mockRejectedValueOnce(
      new Error('idempotency_conflict:control:key-1'),
    );

    await expect(toolFns.sendPromptNow(callerSessionId, workspaceId, {
      sessionId: targetSessionId,
      prompt: 'Conflicting control prompt',
      idempotencyKey: 'control:key-1',
      controlOperation: 'different_operation',
    })).rejects.toThrow('idempotency_conflict:control:key-1');
  });

  it('keeps the default queue audit bounded and excludes full prompt text', async () => {
    const longPrompt = 's'.repeat(1_000);
    queueStore.listForSession.mockResolvedValueOnce([{
      id: 'control-row-audit',
      status: 'pending',
      createdAt: 1,
      prompt: longPrompt,
    }]);

    const audit = JSON.parse(await toolFns.listQueuedPrompts(
      callerSessionId,
      workspaceId,
      targetSessionId,
      {},
    ));

    expect(queueStore.listForSession).toHaveBeenCalledWith(targetSessionId, {
      includeCompleted: false,
    });
    expect(audit.prompts[0].promptPreview).toBe(`${longPrompt.slice(0, 300)}...`);
    expect(audit.prompts[0]).not.toHaveProperty('prompt');
  });

  it('keeps send_prompt byte-for-byte FIFO and non-interrupting', async () => {
    const receipt = await toolFns.sendPrompt(
      callerSessionId,
      workspaceId,
      targetSessionId,
      '  FIFO prompt  ',
    );

    expect(receipt).toBe(JSON.stringify({
      sessionId: targetSessionId,
      queuedPromptId: 'fifo-row-1',
      prompt: 'FIFO prompt',
      statusBeforeQueue: 'idle',
      processingTriggered: true,
      processingTriggerAccepted: true,
      dispatchScheduled: true,
    }, null, 2));
    expect(aiService.queuePromptForSession).toHaveBeenCalledWith(targetSessionId, 'FIFO prompt');
    expect(aiService.interruptCurrentTurnForSession).not.toHaveBeenCalled();
    expect(fixture.getQueuedPromptsStore).not.toHaveBeenCalled();
    expect(fixture.priorityFactoryCalled).not.toHaveBeenCalled();
  });
});
