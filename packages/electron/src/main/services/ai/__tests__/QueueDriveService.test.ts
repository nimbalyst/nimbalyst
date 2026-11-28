// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QueueDriveService,
  HELD_REPORT_DRIVE_DELAY_MS,
  type DriveOutcome,
  type QueueDriveDeps,
} from '../QueueDriveService';
import { runQueueDriveAttempt } from '../queueDriveAttempt';
import { createWorkspaceWindowResolver } from '../resolveWorkspaceWindow';
import { dispatchQueuedPromptToClaudeCli } from '../claudeCliQueueDispatch';

function createHarness(attemptImpl: QueueDriveDeps['attempt'], now = () => Date.now()) {
  const windowListeners: Array<{ workspacePath: string; listener: () => void }> = [];
  const idleListeners: Array<{ sessionId: string; listener: () => void }> = [];
  const timerCalls: Array<{ fn: () => void; ms: number; handle: number }> = [];
  const clearedHandles: unknown[] = [];
  let nextHandle = 1;

  const onWindowAvailable = vi.fn((workspacePath: string, listener: () => void) => {
    const entry = { workspacePath, listener };
    windowListeners.push(entry);
    return () => {
      const index = windowListeners.indexOf(entry);
      if (index >= 0) windowListeners.splice(index, 1);
    };
  });

  const onSessionIdle = vi.fn((sessionId: string, listener: () => void) => {
    const entry = { sessionId, listener };
    idleListeners.push(entry);
    return () => {
      const index = idleListeners.indexOf(entry);
      if (index >= 0) idleListeners.splice(index, 1);
    };
  });

  const deps: QueueDriveDeps = {
    attempt: attemptImpl,
    onWindowAvailable,
    onSessionIdle,
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
    now,
    timers: {
      setTimeout: (fn, ms) => {
        const handle = nextHandle++;
        timerCalls.push({ fn, ms, handle });
        return handle;
      },
      clearTimeout: (handle) => {
        clearedHandles.push(handle);
      },
    },
  };

  return {
    service: new QueueDriveService(deps),
    deps,
    windowListeners,
    idleListeners,
    timerCalls,
    clearedHandles,
    onWindowAvailable,
    onSessionIdle,
  };
}

/** Let the service's internal async attempt loop settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('QueueDriveService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('batches held reports from the first arrival without extending the deadline', async () => {
    const attempt = vi.fn(async (): Promise<DriveOutcome> => ({ kind: 'dispatched' }));
    const h = createHarness(attempt);
    expect(h.service.requestDeferredReportDrive('s1', '/ws')).toEqual({ scheduled: true, coalesced: false, delayMs: 180_000 });
    expect(h.service.requestDeferredReportDrive('s1', '/moved')).toEqual({ scheduled: true, coalesced: true });
    h.service.requestDeferredReportDrive('s1', '/moved');
    expect(h.timerCalls).toHaveLength(1);
    expect(h.timerCalls[0].ms).toBe(HELD_REPORT_DRIVE_DELAY_MS);
    expect(attempt).not.toHaveBeenCalled();
    h.timerCalls[0].fn();
    await flush();
    expect(attempt).toHaveBeenCalledExactlyOnceWith({ sessionId: 's1', workspacePath: '/moved', reason: 'held-report' });
  });

  it('keeps report timers independent and cancels them at shutdown', async () => {
    const attempt = vi.fn(async (): Promise<DriveOutcome> => ({ kind: 'nothing-pending' }));
    const h = createHarness(attempt);
    h.service.requestDeferredReportDrive('s1', '/ws');
    h.service.requestDeferredReportDrive('s2', '/ws');
    expect(h.timerCalls).toHaveLength(2);
    h.service.dispose();
    expect(h.service.requestDeferredReportDrive('s1', '/ws')).toEqual({ scheduled: false, reason: 'disposed' });
    expect(h.clearedHandles).toEqual(h.timerCalls.map((timer) => timer.handle));
    for (const timer of h.timerCalls) timer.fn();
    await flush();
    expect(attempt).not.toHaveBeenCalled();
  });

  it('uses ordinary busy deferral and idle wake after the batching deadline', async () => {
    const attempt = vi.fn<QueueDriveDeps['attempt']>()
      .mockResolvedValueOnce({ kind: 'deferred', reason: 'session-busy' })
      .mockResolvedValueOnce({ kind: 'dispatched' });
    const h = createHarness(attempt);
    h.service.requestDeferredReportDrive('s1', '/ws');
    h.timerCalls[0].fn();
    await flush();
    expect(h.idleListeners).toHaveLength(1);
    h.idleListeners[0].listener();
    await flush();
    expect(attempt.mock.calls.map(([input]) => input.reason)).toEqual(['held-report', 'session-idle']);
  });

  it('lets an instruction drain early and cancels the obsolete deferred timer', async () => {
    const attempt = vi.fn(async (): Promise<DriveOutcome> => ({ kind: 'dispatched' }));
    const h = createHarness(attempt);
    h.service.requestDeferredReportDrive('s1', '/ws');
    await h.service.drive('s1', '/ws', 'meta-agent');
    expect(h.clearedHandles).toContain(h.timerCalls[0].handle);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('slows the next timer at the tenth held-report dispatch within an hour and recovers when the window empties', async () => {
    let now = 0;
    const h = createHarness(async () => ({ kind: 'dispatched' }), () => now);
    for (let turn = 0; turn < 9; turn++) {
      await h.service.drive('s1', '/ws', 'held-report');
      now += 1_000;
    }
    expect(h.service.requestDeferredReportDrive('s1', '/ws')).toMatchObject({ scheduled: true, delayMs: 180_000 });
    await h.service.drive('s1', '/ws', 'held-report');
    expect(h.service.requestDeferredReportDrive('s1', '/ws')).toMatchObject({ scheduled: true, delayMs: 600_000 });
    expect(h.timerCalls[h.timerCalls.length - 1]?.ms).toBe(600_000);
    expect(h.deps.logInfo).toHaveBeenCalledWith(expect.stringContaining('entering slow report batching'));
    // Repeated arrivals join the first timer; mode logging must not repeat.
    h.service.requestDeferredReportDrive('s1', '/ws');
    const entering = vi.mocked(h.deps.logInfo).mock.calls.filter(([message]) => message.includes('entering slow report batching'));
    expect(entering).toHaveLength(1);
    expect(h.service.requestDeferredReportDrive('s2', '/ws')).toMatchObject({ delayMs: 180_000 });
    now += 3_600_000;
    h.timerCalls.find((timer) => timer.ms === 600_000)!.fn();
    await flush();
    expect(h.service.requestDeferredReportDrive('s1', '/ws')).toMatchObject({ scheduled: true, delayMs: 180_000 });
    const leaving = vi.mocked(h.deps.logInfo).mock.calls.filter(([message]) => message.includes('leaving slow report batching'));
    expect(leaving).toHaveLength(1);
  });

  it('counts only held-report dispatched outcomes, not other drives or empty/failed/deferred attempts', async () => {
    const outcomes: DriveOutcome[] = [
      ...Array.from({ length: 9 }, () => ({ kind: 'dispatched' } as DriveOutcome)),
      { kind: 'nothing-pending' }, { kind: 'failed', reason: 'missing' },
      { kind: 'deferred', reason: 'session-busy' }, { kind: 'dispatched' },
    ];
    const h = createHarness(async () => outcomes.shift() ?? { kind: 'dispatched' });
    for (let turn = 0; turn < 12; turn++) await h.service.drive('s1', '/ws', 'held-report');
    await h.service.drive('s1', '/ws', 'session-idle');
    for (let turn = 0; turn < 12; turn++) await h.service.drive('s1', '/ws', 'renderer-trigger');
    expect(h.service.requestDeferredReportDrive('s1', '/ws')).toMatchObject({ scheduled: true, delayMs: 180_000 });
  });

  it('expires dispatches exactly sixty minutes old when selecting the next batch delay', async () => {
    let now = 0;
    const h = createHarness(async () => ({ kind: 'dispatched' }), () => now);
    for (let turn = 0; turn < 10; turn++) await h.service.drive('s1', '/ws', 'held-report');
    expect(h.service.requestDeferredReportDrive('s1', '/ws')).toMatchObject({ delayMs: 600_000 });
    await h.service.drive('s1', '/ws', 'renderer-trigger');
    now = 3_600_000;
    expect(h.service.requestDeferredReportDrive('s1', '/ws')).toMatchObject({ delayMs: 180_000 });
    expect(vi.mocked(h.deps.logInfo).mock.calls.filter(([message]) => message.includes('leaving slow report batching'))).toHaveLength(1);
  });

  it.each([true, false])('uses the existing CLI route with an inactive terminal (project window available: %s)', async (hasWindow) => {
    const window = { id: 1 };
    const createWindow = vi.fn(() => window);
    const resolver = createWorkspaceWindowResolver({
      findWindow: () => hasWindow ? window : null,
      isDestroyed: () => false, workspaceExists: () => true,
      createWindow, waitForLoad: async () => {}, isQuitting: () => false,
      now: () => 0, logInfo: vi.fn(), logWarn: vi.fn(),
    });
    const ensureSession = vi.fn(async () => ({ success: true }));
    const flushNext = vi.fn(async () => true);
    const h = createHarness((input) => runQueueDriveAttempt({
      listPendingIds: async () => ['report-1'], isChainActive: () => false, isSessionBusy: () => false,
      resolveWindow: (workspacePath, allowAutoOpen) => resolver.resolve(workspacePath, { allowAutoOpen }),
      failAllPending: async () => 0,
      dispatch: ({ sessionId, workspacePath }) => dispatchQueuedPromptToClaudeCli({
        isTerminalActive: () => false, ensureSession,
        getLiveTurnState: async () => 'idle', getSnapshotStatus: () => 'idle', flushNext,
        logInfo: vi.fn(), logWarn: vi.fn(),
      }, { sessionId, workspacePath }), logWarn: vi.fn(),
    }, input));
    h.service.requestDeferredReportDrive('s1', '/ws');
    h.timerCalls[0].fn();
    await flush();
    expect(createWindow).not.toHaveBeenCalled();
    if (hasWindow) {
      expect(ensureSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', workspacePath: '/ws' }));
      expect(flushNext).toHaveBeenCalledExactlyOnceWith('s1', '/ws');
      expect(h.windowListeners).toHaveLength(0);
    } else {
      expect(ensureSession).not.toHaveBeenCalled();
      expect(h.windowListeners).toHaveLength(1);
    }
    h.service.dispose();
  });

  it.each(['renderer-trigger', 'send-now'] as const)('never blocks %s after sustained report traffic', async (reason) => {
    const dispatch = vi.fn(async () => true);
    const attempt = vi.fn<QueueDriveDeps['attempt']>((input) => runQueueDriveAttempt({
      listPendingIds: async () => ['report-1'],
      isChainActive: () => false, isSessionBusy: () => false,
      resolveWindow: async () => ({ kind: 'window', window: {}, opened: false }),
      failAllPending: async () => 0, dispatch, logWarn: vi.fn(),
    }, input));
    const h = createHarness(attempt);
    for (let turn = 0; turn < 12; turn++) await h.service.drive('s1', '/ws', 'held-report');
    const timer = h.service.requestDeferredReportDrive('s1', '/ws');
    expect(timer).toMatchObject({ scheduled: true, delayMs: 600_000 });
    expect(await h.service.drive('s1', '/ws', reason)).toEqual({ kind: 'dispatched', promptId: 'report-1' });
    expect(attempt).toHaveBeenLastCalledWith({ sessionId: 's1', workspacePath: '/ws', reason });
    expect(dispatch).toHaveBeenCalledTimes(13);
  });

  it('does not lose a report arriving during another drive attempt', async () => {
    let release!: (value: DriveOutcome) => void;
    const attempt = vi.fn<QueueDriveDeps['attempt']>()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValue({ kind: 'nothing-pending' });
    const h = createHarness(attempt);
    const first = h.service.drive('s1', '/ws', 'meta-agent');
    h.service.requestDeferredReportDrive('s1', '/ws');
    release({ kind: 'dispatched' });
    await first;
    expect(h.clearedHandles).not.toContain(h.timerCalls[0].handle);
    h.timerCalls[0].fn();
    await flush();
    expect(attempt).toHaveBeenCalledTimes(2);
  });


  it('collapses concurrent drive requests for one session into a single dispatch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    let dispatches = 0;

    const harness = createHarness(async () => {
      attempts += 1;
      await gate;
      // Only the first attempt finds a pending row; a second concurrent
      // dispatch is exactly the double-send this guard exists to prevent.
      if (dispatches === 0) {
        dispatches += 1;
        return { kind: 'dispatched', promptId: 'p1' } as DriveOutcome;
      }
      return { kind: 'nothing-pending' } as DriveOutcome;
    });

    harness.service.requestDrive('s1', '/ws', 'renderer-trigger');
    harness.service.requestDrive('s1', '/ws', 'mobile-control');
    harness.service.requestDrive('s1', '/ws', 'fifo-continuation');

    release();
    await flush();
    await flush();

    expect(dispatches).toBe(1);
    // Three edges, but never two attempts in flight: one real attempt plus a
    // single coalesced re-run for everything that arrived during it.
    expect(attempts).toBe(2);
  });

  it('arms a window subscription on no-window and drives exactly once when a window appears', async () => {
    const outcomes: DriveOutcome[] = [
      { kind: 'deferred', reason: 'no-window' },
      { kind: 'dispatched', promptId: 'p1' },
    ];
    const seenReasons: string[] = [];
    const harness = createHarness(async ({ reason }) => {
      seenReasons.push(reason);
      return outcomes.shift() ?? { kind: 'nothing-pending' };
    });

    harness.service.requestDrive('s1', '/ws', 'mobile-control');
    await flush();

    expect(harness.windowListeners).toHaveLength(1);
    expect(harness.windowListeners[0].workspacePath).toBe('/ws');

    harness.windowListeners[0].listener();
    await flush();

    expect(seenReasons).toEqual(['mobile-control', 'window-available']);
    // The subscription is one-shot: it unsubscribed before re-driving.
    expect(harness.windowListeners).toHaveLength(0);
  });

  it('arms an idle subscription on session-busy and drives when the session goes idle', async () => {
    const outcomes: DriveOutcome[] = [
      { kind: 'deferred', reason: 'session-busy' },
      { kind: 'dispatched', promptId: 'p1' },
    ];
    const seenReasons: string[] = [];
    const harness = createHarness(async ({ reason }) => {
      seenReasons.push(reason);
      return outcomes.shift() ?? { kind: 'nothing-pending' };
    });

    harness.service.requestDrive('s1', '/ws', 'boot-recovery');
    await flush();

    expect(harness.idleListeners).toHaveLength(1);
    harness.idleListeners[0].listener();
    await flush();

    expect(seenReasons).toEqual(['boot-recovery', 'session-idle']);
  });

  it('does not defer or retry a terminal failure', async () => {
    const harness = createHarness(async () => ({ kind: 'failed', reason: 'workspace-missing' }));

    harness.service.requestDrive('s1', '/gone', 'mobile-control');
    await flush();

    expect(harness.windowListeners).toHaveLength(0);
    expect(harness.idleListeners).toHaveLength(0);
    expect(harness.timerCalls).toHaveLength(0);
  });

  it.each([
    ['dispatched', { kind: 'dispatched', promptId: 'p1' } as DriveOutcome],
    ['nothing-pending', { kind: 'nothing-pending' } as DriveOutcome],
  ])('disarms the backoff timer after %s', async (_label, settledOutcome) => {
    const outcomes: DriveOutcome[] = [{ kind: 'deferred', reason: 'no-window' }, settledOutcome];
    const harness = createHarness(async () => outcomes.shift() ?? { kind: 'nothing-pending' });

    harness.service.requestDrive('s1', '/ws', 'mobile-control');
    await flush();

    expect(harness.timerCalls).toHaveLength(1);
    expect(harness.timerCalls[0].ms).toBe(2_000);
    const armedHandle = harness.timerCalls[0].handle;

    harness.windowListeners[0].listener();
    await flush();

    expect(harness.clearedHandles).toContain(armedHandle);
  });

  it('does not stack duplicate listeners or timers across repeated defers', async () => {
    const harness = createHarness(async () => ({ kind: 'deferred', reason: 'no-window' }));

    harness.service.requestDrive('s1', '/ws', 'mobile-control');
    await flush();
    harness.service.requestDrive('s1', '/ws', 'renderer-trigger');
    await flush();
    harness.service.requestDrive('s1', '/ws', 'mobile-index');
    await flush();

    expect(harness.onWindowAvailable).toHaveBeenCalledTimes(1);
    expect(harness.windowListeners).toHaveLength(1);
    // A timer is armed once and left running; each defer must not add another.
    expect(harness.timerCalls).toHaveLength(1);
  });

  it('escalates the backoff delay across successive deferred attempts', async () => {
    const harness = createHarness(async () => ({ kind: 'deferred', reason: 'provider-unavailable' }));

    harness.service.requestDrive('s1', '/ws', 'mobile-control');
    await flush();

    // 'provider-unavailable' has no wake event, so the backoff net is the only
    // thing that can recover it — fire it repeatedly and watch the delay climb.
    for (let i = 0; i < 4; i++) {
      const pending = harness.timerCalls[harness.timerCalls.length - 1];
      pending.fn();
      await flush();
    }

    expect(harness.timerCalls.map((t) => t.ms)).toEqual([2_000, 5_000, 15_000, 60_000, 60_000]);
  });

  it('reports the outcome to callers that must know whether the prompt went out', async () => {
    // The wakeup scheduler branches on this: a 'failed' outcome is the only
    // one that should send a wakeup back to waiting-for-workspace.
    const harness = createHarness(async () => ({ kind: 'deferred', reason: 'no-window' }));

    await expect(harness.service.drive('s1', '/ws', 'wakeup')).resolves.toEqual({
      kind: 'deferred',
      reason: 'no-window',
    });
  });

  it('treats a throwing attempt as deferred rather than stranding the queue', async () => {
    const harness = createHarness(async () => {
      throw new Error('db exploded');
    });

    harness.service.requestDrive('s1', '/ws', 'boot-recovery');
    await flush();

    expect(harness.deps.logError).toHaveBeenCalled();
    expect(harness.timerCalls).toHaveLength(1);
  });
});
