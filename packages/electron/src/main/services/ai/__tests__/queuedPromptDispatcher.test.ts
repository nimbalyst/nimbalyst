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
});
