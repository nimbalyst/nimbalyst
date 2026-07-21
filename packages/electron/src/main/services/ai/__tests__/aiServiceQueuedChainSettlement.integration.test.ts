import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const fixture = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  getSession: vi.fn(),
  updateMetadata: vi.fn(),
  pushMetadataChangeWithResult: vi.fn(),
  revokeHostBoundMcpAuthority: vi.fn(async () => undefined),
}));

vi.mock('../../../mcp/httpServer', () => ({
  revokeHostBoundMcpAuthority: fixture.revokeHostBoundMcpAuthority,
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    get: fixture.getSession,
    updateMetadata: fixture.updateMetadata,
  },
}));
vi.mock('../../SyncManager', () => ({
  getSyncProvider: () => ({
    pushMetadataChangeWithResult: fixture.pushMetadataChangeWithResult,
  }),
}));

import {
  SessionStateManager,
  setSessionStateManager,
} from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { AttentionEventService } from '../../AttentionEventService';
import {
  createAIServiceQueuedChainSettlement,
  createDeferredSessionDrainHandlers,
  endHostBoundAiSession,
} from '../aiServiceQueuedChainSettlement';
import {
  resolveQueuedPromptDispatchTarget,
  tryClaimAndDispatchNextQueuedPrompt,
  type QueuedPromptStoreLike,
} from '../queuedPromptDispatcher';
import { clearStalePendingPromptOnTerminal } from '../pendingPromptTerminalClear';
import { setSessionPendingPrompt } from '../pendingPromptPersistence';
import { settleTerminalAttentionBeforeContinuation } from '../terminalAttentionSettlement';
import { installScopedProviderListener } from '../providerListenerRegistry';
import { codexEditWindowRegistry } from '../../CodexEditWindowRegistry';

describe('AIService queued-chain generation settlement integration', () => {
  const sessionId = 'session-queued-race';
  const workspacePath = '/workspace';

  beforeEach(() => {
    vi.clearAllMocks();
    fixture.metadata = {};
    fixture.getSession.mockImplementation(async () => ({
      id: sessionId,
      workspacePath,
      metadata: fixture.metadata,
    }));
    fixture.updateMetadata.mockImplementation(async (_id, update) => {
      fixture.metadata = { ...fixture.metadata, ...(update.metadata ?? {}) };
    });
    fixture.pushMetadataChangeWithResult.mockResolvedValue({
      outcome: 'index_frame_written',
      attempted: true,
      indexFrameWritten: true,
      skippedReason: null,
    });
  });

  afterEach(() => {
    codexEditWindowRegistry.__resetForTests();
    setSessionStateManager(new SessionStateManager());
  });

  it('preserves prompt and attention B when the real AIService callback settles queued turn A late', async () => {
    const stateManager = new SessionStateManager();
    setSessionStateManager(stateManager);
    const attention = new AttentionEventService({
      getSession: fixture.getSession,
      updateSessionMetadata: async (_id, metadata) => {
        fixture.metadata = { ...fixture.metadata, ...metadata };
      },
      pushAttentionSummary: vi.fn().mockResolvedValue(undefined),
      notifyUserJson: vi.fn().mockResolvedValue(JSON.stringify({
        result: { attempted: true, shown: true, skippedReason: null },
        mobilePush: {
          attempted: true,
          requestFrameWritten: true,
          outcome: 'request_frame_written',
          skippedReason: null,
          bypassActiveDeviceRouting: true,
          forceDesktopAwayForPush: true,
        },
      })),
    });

    await stateManager.startSession({ sessionId, workspacePath, attentionGeneration: 'turn-a' });
    await setSessionPendingPrompt(sessionId, true, {
      promptId: 'prompt-a',
      generation: 'turn-a',
    });

    // A replacement turn opens through the production state manager and the
    // real serialized pending-prompt persistence path before A's callback runs.
    await stateManager.startSession({ sessionId, workspacePath, attentionGeneration: 'turn-b' });
    await setSessionPendingPrompt(sessionId, true, {
      promptId: 'prompt-b',
      generation: 'turn-b',
    });
    await attention.arm(workspacePath, {
      sessionId,
      promptId: 'prompt-b',
      attentionGeneration: 'turn-b',
      severity: 'normal',
      dedupeKey: 'waiting:prompt-b',
    });

    const backstopClears = vi.fn();
    const terminalTasks: Promise<unknown>[] = [];
    const unsubscribe = stateManager.subscribe((event) => {
      terminalTasks.push(Promise.all([
        clearStalePendingPromptOnTerminal(event, {
          readHasPendingPrompt: async () => ({
            hasPendingPrompt: fixture.metadata.hasPendingPrompt === true,
            promptId: fixture.metadata.pendingPromptId as string | undefined,
            generation: fixture.metadata.pendingPromptGeneration as string | undefined,
          }),
          clearPendingPrompt: async (id, { expectedGeneration }) => {
            const result = await setSessionPendingPrompt(id, false, { expectedGeneration });
            if (result.local.succeeded) backstopClears();
          },
        }),
        attention.handleSessionStateEvent(event),
      ]));
    });
    const scheduleStop = vi.fn();
    const tracker = createAIServiceQueuedChainSettlement({
      stateManager,
      logInfo: vi.fn(),
      scheduleStop,
      settleTerminal: (args, continuation) => settleTerminalAttentionBeforeContinuation(
        args,
        continuation,
        {
          clearPendingPrompt: setSessionPendingPrompt,
          settleAttention: (id, settleArgs) => attention.settleTerminalAttention(id, settleArgs),
        },
      ),
    });

    await tracker.onChainSettled({
      sessionId,
      workspacePath,
      source: 'integration regression',
      attentionGeneration: 'turn-a',
      outcome: 'completed',
    });

    expect(tracker.settledChainEnded).toBe(false);
    expect(scheduleStop).not.toHaveBeenCalled();
    expect(stateManager.getSessionState(sessionId)).toMatchObject({
      status: 'running',
      attentionGeneration: 'turn-b',
    });

    // Also release an A terminal event that was already queued before B opened.
    // The actual terminal subscribers must independently reject it.
    stateManager.emit('session:completed', {
      sessionId,
      workspacePath,
      timestamp: new Date(),
      attentionGeneration: 'turn-a',
    });
    await Promise.all(terminalTasks);

    expect(backstopClears).not.toHaveBeenCalled();
    expect(fixture.metadata).toMatchObject({
      hasPendingPrompt: true,
      pendingPromptId: 'prompt-b',
      pendingPromptGeneration: 'turn-b',
    });
    const attentionStatus = await attention.status(workspacePath, {
      sessionId,
      includeCancelled: true,
    });
    expect(attentionStatus.events).toContainEqual(expect.objectContaining({
      promptId: 'prompt-b',
      attentionGeneration: 'turn-b',
      status: 'pending',
    }));
    unsubscribe();
  });

  it('emits exactly one canonical completion only after the queued row completes', async () => {
    const canonicalWorkspace = '/repo';
    const worktreePath = '/repo_worktrees/fresh';
    const stateManager = new SessionStateManager();
    setSessionStateManager(stateManager);
    const order: string[] = [];
    const events: Array<{ type: string; workspacePath?: string }> = [];
    const unsubscribe = stateManager.subscribe((event) => {
      events.push({ type: event.type, workspacePath: event.workspacePath });
      order.push(`event:${event.type}`);
    });
    const row = {
      id: 'prompt-success',
      prompt: 'finish successfully',
      status: 'pending' as 'pending' | 'executing' | 'completed' | 'failed',
    };
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => row.status === 'pending' ? [row] : []),
      claim: vi.fn(async () => {
        if (row.status !== 'pending') return null;
        row.status = 'executing';
        return row;
      }),
      complete: vi.fn(async () => {
        row.status = 'completed';
        order.push('row:completed');
      }),
      fail: vi.fn(async () => {
        row.status = 'failed';
      }),
    };
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let reportHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      reportHandlerStarted = resolve;
    });
    let reportAfterSettled!: () => void;
    const afterSettled = new Promise<void>((resolve) => {
      reportAfterSettled = resolve;
    });
    const tracker = createAIServiceQueuedChainSettlement({
      stateManager,
      logInfo: vi.fn(),
      scheduleStop: vi.fn(),
      settleTerminal: (async (
        _args: unknown,
        continuation: (settlement: {
          promptClear: unknown;
          attentionSettledCount: number;
        }) => Promise<unknown>,
      ) => ({
        promptClear: {} as any,
        attentionSettledCount: 0,
        continuationResult: await continuation({
          promptClear: {} as any,
          attentionSettledCount: 0,
        }),
      })) as any,
    });
    const persistedSession = {
      id: sessionId,
      workspacePath: canonicalWorkspace,
      worktreeId: 'worktree-fresh',
      worktreePath,
      worktreeIsArchived: false,
    };

    const accepted = await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onAfterSettled: async () => reportAfterSettled(),
      onChainSettled: tracker.onChainSettled,
      onPromptClaimed: vi.fn(),
      processingSet: new Set<string>(),
      queueStore,
      resolveTarget: ({ sessionId: requestedId, workspacePath: requestedWorkspace }) =>
        resolveQueuedPromptDispatchTarget(requestedId, requestedWorkspace, persistedSession),
      sendMessageHandler: vi.fn(async () => {
        reportHandlerStarted();
        await handlerGate;
        return { content: 'done' };
      }),
      sessionId,
      source: 'success event ordering',
      startSession: async ({ sessionId: startedId, workspacePath: startedWorkspace }) =>
        stateManager.startSession({
          sessionId: startedId,
          workspacePath: startedWorkspace,
          attentionGeneration: 'turn-success',
        }),
      targetWindow: {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), mainFrame: {} },
      } as unknown as Electron.BrowserWindow,
      workspacePath: worktreePath,
    });

    expect(accepted).toBe(true);
    await handlerStarted;
    expect(row.status).toBe('executing');
    expect(events).toEqual([{ type: 'session:started', workspacePath: canonicalWorkspace }]);

    releaseHandler();
    await afterSettled;

    expect(row.status).toBe('completed');
    expect(queueStore.complete).toHaveBeenCalledTimes(1);
    expect(queueStore.fail).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: 'session:started', workspacePath: canonicalWorkspace },
      { type: 'session:completed', workspacePath: canonicalWorkspace },
    ]);
    expect(order.indexOf('row:completed')).toBeLessThan(order.indexOf('event:session:completed'));
    expect(events.filter((event) => event.type === 'session:completed')).toHaveLength(1);
    expect(fixture.revokeHostBoundMcpAuthority).toHaveBeenCalledWith(sessionId);
    unsubscribe();
  });

  it('revokes capability before the real deferred-success drain ends its owned generation', async () => {
    const stateManager = new SessionStateManager();
    setSessionStateManager(stateManager);
    await stateManager.startSession({
      sessionId,
      workspacePath,
      attentionGeneration: 'turn-deferred-success',
    });
    const order: string[] = [];
    fixture.revokeHostBoundMcpAuthority.mockImplementationOnce(async () => {
      order.push('revoked');
    });
    const originalEnd = stateManager.endSession.bind(stateManager);
    vi.spyOn(stateManager, 'endSession').mockImplementation(async (...args) => {
      order.push('ended');
      await originalEnd(...args);
    });
    const handlers = createDeferredSessionDrainHandlers({
      sessionId,
      stateManager,
      processingSet: new Set<string>(),
      getAttentionGeneration: () => 'turn-deferred-success',
      getDeferredOutcome: () => 'completed',
      isLeadBusy: () => false,
      settleTerminal: vi.fn(async () => undefined),
      stopWatcher: vi.fn(async () => undefined),
      scheduleWatcherStop: vi.fn(),
      clearEditWindow: vi.fn(),
      playCompletionSound: vi.fn(),
      logInfo: vi.fn(),
    });

    await handlers.onTeammatesAllCompleted({ sessionId });

    expect(order).toEqual(['revoked', 'ended']);
    expect(stateManager.getSessionState(sessionId)).toBeUndefined();
  });

  it('revalidates generation after an awaited revocation before ending terminal state', async () => {
    const stateManager = new SessionStateManager();
    setSessionStateManager(stateManager);
    await stateManager.startSession({
      sessionId,
      workspacePath,
      attentionGeneration: 'turn-a',
    });
    let releaseRevocation!: () => void;
    fixture.revokeHostBoundMcpAuthority.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseRevocation = resolve; }),
    );

    const staleEnd = endHostBoundAiSession(stateManager, sessionId, {
      attentionGeneration: 'turn-a',
    });
    await vi.waitFor(() => expect(fixture.revokeHostBoundMcpAuthority).toHaveBeenCalled());
    await stateManager.startSession({
      sessionId,
      workspacePath,
      attentionGeneration: 'turn-b',
    });
    releaseRevocation();

    await expect(staleEnd).resolves.toBe(false);
    expect(stateManager.getSessionState(sessionId)?.attentionGeneration).toBe('turn-b');
  });

  it('checks and claims successor B before replaying one successful early drain from A', async () => {
    const stateManager = new SessionStateManager();
    setSessionStateManager(stateManager);
    const processingSet = new Set<string>();
    const rows = [
      {
        id: 'prompt-a',
        prompt: 'turn A with early subagent drain',
        status: 'pending' as 'pending' | 'executing' | 'completed' | 'failed',
      },
      {
        id: 'prompt-b',
        prompt: 'successor turn B',
        status: 'pending' as 'pending' | 'executing' | 'completed' | 'failed',
      },
    ];
    let claimedRow: (typeof rows)[number] | null = null;
    const order: string[] = [];
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => rows.filter((row) => row.status === 'pending')),
      claim: vi.fn(async (promptId) => {
        const row = rows.find((candidate) => candidate.id === promptId);
        if (!row || row.status !== 'pending') return null;
        row.status = 'executing';
        claimedRow = row;
        order.push(`${promptId}:claimed`);
        return row;
      }),
      complete: vi.fn(async (promptId) => {
        const row = rows.find((candidate) => candidate.id === promptId)!;
        row.status = 'completed';
        order.push(`${promptId}:completed`);
      }),
      fail: vi.fn(async (promptId) => {
        rows.find((candidate) => candidate.id === promptId)!.status = 'failed';
      }),
    };
    const events: string[] = [];
    const parentWake = vi.fn();
    const unsubscribe = stateManager.subscribe((event) => {
      events.push(event.type);
      if (event.type === 'session:completed') {
        order.push('session:completed');
        parentWake();
      }
    });
    const stopWatcher = vi.fn(async () => {});
    const clearEditWindow = vi.fn();
    const playCompletionSound = vi.fn();
    let deferredOutcome: 'completed' | 'error' | null = null;
    const provider = new EventEmitter();
    const deferredHandlers = createDeferredSessionDrainHandlers({
      sessionId,
      stateManager,
      processingSet,
      getAttentionGeneration: () => 'turn-a',
      getDeferredOutcome: () => deferredOutcome,
      isLeadBusy: () => false,
      settleTerminal: async () => {},
      stopWatcher,
      scheduleWatcherStop: vi.fn(),
      clearEditWindow,
      playCompletionSound,
      logInfo: vi.fn(),
    });
    let reportDrainFinished!: () => void;
    const drainFinished = new Promise<void>((resolve) => {
      reportDrainFinished = resolve;
    });
    installScopedProviderListener(
      new WeakMap(),
      provider,
      'subagents:drainSettled',
      (data) => {
        void deferredHandlers.onSubagentsDrainSettled(data).finally(reportDrainFinished);
      },
    );
    let reportTurnBStarted!: () => void;
    const turnBStarted = new Promise<void>((resolve) => {
      reportTurnBStarted = resolve;
    });
    let reportFinalSettlement!: () => void;
    const finalSettlement = new Promise<void>((resolve) => {
      reportFinalSettlement = resolve;
    });

    const dispatchNext = async (): Promise<boolean> => {
      const tracker = createAIServiceQueuedChainSettlement({
        stateManager,
        logInfo: vi.fn(),
        scheduleStop: vi.fn(),
        settleTerminal: (async (
          _args: unknown,
          continuation: (settlement: {
            promptClear: unknown;
            attentionSettledCount: number;
          }) => Promise<unknown>,
        ) => ({
          promptClear: {} as any,
          attentionSettledCount: 0,
          continuationResult: await continuation({
            promptClear: {} as any,
            attentionSettledCount: 0,
          }),
        })) as any,
      });
      return tryClaimAndDispatchNextQueuedPrompt({
        continueQueuedPromptChain: async () => {
          await dispatchNext();
        },
        logError: vi.fn(),
        logInfo: vi.fn(),
        onAfterSettled: async () => {
          if (rows.every((row) => row.status === 'completed') && !processingSet.has(sessionId)) {
            reportFinalSettlement();
          }
        },
        onChainSettled: tracker.onChainSettled,
        onPromptClaimed: vi.fn(),
        processingSet,
        queueStore,
        resolveTarget: () => ({
          routingWorkspacePath: workspacePath,
          expectedWorktreeId: null,
          expectedWorktreePath: null,
        }),
        sendMessageHandler: vi.fn(async (
          _event,
          _message,
          documentContext,
          _sessionId,
          _workspacePath,
          turnContext,
        ) => {
          if (documentContext?.queuedPromptId === 'prompt-a') {
            turnContext?.registerDeferredDrainReplay?.(deferredHandlers.replayPendingDrain);
            deferredOutcome = 'completed';
            provider.emit('subagents:drainSettled', { sessionId });
            await drainFinished;
            return { content: 'A done' };
          }
          reportTurnBStarted();
          expect(events.filter((type) => type === 'session:completed')).toHaveLength(0);
          expect(parentWake).not.toHaveBeenCalled();
          expect(playCompletionSound).not.toHaveBeenCalled();
          return { content: 'B done' };
        }),
        sessionId,
        source: `successor ordering ${claimedRow?.id ?? 'next'}`,
        startSession: async ({ sessionId: startedId, workspacePath: startedWorkspace }) => {
          const attentionGeneration = claimedRow?.id === 'prompt-a' ? 'turn-a' : 'turn-b';
          return stateManager.startSession({
            sessionId: startedId,
            workspacePath: startedWorkspace,
            attentionGeneration,
          });
        },
        targetWindow: {
          isDestroyed: () => false,
          webContents: { send: vi.fn(), mainFrame: {} },
        } as unknown as Electron.BrowserWindow,
        workspacePath,
      });
    };

    expect(await dispatchNext()).toBe(true);
    await turnBStarted;
    expect(rows).toEqual([
      expect.objectContaining({ id: 'prompt-a', status: 'completed' }),
      expect.objectContaining({ id: 'prompt-b', status: 'executing' }),
    ]);
    expect(events.filter((type) => type === 'session:completed')).toHaveLength(0);
    expect(parentWake).not.toHaveBeenCalled();
    expect(playCompletionSound).not.toHaveBeenCalled();

    await finalSettlement;
    expect(rows[1].status).toBe('completed');
    expect(events.filter((type) => type === 'session:completed')).toHaveLength(1);
    expect(parentWake).toHaveBeenCalledTimes(1);
    expect(playCompletionSound).not.toHaveBeenCalled();
    expect(stopWatcher).not.toHaveBeenCalled();
    expect(clearEditWindow).not.toHaveBeenCalled();
    expect(order.indexOf('prompt-b:claimed')).toBeLessThan(order.indexOf('session:completed'));
    unsubscribe();
  });

  it('settles a plain post-claim handler failure once without completion or parent wakeup', async () => {
    const stateManager = new SessionStateManager();
    setSessionStateManager(stateManager);
    const events: Array<{ type: string; workspacePath?: string }> = [];
    const unsubscribe = stateManager.subscribe((event) => {
      events.push({ type: event.type, workspacePath: event.workspacePath });
    });
    const row = {
      id: 'prompt-handler-failure',
      prompt: 'fail before provider start',
      status: 'pending' as 'pending' | 'executing' | 'completed' | 'failed',
      errorMessage: null as string | null,
    };
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => row.status === 'pending' ? [row] : []),
      claim: vi.fn(async () => {
        if (row.status !== 'pending') return null;
        row.status = 'executing';
        return row;
      }),
      complete: vi.fn(async () => {
        row.status = 'completed';
      }),
      fail: vi.fn(async (_promptId, errorMessage) => {
        row.status = 'failed';
        row.errorMessage = errorMessage;
      }),
    };
    const processingSet = new Set<string>();
    const continueQueuedPromptChain = vi.fn(async () => {});
    codexEditWindowRegistry.open({
      sessionId,
      editGroupId: 'abandoned-codex-write',
      toolName: 'mcp__nimbalyst-mcp__applyCollabDocEdit',
      workspacePath,
    });
    expect(codexEditWindowRegistry.getSessionWindowCount(sessionId)).toBe(1);

    const settleTerminal = vi.fn(async (args, continuation) => {
      const continuationResult = await continuation({
        promptClear: {} as any,
        attentionSettledCount: 0,
      });
      return {
        promptClear: {} as any,
        attentionSettledCount: 0,
        continuationResult,
      };
    });
    const scheduleStop = vi.fn();
    const tracker = createAIServiceQueuedChainSettlement({
      stateManager,
      logInfo: vi.fn(),
      scheduleStop,
      settleTerminal: settleTerminal as any,
    });
    const parentWake = vi.fn();
    let reportAfterSettled!: () => void;
    const afterSettled = new Promise<void>((resolve) => {
      reportAfterSettled = resolve;
    });

    const accepted = await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain,
      logError: vi.fn(),
      logInfo: vi.fn(),
      onAfterSettled: async () => {
        if (tracker.settledChainEnded && !tracker.settledChildErrored) {
          parentWake();
        }
        reportAfterSettled();
      },
      onChainSettled: tracker.onChainSettled,
      onPromptClaimed: vi.fn(),
      processingSet,
      queueStore,
      resolveTarget: () => ({
        routingWorkspacePath: workspacePath,
        expectedWorktreeId: null,
        expectedWorktreePath: null,
      }),
      sendMessageHandler: vi.fn(async () => {
        throw new Error('plain early validation failure');
      }),
      sessionId,
      source: 'plain handler failure',
      startSession: async ({ sessionId: startedId, workspacePath: startedWorkspace }) =>
        stateManager.startSession({
          sessionId: startedId,
          workspacePath: startedWorkspace,
          attentionGeneration: 'turn-failed',
        }),
      targetWindow: {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), mainFrame: {} },
      } as unknown as Electron.BrowserWindow,
      workspacePath,
    });
    expect(accepted).toBe(true);
    await afterSettled;

    expect(tracker.settledChildErrored).toBe(true);
    expect(tracker.settledChainEnded).toBe(true);
    expect(row).toMatchObject({
      status: 'failed',
      errorMessage: 'plain early validation failure',
    });
    expect(queueStore.fail).toHaveBeenCalledTimes(1);
    expect(queueStore.fail).toHaveBeenCalledWith(
      'prompt-handler-failure',
      'plain early validation failure',
    );
    expect(queueStore.complete).not.toHaveBeenCalled();
    expect(continueQueuedPromptChain).not.toHaveBeenCalled();
    expect(processingSet.has(sessionId)).toBe(false);
    expect(stateManager.getSessionState(sessionId)).toMatchObject({
      status: 'error',
      workspacePath,
      attentionGeneration: 'turn-failed',
    });
    expect(events).toEqual([
      { type: 'session:started', workspacePath },
      { type: 'session:error', workspacePath },
    ]);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'session:completed' }));
    expect(parentWake).not.toHaveBeenCalled();
    expect(settleTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        attentionGeneration: 'turn-failed',
        reason: 'error',
      }),
      expect.any(Function),
    );
    expect(scheduleStop).toHaveBeenCalledWith(sessionId, 500);
    expect(codexEditWindowRegistry.getSessionWindowCount(sessionId)).toBe(0);
    expect(codexEditWindowRegistry.getWindow('abandoned-codex-write')).toBeUndefined();
    expect(fixture.revokeHostBoundMcpAuthority).toHaveBeenCalledWith(sessionId);
    unsubscribe();
  });

  it('does not duplicate session:error when the handler already marked the turn failed', async () => {
    const stateManager = new SessionStateManager();
    setSessionStateManager(stateManager);
    const events: string[] = [];
    const unsubscribe = stateManager.subscribe((event) => events.push(event.type));
    await stateManager.startSession({
      sessionId,
      workspacePath,
      attentionGeneration: 'turn-handler-marked',
    });
    events.length = 0;
    await stateManager.updateActivity({
      sessionId,
      status: 'error',
      attentionGeneration: 'turn-handler-marked',
    });

    const tracker = createAIServiceQueuedChainSettlement({
      stateManager,
      logInfo: vi.fn(),
      scheduleStop: vi.fn(),
      settleTerminal: (async (
        _args: unknown,
        continuation: (settlement: {
          promptClear: unknown;
          attentionSettledCount: number;
        }) => Promise<unknown>,
      ) => ({
        promptClear: {} as any,
        attentionSettledCount: 0,
        continuationResult: await continuation({
          promptClear: {} as any,
          attentionSettledCount: 0,
        }),
      })) as any,
    });
    await tracker.onChainSettled({
      sessionId,
      workspacePath,
      source: 'handler already marked error',
      attentionGeneration: 'turn-handler-marked',
      outcome: 'failed',
    });

    expect(events.filter((type) => type === 'session:error')).toHaveLength(1);
    expect(events).not.toContain('session:completed');
    expect(tracker.settledChildErrored).toBe(true);
    expect(tracker.settledChainEnded).toBe(true);
    unsubscribe();
  });

  it('does not clear replacement B edit attribution when failed generation A settles late', async () => {
    const stateManager = new SessionStateManager();
    setSessionStateManager(stateManager);
    await stateManager.startSession({
      sessionId,
      workspacePath,
      attentionGeneration: 'turn-a',
    });
    await stateManager.startSession({
      sessionId,
      workspacePath,
      attentionGeneration: 'turn-b',
    });
    codexEditWindowRegistry.open({
      sessionId,
      editGroupId: 'turn-b-edit',
      toolName: 'mcp__nimbalyst-mcp__applyCollabDocEdit',
      workspacePath,
    });
    const tracker = createAIServiceQueuedChainSettlement({
      stateManager,
      logInfo: vi.fn(),
      scheduleStop: vi.fn(),
      settleTerminal: (async (
        _args: unknown,
        continuation: (settlement: {
          promptClear: unknown;
          attentionSettledCount: number;
        }) => Promise<unknown>,
      ) => ({
        promptClear: {} as any,
        attentionSettledCount: 0,
        continuationResult: await continuation({
          promptClear: {} as any,
          attentionSettledCount: 0,
        }),
      })) as any,
    });

    await tracker.onChainSettled({
      sessionId,
      workspacePath,
      source: 'late failed A',
      attentionGeneration: 'turn-a',
      outcome: 'failed',
    });

    expect(tracker.settledChainEnded).toBe(false);
    expect(stateManager.getSessionState(sessionId)).toMatchObject({
      status: 'running',
      attentionGeneration: 'turn-b',
    });
    expect(codexEditWindowRegistry.getSessionWindowCount(sessionId)).toBe(1);
    expect(codexEditWindowRegistry.getWindow('turn-b-edit')).toBeDefined();
  });

  it.each([
    ['teammates:allCompleted', 'onTeammatesAllCompleted'],
    ['subagents:drainSettled', 'onSubagentsDrainSettled'],
  ] as const)(
    'replays one early %s drain after the failed queued turn releases its queue guard',
    async (providerEvent, handlerName) => {
      const stateManager = new SessionStateManager();
      setSessionStateManager(stateManager);
      const processingSet = new Set<string>();
      const row = {
        id: `prompt-${providerEvent}`,
        prompt: 'queued turn with deferred agents',
        status: 'pending' as 'pending' | 'executing' | 'completed' | 'failed',
        errorMessage: null as string | null,
      };
      const queueStore: QueuedPromptStoreLike = {
        listPending: vi.fn(async () => row.status === 'pending' ? [row] : []),
        claim: vi.fn(async () => {
          if (row.status !== 'pending') return null;
          row.status = 'executing';
          return row;
        }),
        complete: vi.fn(async () => {
          row.status = 'completed';
        }),
        fail: vi.fn(async (_promptId, errorMessage) => {
          row.status = 'failed';
          row.errorMessage = errorMessage;
        }),
      };
      const events: string[] = [];
      const parentSuccessWake = vi.fn();
      const unsubscribe = stateManager.subscribe((event) => {
        events.push(event.type);
        if (event.type === 'session:completed') parentSuccessWake();
      });
      const terminalReasons: string[] = [];
      const stopWatcher = vi.fn(async () => {});
      const scheduleWatcherStop = vi.fn();
      const clearEditWindow = vi.fn();
      const playCompletionSound = vi.fn();
      let deferredOutcome: 'completed' | 'error' | null = null;
      const provider = new EventEmitter() as EventEmitter & { isLeadBusy(): boolean };
      provider.isLeadBusy = () => false;
      const deferredHandlers = createDeferredSessionDrainHandlers({
        sessionId,
        stateManager,
        processingSet,
        getAttentionGeneration: () => 'turn-deferred-error',
        getDeferredOutcome: () => deferredOutcome,
        isLeadBusy: () => provider.isLeadBusy(),
        settleTerminal: async (reason) => {
          terminalReasons.push(reason);
        },
        stopWatcher,
        scheduleWatcherStop,
        clearEditWindow,
        playCompletionSound,
        logInfo: vi.fn(),
      });
      let reportDrainFinished!: () => void;
      const drainFinished = new Promise<void>((resolve) => {
        reportDrainFinished = resolve;
      });
      installScopedProviderListener(
        new WeakMap(),
        provider,
        providerEvent,
        (data) => {
          void deferredHandlers[handlerName](data).finally(reportDrainFinished);
        },
      );
      const tracker = createAIServiceQueuedChainSettlement({
        stateManager,
        logInfo: vi.fn(),
        scheduleStop: vi.fn(),
        settleTerminal: (async (
          _args: unknown,
          continuation: (settlement: {
            promptClear: unknown;
            attentionSettledCount: number;
          }) => Promise<unknown>,
        ) => ({
          promptClear: {} as any,
          attentionSettledCount: 0,
          continuationResult: await continuation({
            promptClear: {} as any,
            attentionSettledCount: 0,
          }),
        })) as any,
      });
      const continueQueuedPromptChain = vi.fn(async () => {});
      let reportAfterSettled!: () => void;
      const afterSettled = new Promise<void>((resolve) => {
        reportAfterSettled = resolve;
      });
      let reportSendMessageReady!: () => void;
      const sendMessageReady = new Promise<void>((resolve) => {
        reportSendMessageReady = resolve;
      });
      let releaseSendMessage!: () => void;
      const sendMessageGate = new Promise<void>((resolve) => {
        releaseSendMessage = resolve;
      });

      const accepted = await tryClaimAndDispatchNextQueuedPrompt({
        continueQueuedPromptChain,
        logError: vi.fn(),
        logInfo: vi.fn(),
        onAfterSettled: async () => reportAfterSettled(),
        onChainSettled: tracker.onChainSettled,
        onPromptClaimed: vi.fn(),
        processingSet,
        queueStore,
        resolveTarget: () => ({
          routingWorkspacePath: workspacePath,
          expectedWorktreeId: null,
          expectedWorktreePath: null,
        }),
        sendMessageHandler: vi.fn(async (
          _event,
          _message,
          _documentContext,
          _sessionId,
          _workspacePath,
          turnContext,
        ) => {
          turnContext?.registerDeferredDrainReplay?.(deferredHandlers.replayPendingDrain);
          reportSendMessageReady();
          await sendMessageGate;
          deferredOutcome = 'error';
          await stateManager.updateActivity({
            sessionId,
            status: 'error',
            attentionGeneration: 'turn-deferred-error',
          });
          throw new Error('deferred agent turn failed');
        }),
        sessionId,
        source: `failed ${providerEvent}`,
        startSession: ({ sessionId: startedId, workspacePath: startedWorkspace }) =>
          stateManager.startSession({
            sessionId: startedId,
            workspacePath: startedWorkspace,
            attentionGeneration: 'turn-deferred-error',
          }),
        targetWindow: {
          isDestroyed: () => false,
          webContents: { send: vi.fn(), mainFrame: {} },
        } as unknown as Electron.BrowserWindow,
        workspacePath,
      });

      expect(accepted).toBe(true);
      await sendMessageReady;
      expect(processingSet.has(sessionId)).toBe(true);
      provider.emit(providerEvent, { sessionId });
      await drainFinished;
      expect(terminalReasons).toEqual([]);
      expect(clearEditWindow).not.toHaveBeenCalled();

      releaseSendMessage();
      await afterSettled;
      expect(processingSet.has(sessionId)).toBe(false);

      expect(row).toMatchObject({
        status: 'failed',
        errorMessage: 'deferred agent turn failed',
      });
      expect(queueStore.fail).toHaveBeenCalledTimes(1);
      expect(queueStore.complete).not.toHaveBeenCalled();
      expect(continueQueuedPromptChain).not.toHaveBeenCalled();
      expect(events.filter((type) => type === 'session:error')).toHaveLength(1);
      expect(events.filter((type) => type === 'session:completed')).toHaveLength(0);
      expect(parentSuccessWake).not.toHaveBeenCalled();
      expect(stateManager.getSessionState(sessionId)).toMatchObject({
        status: 'error',
        attentionGeneration: 'turn-deferred-error',
      });
      expect(terminalReasons).toEqual(['error']);
      expect(stopWatcher).not.toHaveBeenCalled();
      expect(scheduleWatcherStop).toHaveBeenCalledWith(500);
      expect(clearEditWindow).toHaveBeenCalledTimes(1);
      expect(playCompletionSound).not.toHaveBeenCalled();
      expect(fixture.revokeHostBoundMcpAuthority).toHaveBeenCalledWith(sessionId);
      unsubscribe();
    },
  );

  it.each([
    ['teammates:allCompleted', 'onTeammatesAllCompleted'],
    ['subagents:drainSettled', 'onSubagentsDrainSettled'],
  ] as const)(
    'drops a latched %s drain when replacement generation B owns the session before replay',
    async (_providerEvent, handlerName) => {
      const stateManager = new SessionStateManager();
      setSessionStateManager(stateManager);
      const processingSet = new Set([sessionId]);
      const settleTerminal = vi.fn(async () => {});
      const stopWatcher = vi.fn(async () => {});
      const scheduleWatcherStop = vi.fn();
      const clearEditWindow = vi.fn();
      const playCompletionSound = vi.fn();
      await stateManager.startSession({
        sessionId,
        workspacePath,
        attentionGeneration: 'turn-a',
      });

      const deferredHandlers = createDeferredSessionDrainHandlers({
        sessionId,
        stateManager,
        processingSet,
        getAttentionGeneration: () => 'turn-a',
        getDeferredOutcome: () => 'error',
        isLeadBusy: () => false,
        settleTerminal,
        stopWatcher,
        scheduleWatcherStop,
        clearEditWindow,
        playCompletionSound,
        logInfo: vi.fn(),
      });

      await deferredHandlers[handlerName]({ sessionId });
      expect(settleTerminal).not.toHaveBeenCalled();

      await stateManager.startSession({
        sessionId,
        workspacePath,
        attentionGeneration: 'turn-b',
      });
      processingSet.delete(sessionId);
      await deferredHandlers.replayPendingDrain();
      await deferredHandlers[handlerName]({ sessionId });
      await deferredHandlers.replayPendingDrain();

      expect(stateManager.getSessionState(sessionId)).toMatchObject({
        status: 'running',
        attentionGeneration: 'turn-b',
      });
      expect(settleTerminal).not.toHaveBeenCalled();
      expect(stopWatcher).not.toHaveBeenCalled();
      expect(scheduleWatcherStop).not.toHaveBeenCalled();
      expect(clearEditWindow).not.toHaveBeenCalled();
      expect(playCompletionSound).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['session:started listener', 'session:started listener exploded'],
    ['database update', 'session start database exploded'],
  ] as const)('keeps direct turn B running when a %s fails after installing queued turn A', async (failurePhase, failureMessage) => {
    const stateManager = new SessionStateManager();
    setSessionStateManager(stateManager);
    const processingSet = new Set<string>();
    const row = {
      id: 'prompt-start-emission-failure',
      prompt: 'queued turn A',
      status: 'pending' as 'pending' | 'executing' | 'completed' | 'failed',
      errorMessage: null as string | null,
    };
    let reportFailStarted!: () => void;
    const failStarted = new Promise<void>((resolve) => {
      reportFailStarted = resolve;
    });
    let releaseFail!: () => void;
    const failGate = new Promise<void>((resolve) => {
      releaseFail = resolve;
    });
    let processingGuardHeldDuringFail = false;
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => row.status === 'pending' ? [row] : []),
      claim: vi.fn(async () => {
        if (row.status !== 'pending') return null;
        row.status = 'executing';
        return row;
      }),
      complete: vi.fn(async () => {
        row.status = 'completed';
      }),
      fail: vi.fn(async (_promptId, errorMessage) => {
        processingGuardHeldDuringFail = processingSet.has(sessionId);
        reportFailStarted();
        await failGate;
        row.status = 'failed';
        row.errorMessage = errorMessage;
      }),
    };
    const events: Array<{ type: string; attentionGeneration?: string }> = [];
    const unsubscribeEvents = stateManager.subscribe((event) => {
      events.push({
        type: event.type,
        attentionGeneration: event.attentionGeneration,
      });
    });
    const throwOnTurnAStart = (event: { attentionGeneration?: string }) => {
      if (event.attentionGeneration === 'turn-a') {
        throw new Error(failureMessage);
      }
    };
    if (failurePhase === 'session:started listener') {
      stateManager.on('session:started', throwOnTurnAStart);
    } else {
      const stateManagerInternals = stateManager as unknown as {
        updateDatabase(sessionId: string, status: string): Promise<void>;
      };
      const originalUpdateDatabase = stateManagerInternals.updateDatabase.bind(stateManager);
      let failNextDatabaseUpdate = true;
      vi.spyOn(stateManagerInternals, 'updateDatabase').mockImplementation(async (...args) => {
        if (failNextDatabaseUpdate) {
          failNextDatabaseUpdate = false;
          throw new Error(failureMessage);
        }
        await originalUpdateDatabase(...args);
      });
    }
    const attention = new AttentionEventService({
      getSession: fixture.getSession,
      updateSessionMetadata: async (_id, metadata) => {
        fixture.metadata = { ...fixture.metadata, ...metadata };
      },
      pushAttentionSummary: vi.fn().mockResolvedValue(undefined),
      notifyUserJson: vi.fn().mockResolvedValue(JSON.stringify({
        result: { attempted: true, shown: true, skippedReason: null },
        mobilePush: {
          attempted: true,
          requestFrameWritten: true,
          outcome: 'request_frame_written',
          skippedReason: null,
          bypassActiveDeviceRouting: true,
          forceDesktopAwayForPush: true,
        },
      })),
    });
    const settleTerminal = vi.fn((args, continuation) =>
      settleTerminalAttentionBeforeContinuation(args, continuation, {
        clearPendingPrompt: setSessionPendingPrompt,
        settleAttention: (id, settleArgs) => attention.settleTerminalAttention(id, settleArgs),
      }));
    const tracker = createAIServiceQueuedChainSettlement({
      stateManager,
      logInfo: vi.fn(),
      scheduleStop: vi.fn(),
      settleTerminal: settleTerminal as any,
    });
    const onChainSettled = vi.fn(tracker.onChainSettled);
    let reportAfterSettled!: () => void;
    const afterSettled = new Promise<void>((resolve) => {
      reportAfterSettled = resolve;
    });

    const dispatchPromise = tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onAfterSettled: async () => reportAfterSettled(),
      onChainSettled,
      onPromptClaimed: vi.fn(),
      processingSet,
      queueStore,
      resolveTarget: () => ({
        routingWorkspacePath: workspacePath,
        expectedWorktreeId: null,
        expectedWorktreePath: null,
      }),
      sendMessageHandler: vi.fn(async () => ({ content: 'must not run' })),
      sessionId,
      source: 'start emission failure A-to-B',
      startSession: ({ sessionId: startedId, workspacePath: startedWorkspace }) =>
        stateManager.startSession({
          sessionId: startedId,
          workspacePath: startedWorkspace,
          attentionGeneration: 'turn-a',
        }),
      targetWindow: {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), mainFrame: {} },
      } as unknown as Electron.BrowserWindow,
      workspacePath,
    });

    await failStarted;
    stateManager.off('session:started', throwOnTurnAStart);
    await stateManager.startSession({
      sessionId,
      workspacePath,
      attentionGeneration: 'turn-b',
    });
    await setSessionPendingPrompt(sessionId, true, {
      promptId: 'prompt-b',
      generation: 'turn-b',
    });
    await attention.arm(workspacePath, {
      sessionId,
      promptId: 'prompt-b',
      attentionGeneration: 'turn-b',
      severity: 'normal',
      dedupeKey: 'waiting:prompt-b',
    });
    releaseFail();

    await expect(dispatchPromise).resolves.toBe(false);
    await afterSettled;

    expect(row).toMatchObject({
      status: 'failed',
      errorMessage: failureMessage,
    });
    expect(processingGuardHeldDuringFail).toBe(true);
    expect(processingSet.has(sessionId)).toBe(false);
    expect(onChainSettled).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      attentionGeneration: 'turn-a',
      outcome: 'failed',
    }));
    expect(stateManager.getSessionState(sessionId)).toMatchObject({
      status: 'running',
      attentionGeneration: 'turn-b',
    });
    expect(events).not.toContainEqual({
      type: 'session:error',
      attentionGeneration: 'turn-b',
    });
    expect(fixture.metadata).toMatchObject({
      hasPendingPrompt: true,
      pendingPromptId: 'prompt-b',
      pendingPromptGeneration: 'turn-b',
    });
    const attentionStatus = await attention.status(workspacePath, {
      sessionId,
      includeCancelled: true,
    });
    expect(attentionStatus.events).toContainEqual(expect.objectContaining({
      promptId: 'prompt-b',
      attentionGeneration: 'turn-b',
      status: 'pending',
    }));
    expect(settleTerminal).not.toHaveBeenCalledWith(
      expect.objectContaining({ attentionGeneration: 'turn-b' }),
      expect.any(Function),
    );
    unsubscribeEvents();
  });
});
