// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QueueDriveService,
  type DriveOutcome,
  type QueueDriveDeps,
} from '../QueueDriveService';

function createHarness(attemptImpl: QueueDriveDeps['attempt']) {
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
