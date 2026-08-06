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

describe('queuedPromptDispatcher reservation race fix (NIM-590)', () => {
  afterEach(() => vi.useRealTimers());

  it('a second concurrent call for the same session fails the has() check without calling listPending or claim itself', async () => {
    let resolveListPending!: (value: ClaimedQueuedPrompt[]) => void;
    const listPendingGate = new Promise<ClaimedQueuedPrompt[]>((resolve) => {
      resolveListPending = resolve;
    });
    const store = queueStoreFor(claimed());
    vi.mocked(store.listPending).mockImplementation(() => listPendingGate);
    const processingLeases = new Map<string, symbol>();
    const options1 = optionsFor(store, { processingLeases });
    const options2 = optionsFor(store, { processingLeases });

    const call1 = tryClaimAndDispatchNextQueuedPrompt(options1);
    await vi.waitFor(() => expect(store.listPending).toHaveBeenCalledTimes(1));
    expect(processingLeases.has('session-1')).toBe(true);

    const result2 = await tryClaimAndDispatchNextQueuedPrompt(options2);

    expect(result2).toBe(false);
    // Call 2 never reached listPending or claim itself -- the call count is
    // still exactly the one call1 made before call2 even started.
    expect(store.listPending).toHaveBeenCalledTimes(1);
    expect(store.claim).not.toHaveBeenCalled();
    expect(options2.logInfo).toHaveBeenCalledWith(
      expect.stringContaining('already processing a queued prompt, skipping'),
    );

    resolveListPending([]);
    await call1;
  });

  it('releases the reservation and propagates when preflight rejects', async () => {
    const store = queueStoreFor(claimed());
    const preflightError = new Error('preflight boom');
    const options = optionsFor(store, {
      preflight: vi.fn(async () => { throw preflightError; }),
    });

    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).rejects.toThrow('preflight boom');
    expect(options.processingLeases.has('session-1')).toBe(false);
    expect(store.listPending).not.toHaveBeenCalled();
  });

  it('releases the reservation and propagates when listPending rejects', async () => {
    const store = queueStoreFor(claimed());
    const listPendingError = new Error('listPending boom');
    vi.mocked(store.listPending).mockRejectedValue(listPendingError);
    const options = optionsFor(store);

    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).rejects.toThrow('listPending boom');
    expect(options.processingLeases.has('session-1')).toBe(false);
    expect(store.claim).not.toHaveBeenCalled();
  });

  it('releases the reservation and propagates when claim rejects', async () => {
    const store = queueStoreFor(claimed());
    const claimError = new Error('claim boom');
    vi.mocked(store.claim).mockRejectedValue(claimError);
    const options = optionsFor(store);

    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).rejects.toThrow('claim boom');
    expect(options.processingLeases.has('session-1')).toBe(false);
  });

  it('releases the reservation when there are no pending prompts', async () => {
    const store = queueStoreFor(claimed());
    vi.mocked(store.listPending).mockResolvedValue([]);
    const options = optionsFor(store);

    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).resolves.toBe(false);
    expect(options.processingLeases.has('session-1')).toBe(false);
    expect(store.claim).not.toHaveBeenCalled();
  });

  it('releases the reservation when claim returns null', async () => {
    const store = queueStoreFor(claimed());
    vi.mocked(store.claim).mockResolvedValue(null);
    const options = optionsFor(store);

    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).resolves.toBe(false);
    expect(options.processingLeases.has('session-1')).toBe(false);
  });

  it('hands ownership to dispatchClaimedQueuedPrompt with a fresh lease on successful dispatch', async () => {
    vi.useFakeTimers();
    const store = queueStoreFor(claimed());
    const processingLeases = new Map<string, symbol>();
    const setSpy = vi.spyOn(processingLeases, 'set');
    const options = optionsFor(store, { processingLeases });

    const result = await tryClaimAndDispatchNextQueuedPrompt(options);
    expect(result).toBe(true);

    // processingLeases.set() is called exactly twice: once by
    // tryClaimAndDispatchNextQueuedPrompt's own reservation, and once by
    // dispatchClaimedQueuedPrompt's dispatch lease.
    expect(setSpy).toHaveBeenCalledTimes(2);
    const reservationSymbol = setSpy.mock.calls[0][1];
    const dispatchLeaseSymbol = setSpy.mock.calls[1][1];

    // Ownership was handed off, not released: the map still has an entry
    // immediately after tryClaimAndDispatchNextQueuedPrompt resolves true.
    expect(processingLeases.has('session-1')).toBe(true);
    // ...and it's dispatchClaimedQueuedPrompt's OWN fresh lease, not the
    // reservation tryClaimAndDispatchNextQueuedPrompt minted.
    expect(processingLeases.get('session-1')).toBe(dispatchLeaseSymbol);
    expect(dispatchLeaseSymbol).not.toBe(reservationSymbol);

    await vi.runAllTimersAsync();
  });

  it('external clear-then-refill: a stale reservation release does not clobber a fresh reservation for the same session', async () => {
    vi.useFakeTimers();
    const sessionId = 'session-1';
    const processingLeases = new Map<string, symbol>();

    // T1: listPending is a deferred (manually controlled) promise, so T1
    // stays parked mid-flight until we choose to unblock it.
    let resolveT1ListPending!: (value: ClaimedQueuedPrompt[]) => void;
    const t1ListPendingGate = new Promise<ClaimedQueuedPrompt[]>((resolve) => {
      resolveT1ListPending = resolve;
    });
    const t1Store = queueStoreFor(claimed('t1-prompt'));
    vi.mocked(t1Store.listPending).mockImplementation(() => t1ListPendingGate);
    const t1Options = optionsFor(t1Store, { processingLeases });

    const t1Call = tryClaimAndDispatchNextQueuedPrompt(t1Options);
    // T1's reservation is set synchronously, before its first await, so it
    // is already visible here.
    expect(processingLeases.has(sessionId)).toBe(true);

    // Simulate NIM-615's cancel/interrupt handler firing mid-flight: a
    // blind delete that clears T1's reservation out from under it.
    processingLeases.delete(sessionId);
    expect(processingLeases.has(sessionId)).toBe(false);

    // T2 starts fresh for the SAME session (the map is empty again), claims
    // its own reservation, and completes a full successful dispatch -- so a
    // lease symbol distinct from T1's original reservation ends up in the
    // map, owned by dispatchClaimedQueuedPrompt.
    const t2Store = queueStoreFor(claimed('t2-prompt'));
    const t2Options = optionsFor(t2Store, { processingLeases });
    const t2Result = await tryClaimAndDispatchNextQueuedPrompt(t2Options);
    expect(t2Result).toBe(true);
    expect(processingLeases.has(sessionId)).toBe(true);
    const t2LeaseAfterDispatch = processingLeases.get(sessionId);
    // Confirm T1 really is still parked awaiting its deferred listPending at
    // this point (not finished, not short-circuited some other way).
    expect(t1Store.listPending).toHaveBeenCalledTimes(1);

    // Now let T1's long-deferred listPending resolve to empty. T1 resumes,
    // finds nothing pending, and tries to release ITS OWN (now-stale, no
    // longer present) reservation.
    resolveT1ListPending([]);
    await expect(t1Call).resolves.toBe(false);

    // T1's identity-checked release must be a no-op: T2's lease survives
    // untouched.
    expect(processingLeases.has(sessionId)).toBe(true);
    expect(processingLeases.get(sessionId)).toBe(t2LeaseAfterDispatch);

    await vi.runAllTimersAsync();
  });
});
