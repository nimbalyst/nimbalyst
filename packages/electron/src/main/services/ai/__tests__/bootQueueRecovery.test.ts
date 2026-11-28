// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { driveStrandedQueuesOnBoot } from '../bootQueueRecovery';
import { QueueDriveService } from '../QueueDriveService';
import { runQueueDriveAttempt } from '../queueDriveAttempt';

type DepOverrides = Partial<Omit<Parameters<typeof driveStrandedQueuesOnBoot>[0], 'requestDrive'>>;

function createDeps(overrides: DepOverrides = {}) {
  return {
    listSessionIdsWithPending: vi.fn(async () => [] as string[]),
    getWorkspacePath: vi.fn(async () => '/ws' as string | null | undefined),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    ...overrides,
    requestDrive: vi.fn<(sessionId: string, workspacePath: string) => void>(),
  };
}

describe('driveStrandedQueuesOnBoot', () => {
  it('recovers held report/status rows after restart without a transcript or an in-memory timer', async () => {
    const pending = ['report', 'status'].map((messageKind) => ({
      id: messageKind,
      documentContext: { promptProvenance: { actor: 'agent', origin: 'session-orchestration', messageKind } },
    }));
    const dispatch = vi.fn(async () => { pending.splice(0); return true; });
    const driver = new QueueDriveService({
      attempt: (input) => runQueueDriveAttempt({
        listPendingIds: async () => pending.map((row) => row.id),
        isChainActive: () => false, isSessionBusy: () => false,
        resolveWindow: async () => ({ kind: 'window', window: {}, opened: false }),
        failAllPending: async () => 0, dispatch, logWarn: vi.fn(),
      }, input),
      onWindowAvailable: () => () => {}, onSessionIdle: () => () => {},
      logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(),
    });
    const attempts: Promise<unknown>[] = [];
    const deps = createDeps({ listSessionIdsWithPending: vi.fn(async () => ['idle-recipient']) });
    deps.requestDrive.mockImplementation((id, workspacePath) => { attempts.push(driver.drive(id, workspacePath, 'boot-recovery')); });
    expect(await driveStrandedQueuesOnBoot(deps)).toBe(1);
    await Promise.all(attempts);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(pending).toEqual([]);
    driver.dispose();
  });
  it('drives each stranded session exactly once', async () => {
    const deps = createDeps({
      listSessionIdsWithPending: vi.fn(async () => ['s1', 's2', 's3']),
      getWorkspacePath: vi.fn(async (sessionId: string) => `/ws/${sessionId}`),
    });

    const driven = await driveStrandedQueuesOnBoot(deps);

    expect(driven).toBe(3);
    expect(deps.requestDrive).toHaveBeenCalledTimes(3);
    expect(deps.requestDrive.mock.calls).toEqual([
      ['s1', '/ws/s1'],
      ['s2', '/ws/s2'],
      ['s3', '/ws/s3'],
    ]);
  });

  it('drives nothing when the boot sweep left no pending rows', async () => {
    // Rows the sweep resolved (delivered-and-answered, or delivered-but-
    // unanswered) are no longer 'pending', so they must not be re-sent.
    // NIM-615 / #783.
    const deps = createDeps();

    expect(await driveStrandedQueuesOnBoot(deps)).toBe(0);
    expect(deps.requestDrive).not.toHaveBeenCalled();
    expect(deps.logInfo).not.toHaveBeenCalled();
  });

  it('skips a session with no workspace path instead of guessing a window', async () => {
    const deps = createDeps({
      listSessionIdsWithPending: vi.fn(async () => ['orphan', 'ok']),
      getWorkspacePath: vi.fn(async (sessionId: string) => (sessionId === 'ok' ? '/ws' : null)),
    });

    expect(await driveStrandedQueuesOnBoot(deps)).toBe(1);
    expect(deps.requestDrive).toHaveBeenCalledExactlyOnceWith('ok', '/ws');
    expect(deps.logWarn).toHaveBeenCalledOnce();
  });
});
