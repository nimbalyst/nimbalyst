import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  tryClaimAndDispatchNextQueuedPrompt,
  type ClaimedQueuedPrompt,
  type QueuedPromptStoreLike,
} from '../queuedPromptDispatcher';

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

    const processingSet = new Map<string, symbol>();
    const targetWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn(() => {
          order.push('promptClaimed');
        }),
        mainFrame: {},
      },
    } as unknown as Electron.BrowserWindow;

    const processed = await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {
        order.push('continue');
      }),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: ({ sessionId, promptId }) => {
        targetWindow.webContents.send('ai:promptClaimed', { sessionId, promptId });
      },
      processingLeases: processingSet,
      queueStore,
      sendMessageHandler: vi.fn(async () => {
        order.push('sendMessage');
        return { content: 'ok' };
      }),
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => {
        order.push('startSession');
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
  });

  it('fires onChainSettled when no follow-on prompt is dispatched', async () => {
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

    const processingSet = new Map<string, symbol>();
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
      processingLeases: processingSet,
      queueStore,
      sendMessageHandler: vi.fn(async () => ({ content: 'ok' })),
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => {}),
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

    const processingSet = new Map<string, symbol>();
    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    const onChainSettled = vi.fn(async () => {});
    // continueQueuedPromptChain dispatches a follow-on by acquiring a new lease.
    const continueQueuedPromptChain = vi.fn(async (sessionId: string) => {
      processingSet.set(sessionId, Symbol('follow-on'));
    });

    await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain,
      logError: vi.fn(),
      logInfo: vi.fn(),
      onChainSettled,
      onPromptClaimed: () => {},
      processingLeases: processingSet,
      queueStore,
      sendMessageHandler: vi.fn(async () => ({ content: 'ok' })),
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => {}),
      targetWindow,
      workspacePath: '/workspace/project',
    });

    await vi.runAllTimersAsync();

    expect(onChainSettled).not.toHaveBeenCalled();
  });

  it('dispatches an ordinary prompt exactly once when post-turn drains race', async () => {
    vi.useFakeTimers();

    const queued: ClaimedQueuedPrompt = {
      id: 'ordinary-after-active-turn',
      prompt: 'continue after the current turn',
      attachments: null,
      documentContext: null,
    };
    let claimed = false;
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => claimed ? [] : [queued]),
      claim: vi.fn(async () => {
        if (claimed) return null;
        claimed = true;
        return queued;
      }),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };
    const sendMessageHandler = vi.fn(async () => ({ content: 'ok' }));
    const processingSet = new Map<string, symbol>();
    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;
    const options = {
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: vi.fn(),
      processingLeases: processingSet,
      queueStore,
      sendMessageHandler,
      sessionId: 'session-1',
      source: 'completion-handler queue',
      startSession: vi.fn(async () => {}),
      targetWindow,
      workspacePath: '/workspace/project',
    };

    const results = await Promise.all([
      tryClaimAndDispatchNextQueuedPrompt(options),
      tryClaimAndDispatchNextQueuedPrompt(options),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    await vi.runAllTimersAsync();

    expect(queueStore.claim).toHaveBeenCalledTimes(2);
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(queueStore.complete).toHaveBeenCalledTimes(1);
  });

  it('keeps an ordinary FIFO prompt fenced while an interrupting priority dispatch owns the lease', async () => {
    const deferred = () => {
      let resolve!: () => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      return { promise, resolve, reject };
    };

    const sessionId = 'interrupted-session';
    const oldPrompt: ClaimedQueuedPrompt = {
      id: 'initial-executing',
      prompt: 'initial turn',
    };
    const priorityPrompt: ClaimedQueuedPrompt = {
      id: 'priority-control',
      prompt: 'priority turn',
    };
    const ordinaryPrompt: ClaimedQueuedPrompt = {
      id: 'ordinary-fifo',
      prompt: 'ordinary turn',
    };
    const rows = new Map([
      [oldPrompt.id, { prompt: oldPrompt, status: 'pending' }],
      [priorityPrompt.id, { prompt: priorityPrompt, status: 'held' }],
      [ordinaryPrompt.id, { prompt: ordinaryPrompt, status: 'held' }],
    ]);
    const claims: string[] = [];
    const completions: string[] = [];
    const failures: string[] = [];
    const effects: string[] = [];
    const oldStarted = deferred();
    const priorityStarted = deferred();
    const oldTurn = deferred();
    const priorityTurn = deferred();
    const structuredPromptPersisted = deferred();
    const structuredReply = deferred();
    const ordinaryCompleted = deferred();

    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () =>
        [...rows.values()]
          .filter((row) => row.status === 'pending')
          .map((row) => row.prompt)),
      claim: vi.fn(async (promptId) => {
        const row = rows.get(promptId);
        if (!row || row.status !== 'pending') return null;
        row.status = 'executing';
        claims.push(promptId);
        return row.prompt;
      }),
      complete: vi.fn(async (promptId) => {
        const row = rows.get(promptId);
        if (row) row.status = 'completed';
        completions.push(promptId);
        if (promptId === ordinaryPrompt.id) ordinaryCompleted.resolve();
      }),
      fail: vi.fn(async (promptId) => {
        const row = rows.get(promptId);
        if (row) row.status = 'failed';
        failures.push(promptId);
      }),
    };
    const processingSet = new Map<string, symbol>();
    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;
    const sendMessageHandler = vi.fn(async (
      _event: Electron.IpcMainInvokeEvent,
      message: string,
    ) => {
      if (message === oldPrompt.prompt) {
        oldStarted.resolve();
        await oldTurn.promise;
      } else if (message === priorityPrompt.prompt) {
        priorityStarted.resolve();
        await priorityTurn.promise;
        effects.push('PRIORITY_ACK');
      } else {
        effects.push('ORDINARY_MARKER');
        structuredPromptPersisted.resolve();
        await structuredReply.promise;
        effects.push('STRUCTURED_REPLY_CONTINUED');
      }
      return { content: message };
    });
    let dispatch!: (source: string) => Promise<boolean>;
    const continueQueuedPromptChain = vi.fn(async () => {
      await dispatch('test continuation');
    });
    dispatch = (source) => tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain,
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: vi.fn(),
      processingLeases: processingSet,
      queueStore,
      sendMessageHandler,
      sessionId,
      source,
      startSession: vi.fn(async () => {}),
      targetWindow,
      workspacePath: '/workspace/project',
    });

    expect(await dispatch('initial queue')).toBe(true);
    await oldStarted.promise;

    // Priority interruption revokes the initial dispatch lease before claiming
    // the control prompt. The replacement priority dispatch must remain fenced
    // when the interrupted dispatch's stale finally block later runs.
    processingSet.delete(sessionId);
    rows.get(priorityPrompt.id)!.status = 'pending';
    expect(await dispatch('priority queue')).toBe(true);
    await priorityStarted.promise;
    rows.get(ordinaryPrompt.id)!.status = 'pending';

    oldTurn.reject(new Error('native abort'));
    await vi.waitFor(() => {
      expect(failures).toEqual([oldPrompt.id]);
    });

    expect(processingSet.has(sessionId)).toBe(true);
    expect(claims).toEqual([oldPrompt.id, priorityPrompt.id]);
    expect(completions).toEqual([]);
    expect(effects).toEqual([]);
    expect(continueQueuedPromptChain).not.toHaveBeenCalled();

    priorityTurn.resolve();
    await structuredPromptPersisted.promise;

    // AskUserQuestion is now durable and waiting for its response. The FIFO
    // dispatch must keep its own lease until that structured reply settles;
    // completion must not clear the lease early or start a duplicate drain.
    expect(processingSet.has(sessionId)).toBe(true);
    expect(rows.get(ordinaryPrompt.id)?.status).toBe('executing');
    expect(completions).toEqual([priorityPrompt.id]);

    structuredReply.resolve();
    await ordinaryCompleted.promise;

    expect(claims).toEqual([oldPrompt.id, priorityPrompt.id, ordinaryPrompt.id]);
    expect(completions).toEqual([priorityPrompt.id, ordinaryPrompt.id]);
    expect(effects).toEqual(['PRIORITY_ACK', 'ORDINARY_MARKER', 'STRUCTURED_REPLY_CONTINUED']);
    expect(sendMessageHandler).toHaveBeenCalledTimes(3);
  });
});
