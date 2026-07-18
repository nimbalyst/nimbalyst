import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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
      { attentionGeneration: 'turn-a' },
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
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [claimedPrompt]),
      claim: vi.fn(async () => claimedPrompt),
      complete: vi.fn(async () => {}),
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
});
