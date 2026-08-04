import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionPromptDispatchPreflight,
  tryClaimAndDispatchNextQueuedPrompt,
  type ClaimedQueuedPrompt,
  type QueuedPromptStoreLike,
} from '../queuedPromptDispatcher';

const settled = { outcome: 'settled' as const };

function claimed(id = 'prompt-1', prompt = 'continue'): ClaimedQueuedPrompt {
  return { id, prompt, claimToken: `token-${id}`, attachments: null, documentContext: null };
}

function queueStoreFor(row: ClaimedQueuedPrompt): QueuedPromptStoreLike {
  return {
    listPending: vi.fn(async () => [row]),
    claim: vi.fn(async () => row),
    beginDispatch: vi.fn(async () => settled),
    releaseClaim: vi.fn(async () => settled),
    completeAfterDispatch: vi.fn(async () => settled),
    failAfterDispatch: vi.fn(async () => settled),
  };
}

function windowFixture(): Electron.BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn(), mainFrame: {} },
  } as unknown as Electron.BrowserWindow;
}

function optionsFor(queueStore: QueuedPromptStoreLike, overrides: Record<string, unknown> = {}) {
  return {
    continueQueuedPromptChain: vi.fn(async () => {}),
    logError: vi.fn(),
    logInfo: vi.fn(),
    onChainSettled: vi.fn(async () => {}),
    onPromptClaimed: vi.fn(),
    preflight: vi.fn(async () => true),
    processingLeases: new Map<string, symbol>(),
    queueStore,
    sendMessageHandler: vi.fn(async () => ({ content: 'ok' })),
    sessionId: 'session-1',
    source: 'test queue',
    startSession: vi.fn(async () => {}),
    targetWindow: windowFixture(),
    workspacePath: '/workspace/project',
    ...overrides,
  };
}

describe('queuedPromptDispatcher token owner', () => {
  afterEach(() => vi.useRealTimers());

  it('persists intent before send and settles the exact token before continuing', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const row = claimed();
    const store = queueStoreFor(row);
    vi.mocked(store.beginDispatch).mockImplementation(async () => {
      order.push('begin');
      return settled;
    });
    vi.mocked(store.completeAfterDispatch).mockImplementation(async () => {
      order.push('complete');
      return settled;
    });
    const options = optionsFor(store, {
      startSession: vi.fn(async () => { order.push('start'); }),
      onPromptClaimed: vi.fn(() => { order.push('notify'); }),
      sendMessageHandler: vi.fn(async () => { order.push('send'); return { content: 'ok' }; }),
      continueQueuedPromptChain: vi.fn(async () => { order.push('continue'); }),
    });

    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).resolves.toBe(true);
    expect(order).toEqual(['start', 'notify']);
    await vi.runAllTimersAsync();
    expect(order).toEqual(['start', 'notify', 'begin', 'send', 'complete', 'continue']);
    expect(store.beginDispatch).toHaveBeenCalledWith('prompt-1', 'session-1', 'token-prompt-1');
    expect(store.completeAfterDispatch).toHaveBeenCalledWith(
      'prompt-1', 'session-1', 'token-prompt-1',
    );
    expect(options.onChainSettled).toHaveBeenCalledTimes(1);
  });

  it('makes notification best-effort without releasing or wedging the claim', async () => {
    vi.useFakeTimers();
    const store = queueStoreFor(claimed());
    const options = optionsFor(store, {
      onPromptClaimed: vi.fn(() => { throw new Error('destroyed window'); }),
    });
    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).resolves.toBe(true);
    await vi.runAllTimersAsync();
    expect(options.sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(store.completeAfterDispatch).toHaveBeenCalledTimes(1);
    expect(store.releaseClaim).not.toHaveBeenCalled();
  });

  it('releases the exact undispatched token when session start fails', async () => {
    const row = claimed();
    const store = queueStoreFor(row);
    const options = optionsFor(store, {
      startSession: vi.fn(async () => { throw new Error('start failed'); }),
    });
    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).rejects.toThrow('start failed');
    expect(store.releaseClaim).toHaveBeenCalledWith(row.id, 'session-1', row.claimToken);
    expect(store.beginDispatch).not.toHaveBeenCalled();
    expect(options.sendMessageHandler).not.toHaveBeenCalled();
    expect(options.processingLeases.has('session-1')).toBe(false);
  });

  it('releases instead of failing when the production send handler is unavailable', async () => {
    const row = claimed();
    const store = queueStoreFor(row);
    const options = optionsFor(store, { sendMessageHandler: null });
    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).resolves.toBe(false);
    expect(store.releaseClaim).toHaveBeenCalledWith(row.id, 'session-1', row.claimToken);
    expect(store.beginDispatch).not.toHaveBeenCalled();
  });

  it('does not send or settle another owner when begin-dispatch is rejected', async () => {
    vi.useFakeTimers();
    const store = queueStoreFor(claimed());
    vi.mocked(store.beginDispatch).mockResolvedValue({ outcome: 'stale_owner' });
    const options = optionsFor(store);
    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).resolves.toBe(true);
    await vi.runAllTimersAsync();
    expect(options.sendMessageHandler).not.toHaveBeenCalled();
    expect(store.completeAfterDispatch).not.toHaveBeenCalled();
    expect(store.failAfterDispatch).not.toHaveBeenCalled();
    expect(options.continueQueuedPromptChain).not.toHaveBeenCalled();
    expect(options.onChainSettled).not.toHaveBeenCalled();
  });

  it('dispatches once to a replacement window when the original window is destroyed', async () => {
    vi.useFakeTimers();

    // Regression: a long guarded/streaming prompt retains its original
    // BrowserWindow. If that renderer dies or reloads, FIFO continuation must
    // not bail just because the passed window is gone — a replacement window
    // for the same workspace should receive the next queued prompt exactly once.
    const store = queueStoreFor(claimed());

    // The original window is destroyed (renderer died/reloaded mid-stream).
    const destroyedWindow = {
      isDestroyed: () => true,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    // The replacement window for the same workspace is live.
    const replacementWindow = windowFixture();

    let dispatchedSender: Electron.WebContents | undefined;
    const resolveLiveWindow = vi.fn((_workspacePath: string) => replacementWindow);
    const options = optionsFor(store, {
      targetWindow: destroyedWindow,
      resolveLiveWindow,
      sendMessageHandler: vi.fn(async (event: Electron.IpcMainInvokeEvent) => {
        dispatchedSender = event.sender;
        return { content: 'ok' };
      }),
    });

    const processed = await tryClaimAndDispatchNextQueuedPrompt(options);

    // Without the fix the dispatcher bails on the destroyed window and never
    // resolves a replacement, so nothing is dispatched.
    expect(processed).toBe(true);
    expect(resolveLiveWindow).toHaveBeenCalledWith('/workspace/project');

    await vi.runAllTimersAsync();

    // Exactly-once after the deferred dispatch settles. The replacement
    // window's webContents, not the destroyed original, is the IPC sender.
    expect(options.sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(dispatchedSender).toBe(replacementWindow.webContents);
    expect(store.completeAfterDispatch).toHaveBeenCalledTimes(1);
    expect(store.failAfterDispatch).not.toHaveBeenCalled();
    expect(options.processingLeases.has('session-1')).toBe(false);
  });

  it('bails (without dispatching) when the window is destroyed and no replacement exists', async () => {
    vi.useFakeTimers();

    const store = queueStoreFor(claimed());

    const destroyedWindow = {
      isDestroyed: () => true,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    const options = optionsFor(store, {
      targetWindow: destroyedWindow,
      resolveLiveWindow: vi.fn(() => null),
    });

    const processed = await tryClaimAndDispatchNextQueuedPrompt(options);

    expect(processed).toBe(false);
    expect(options.sendMessageHandler).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(options.processingLeases.has('session-1')).toBe(false);
  });

  it('does NOT fire onChainSettled when a follow-on prompt is dispatched', async () => {
    vi.useFakeTimers();

    const store = queueStoreFor(claimed());
    const onChainSettled = vi.fn(async () => {});
    const processingLeases = new Map<string, symbol>();
    // continueQueuedPromptChain dispatches a follow-on by re-acquiring the lease.
    const continueQueuedPromptChain = vi.fn(async (sessionId: string) => {
      processingLeases.set(sessionId, Symbol('follow-on'));
    });
    const options = optionsFor(store, {
      onChainSettled,
      processingLeases,
      continueQueuedPromptChain,
    });

    await tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.runAllTimersAsync();

    expect(onChainSettled).not.toHaveBeenCalled();
  });

  it('fails the same begun token on send error and only then continues', async () => {
    vi.useFakeTimers();
    const row = claimed();
    const store = queueStoreFor(row);
    const options = optionsFor(store, {
      sendMessageHandler: vi.fn(async () => { throw new Error('provider failed'); }),
    });
    await tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.runAllTimersAsync();
    expect(store.failAfterDispatch).toHaveBeenCalledWith(
      row.id,
      'provider failed',
      'session-1',
      row.claimToken,
    );
    expect(options.continueQueuedPromptChain).toHaveBeenCalledTimes(1);
  });

  it('does not continue or end a replacement lifecycle after rejected completion', async () => {
    vi.useFakeTimers();
    const store = queueStoreFor(claimed());
    vi.mocked(store.completeAfterDispatch).mockResolvedValue({ outcome: 'stale_owner' });
    const options = optionsFor(store);
    await tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.runAllTimersAsync();
    expect(options.continueQueuedPromptChain).not.toHaveBeenCalled();
    expect(options.onChainSettled).not.toHaveBeenCalled();
  });

  it('lets a late same-token owner settle but not continue after its lease was revoked', async () => {
    let finishSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { finishSend = resolve; });
    const row = claimed('owner-a');
    const store = queueStoreFor(row);
    const leases = new Map<string, symbol>();
    const options = optionsFor(store, {
      processingLeases: leases,
      sendMessageHandler: vi.fn(async () => { await sendGate; return { content: 'late' }; }),
    });
    await tryClaimAndDispatchNextQueuedPrompt(options);
    await new Promise<void>((resolve) => setImmediate(resolve));
    leases.set('session-1', Symbol('owner-b'));
    finishSend();
    await vi.waitFor(() => expect(store.completeAfterDispatch).toHaveBeenCalledTimes(1));
    expect(options.continueQueuedPromptChain).not.toHaveBeenCalled();
    expect(leases.has('session-1')).toBe(true);
  });

  it.each([
    ['missing', null],
    ['pending marker', { metadata: { modelChangeReconciliation: { status: 'pending' } } }],
    ['malformed metadata', { metadata: '{not-json' }],
  ])('fails closed before list/claim/send for %s', async (_label, session) => {
    const preflight = createSessionPromptDispatchPreflight(async () => session as any);
    const store = queueStoreFor(claimed());
    const options = optionsFor(store, { preflight });
    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).resolves.toBe(false);
    expect(store.listPending).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(options.sendMessageHandler).not.toHaveBeenCalled();
  });

  it('delegates a marker installed after listing to the atomic claim', async () => {
    const row = claimed('race');
    const store = queueStoreFor(row);
    vi.mocked(store.claim).mockResolvedValue(null);
    const options = optionsFor(store);
    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).resolves.toBe(false);
    expect(store.claim).toHaveBeenCalledWith('race', 'session-1', 'test queue');
    expect(store.beginDispatch).not.toHaveBeenCalled();
  });
});
