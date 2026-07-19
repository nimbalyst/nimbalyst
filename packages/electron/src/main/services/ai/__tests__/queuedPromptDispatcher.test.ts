import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertQueuedPromptReloadTarget,
  resolveQueuedPromptDispatchTarget,
  tryClaimAndDispatchNextQueuedPrompt,
  type ClaimedQueuedPrompt,
  type QueuedPromptStoreLike,
} from '../queuedPromptDispatcher';
import { settleTerminalAttentionBeforeContinuation } from '../terminalAttentionSettlement';

describe('queuedPromptDispatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the session before dispatching a claimed queued prompt', async () => {
    vi.useFakeTimers();

    const order: string[] = [];
    const claimedPrompt: ClaimedQueuedPrompt = {
      id: 'prompt-1',
      prompt: 'continue',
      attachments: null,
      documentContext: { filePath: '/tmp/example.md' } as any,
    };

    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [claimedPrompt]),
      claim: vi.fn(async () => claimedPrompt),
      complete: vi.fn(async () => {
        order.push('complete');
      }),
      fail: vi.fn(async () => {
        order.push('fail');
      }),
    };

    const processingSet = new Set<string>();
    const targetWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn(() => {
          order.push('promptClaimed');
        }),
        mainFrame: {},
      },
    } as unknown as Electron.BrowserWindow;

    const sendMessageHandler = vi.fn(async () => {
      order.push('sendMessage');
      return { content: 'ok' };
    });
    const processed = await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {
        order.push('continue');
      }),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: ({ sessionId, promptId }) => {
        targetWindow.webContents.send('ai:promptClaimed', { sessionId, promptId });
      },
      processingSet,
      queueStore,
      resolveTarget: async () => ({
        routingWorkspacePath: '/workspace/project',
        expectedWorktreeId: null,
        expectedWorktreePath: null,
      }),
      sendMessageHandler,
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => {
        order.push('startSession');
        return 'turn-a';
      }),
      targetWindow,
      workspacePath: '/workspace/project',
    });

    expect(processed).toBe(true);
    expect(order).toEqual(['startSession', 'promptClaimed']);
    expect(processingSet.has('session-1')).toBe(true);

    await vi.runAllTimersAsync();

    expect(order).toEqual(['startSession', 'promptClaimed', 'sendMessage', 'complete', 'continue']);
    expect(processingSet.has('session-1')).toBe(false);
    expect(sendMessageHandler).toHaveBeenCalledWith(
      expect.anything(),
      'continue',
      expect.objectContaining({ queuedPromptId: 'prompt-1' }),
      'session-1',
      '/workspace/project',
      expect.objectContaining({
        attentionGeneration: 'turn-a',
        expectedWorktreeId: null,
        expectedWorktreePath: null,
        registerDeferredDrainReplay: expect.any(Function),
      }),
    );
  });

  it('fires onChainSettled when no follow-on prompt is dispatched', async () => {
    vi.useFakeTimers();

    const claimedPrompt: ClaimedQueuedPrompt = {
      id: 'prompt-1',
      prompt: 'continue',
      attachments: null,
      documentContext: null,
    };

    let rowStatus: 'pending' | 'executing' | 'completed' = 'pending';
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => rowStatus === 'pending' ? [claimedPrompt] : []),
      claim: vi.fn(async () => {
        rowStatus = 'executing';
        return claimedPrompt;
      }),
      complete: vi.fn(async () => {
        rowStatus = 'completed';
      }),
      fail: vi.fn(async () => {}),
    };

    const processingSet = new Set<string>();
    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    const onChainSettled = vi.fn(async () => {});
    // continueQueuedPromptChain doesn't dispatch a follow-on (no pending prompts).
    const continueQueuedPromptChain = vi.fn(async () => {});

    await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain,
      logError: vi.fn(),
      logInfo: vi.fn(),
      onChainSettled,
      onPromptClaimed: () => {},
      processingSet,
      queueStore,
      resolveTarget: async () => ({
        routingWorkspacePath: '/workspace/project',
        expectedWorktreeId: null,
        expectedWorktreePath: null,
      }),
      sendMessageHandler: vi.fn(async () => ({ content: 'ok' })),
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => 'turn-a'),
      targetWindow,
      workspacePath: '/workspace/project',
    });

    await vi.runAllTimersAsync();

    expect(processingSet.has('session-1')).toBe(false);
    expect(onChainSettled).toHaveBeenCalledTimes(1);
    expect(onChainSettled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspacePath: '/workspace/project',
      source: 'test queue',
      attentionGeneration: 'turn-a',
      outcome: 'completed',
    });
  });

  it('does NOT fire onChainSettled when a follow-on prompt is dispatched', async () => {
    vi.useFakeTimers();

    const claimedPrompt: ClaimedQueuedPrompt = {
      id: 'prompt-1',
      prompt: 'continue',
      attachments: null,
      documentContext: null,
    };

    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [claimedPrompt]),
      claim: vi.fn(async () => claimedPrompt),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };

    const processingSet = new Set<string>();
    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    const onChainSettled = vi.fn(async () => {});
    // continueQueuedPromptChain dispatches a follow-on by re-adding to processingSet.
    const continueQueuedPromptChain = vi.fn(async (sessionId: string) => {
      processingSet.add(sessionId);
    });

    await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain,
      logError: vi.fn(),
      logInfo: vi.fn(),
      onChainSettled,
      onPromptClaimed: () => {},
      processingSet,
      queueStore,
      resolveTarget: async () => ({
        routingWorkspacePath: '/workspace/project',
        expectedWorktreeId: null,
        expectedWorktreePath: null,
      }),
      sendMessageHandler: vi.fn(async () => ({ content: 'ok' })),
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => 'turn-a'),
      targetWindow,
      workspacePath: '/workspace/project',
    });

    await vi.runAllTimersAsync();

    expect(onChainSettled).not.toHaveBeenCalled();
  });

  it('keeps direct turn B active when queued turn A settles after releasing processingSet', async () => {
    vi.useFakeTimers();

    const sessionId = 'session-race';
    const turnA = 'turn-a';
    const turnB = 'turn-b';
    const processingSet = new Set<string>();
    const order: string[] = [];
    let activeState: { status: 'running'; attentionGeneration: string } | null = null;
    const promptState = {
      hasPendingPrompt: false,
      promptId: null as string | null,
      generation: null as string | null,
    };
    const attentionState = {
      status: 'cancelled' as 'pending' | 'cancelled',
      promptId: null as string | null,
      generation: null as string | null,
    };
    const claimedPrompt: ClaimedQueuedPrompt = {
      id: 'queued-a',
      prompt: 'queued turn A',
      attachments: null,
      documentContext: null,
    };
    let rowStatus: 'pending' | 'executing' | 'completed' = 'pending';
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => rowStatus === 'pending' ? [claimedPrompt] : []),
      claim: vi.fn(async () => {
        rowStatus = 'executing';
        return claimedPrompt;
      }),
      complete: vi.fn(async () => {
        rowStatus = 'completed';
      }),
      fail: vi.fn(async () => {}),
    };
    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {
        // This is the acceptance interleaving boundary: A has released the
        // queued-processing guard, so an ordinary direct turn B can start.
        expect(processingSet.has(sessionId)).toBe(false);
        activeState = { status: 'running', attentionGeneration: turnB };
        promptState.hasPendingPrompt = true;
        promptState.promptId = 'prompt-b';
        promptState.generation = turnB;
        attentionState.status = 'pending';
        attentionState.promptId = 'prompt-b';
        attentionState.generation = turnB;
      }),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onChainSettled: async (payload) => {
        const attentionGeneration = (payload as typeof payload & {
          attentionGeneration?: string;
        }).attentionGeneration;
        await settleTerminalAttentionBeforeContinuation({
          sessionId,
          attentionGeneration: attentionGeneration as string,
          reason: 'completed',
        }, async () => {
          order.push('terminal');
          // Mirrors SessionStateManager.endSession: without an expected
          // generation, a delayed A callback adopts and ends current turn B.
          if (
            attentionGeneration &&
            activeState &&
            activeState.attentionGeneration !== attentionGeneration
          ) {
            return;
          }
          const emittedGeneration = attentionGeneration || activeState?.attentionGeneration;
          activeState = null;
          // Model the terminal state subscription/backstop reached by the
          // emitted completion event.
          if (promptState.generation === emittedGeneration) {
            promptState.hasPendingPrompt = false;
            promptState.promptId = null;
            promptState.generation = null;
          }
          if (attentionState.generation === emittedGeneration) {
            attentionState.status = 'cancelled';
          }
        }, {
          clearPendingPrompt: vi.fn(async (_id, _pending, options) => {
            order.push('prompt:false');
            const superseded = Boolean(
              options.expectedGeneration &&
              promptState.hasPendingPrompt &&
              promptState.generation !== options.expectedGeneration,
            );
            if (!superseded) {
              promptState.hasPendingPrompt = false;
              promptState.promptId = null;
              promptState.generation = null;
            }
            return {
              sessionId,
              hasPendingPrompt: false,
              promptId: null,
              generation: null,
              applied: !superseded,
              superseded,
              local: {
                attempted: !superseded,
                succeeded: !superseded,
                skippedReason: superseded ? 'newer_prompt_is_pending' : null,
              },
              sync: {
                attempted: !superseded,
                succeeded: !superseded,
                skippedReason: superseded ? 'newer_prompt_is_pending' : null,
              },
              fullyPropagated: !superseded,
            };
          }) as any,
          settleAttention: vi.fn(async (_id, args) => {
            order.push('attention:settle');
            if (
              !args.attentionGeneration ||
              attentionState.generation === args.attentionGeneration
            ) {
              attentionState.status = 'cancelled';
              return 1;
            }
            return 0;
          }),
        });
      },
      onPromptClaimed: () => {},
      processingSet,
      queueStore,
      resolveTarget: async () => ({
        routingWorkspacePath: '/workspace/project',
        expectedWorktreeId: null,
        expectedWorktreePath: null,
      }),
      sendMessageHandler: vi.fn(async () => ({ content: 'ok' })),
      sessionId,
      source: 'forced A-to-B interleaving',
      startSession: vi.fn(async () => {
        activeState = { status: 'running', attentionGeneration: turnA };
        return turnA;
      }),
      targetWindow,
      workspacePath: '/workspace/project',
    });

    await vi.runAllTimersAsync();

    expect(order).toEqual(['prompt:false', 'attention:settle', 'terminal']);
    expect(activeState).toEqual({ status: 'running', attentionGeneration: turnB });
    expect(promptState).toEqual({
      hasPendingPrompt: true,
      promptId: 'prompt-b',
      generation: turnB,
    });
    expect(attentionState).toEqual({
      status: 'pending',
      promptId: 'prompt-b',
      generation: turnB,
    });
  });

  it('canonicalizes an active worktree alias before claim and completes only after handler success', async () => {
    const sessionId = 'session-worktree';
    const canonicalWorkspace = '/repo';
    const worktreePath = '/repo_worktrees/fresh';
    const persistedSession = {
      id: sessionId,
      workspacePath: canonicalWorkspace,
      worktreeId: 'worktree-fresh',
      worktreePath,
      worktreeIsArchived: false,
    };
    const row = {
      id: 'prompt-worktree-initial',
      prompt: 'implement the bounded task',
      status: 'pending' as 'pending' | 'executing' | 'completed' | 'failed',
      errorMessage: null as string | null,
    };
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let reportHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      reportHandlerStarted = resolve;
    });
    let reportChainSettled!: () => void;
    const chainSettled = new Promise<void>((resolve) => {
      reportChainSettled = resolve;
    });
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
      fail: vi.fn(async (_id, errorMessage) => {
        row.status = 'failed';
        row.errorMessage = errorMessage;
      }),
    };
    const lifecycleWorkspaces: string[] = [];
    const handlerWorkspaces: string[] = [];
    const executionCwds: string[] = [];
    const onChainSettled = vi.fn(async (payload) => {
      expect(payload).toMatchObject({
        sessionId,
        workspacePath: canonicalWorkspace,
        outcome: 'completed',
      });
      reportChainSettled();
    });

    const processed = await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onChainSettled,
      onPromptClaimed: vi.fn(),
      processingSet: new Set<string>(),
      queueStore,
      resolveTarget: ({ sessionId: requestedSessionId, workspacePath: requestedWorkspace }) =>
        resolveQueuedPromptDispatchTarget(
          requestedSessionId,
          requestedWorkspace,
          persistedSession,
        ),
      sendMessageHandler: vi.fn(async (_event, _message, _context, _sessionId, handlerWorkspace) => {
        handlerWorkspaces.push(handlerWorkspace!);
        executionCwds.push(persistedSession.worktreePath || handlerWorkspace!);
        reportHandlerStarted();
        await handlerGate;
        return { content: 'done' };
      }),
      sessionId,
      source: 'native-worktree initial prompt',
      startSession: vi.fn(async ({ workspacePath: lifecycleWorkspace }) => {
        lifecycleWorkspaces.push(lifecycleWorkspace);
        return 'turn-worktree-a';
      }),
      targetWindow: {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), mainFrame: {} },
      } as unknown as Electron.BrowserWindow,
      workspacePath: worktreePath,
    });

    expect(processed).toBe(true);
    expect(row.status).toBe('executing');
    await handlerStarted;
    expect(row.status).toBe('executing');
    expect(lifecycleWorkspaces).toEqual([canonicalWorkspace]);
    expect(handlerWorkspaces).toEqual([canonicalWorkspace]);
    expect(executionCwds).toEqual([worktreePath]);

    releaseHandler();
    await chainSettled;

    expect(row.status).toBe('completed');
    expect(row.errorMessage).toBeNull();
    expect(queueStore.claim).toHaveBeenCalledTimes(1);
    expect(queueStore.complete).toHaveBeenCalledTimes(1);
    expect(queueStore.fail).not.toHaveBeenCalled();
    expect(onChainSettled).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'deletion',
      {
        worktreeId: 'worktree-a',
        worktreePath: null,
        worktreeIsArchived: undefined,
      },
    ],
    [
      'replacement',
      {
        worktreeId: 'worktree-b',
        worktreePath: '/repo_worktrees/b',
        worktreeIsArchived: false,
      },
    ],
    [
      'archive',
      {
        isArchived: true,
      },
    ],
  ])('fails a claimed worktree turn when reload observes %s after preflight', async (_label, reloadMutation) => {
    const sessionId = 'session-worktree-race';
    const canonicalWorkspace = '/repo';
    const originalWorktreePath = '/repo_worktrees/a';
    const preflightSession = {
      id: sessionId,
      workspacePath: canonicalWorkspace,
      worktreeId: 'worktree-a',
      worktreePath: originalWorktreePath,
      isArchived: false,
      worktreeIsArchived: false,
    };
    const reloadedSession = { ...preflightSession } as {
      id: string;
      workspacePath: string;
      worktreeId: string | null;
      worktreePath: string | null;
      isArchived: boolean;
      worktreeIsArchived?: boolean;
    };
    const row = {
      id: `prompt-worktree-${_label}`,
      prompt: 'must stay target-bound',
      status: 'pending' as 'pending' | 'executing' | 'completed' | 'failed',
      errorMessage: null as string | null,
    };
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => row.status === 'pending' ? [row] : []),
      claim: vi.fn(async () => {
        if (row.status !== 'pending') return null;
        row.status = 'executing';
        Object.assign(reloadedSession, reloadMutation);
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
    const watcherConstructed = vi.fn();
    const providerConstructed = vi.fn();
    let capturedTurnContext: any;
    let reportAfterSettled!: () => void;
    const afterSettled = new Promise<void>((resolve) => {
      reportAfterSettled = resolve;
    });

    const accepted = await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onAfterSettled: async () => reportAfterSettled(),
      onChainSettled: vi.fn(async () => {}),
      onPromptClaimed: vi.fn(),
      processingSet: new Set<string>(),
      queueStore,
      resolveTarget: ({ sessionId: requestedId, workspacePath }) =>
        resolveQueuedPromptDispatchTarget(requestedId, workspacePath, preflightSession),
      sendMessageHandler: vi.fn(async (
        _event,
        _message,
        _context,
        requestedId,
        _routingWorkspace,
        turnContext,
      ) => {
        capturedTurnContext = turnContext;
        // This is the exact production assertion MessageStreamingHandler runs
        // after loadSession and before watcher/provider construction.
        assertQueuedPromptReloadTarget(requestedId!, reloadedSession, turnContext);
        watcherConstructed();
        providerConstructed();
        return { content: 'unexpected' };
      }),
      sessionId,
      source: `worktree ${_label} race`,
      startSession: vi.fn(async () => 'turn-worktree-race'),
      targetWindow: {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), mainFrame: {} },
      } as unknown as Electron.BrowserWindow,
      workspacePath: originalWorktreePath,
    });

    expect(accepted).toBe(true);
    await afterSettled;

    expect(capturedTurnContext).toEqual(expect.objectContaining({
      attentionGeneration: 'turn-worktree-race',
      expectedWorktreeId: 'worktree-a',
      expectedWorktreePath: originalWorktreePath,
      registerDeferredDrainReplay: expect.any(Function),
    }));
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toMatch(/archived|retired|changed worktree identity/i);
    expect(queueStore.fail).toHaveBeenCalledTimes(1);
    expect(queueStore.complete).not.toHaveBeenCalled();
    expect(watcherConstructed).not.toHaveBeenCalled();
    expect(providerConstructed).not.toHaveBeenCalled();
  });

  it.each([
    ['retired worktree alias', '/repo_worktrees/retired'],
    ['unrelated workspace alias', '/other-repo'],
  ])('rejects a %s before listing or claiming a queue row', async (_label, requestedWorkspace) => {
    const sessionId = 'session-worktree';
    const persistedSession = {
      id: sessionId,
      workspacePath: '/repo',
      worktreeId: 'worktree-active',
      worktreePath: '/repo_worktrees/active',
      worktreeIsArchived: false,
    };
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [{ id: 'prompt-1', prompt: 'continue' }]),
      claim: vi.fn(async (id) => ({ id, prompt: 'continue' })),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };
    const sendMessageHandler = vi.fn(async () => ({ content: 'unexpected' }));
    const startSession = vi.fn(async () => 'turn-unexpected');

    const processed = await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: vi.fn(),
      processingSet: new Set<string>(),
      queueStore,
      resolveTarget: ({ sessionId: requestedSessionId, workspacePath }) =>
        resolveQueuedPromptDispatchTarget(
          requestedSessionId,
          workspacePath,
          persistedSession,
        ),
      sendMessageHandler,
      sessionId,
      source: 'invalid alias preflight',
      startSession,
      targetWindow: {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), mainFrame: {} },
      } as unknown as Electron.BrowserWindow,
      workspacePath: requestedWorkspace,
    });

    expect(processed).toBe(false);
    expect(queueStore.listPending).not.toHaveBeenCalled();
    expect(queueStore.claim).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it.each([
    [
      'archived session',
      {
        id: 'session-retired',
        workspacePath: '/repo',
        worktreeId: 'worktree-active',
        worktreePath: '/repo_worktrees/active',
        isArchived: true,
        worktreeIsArchived: false,
      },
    ],
    [
      'archived worktree',
      {
        id: 'session-retired',
        workspacePath: '/repo',
        worktreeId: 'worktree-retired',
        worktreePath: '/repo_worktrees/retired',
        isArchived: false,
        worktreeIsArchived: true,
      },
    ],
    [
      'deleted worktree row',
      {
        id: 'session-retired',
        workspacePath: '/repo',
        worktreeId: 'worktree-deleted',
        worktreePath: null,
        isArchived: false,
        worktreeIsArchived: undefined,
      },
    ],
  ])('rejects a %s before listing or claiming its queue', async (_label, persistedSession) => {
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [{ id: 'prompt-1', prompt: 'continue' }]),
      claim: vi.fn(async (id) => ({ id, prompt: 'continue' })),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };
    const startSession = vi.fn(async () => 'turn-unexpected');
    const sendMessageHandler = vi.fn(async () => ({ content: 'unexpected' }));

    const processed = await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: vi.fn(),
      processingSet: new Set<string>(),
      queueStore,
      resolveTarget: ({ sessionId, workspacePath }) =>
        resolveQueuedPromptDispatchTarget(
          sessionId,
          workspacePath,
          persistedSession,
        ),
      sendMessageHandler,
      sessionId: persistedSession.id,
      source: 'retired target preflight',
      startSession,
      targetWindow: {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), mainFrame: {} },
      } as unknown as Electron.BrowserWindow,
      workspacePath: persistedSession.workspacePath,
    });

    expect(processed).toBe(false);
    expect(queueStore.listPending).not.toHaveBeenCalled();
    expect(queueStore.claim).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it('settles a plain post-claim handler throw as failed without continuing the queue', async () => {
    vi.useFakeTimers();
    const claimedPrompt: ClaimedQueuedPrompt = {
      id: 'prompt-handler-failure',
      prompt: 'fail before provider start',
    };
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [claimedPrompt]),
      claim: vi.fn(async () => claimedPrompt),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };
    const processingSet = new Set<string>();
    const continueQueuedPromptChain = vi.fn(async () => {});
    const onChainSettled = vi.fn(async () => {});

    await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain,
      logError: vi.fn(),
      logInfo: vi.fn(),
      onChainSettled,
      onPromptClaimed: vi.fn(),
      processingSet,
      queueStore,
      resolveTarget: async () => ({
        routingWorkspacePath: '/repo',
        expectedWorktreeId: null,
        expectedWorktreePath: null,
      }),
      sendMessageHandler: vi.fn(async () => {
        throw new Error('plain early validation failure');
      }),
      sessionId: 'session-handler-failure',
      source: 'handler failure',
      startSession: vi.fn(async () => 'turn-handler-failure'),
      targetWindow: {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), mainFrame: {} },
      } as unknown as Electron.BrowserWindow,
      workspacePath: '/repo',
    });

    await vi.runAllTimersAsync();

    expect(queueStore.fail).toHaveBeenCalledTimes(1);
    expect(queueStore.fail).toHaveBeenCalledWith(
      'prompt-handler-failure',
      'plain early validation failure',
    );
    expect(queueStore.complete).not.toHaveBeenCalled();
    expect(continueQueuedPromptChain).not.toHaveBeenCalled();
    expect(processingSet.has('session-handler-failure')).toBe(false);
    expect(onChainSettled).toHaveBeenCalledTimes(1);
    expect(onChainSettled).toHaveBeenCalledWith({
      sessionId: 'session-handler-failure',
      workspacePath: '/repo',
      source: 'handler failure',
      attentionGeneration: 'turn-handler-failure',
      outcome: 'failed',
    });
  });

  it('fails the claimed row and returns false when session start fails before handler scheduling', async () => {
    const claimedPrompt: ClaimedQueuedPrompt = {
      id: 'prompt-start-failure',
      prompt: 'cannot start',
    };
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [claimedPrompt]),
      claim: vi.fn(async () => claimedPrompt),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };
    const processingSet = new Set<string>();
    const onChainSettled = vi.fn(async () => {});
    const onPromptClaimed = vi.fn();
    const sendMessageHandler = vi.fn(async () => ({ content: 'unexpected' }));

    await expect(tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onChainSettled,
      onPromptClaimed,
      processingSet,
      queueStore,
      resolveTarget: async () => ({
        routingWorkspacePath: '/repo',
        expectedWorktreeId: null,
        expectedWorktreePath: null,
      }),
      sendMessageHandler,
      sessionId: 'session-start-failure',
      source: 'start failure',
      startSession: vi.fn(async () => {
        throw new Error('state start failed');
      }),
      targetWindow: {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), mainFrame: {} },
      } as unknown as Electron.BrowserWindow,
      workspacePath: '/repo',
    })).resolves.toBe(false);

    expect(queueStore.fail).toHaveBeenCalledTimes(1);
    expect(queueStore.fail).toHaveBeenCalledWith('prompt-start-failure', 'state start failed');
    expect(queueStore.complete).not.toHaveBeenCalled();
    expect(onPromptClaimed).not.toHaveBeenCalled();
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(processingSet.has('session-start-failure')).toBe(false);
    expect(onChainSettled).toHaveBeenCalledWith({
      sessionId: 'session-start-failure',
      workspacePath: '/repo',
      source: 'start failure',
      attentionGeneration: undefined,
      outcome: 'failed',
    });
  });
});
