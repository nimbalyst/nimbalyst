// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
import { beginSessionTurn, isTurnControlPending, isDirectTurnAdmissionBlocked, isTurnRecoveryQuarantined, performTurnInterruption, TurnControlPendingError } from '../sessionTurnControl';
import { codexQuestionTurns } from '../codexQuestionTurns';
import { beginTurnSetup } from '../turnSetupStages';
import { captureQueueAuthorization, holdQueueAfterStop, isQueueStopped } from '../stoppedQueueHold';
import { runQueueDriveAttempt } from '../queueDriveAttempt';
import { QueueDriveService } from '../QueueDriveService';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let serial = 0;
function fixture(provider: any = { abort: vi.fn(), interruptCurrentTurn: vi.fn(async () => ({ method: 'abort' })) }) {
  const sessionId = `control-${++serial}`;
  return {
    sessionId, mode: 'interrupt' as 'stop' | 'interrupt', provider,
    isCurrentProvider: vi.fn(() => true), guard: new Set([sessionId]),
    retireInbox: vi.fn(async () => {}), sweep: vi.fn(async () => {}),
    settle: vi.fn(async () => {}), drive: vi.fn(async () => {}),
    requestDrive: vi.fn(() => true), invalidateDrive: vi.fn(), logError: vi.fn(),
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('captured desktop turn interruption', () => {
  it('records repeated explicit Stop immediately without a late recovery re-holding a new send', async () => {
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    const stop = vi.fn(() => holdQueueAfterStop(options.sessionId));
    stop();
    const first = performTurnInterruption({ ...options, mode: 'stop', timeouts: { stageMs: 5 } });
    const authorizeOlderSend = captureQueueAuthorization(options.sessionId);
    stop();
    const second = performTurnInterruption({ ...options, mode: 'stop' });
    expect(first).toBe(second);
    authorizeOlderSend();
    expect(isQueueStopped(options.sessionId)).toBe(true);
    await first;
    // A genuinely new send may authorize the queue while old retirement recovers.
    captureQueueAuthorization(options.sessionId)();
    host.finish();
    await vi.waitFor(() => expect(options.settle).toHaveBeenCalledOnce());
    expect(stop).toHaveBeenCalledTimes(2);
    expect(isQueueStopped(options.sessionId)).toBe(false);
  });
  it('coalesces repeated controls and escalates graceful lightning to hard Stop once', async () => {
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    options.provider.interruptCurrentTurn.mockImplementation(() => new Promise(() => {}));
    const lightning = performTurnInterruption(options);
    expect(isTurnControlPending(options.sessionId)).toBe(true);
    expect(() => beginSessionTurn(options.sessionId)).toThrow(TurnControlPendingError);
    const stop = performTurnInterruption({ ...options, mode: 'stop' });
    const duplicate = performTurnInterruption({ ...options, mode: 'stop' });
    expect(stop).toBe(lightning);
    expect(duplicate).toBe(lightning);
    expect(options.provider.abort).toHaveBeenCalledOnce();
    expect(options.sweep).not.toHaveBeenCalled();
    host.finish();
    expect(await stop).toEqual({ success: true, method: 'abort' });
    expect(options.provider.interruptCurrentTurn).toHaveBeenCalledOnce();
    expect(options.drive).toHaveBeenCalledOnce();
    expect(options.guard.has(options.sessionId)).toBe(false);
  });

  it('retires an abandoned question exactly once when no provider exists', async () => {
    const options = fixture(null);
    const question = codexQuestionTurns.begin(options.sessionId);
    const abandon = vi.fn();
    codexQuestionTurns.register(question, 'q', {}, { abandon, answer: vi.fn() });
    expect((await performTurnInterruption(options)).success).toBe(true);
    expect(question.active).toBe(false);
    await codexQuestionTurns.end(question);
    expect(abandon).toHaveBeenCalledOnce();
    expect(options.settle).toHaveBeenCalledOnce();
  });

  it('recovers an orphaned question with a hard abort when no host or setup remains', async () => {
    const options = fixture();
    const question = codexQuestionTurns.begin(options.sessionId);
    expect((await performTurnInterruption(options)).success).toBe(true);
    expect(options.provider.abort).toHaveBeenCalledOnce();
    expect(options.provider.interruptCurrentTurn).not.toHaveBeenCalled();
    expect(options.sweep).toHaveBeenCalledOnce();
    expect(question.active).toBe(false);
    await codexQuestionTurns.end(question);
  });

  it('preserves question waiters, queue ownership and live state when the provider rejects', async () => {
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    const question = codexQuestionTurns.begin(options.sessionId);
    const setup = beginTurnSetup(options.sessionId);
    const abandon = vi.fn();
    codexQuestionTurns.register(question, 'q', {}, { abandon, answer: vi.fn() });
    options.provider.interruptCurrentTurn.mockRejectedValueOnce(new Error('native refused'));
    expect(await performTurnInterruption(options)).toMatchObject({ success: false, error: 'native refused' });
    expect(abandon).not.toHaveBeenCalled();
    expect(question.active).toBe(true);
    expect(options.guard.has(options.sessionId)).toBe(true);
    expect(options.sweep).not.toHaveBeenCalled();
    expect(options.settle).not.toHaveBeenCalled();
    expect(host.cancelled).toBe(false);
    await expect(setup.stage('not-cancelled', async () => 1)).resolves.toBe(1);
    setup.finish();
    host.finish();
    await codexQuestionTurns.end(question);
  });

  it('revalidates replacement before touching setup or sending native control', async () => {
    const options = fixture();
    const setup = beginTurnSetup(options.sessionId);
    options.isCurrentProvider.mockReturnValue(false);
    expect((await performTurnInterruption(options)).success).toBe(false);
    await expect(setup.stage('still-owned', async () => 7)).resolves.toBe(7);
    setup.finish();
    expect(options.provider.interruptCurrentTurn).not.toHaveBeenCalled();
  });

  it('settles Stop after host retirement even when its provider was replaced', async () => {
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    const control = performTurnInterruption({ ...options, mode: 'stop' });
    await Promise.resolve();
    options.isCurrentProvider.mockReturnValue(false);
    host.finish();
    expect(await control).toMatchObject({ success: true, warning: expect.stringContaining('provider was replaced') });
    expect(options.sweep).toHaveBeenCalledOnce();
    expect(options.settle).toHaveBeenCalledOnce();
    expect(options.drive).not.toHaveBeenCalled();
    expect(options.requestDrive).toHaveBeenCalledOnce();
  });

  it('drives two swept rows in order after replacement, including a backoff wake', async () => {
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    const pending = ['older', 'newer'];
    const delivered: string[] = [];
    const allDelivered = deferred();
    const backoffArmed = deferred();
    const timers: Array<() => void> = [];
    let ready = false;
    let driver!: QueueDriveService;
    let issuedDrive!: Promise<unknown>;
    driver = new QueueDriveService({
      attempt: async () => {
        if (!ready) return { kind: 'deferred', reason: 'session-busy' };
        const row = pending.shift();
        if (!row) return { kind: 'nothing-pending' };
        delivered.push(row);
        if (pending.length) queueMicrotask(() => driver.requestDrive(options.sessionId, '/workspace', 'fifo-continuation'));
        else allDelivered.resolve();
        return { kind: 'dispatched', promptId: row };
      },
      onWindowAvailable: () => () => {}, onSessionIdle: () => () => {},
      logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(),
      timers: {
        setTimeout: fn => { timers.push(fn); backoffArmed.resolve(); return fn; },
        clearTimeout: vi.fn(),
      },
    });
    options.requestDrive.mockImplementation(() => {
      expect(isDirectTurnAdmissionBlocked(options.sessionId)).toBe(false);
      issuedDrive = driver.drive(options.sessionId, '/workspace', 'renderer-trigger');
      return true;
    });
    try {
      const control = performTurnInterruption({ ...options, mode: 'stop' });
      options.isCurrentProvider.mockReturnValue(false);
      host.finish();
      expect((await control).success).toBe(true);
      await issuedDrive;
      await backoffArmed.promise;
      expect(delivered).toEqual([]);
      ready = true;
      timers[0]();
      await allDelivered.promise;
      expect(delivered).toEqual(['older', 'newer']);
      expect(options.requestDrive).toHaveBeenCalledOnce();
    } finally { host.finish(); driver.dispose(); }
  });

  it('coalesces a replacement drive with an already in-flight drive on the same session', async () => {
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    const oldEntered = deferred();
    const releaseOld = deferred();
    const delivered = deferred();
    const rows = ['only-row'];
    let attempts = 0;
    let deliveries = 0;
    const driver = new QueueDriveService({
      attempt: async ({ signal }) => {
        if (++attempts === 1) { oldEntered.resolve(); await releaseOld.promise; }
        if (signal.aborted) return { kind: 'deferred', reason: 'session-busy' };
        const row = rows.shift();
        if (!row) return { kind: 'nothing-pending' };
        deliveries += 1;
        delivered.resolve();
        return { kind: 'dispatched', promptId: row };
      },
      onWindowAvailable: () => () => {}, onSessionIdle: () => () => {},
      logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(),
      timers: { setTimeout: vi.fn(), clearTimeout: vi.fn() },
    });
    options.invalidateDrive.mockImplementation(() => driver.invalidate(options.sessionId));
    options.requestDrive.mockImplementation(() => {
      driver.requestDrive(options.sessionId, '/workspace', 'send-now');
      return true;
    });
    try {
      const oldDrive = driver.drive(options.sessionId, '/workspace', 'renderer-trigger');
      await oldEntered.promise;
      const control = performTurnInterruption(options);
      options.isCurrentProvider.mockReturnValue(false);
      host.finish();
      expect((await control).success).toBe(true);
      releaseOld.resolve();
      await oldDrive;
      await delivered.promise;
      expect(attempts).toBe(2);
      expect(deliveries).toBe(1);
      expect(options.requestDrive).toHaveBeenCalledOnce();
    } finally { releaseOld.resolve(); host.finish(); driver.dispose(); }
  });

  it('issues only one replacement drive for duplicate Stop events', async () => {
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    const first = performTurnInterruption({ ...options, mode: 'stop' });
    const duplicate = performTurnInterruption({ ...options, mode: 'stop' });
    expect(duplicate).toBe(first);
    options.isCurrentProvider.mockReturnValue(false);
    host.finish();
    expect((await first).success).toBe(true);
    expect(options.requestDrive).toHaveBeenCalledOnce();
    expect((await performTurnInterruption({ ...options, mode: 'stop' })).success).toBe(false);
    expect(options.requestDrive).toHaveBeenCalledOnce();
  });

  it.each(['stop', 'interrupt'] as const)('does not report %s success when a replacement drive cannot be issued', async mode => {
    const options = fixture();
    options.requestDrive.mockReturnValue(false);
    const host = beginSessionTurn(options.sessionId);
    const control = performTurnInterruption({ ...options, mode });
    options.isCurrentProvider.mockReturnValue(false);
    host.finish();
    expect((await control).success).toBe(false);
    expect(options.requestDrive).toHaveBeenCalledOnce();
  });

  it('reports a replaced Stop as incomplete when cleanup fails before a drive can be issued', async () => {
    const options = fixture();
    options.sweep.mockRejectedValueOnce(new Error('queue storage unavailable'));
    const host = beginSessionTurn(options.sessionId);
    const control = performTurnInterruption({ ...options, mode: 'stop' });
    options.isCurrentProvider.mockReturnValue(false);
    host.finish();
    expect(await control).toMatchObject({ success: false, error: expect.stringContaining('queue storage unavailable') });
    expect(options.requestDrive).not.toHaveBeenCalled();
  });

  it('requests the replacement drive after a timed-out settlement eventually retires', async () => {
    vi.useFakeTimers();
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    const settle = deferred();
    options.settle.mockImplementationOnce(() => settle.promise);
    const control = performTurnInterruption({ ...options, mode: 'stop', timeouts: { stageMs: 20 } });
    options.isCurrentProvider.mockReturnValue(false);
    host.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect((await control).success).toBe(false);
    expect(options.requestDrive).not.toHaveBeenCalled();
    settle.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(options.requestDrive).toHaveBeenCalledOnce();
    expect(options.drive).not.toHaveBeenCalled();
  });

  it('cancels setup before a parked preparation can reach the provider', async () => {
    const options = fixture(null);
    const host = beginSessionTurn(options.sessionId);
    const setup = beginTurnSetup(options.sessionId);
    const preparation = deferred();
    let providerStarted = false;
    const preparing = setup.stage('prepare', () => preparation.promise).then(() => { providerStarted = true; });
    const rejected = expect(preparing).rejects.toThrow('Stopped before the agent started');
    const control = performTurnInterruption(options);
    await vi.waitFor(() => expect(host.cancelled).toBe(true));
    preparation.resolve();
    await rejected;
    host.finish();
    expect((await control).success).toBe(true);
    expect(providerStarted).toBe(false);
  });

  it('holds through captured inbox cleanup and leaves later generations untouched', async () => {
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    const retired = deferred();
    options.retireInbox.mockImplementationOnce(() => retired.promise);
    const control = performTurnInterruption(options);
    host.finish();
    await vi.waitFor(() => expect(options.retireInbox).toHaveBeenCalledOnce());
    expect(isTurnControlPending(options.sessionId)).toBe(true);
    expect(options.sweep).not.toHaveBeenCalled();
    retired.resolve();
    expect((await control).success).toBe(true);
    const next = beginSessionTurn(options.sessionId);
    host.finish();
    expect(next.cancelled).toBe(false);
    next.finish();
  });

  it('releases only retired ownership when storage cleanup fails', async () => {
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    options.sweep.mockRejectedValueOnce(new Error('storage unavailable'));
    const control = performTurnInterruption(options);
    host.finish();
    expect(await control).toMatchObject({ success: false, error: 'storage unavailable' });
    expect(options.settle).toHaveBeenCalledOnce();
    expect(options.guard.has(options.sessionId)).toBe(false);
    expect(options.drive).not.toHaveBeenCalled();
    expect(isTurnControlPending(options.sessionId)).toBe(false);
  });

  it('reports a post-retirement queue-drive failure to the caller', async () => {
    const options = fixture(null);
    options.drive.mockRejectedValueOnce(new Error('queue drive failed'));
    expect(await performTurnInterruption(options)).toMatchObject({ success: false, error: 'queue drive failed' });
    expect(isTurnControlPending(options.sessionId)).toBe(false);
  });

  it.each(['deferred', 'failed'] as const)('exposes a resolved %s queue-drive outcome', async kind => {
    const options = fixture(null);
    const result = await performTurnInterruption({
      ...options,
      drive: async () => kind === 'deferred'
        ? { kind: 'deferred', reason: 'session-busy' } as const
        : { kind: 'failed', reason: 'workspace-missing' } as const,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('turn stopped');
  });

  it.each(['deferred', 'failed'] as const)('reports Stop success with a warning when queue drive is %s', async kind => {
    const options = fixture(null);
    const result = await performTurnInterruption({
      ...options, mode: 'stop',
      drive: async () => kind === 'deferred'
        ? { kind: 'deferred', reason: 'session-busy' } as const
        : { kind: 'failed', reason: 'workspace-missing' } as const,
    });
    expect(result).toMatchObject({ success: true, warning: expect.stringContaining('turn stopped') });
  });

  it.each(['sweep', 'drive'] as const)('keeps Stop success truthful when post-retirement %s fails', async stage => {
    const options = fixture(null);
    options[stage].mockRejectedValueOnce(new Error(`${stage} unavailable`));
    const result = await performTurnInterruption({ ...options, mode: 'stop' });
    expect(result).toMatchObject({ success: true, warning: expect.stringContaining(`${stage} unavailable`) });
  });

  it.each(['stop', 'interrupt'] as const)('honors a new %s targeting the successor admitted during the previous drive', async mode => {
    const options = fixture();
    options.mode = mode;
    const old = beginSessionTurn(options.sessionId);
    const driven = deferred();
    const driving = deferred();
    let successor!: ReturnType<typeof beginSessionTurn>;
    options.drive.mockImplementationOnce(async () => {
      successor = beginSessionTurn(options.sessionId);
      driving.resolve();
      await driven.promise;
    });
    const first = performTurnInterruption(options);
    old.finish();
    await driving.promise;
    const second = performTurnInterruption(options);
    expect(second).not.toBe(first);
    await Promise.resolve();
    expect(mode === 'stop' ? options.provider.abort : options.provider.interruptCurrentTurn).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(successor.cancelled).toBe(true));
    successor.finish();
    expect((await second).success).toBe(true);
    driven.resolve();
    expect((await first).success).toBe(true);
  });

  it('waits all question recoveries and finishes control even when one recovery fails', async () => {
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    const question = codexQuestionTurns.begin(options.sessionId);
    const recovery = deferred();
    codexQuestionTurns.register(question, 'q', {}, { answer: vi.fn(), abandon: vi.fn() });
    expect(codexQuestionTurns.claim(options.sessionId, 'q', { answers: {}, respondedBy: 'desktop' }, async () => {
      await recovery.promise;
      throw new Error('recovery database failed');
    }, async () => {})).toBe('live');
    const control = performTurnInterruption(options);
    const retiring = codexQuestionTurns.end(question).catch(() => {});
    expect(isTurnControlPending(options.sessionId)).toBe(true);
    recovery.resolve();
    await retiring;
    host.finish();
    expect((await control).success).toBe(true);
    expect(options.logError).toHaveBeenCalled();
    expect(options.drive).toHaveBeenCalledOnce();
  });
  it('bounds a never-settling graceful interrupt and escalates to abort', async () => {
    vi.useFakeTimers();
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    options.provider.interruptCurrentTurn.mockImplementation(() => new Promise(() => {}));
    options.provider.abort.mockImplementation(() => host.finish());
    const control = performTurnInterruption({ ...options, timeouts: { interruptMs: 10, stageMs: 20 } });
    await vi.advanceTimersByTimeAsync(10);
    expect(await control).toMatchObject({ success: true, method: 'abort' });
    expect(options.provider.abort).toHaveBeenCalledOnce();
    expect(isTurnControlPending(options.sessionId)).toBe(false);
  });

  it('clears the control fence after unfinished host timeout and rejects new sends visibly', async () => {
    vi.useFakeTimers();
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    const control = performTurnInterruption({ ...options, mode: 'stop', timeouts: { stageMs: 20 } });
    expect(() => beginSessionTurn(options.sessionId)).toThrow(TurnControlPendingError);
    await vi.advanceTimersByTimeAsync(20);
    expect(await control).toMatchObject({ success: false, error: expect.stringContaining('timed out') });
    expect(isTurnControlPending(options.sessionId)).toBe(false);
    expect(options.sweep).not.toHaveBeenCalled();
    expect(options.drive).not.toHaveBeenCalled();
    expect(() => beginSessionTurn(options.sessionId)).toThrow(TurnControlPendingError);
    const retry = await performTurnInterruption(options);
    expect(retry.success).toBe(false);
    expect(retry.error).toContain('Restart the app');
    expect(options.provider.abort).toHaveBeenCalledTimes(2);
    expect(options.sweep).not.toHaveBeenCalled();
    host.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(options.drive).toHaveBeenCalledOnce();
    const next = beginSessionTurn(options.sessionId);
    next.finish();
  });

  it.each(['retireInbox', 'sweep', 'settle', 'drive'] as const)('bounds a stalled %s and prevents a late write reaching a successor', async stage => {
    vi.useFakeTimers();
    const options = fixture(null);
    const stalled = deferred();
    options[stage].mockImplementationOnce(() => stalled.promise);
    const control = performTurnInterruption({ ...options, timeouts: { stageMs: 20 } });
    await vi.advanceTimersByTimeAsync(20);
    expect(await control).toMatchObject({ success: false, error: expect.stringContaining('timed out') });
    expect(isTurnControlPending(options.sessionId)).toBe(false);
    expect(() => beginSessionTurn(options.sessionId)).toThrow(TurnControlPendingError);
    if (stage === 'sweep') {
      expect(options.guard.has(options.sessionId)).toBe(true);
      expect(options.settle).not.toHaveBeenCalled();
    }
    stalled.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(options[stage]).toHaveBeenCalledTimes(stage === 'drive' ? 2 : 1);
    const next = beginSessionTurn(options.sessionId);
    next.finish();
  });

  it('refuses an actually active unregistered setup while preserving its state', async () => {
    const options = fixture();
    const setup = beginTurnSetup(options.sessionId);
    expect(await performTurnInterruption(options)).toMatchObject({ success: false, error: expect.stringContaining('active setup') });
    expect(options.provider.abort).not.toHaveBeenCalled();
    await expect(setup.stage('unchanged', async () => 1)).resolves.toBe(1);
    setup.finish();
  });

  it('does not mistake a previous drive before host registration for an orphan', async () => {
    const options = fixture(null);
    const entered = deferred();
    const drive = deferred();
    options.drive.mockImplementationOnce(async () => { entered.resolve(); await drive.promise; });
    const first = performTurnInterruption(options);
    await entered.promise;
    expect(await performTurnInterruption(options)).toMatchObject({ success: false, error: expect.stringContaining('still starting') });
    expect(options.sweep).toHaveBeenCalledOnce();
    expect(options.drive).toHaveBeenCalledOnce();
    drive.resolve();
    expect((await first).success).toBe(true);
  });

  it('cancels a successor setup when Stop retries during a timed-out drive', async () => {
    vi.useFakeTimers();
    const options = fixture();
    const entered = deferred();
    const stalled = deferred();
    let successor!: ReturnType<typeof beginSessionTurn>;
    let setup!: ReturnType<typeof beginTurnSetup>;
    options.drive.mockImplementationOnce(async () => {
      successor = beginSessionTurn(options.sessionId);
      setup = beginTurnSetup(options.sessionId);
      entered.resolve();
      await stalled.promise;
    });
    const control = performTurnInterruption({ ...options, mode: 'stop', timeouts: { stageMs: 20 } });
    await vi.advanceTimersByTimeAsync(0);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(20);
    expect(await control).toMatchObject({ success: true, warning: expect.stringContaining('timed out') });
    expect((await performTurnInterruption({ ...options, mode: 'stop' })).error).toContain('Restart the app');
    expect(options.provider.abort).toHaveBeenCalledTimes(2);
    expect(successor.cancelled).toBe(true);
    await expect(setup.stage('late-provider', async () => 1)).rejects.toThrow('back in the composer');
    successor.finish();
    stalled.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(options.drive).toHaveBeenCalledTimes(2);
  });

  it('preserves a failed sweep across delayed settlement and never drives', async () => {
    vi.useFakeTimers();
    const options = fixture(null);
    options.sweep.mockRejectedValueOnce(new Error('sweep failed'));
    const stalled = deferred();
    options.settle.mockImplementationOnce(() => stalled.promise);
    const control = performTurnInterruption({ ...options, timeouts: { stageMs: 20 } });
    await vi.advanceTimersByTimeAsync(20);
    expect((await control).success).toBe(false);
    stalled.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(options.sweep).toHaveBeenCalledOnce();
    expect(options.drive).not.toHaveBeenCalled();
    expect(options.logError).toHaveBeenCalledWith(expect.objectContaining({ message: 'sweep failed' }));
  });

  it.each([5, 30])('retains both overlapping timed-out controls when the newer timeout is %ims', async newerTimeout => {
    vi.useFakeTimers();
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    const entered = deferred();
    const parked = deferred();
    let successor!: ReturnType<typeof beginSessionTurn>;
    options.drive.mockImplementationOnce(async () => {
      successor = beginSessionTurn(options.sessionId);
      entered.resolve();
      await parked.promise;
    });
    const first = performTurnInterruption({ ...options, mode: 'stop', timeouts: { stageMs: 20 } });
    host.finish();
    await vi.advanceTimersByTimeAsync(0);
    await entered.promise;
    const second = performTurnInterruption({ ...options, mode: 'stop', timeouts: { stageMs: newerTimeout } });
    await vi.advanceTimersByTimeAsync(35);
    expect(await first).toMatchObject({ success: true, warning: expect.stringContaining('timed out') });
    expect((await second).success).toBe(false);
    successor.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(isTurnRecoveryQuarantined(options.sessionId)).toBe(true);
    expect(() => beginSessionTurn(options.sessionId)).toThrow(TurnControlPendingError);
    expect(options.drive).toHaveBeenCalledOnce();
    parked.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(isTurnRecoveryQuarantined(options.sessionId)).toBe(false);
    // The newer Stop must finish its cleanup, rather than the old drive's retry
    // overtaking it. Exactly one recovery resumes queue admission.
    expect(options.sweep).toHaveBeenCalledTimes(2);
    expect(options.settle).toHaveBeenCalledTimes(2);
    expect(options.drive).toHaveBeenCalledTimes(2);
    expect(isDirectTurnAdmissionBlocked(options.sessionId)).toBe(false);
  });

  it('retains a timed-out retry drive even before it registers a host', async () => {
    vi.useFakeTimers();
    const options = fixture(null);
    const firstDrive = deferred();
    const retryDrive = deferred();
    options.drive.mockImplementationOnce(() => firstDrive.promise).mockImplementationOnce(() => retryDrive.promise);
    const control = performTurnInterruption({ ...options, timeouts: { stageMs: 20 } });
    await vi.advanceTimersByTimeAsync(20);
    expect((await control).success).toBe(false);
    firstDrive.resolve();
    await vi.advanceTimersByTimeAsync(20);
    expect(options.drive).toHaveBeenCalledTimes(2);
    expect(isTurnRecoveryQuarantined(options.sessionId)).toBe(true);
    expect(() => beginSessionTurn(options.sessionId)).toThrow(TurnControlPendingError);
    retryDrive.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(isTurnRecoveryQuarantined(options.sessionId)).toBe(false);
    expect(isDirectTurnAdmissionBlocked(options.sessionId)).toBe(false);
  });

  it.each([false, true])('lets a newer Stop drive after an older retry times out during its cleanup (wait also times out: %s)', async waitTimesOut => {
    vi.useFakeTimers();
    const options = fixture();
    const firstDrive = deferred();
    const retryDrive = deferred();
    const newerSettlement = deferred();
    let successor!: ReturnType<typeof beginSessionTurn>;
    let resumed!: ReturnType<typeof beginSessionTurn>;
    options.drive.mockImplementationOnce(() => firstDrive.promise).mockImplementationOnce(async () => {
      successor = beginSessionTurn(options.sessionId);
      await retryDrive.promise;
    }).mockImplementationOnce(async () => { resumed = beginSessionTurn(options.sessionId); resumed.finish(); });
    const first = performTurnInterruption({ ...options, mode: 'stop', timeouts: { stageMs: 10 } });
    await vi.advanceTimersByTimeAsync(10);
    expect(await first).toMatchObject({ success: true, warning: expect.stringContaining('timed out') });
    firstDrive.resolve();
    await vi.advanceTimersByTimeAsync(0);
    options.settle.mockImplementationOnce(() => newerSettlement.promise);
    const second = performTurnInterruption({ ...options, mode: 'stop', timeouts: { stageMs: 50 } });
    successor.finish();
    await vi.advanceTimersByTimeAsync(10);
    expect(options.settle).toHaveBeenCalledTimes(2);
    newerSettlement.resolve();
    await vi.advanceTimersByTimeAsync(0);
    if (waitTimesOut) {
      await vi.advanceTimersByTimeAsync(50);
      expect(await second).toMatchObject({ success: true, warning: expect.stringContaining('timed out') });
      expect(isTurnRecoveryQuarantined(options.sessionId)).toBe(true);
    }
    retryDrive.resolve();
    await vi.advanceTimersByTimeAsync(0);
    if (!waitTimesOut) expect((await second).success).toBe(true);
    expect(resumed).toBeDefined();
    expect(options.drive).toHaveBeenCalledTimes(3);
    expect(isDirectTurnAdmissionBlocked(options.sessionId)).toBe(false);
  });

  it('keeps a newer Stop held when an older drive retries after that control finishes', async () => {
    vi.useFakeTimers();
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    const parked = deferred();
    let successor!: ReturnType<typeof beginSessionTurn>;
    const dispatch = vi.fn(async () => true);
    const attempt = () => runQueueDriveAttempt({
      listPendingIds: async () => ['retained-original'], isChainActive: () => false,
      isSessionBusy: () => false, resolveWindow: async () => ({ kind: 'window', window: {}, opened: false }),
      failAllPending: vi.fn(), dispatch, logWarn: vi.fn(),
    }, { sessionId: options.sessionId, workspacePath: '/workspace', reason: 'send-now' });
    const drive = vi.fn(attempt).mockImplementationOnce(async () => {
      successor = beginSessionTurn(options.sessionId);
      await parked.promise;
      return { kind: 'dispatched' as const };
    });
    const first = performTurnInterruption({ ...options, drive, timeouts: { stageMs: 20 } });
    host.finish();
    await vi.advanceTimersByTimeAsync(0);
    holdQueueAfterStop(options.sessionId);
    const second = performTurnInterruption({ ...options, drive, mode: 'stop' });
    successor.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await second).toMatchObject({ success: true, warning: expect.stringContaining('still queued') });
    await vi.advanceTimersByTimeAsync(20);
    expect((await first).success).toBe(false);
    parked.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(drive).toHaveBeenCalledTimes(3);
    expect(dispatch).not.toHaveBeenCalled();
    expect(isQueueStopped(options.sessionId)).toBe(true);
    expect(isDirectTurnAdmissionBlocked(options.sessionId)).toBe(false);
  });

  it('keeps the older post-drive reservation when a newer control finishes first', async () => {
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    const entered = deferred();
    const parked = deferred();
    let successor!: ReturnType<typeof beginSessionTurn>;
    options.drive.mockImplementationOnce(async () => {
      successor = beginSessionTurn(options.sessionId);
      entered.resolve();
      await parked.promise;
    });
    const first = performTurnInterruption({ ...options, mode: 'stop' });
    host.finish();
    await entered.promise;
    const second = performTurnInterruption({ ...options, mode: 'stop' });
    successor.finish();
    expect((await second).success).toBe(true);
    expect(isDirectTurnAdmissionBlocked(options.sessionId)).toBe(true);
    parked.resolve();
    expect((await first).success).toBe(true);
    expect(isDirectTurnAdmissionBlocked(options.sessionId)).toBe(false);
  });

});
