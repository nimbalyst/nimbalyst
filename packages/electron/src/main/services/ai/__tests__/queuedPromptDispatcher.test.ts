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

    const processingSet = new Set<string>();

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

    const processingSet = new Set<string>();

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
    const processingSet = new Set<string>();
    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;
    const options = {
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: vi.fn(),
      processingSet,
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
});
