// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { isTurnControlPending, performTurnInterruption } from '../sessionTurnControl';
import { TurnSetupCancelledError } from '../turnSetupStages';
import {
  SessionProcessingGuard,
  dispatchClaimedQueuedPrompt,
  tryClaimAndDispatchNextQueuedPrompt,
  type ClaimedQueuedPrompt,
  type QueuedPromptStoreLike,
} from '../queuedPromptDispatcher';

function lateHoldFixture(phase: string, agentRows = false) {
  let held = phase === 'before';
  const rows: ClaimedQueuedPrompt[] = ['p1', ...(agentRows ? ['p2'] : [])].map((id) => ({
    id, prompt: id,
    documentContext: agentRows ? { promptProvenance: { actor: 'agent' } } as any : null,
  }));
  const pending = new Set(rows.map((row) => row.id));
  const executing = new Map<string, string>();
  const queueStore = {
    listPending: vi.fn(async (_sessionId: string) => {
      if (phase === 'list') held = true;
      return rows.filter((row) => pending.has(row.id));
    }),
    claim: vi.fn(async (id: string) => {
      if (!pending.delete(id)) return null;
      const claimToken = randomUUID();
      executing.set(id, claimToken);
      if (phase === `claim-${id}`) held = true;
      return { ...rows.find((row) => row.id === id)!, claimToken };
    }),
    releaseClaims: vi.fn(async (claims: readonly { id: string; claimToken?: string }[]) => {
      for (const { id, claimToken } of claims) {
        if (claimToken && executing.get(id) === claimToken) {
          executing.delete(id);
          pending.add(id);
        }
      }
    }),
    complete: vi.fn(async (id: string) => { executing.delete(id); }),
    fail: vi.fn(async () => {}),
  };
  const options = {
    queueStore, processingSet: new SessionProcessingGuard(),
    onDispatchDeferred: vi.fn(),
    sendMessageHandler: vi.fn(async () => ({ content: 'ok' })),
    startSession: vi.fn(async (_options: { sessionId: string; workspacePath: string }) => { if (phase === 'start') held = true; }),
    continueQueuedPromptChain: vi.fn(async () => {}),
    onPromptClaimed: vi.fn(), logInfo: vi.fn(), logError: vi.fn(),
    sessionId: 's1', workspacePath: '/ws', source: 'queue-drive:meta-agent',
    targetWindow: { isDestroyed: () => false, webContents: { mainFrame: {} } } as unknown as Electron.BrowserWindow,
  };
  return {
    options, queueStore, pending, executing,
    setHeld: () => { held = true; },
    clearHeld: () => { held = false; phase = 'none'; },
  };
}

describe('queuedPromptDispatcher', () => {
  it('releases its claim lease if control begins during turn registration', async () => {
    const fixture = lateHoldFixture('none');
    let release!: () => void;
    const parked = new Promise<void>(resolve => { release = resolve; });
    let control: Promise<unknown> | undefined;
    const guard = fixture.options.processingSet;
    const beginClaim = guard.beginClaim.bind(guard);
    vi.spyOn(guard, 'beginClaim').mockImplementationOnce(id => {
      const token = beginClaim(id);
      control = performTurnInterruption({
        sessionId: id, mode: 'stop', provider: null, guard, isCurrentProvider: () => true,
        retireInbox: () => parked, sweep: async () => {}, settle: async () => {},
        drive: async () => {}, logError: vi.fn(),
      });
      return token;
    });
    try {
      await expect(tryClaimAndDispatchNextQueuedPrompt(fixture.options)).rejects.toThrow('Cancellation is still finishing');
      expect(guard.has('s1')).toBe(false);
      expect(fixture.queueStore.claim).not.toHaveBeenCalled();
    } finally { release(); await control; }
    expect(await tryClaimAndDispatchNextQueuedPrompt(fixture.options)).toBe(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.options.sendMessageHandler).toHaveBeenCalledOnce();
  });
  it('returns every scheduled undelivered claim when cancellation wins before handoff', async () => {
    vi.useFakeTimers();
    const fixture = lateHoldFixture('none', true);
    expect(await tryClaimAndDispatchNextQueuedPrompt(fixture.options)).toBe(true);
    const control = performTurnInterruption({
      sessionId: 's1', mode: 'stop', guard: fixture.options.processingSet,
      provider: { abort: vi.fn(), interruptCurrentTurn: vi.fn(async () => ({ method: 'abort' as const })) },
      isCurrentProvider: () => true, retireInbox: async () => {}, sweep: async () => {},
      settle: async () => {}, drive: async () => {}, logError: vi.fn(),
    });
    expect(isTurnControlPending('s1')).toBe(true);
    await vi.runAllTimersAsync();
    expect((await control).success).toBe(true);
    expect(fixture.options.sendMessageHandler).not.toHaveBeenCalled();
    expect(fixture.pending).toEqual(new Set(['p1', 'p2']));
    expect(fixture.executing.size).toBe(0);
    expect(fixture.queueStore.fail).not.toHaveBeenCalled();
    expect(fixture.queueStore.complete).not.toHaveBeenCalled();
    expect(await tryClaimAndDispatchNextQueuedPrompt(fixture.options)).toBe(true);
    await vi.runAllTimersAsync();
    expect(fixture.options.sendMessageHandler).toHaveBeenCalledOnce();
    expect(fixture.queueStore.complete).toHaveBeenCalledTimes(2);
  });

  it('retains original claims when cancellation wins during registered host setup', async () => {
    vi.useFakeTimers();
    const fixture = lateHoldFixture('none', true);
    fixture.options.sendMessageHandler.mockRejectedValueOnce(new TurnSetupCancelledError());
    expect(await tryClaimAndDispatchNextQueuedPrompt(fixture.options)).toBe(true);
    await vi.runAllTimersAsync();
    expect(fixture.pending).toEqual(new Set(['p1', 'p2']));
    expect(fixture.queueStore.fail).not.toHaveBeenCalled();
    expect(fixture.queueStore.complete).not.toHaveBeenCalled();
    expect(fixture.options.onDispatchDeferred).toHaveBeenCalledOnce();
  });

  it('does not wake or settle a replacement after displaced setup cancellation', async () => {
    vi.useFakeTimers();
    const fixture = lateHoldFixture('none');
    fixture.options.sendMessageHandler.mockImplementationOnce(async () => {
      fixture.options.processingSet.acquire('s1');
      throw new TurnSetupCancelledError();
    });
    const onChainSettled = vi.fn(async () => {});
    expect(await tryClaimAndDispatchNextQueuedPrompt({ ...fixture.options, onChainSettled })).toBe(true);
    await vi.runAllTimersAsync();
    expect(fixture.options.onDispatchDeferred).not.toHaveBeenCalled();
    expect(fixture.options.continueQueuedPromptChain).not.toHaveBeenCalled();
    expect(onChainSettled).not.toHaveBeenCalled();
    expect(fixture.options.processingSet.has('s1')).toBe(true);
  });

  it('retains unsettled claims visibly when cancelled-setup rollback fails', async () => {
    vi.useFakeTimers();
    const fixture = lateHoldFixture('none');
    fixture.options.sendMessageHandler.mockRejectedValueOnce(new TurnSetupCancelledError());
    fixture.queueStore.releaseClaims.mockRejectedValue(new Error('storage unavailable'));
    expect(await tryClaimAndDispatchNextQueuedPrompt(fixture.options)).toBe(true);
    await vi.runAllTimersAsync();
    expect(fixture.executing.size).toBe(1);
    expect(fixture.queueStore.fail).not.toHaveBeenCalled();
    expect(fixture.options.logError).toHaveBeenCalled();
    expect(fixture.options.onDispatchDeferred).not.toHaveBeenCalled();
    expect(fixture.options.processingSet.has('s1')).toBe(false);
  });

  it('does not settle or continue after its replacement already finished', async () => {
    vi.useFakeTimers();
    const fixture = lateHoldFixture('none');
    fixture.options.sendMessageHandler.mockImplementationOnce(async () => {
      const replacement = fixture.options.processingSet.acquire('s1');
      fixture.options.processingSet.releaseIfOwner('s1', replacement);
      return { content: 'ok' };
    });
    const onChainSettled = vi.fn(async () => {});
    expect(await tryClaimAndDispatchNextQueuedPrompt({ ...fixture.options, onChainSettled })).toBe(true);
    await vi.runAllTimersAsync();
    expect(fixture.options.continueQueuedPromptChain).not.toHaveBeenCalled();
    expect(onChainSettled).not.toHaveBeenCalled();
  });

  it('preserves already completed coalesced rows when a later settlement fails', async () => {
    vi.useFakeTimers();
    const fixture = lateHoldFixture('none', true);
    // The first row succeeds; only the second row's failed completion is failed.
    fixture.queueStore.complete.mockReset().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await tryClaimAndDispatchNextQueuedPrompt(fixture.options)).toBe(true);
    await vi.runAllTimersAsync();
    expect(fixture.queueStore.fail).toHaveBeenCalledTimes(1);
    expect(fixture.queueStore.fail).toHaveBeenCalledWith('p2', 'storage unavailable');
  });

  it('safely returns only undelivered claims if recording the missing-handler failure fails', async () => {
    const fixture = lateHoldFixture('none');
    fixture.queueStore.fail.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(tryClaimAndDispatchNextQueuedPrompt({ ...fixture.options, sendMessageHandler: null })).rejects.toThrow('storage unavailable');
    expect(fixture.queueStore.releaseClaims).toHaveBeenCalledOnce();
    expect(fixture.pending.has('p1')).toBe(true);
    expect(fixture.options.sendMessageHandler).not.toHaveBeenCalled();
  });

  it('fences an in-flight claim before it can acquire or deliver a row', async () => {
    const fixture = lateHoldFixture('none');
    let entered!: () => void;
    let release!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const originalList = fixture.queueStore.listPending.getMockImplementation()!;
    fixture.queueStore.listPending.mockImplementationOnce(async id => { entered(); await blocked; return originalList(id); });
    const claiming = tryClaimAndDispatchNextQueuedPrompt(fixture.options);
    await enteredGate;
    const control = performTurnInterruption({
      sessionId: 's1', mode: 'stop', guard: fixture.options.processingSet,
      provider: { abort: vi.fn(), interruptCurrentTurn: vi.fn(async () => ({ method: 'abort' as const })) },
      isCurrentProvider: () => true, retireInbox: async () => {}, sweep: async () => {},
      settle: async () => {}, drive: async () => {}, logError: vi.fn(),
    });
    expect(isTurnControlPending('s1')).toBe(true);
    release();
    expect(await claiming).toBe(false);
    expect((await control).success).toBe(true);
    expect(fixture.queueStore.claim).not.toHaveBeenCalled();
    expect(fixture.pending.has('p1')).toBe(true);
  });

  it('waits for old row settlement and chain cleanup before sweeping or admitting a successor', async () => {
    vi.useFakeTimers();
    const fixture = lateHoldFixture('none');
    let enter!: () => void;
    let releaseSend!: () => void;
    let completing!: () => void;
    let releaseComplete!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const sent = new Promise<void>(resolve => { releaseSend = resolve; });
    const completionStarted = new Promise<void>(resolve => { completing = resolve; });
    const completed = new Promise<void>(resolve => { releaseComplete = resolve; });
    const order: string[] = [];
    fixture.options.sendMessageHandler.mockImplementationOnce(async () => { enter(); await sent; return { content: 'ok' }; });
    fixture.queueStore.complete.mockImplementationOnce(async () => { completing(); await completed; order.push('row-settled'); });
    expect(await tryClaimAndDispatchNextQueuedPrompt({ ...fixture.options, onChainSettled: async () => { order.push('chain-settled'); } })).toBe(true);
    const timers = vi.runAllTimersAsync();
    await entered;
    const sweep = vi.fn(async () => { order.push('sweep'); });
    const control = performTurnInterruption({
      sessionId: 's1', mode: 'stop', guard: fixture.options.processingSet,
      provider: { abort: vi.fn(), interruptCurrentTurn: vi.fn(async () => ({ method: 'abort' as const })) },
      isCurrentProvider: () => true, retireInbox: async () => {}, sweep,
      settle: async () => {}, drive: async () => {}, logError: vi.fn(),
    });
    releaseSend();
    await completionStarted;
    expect(sweep).not.toHaveBeenCalled();
    expect(isTurnControlPending('s1')).toBe(true);
    releaseComplete();
    await timers;
    expect((await control).success).toBe(true);
    expect(order).toEqual(['row-settled', 'chain-settled', 'sweep']);
  });


  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([false, true])('serializes send-now and FIFO continuation while claiming (drain bypass: %s)', async (bypass) => {
    vi.useFakeTimers();
    let pending: ClaimedQueuedPrompt[] = [
      { id: 'agent', prompt: 'agent follow-up' },
      { id: 'human', prompt: 'human follow-up' },
    ];
    let releaseClaim!: () => void;
    let claimStarted!: () => void;
    const started = new Promise<void>((resolve) => { claimStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const queueStore: QueuedPromptStoreLike = {
      releaseClaims: vi.fn(async () => {}),
      listPending: vi.fn(async () => [...pending]),
      claim: vi.fn(async (id) => {
        const row = pending.find((prompt) => prompt.id === id) ?? null;
        pending = pending.filter((prompt) => prompt.id !== id);
        if (id === 'agent') {
          claimStarted();
          await blocked;
        }
        return row;
      }),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };
    const processingSet = new SessionProcessingGuard();
    const sendMessageHandler = vi.fn(async () => ({ content: 'ok' }));
    const options = {
      queueStore, processingSet, sendMessageHandler,
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(), logInfo: vi.fn(), onPromptClaimed: vi.fn(),
      startSession: vi.fn(async () => {}),
      targetWindow: { isDestroyed: () => false, webContents: { mainFrame: {} } } as unknown as Electron.BrowserWindow,
      sessionId: 'session', workspacePath: '/workspace', source: 'send-now',
      canBypassChainGuard: () => bypass,
    };
    const first = tryClaimAndDispatchNextQueuedPrompt(options);
    await started;
    const reserved = processingSet.has('session');
    const competing = await tryClaimAndDispatchNextQueuedPrompt({ ...options, source: 'FIFO continuation' });
    releaseClaim();
    await first;
    await vi.runAllTimersAsync();

    expect(competing).toBe(false);
    expect(reserved).toBe(true);
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(pending.map((row) => row.id)).toEqual(['human']);
    expect(processingSet.has('session')).toBe(false);
    expect(await tryClaimAndDispatchNextQueuedPrompt(options)).toBe(true);
    await vi.runAllTimersAsync();
    expect(sendMessageHandler).toHaveBeenCalledTimes(2);
    expect(queueStore.fail).not.toHaveBeenCalled();

    // A storage failure must release the reservation and let a later retry run.
    vi.mocked(queueStore.listPending).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).rejects.toThrow('storage unavailable');
    expect(processingSet.has('session')).toBe(false);
    expect(await tryClaimAndDispatchNextQueuedPrompt(options)).toBe(false);
    expect(processingSet.has('session')).toBe(false);
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
      releaseClaims: vi.fn(async () => {}),
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
    // Announce only when the cancellable scheduled handoff actually starts.
    expect(order).toEqual(['startSession']);
    expect(processingSet.has('session-1')).toBe(true);

    await vi.runAllTimersAsync();

    expect(order).toEqual(['startSession', 'promptClaimed', 'sendMessage', 'complete', 'continue']);
    expect(processingSet.has('session-1')).toBe(false);
  });

  describe('agent-authored coalescing', () => {
    const agentPrompt = (id: string, prompt: string): ClaimedQueuedPrompt => ({
      id,
      prompt,
      attachments: null,
      documentContext: {
        promptProvenance: { actor: 'agent', origin: 'child-session-update' },
      } as any,
    });

    const humanPrompt = (id: string, prompt: string): ClaimedQueuedPrompt => ({
      id,
      prompt,
      attachments: null,
      documentContext: {
        promptProvenance: { actor: 'human', origin: 'composer' },
      } as any,
    });

    async function drain(pending: ClaimedQueuedPrompt[]) {
      vi.useFakeTimers();
      const completed: string[] = [];
      const sent: string[] = [];

      const queueStore: QueuedPromptStoreLike = {
      releaseClaims: vi.fn(async () => {}),
        listPending: vi.fn(async () => pending),
        claim: vi.fn(async (id: string) => pending.find((p) => p.id === id) ?? null),
        complete: vi.fn(async (id: string) => {
          completed.push(id);
        }),
        fail: vi.fn(async () => {}),
      };

      const targetWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), mainFrame: {} },
      } as unknown as Electron.BrowserWindow;

      await tryClaimAndDispatchNextQueuedPrompt({
        continueQueuedPromptChain: vi.fn(async () => {}),
        logError: vi.fn(),
        logInfo: vi.fn(),
        onPromptClaimed: () => {},
        processingSet: new SessionProcessingGuard(),
        queueStore,
        sendMessageHandler: vi.fn(async (_e, message: string) => {
          sent.push(message);
          return { content: 'ok' };
        }),
        sessionId: 'session-1',
        source: 'test queue',
        startSession: vi.fn(async () => {}),
        targetWindow,
        workspacePath: '/workspace/project',
      });

      await vi.runAllTimersAsync();
      return { completed, sent };
    }

    // The orchestration bottleneck: N children reporting cost the parent N
    // turns, because the drain took pendingPrompts[0] and nothing else.
    it('merges a run of agent-authored prompts into one turn and completes every row', async () => {
      const { completed, sent } = await drain([
        agentPrompt('a', 'first report'),
        agentPrompt('b', 'second report'),
        agentPrompt('c', 'third report'),
      ]);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('first report');
      expect(sent[0]).toContain('second report');
      expect(sent[0]).toContain('third report');
      expect([...completed].sort()).toEqual(['a', 'b', 'c']);
    });

    // A human message is a hard boundary: it must never be silently folded in
    // with agent chatter, and nothing behind it may be pulled forward.
    it('stops the run at a human-authored prompt', async () => {
      const { completed, sent } = await drain([
        agentPrompt('a', 'agent one'),
        humanPrompt('h', 'stop and do this instead'),
        agentPrompt('c', 'agent two'),
      ]);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toBe('agent one');
      expect(sent[0]).not.toContain('stop and do this instead');
      expect(completed).toEqual(['a']);
    });

    it('leaves a human-authored head as its own turn', async () => {
      const { completed, sent } = await drain([
        humanPrompt('h', 'do the thing'),
        agentPrompt('a', 'agent report'),
      ]);

      expect(sent).toEqual(['do the thing']);
      expect(completed).toEqual(['h']);
    });
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
      releaseClaims: vi.fn(async () => {}),
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

  // NIM-7428: a turn that ends with settled background work wakes the session
  // with a turn the chain does not own. Settling the chain then ended a running
  // session and woke the parent mid-turn; continuing it sent a second prompt that
  // aborted the wake turn and dropped the task results it carried.
  it('leaves the session to a wake turn the lead started instead of settling or continuing', async () => {
    vi.useFakeTimers();
    const claimedPrompt: ClaimedQueuedPrompt = { id: 'prompt-1', prompt: 'continue', attachments: null, documentContext: null };
    const queueStore: QueuedPromptStoreLike = {
      releaseClaims: vi.fn(async () => {}),
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
    const continueQueuedPromptChain = vi.fn(async () => {});
    const onChainSettled = vi.fn(async () => {});
    const onAfterSettled = vi.fn(async () => {});

    await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain,
      logError: vi.fn(),
      logInfo: vi.fn(),
      onAfterSettled,
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
      isLeadTurnPending: () => true,
    });
    await vi.runAllTimersAsync();

    expect(queueStore.complete).toHaveBeenCalledWith('prompt-1');
    expect(processingSet.has('session-1')).toBe(false);
    expect(continueQueuedPromptChain).not.toHaveBeenCalled();
    expect(onChainSettled).not.toHaveBeenCalled();
    expect(onAfterSettled).not.toHaveBeenCalled();
  });

  it('dispatches past the guard a draining turn holds, only when its live query can take the prompt', async () => {
    vi.useFakeTimers();
    const claimedPrompt = { id: 'prompt-1', sessionId: 'session-1', prompt: 'follow up', status: 'executing' } as never;
    const queueStore: QueuedPromptStoreLike = {
      releaseClaims: vi.fn(async () => {}),
      listPending: vi.fn(async () => [claimedPrompt]),
      claim: vi.fn(async () => claimedPrompt),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };
    const processingSet = new SessionProcessingGuard();
    const drainingTurnToken = processingSet.acquire('session-1');
    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;
    const sendMessageHandler = vi.fn(async () => ({ content: 'ok' }));
    const dispatch = (canBypassChainGuard: () => boolean) => tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: () => {},
      processingSet,
      queueStore,
      sendMessageHandler,
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => {}),
      targetWindow,
      workspacePath: '/workspace/project',
      canBypassChainGuard,
    });

    expect(await dispatch(() => false)).toBe(false);
    expect(await dispatch(() => true)).toBe(true);
    await vi.runAllTimersAsync();

    expect(sendMessageHandler).toHaveBeenCalledOnce();
    // The draining turn's later release must not drop the follow-up's guard.
    expect(processingSet.releaseIfOwner('session-1', drainingTurnToken)).toBe(false);
    vi.useRealTimers();
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
      releaseClaims: vi.fn(async () => {}),
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
      releaseClaims: vi.fn(async () => {}),
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
      releaseClaims: vi.fn(async () => {}),
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
      releaseClaims: vi.fn(async () => {}),
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

    const onAfterSettled = vi.fn(async () => {});
    const dispatchOptions = () => ({
      continueQueuedPromptChain,
      onAfterSettled,
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
    expect(onAfterSettled).not.toHaveBeenCalled();

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
