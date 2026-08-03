// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { QueueDriveService, type DriveReason } from '../QueueDriveService';
import { runQueueDriveAttempt } from '../queueDriveAttempt';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('queue drain liveness', () => {
  it('continues an ordinary FIFO of three rows with one dispatch per row', async () => {
    const pending = ['p1', 'p2', 'p3'];
    const dispatched: string[] = [];
    let service!: QueueDriveService;

    service = new QueueDriveService({
      attempt: (input) =>
        runQueueDriveAttempt(
          {
            listPendingIds: async () => [...pending],
            isChainActive: () => false,
            isSessionBusy: () => false,
            resolveWindow: async () => ({ kind: 'window', window: { id: 1 }, opened: false }) as const,
            failAllPending: async () => 0,
            dispatch: async () => {
              const promptId = pending.shift();
              if (!promptId) return false;
              dispatched.push(promptId);
              if (pending.length > 0) {
                service.requestDrive('s1', '/ws', 'fifo-continuation');
              }
              return true;
            },
            logWarn: () => {},
          },
          input,
        ),
      onWindowAvailable: () => () => {},
      onSessionIdle: () => () => {},
      logInfo: () => {},
      logWarn: () => {},
      logError: () => {},
    });

    await service.drive('s1', '/ws', 'mobile-control');

    expect(dispatched).toEqual(['p1', 'p2', 'p3']);
  });

  it('re-drives after an ordinary active-turn terminal edge', async () => {
    const pending = ['p1'];
    const reasons: DriveReason[] = [];
    let busy = true;
    let onIdle: (() => void) | undefined;

    const service = new QueueDriveService({
      attempt: async (input) => {
        reasons.push(input.reason);
        return runQueueDriveAttempt(
          {
            listPendingIds: async () => [...pending],
            isChainActive: () => false,
            isSessionBusy: () => busy,
            resolveWindow: async () => ({ kind: 'window', window: { id: 1 }, opened: false }) as const,
            failAllPending: async () => 0,
            dispatch: async () => {
              pending.shift();
              return true;
            },
            logWarn: () => {},
          },
          input,
        );
      },
      onWindowAvailable: () => () => {},
      onSessionIdle: (_sessionId, listener) => {
        onIdle = listener;
        return () => {
          onIdle = undefined;
        };
      },
      logInfo: () => {},
      logWarn: () => {},
      logError: () => {},
    });

    await service.drive('s1', '/ws', 'mobile-control');
    expect(onIdle).toBeTypeOf('function');

    busy = false;
    onIdle?.();
    await flush();

    expect(reasons).toEqual(['mobile-control', 'session-idle']);
    expect(pending).toEqual([]);
  });

  it('collapses concurrent ordinary triggers into one claim and dispatch', async () => {
    const pending = ['p1'];
    const dispatched: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const service = new QueueDriveService({
      attempt: (input) =>
        runQueueDriveAttempt(
          {
            listPendingIds: async () => [...pending],
            isChainActive: () => false,
            isSessionBusy: () => false,
            resolveWindow: async () => ({ kind: 'window', window: { id: 1 }, opened: false }) as const,
            failAllPending: async () => 0,
            dispatch: async () => {
              await gate;
              const promptId = pending.shift();
              if (!promptId) return false;
              dispatched.push(promptId);
              return true;
            },
            logWarn: () => {},
          },
          input,
        ),
      onWindowAvailable: () => () => {},
      onSessionIdle: () => () => {},
      logInfo: () => {},
      logWarn: () => {},
      logError: () => {},
    });

    const first = service.drive('s1', '/ws', 'mobile-control');
    const second = service.drive('s1', '/ws', 'mobile-index');
    const third = service.drive('s1', '/ws', 'renderer-trigger');
    release();
    await Promise.all([first, second, third]);

    expect(dispatched).toEqual(['p1']);
  });
});
