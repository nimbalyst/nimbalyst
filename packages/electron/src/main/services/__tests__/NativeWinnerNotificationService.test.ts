import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeWinnerNotificationService,
  NATIVE_WINNER_COMPANION_ARGV_ENV,
  notifyNativeWinnerAfterAttentionTransition,
  settleInteractiveAttentionAfterResponse,
  type NativeWinnerSpawnFn,
} from '../NativeWinnerNotificationService';
import type { NativeWinnerOutboxRow } from '../HostControlReceiptsStore';

function fakeChild(output: string, code = 0): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
  queueMicrotask(() => {
    (child.stdout as EventEmitter).emit('data', Buffer.from(output));
    child.emit('close', code);
  });
  return child;
}

function createStoreHarness() {
  const rows = new Map<string, NativeWinnerOutboxRow>();
  const reserveNativeWinner = vi.fn(async (input: {
    reservationKey: string;
    sessionId: string;
    eventIdentity: string;
    attentionGeneration?: string;
  }) => {
    const existing = rows.get(input.reservationKey);
    if (existing) return { row: existing, isNewReservation: false };
    const row: NativeWinnerOutboxRow = {
      id: 'native-row-1',
      reservationKey: input.reservationKey,
      sessionId: input.sessionId,
      eventIdentity: input.eventIdentity,
      attentionGeneration: input.attentionGeneration,
      state: 'pending',
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    rows.set(input.reservationKey, row);
    return { row, isNewReservation: true };
  });
  const listPendingNativeWinners = vi.fn(async () =>
    [...rows.values()].filter((row) => row.state === 'pending')
  );
  const recordNativeWinnerAttempt = vi.fn(async (input: {
    id: string;
    sent: boolean;
    receipt: Record<string, unknown>;
  }) => {
    const row = [...rows.values()].find((candidate) => candidate.id === input.id)!;
    row.attemptCount += 1;
    row.receipt = input.receipt;
    row.state = input.sent ? 'sent' : 'pending';
    return row;
  });
  return {
    rows,
    store: { reserveNativeWinner, listPendingNativeWinners, recordNativeWinnerAttempt },
  };
}

const winner = {
  sessionId: 'session-immutable',
  eventIdentity: 'prompt-immutable',
  attentionGeneration: 'generation-immutable',
};

describe('NativeWinnerNotificationService', () => {
  it('invokes the configured argv-only companion once for a first native answered transition', async () => {
    const harness = createStoreHarness();
    const spawnFn = vi.fn(() => fakeChild('{"status":"recorded"}'));
    const service = createNativeWinnerNotificationService({
      store: harness.store,
      env: {
        [NATIVE_WINNER_COMPANION_ARGV_ENV]: JSON.stringify([
          'workspace-companion',
          '--json',
        ]),
      },
      spawnFn: spawnFn as unknown as NativeWinnerSpawnFn,
    });

    const result = await notifyNativeWinnerAfterAttentionTransition(service, {
      ...winner,
      respondedBy: 'desktop',
      cancelReason: 'answered',
      attentionCancelledCount: 1,
    });

    expect(result).toEqual({ configured: true, sent: true });
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(spawnFn).toHaveBeenCalledWith(
      'workspace-companion',
      [
        '--json',
        'native-winner',
        '--session-id',
        'session-immutable',
        '--event-identity',
        'prompt-immutable',
        '--attention-generation',
        'generation-immutable',
      ],
      expect.objectContaining({ shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    expect(harness.store.reserveNativeWinner.mock.invocationCallOrder[0])
      .toBeLessThan(spawnFn.mock.invocationCallOrder[0]);
  });

  it('never invokes the companion for a Telegram-sourced answer', async () => {
    const notify = vi.fn(async () => ({ configured: true, sent: true }));

    const result = await notifyNativeWinnerAfterAttentionTransition({ notify }, {
      ...winner,
      respondedBy: 'telegram',
      cancelReason: 'answered',
      attentionCancelledCount: 1,
    });

    expect(result).toEqual({ configured: false, sent: false });
    expect(notify).not.toHaveBeenCalled();
  });

  it('persists/notifies only after the exact attention transition returns a positive count', async () => {
    const cancelInteractivePrompt = vi.fn(async () => 1);
    const notify = vi.fn(async () => ({ configured: true, sent: true }));

    const count = await settleInteractiveAttentionAfterResponse({
      cancelInteractivePrompt,
      notificationService: { notify },
    }, {
      ...winner,
      respondedBy: 'mobile',
      cancelReason: 'answered',
    });

    expect(count).toBe(1);
    expect(cancelInteractivePrompt).toHaveBeenCalledWith(
      winner.sessionId,
      winner.eventIdentity,
      'answered',
      { expectedGeneration: winner.attentionGeneration },
    );
    expect(cancelInteractivePrompt.mock.invocationCallOrder[0])
      .toBeLessThan(notify.mock.invocationCallOrder[0]);
  });

  it('does not notify on a count-zero settle or a cancelled transition', async () => {
    const notify = vi.fn(async () => ({ configured: true, sent: true }));
    await notifyNativeWinnerAfterAttentionTransition({ notify }, {
      ...winner,
      respondedBy: 'mobile',
      cancelReason: 'answered',
      attentionCancelledCount: 0,
    });
    await notifyNativeWinnerAfterAttentionTransition({ notify }, {
      ...winner,
      respondedBy: 'desktop',
      cancelReason: 'cancelled',
      attentionCancelledCount: 1,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('retries only the pending outbox notification after spawn failure', async () => {
    const harness = createStoreHarness();
    const sensitivePath =
      'C:\\sessions\\3fa85f64-5717-4562-b3fc-2c963f66afa6\\companion.log';
    const spawnFn = vi.fn()
      .mockImplementationOnce(() => { throw new Error(`cannot open ${sensitivePath}`); })
      .mockImplementationOnce(() => fakeChild('{"status":"already_resolved"}'));
    const service = createNativeWinnerNotificationService({
      store: harness.store,
      env: {
        [NATIVE_WINNER_COMPANION_ARGV_ENV]: JSON.stringify(['workspace-companion']),
      },
      spawnFn: spawnFn as unknown as NativeWinnerSpawnFn,
    });

    await expect(service.notify(winner)).resolves.toEqual({ configured: true, sent: false });
    await expect(service.retryPending()).resolves.toBe(1);

    expect(harness.store.reserveNativeWinner).toHaveBeenCalledOnce();
    expect(harness.store.recordNativeWinnerAttempt).toHaveBeenCalledTimes(2);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    const receipts = harness.store.recordNativeWinnerAttempt.mock.calls
      .map(([input]) => JSON.stringify(input.receipt));
    expect(receipts[0]).not.toContain('3fa85f64-5717-4562-b3fc-2c963f66afa6');
    expect(Buffer.byteLength(receipts[0], 'utf8')).toBeLessThanOrEqual(4096);
    expect([...harness.rows.values()][0].state).toBe('sent');
  });
});
