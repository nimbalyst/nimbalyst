// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  allowsAutoOpen,
  runQueueDriveAttempt,
  type QueueDriveAttemptDeps,
} from '../queueDriveAttempt';
import type { DriveReason } from '../QueueDriveService';

type FakeWindow = { id: number };

function createDeps(overrides: Partial<QueueDriveAttemptDeps<FakeWindow>> = {}) {
  const deps: QueueDriveAttemptDeps<FakeWindow> = {
    listPendingIds: vi.fn(async () => ['p1', 'p2']),
    isChainActive: vi.fn(() => false),
    isSessionBusy: vi.fn(() => false),
    resolveWindow: vi.fn(async () => ({ kind: 'window', window: { id: 1 }, opened: false }) as const),
    failAllPending: vi.fn(async () => 0),
    dispatch: vi.fn(async () => true),
    logWarn: vi.fn(),
    ...overrides,
  };
  return deps;
}

const run = (deps: QueueDriveAttemptDeps<FakeWindow>, reason: DriveReason = 'mobile-control') =>
  runQueueDriveAttempt(deps, { sessionId: 's1', workspacePath: '/ws', reason });

describe('runQueueDriveAttempt', () => {
  it('never resolves a window when nothing is pending', async () => {
    const deps = createDeps({ listPendingIds: vi.fn(async () => []) });

    expect(await run(deps)).toEqual({ kind: 'nothing-pending' });
    // Resolving would auto-open a project window for an empty queue.
    expect(deps.resolveWindow).not.toHaveBeenCalled();
  });

  it('dispatches the oldest pending prompt through the resolved window', async () => {
    const deps = createDeps();

    expect(await run(deps)).toEqual({ kind: 'dispatched', promptId: 'p1' });
    expect(deps.dispatch).toHaveBeenCalledExactlyOnceWith({
      sessionId: 's1',
      workspacePath: '/ws',
      window: { id: 1 },
      reason: 'mobile-control',
    });
  });

  it.each([
    ['a queued chain is already running', { isChainActive: vi.fn(() => true) }],
    ['the session is mid-turn', { isSessionBusy: vi.fn(() => true) }],
  ])('defers as session-busy when %s, without touching a window', async (_label, override) => {
    const deps = createDeps(override);

    expect(await run(deps)).toEqual({ kind: 'deferred', reason: 'session-busy' });
    expect(deps.resolveWindow).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('defers as no-window rather than dropping the prompt', async () => {
    const deps = createDeps({
      resolveWindow: vi.fn(async () => ({ kind: 'deferred', reason: 'no-window' }) as const),
    });

    expect(await run(deps)).toEqual({ kind: 'deferred', reason: 'no-window' });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.failAllPending).not.toHaveBeenCalled();
  });

  it('fails every pending row with an actionable message when the project folder is gone', async () => {
    const deps = createDeps({
      resolveWindow: vi.fn(async () => ({ kind: 'terminal', reason: 'workspace-missing' }) as const),
      failAllPending: vi.fn(async () => 2),
    });

    expect(await run(deps)).toEqual({ kind: 'failed', reason: 'workspace-missing' });
    expect(deps.failAllPending).toHaveBeenCalledExactlyOnceWith(
      's1',
      'Project folder is no longer available at /ws',
    );
  });

  it('defers when the dispatcher declines but rows are still pending', async () => {
    const deps = createDeps({ dispatch: vi.fn(async () => false) });

    expect(await run(deps)).toEqual({ kind: 'deferred', reason: 'session-busy' });
  });

  it('reports nothing-pending when the declined row was claimed by someone else', async () => {
    const listPendingIds = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['p1'])
      .mockResolvedValueOnce([]);
    const deps = createDeps({ listPendingIds, dispatch: vi.fn(async () => false) });

    expect(await run(deps)).toEqual({ kind: 'nothing-pending' });
  });

  it('only lets a remote-originated delivery open a window', () => {
    expect(allowsAutoOpen('mobile-control')).toBe(true);
    expect(allowsAutoOpen('mobile-index')).toBe(true);
    // Boot recovery would race window restore; a wakeup keeps its existing
    // "wait for the user to open the project" contract.
    expect(allowsAutoOpen('boot-recovery')).toBe(false);
    expect(allowsAutoOpen('wakeup')).toBe(false);
    expect(allowsAutoOpen('safety-sweep')).toBe(false);
  });
});
