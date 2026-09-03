// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionProcessingGuard,
  dispatchClaimedQueuedPrompt,
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

    const processingSet = new SessionProcessingGuard();
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
      processingSet,
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

    const processingSet = new SessionProcessingGuard();
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

  it('dispatches once to a replacement window when the original window is destroyed', async () => {
    vi.useFakeTimers();

    // Regression: a long guarded/streaming prompt retains its original
    // BrowserWindow. If that renderer dies or reloads, FIFO continuation must
    // not bail just because the passed window is gone — a replacement window
    // for the same workspace should receive the next queued prompt exactly once.
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

    const processingSet = new SessionProcessingGuard();

    // The original window is destroyed (renderer died/reloaded mid-stream).
    const destroyedWindow = {
      isDestroyed: () => true,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    // The replacement window for the same workspace is live.
    const replacementWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    let dispatchedSender: Electron.WebContents | undefined;
    const sendMessageHandler = vi.fn(async (event: Electron.IpcMainInvokeEvent) => {
      dispatchedSender = event.sender;
      return { content: 'ok' };
    });
    const resolveLiveWindow = vi.fn((_workspacePath: string) => replacementWindow);

    const processed = await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: () => {},
      processingSet,
      queueStore,
      sendMessageHandler,
      resolveLiveWindow,
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => {}),
      targetWindow: destroyedWindow,
      workspacePath: '/workspace/project',
    });

    // Without the fix the dispatcher bails on the destroyed window and never
    // resolves a replacement, so nothing is dispatched.
    expect(processed).toBe(true);
    expect(resolveLiveWindow).toHaveBeenCalledWith('/workspace/project');

    await vi.runAllTimersAsync();

    // Exactly-once after the deferred dispatch settles. The replacement
    // window's webContents, not the destroyed original, is the IPC sender.
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(dispatchedSender).toBe(replacementWindow.webContents);
    expect(queueStore.complete).toHaveBeenCalledTimes(1);
    expect(queueStore.fail).not.toHaveBeenCalled();
    expect(processingSet.has('session-1')).toBe(false);
  });

  it('bails (without dispatching) when the window is destroyed and no replacement exists', async () => {
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

    const processingSet = new SessionProcessingGuard();

    const destroyedWindow = {
      isDestroyed: () => true,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    const sendMessageHandler = vi.fn(async () => ({ content: 'ok' }));

    const processed = await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: () => {},
      processingSet,
      queueStore,
      sendMessageHandler,
      resolveLiveWindow: vi.fn(() => null),
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => {}),
      targetWindow: destroyedWindow,
      workspacePath: '/workspace/project',
    });

    expect(processed).toBe(false);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(queueStore.claim).not.toHaveBeenCalled();
    expect(processingSet.has('session-1')).toBe(false);
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

    const processingSet = new SessionProcessingGuard();
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

  it('keeps the guard held for a priority prompt when the dispatch it displaced settles (#1018)', async () => {
    vi.useFakeTimers();

    // #1018: an interrupt drops the processing guard and replaces the in-flight
    // queued prompt with a priority one. The displaced dispatch still has a
    // pending `finally`; when it runs it must not release a guard the priority
    // prompt now owns, or the FIFO continuation claims the next prompt and sends
    // it while the priority turn is still executing.
    const displaced: ClaimedQueuedPrompt = {
      id: 'prompt-displaced',
      prompt: 'displaced',
      attachments: null,
      documentContext: null,
    };
    const priority: ClaimedQueuedPrompt = {
      id: 'prompt-priority',
      prompt: 'priority',
      attachments: null,
      documentContext: null,
    };
    const fifo: ClaimedQueuedPrompt = {
      id: 'prompt-fifo',
      prompt: 'fifo',
      attachments: null,
      documentContext: null,
    };

    let pending: ClaimedQueuedPrompt[] = [displaced];
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => pending),
      claim: vi.fn(async (promptId: string) => {
        const found = pending.find((row) => row.id === promptId) ?? null;
        pending = pending.filter((row) => row.id !== promptId);
        return found;
      }),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };

    const processingSet = new SessionProcessingGuard();
    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    // Each turn hangs until the test settles it by its prompt text.
    const settleTurn = new Map<string, () => void>();
    const sendMessageHandler = vi.fn(
      async (_event: Electron.IpcMainInvokeEvent, message: string) => {
        await new Promise<void>((resolve) => settleTurn.set(message, resolve));
        return { content: 'ok' };
      },
    );

    const continueQueuedPromptChain = vi.fn(
      async (
        sessionId: string,
        _workspacePath: string,
        _window: Electron.BrowserWindow,
        source: string,
      ) => {
        await tryClaimAndDispatchNextQueuedPrompt({
          ...dispatchOptions(),
          logInfo: vi.fn(),
          sessionId,
          source,
        });
      },
    );

    const dispatchOptions = () => ({
      continueQueuedPromptChain,
      logError: vi.fn(),
      onPromptClaimed: () => {},
      processingSet,
      queueStore,
      sendMessageHandler,
      startSession: vi.fn(async () => {}),
      targetWindow,
      workspacePath: '/workspace/project',
    });

    const flush = async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    };

    // The ordinary FIFO dispatch takes the guard and starts its turn.
    await tryClaimAndDispatchNextQueuedPrompt({
      ...dispatchOptions(),
      logInfo: vi.fn(),
      sessionId: 'session-1',
      source: 'initial',
    });
    await flush();
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);

    // The interrupt drops the guard, then the priority prompt takes it.
    processingSet.delete('session-1');
    await dispatchClaimedQueuedPrompt({
      ...dispatchOptions(),
      claimed: priority,
      sessionId: 'session-1',
      source: 'priority',
    });
    await flush();
    expect(sendMessageHandler).toHaveBeenCalledTimes(2);
    expect(processingSet.has('session-1')).toBe(true);

    // A FIFO prompt lands behind the priority turn; the displaced dispatch now
    // settles and runs its `finally`.
    pending = [fifo];
    settleTurn.get('displaced')!();
    await flush();

    // The priority turn still owns the guard, so the FIFO prompt stays queued.
    expect(processingSet.has('session-1')).toBe(true);
    expect(queueStore.claim).not.toHaveBeenCalledWith('prompt-fifo');
    expect(sendMessageHandler).toHaveBeenCalledTimes(2);

    // Once the priority turn settles it releases its own guard, and the FIFO
    // prompt is claimed by the normal continuation.
    settleTurn.get('priority')!();
    await flush();
    expect(queueStore.claim).toHaveBeenCalledWith('prompt-fifo');
    expect(sendMessageHandler).toHaveBeenCalledTimes(3);

    settleTurn.get('fifo')!();
    await vi.runAllTimersAsync();
    expect(processingSet.has('session-1')).toBe(false);
  });
});
