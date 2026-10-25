// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
import { beginSessionTurn, isTurnControlPending, isDirectTurnAdmissionBlocked, performTurnInterruption, TurnControlPendingError } from '../sessionTurnControl';
import { codexQuestionTurns } from '../codexQuestionTurns';
import { beginTurnSetup } from '../turnSetupStages';

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
    settle: vi.fn(async () => {}), drive: vi.fn(async () => {}), logError: vi.fn(),
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('captured desktop turn interruption', () => {
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

  it('does not sweep or idle a replacement after the old host finishes', async () => {
    const options = fixture();
    const host = beginSessionTurn(options.sessionId);
    const control = performTurnInterruption(options);
    await Promise.resolve();
    options.isCurrentProvider.mockReturnValue(false);
    host.finish();
    expect((await control).success).toBe(false);
    expect(options.sweep).not.toHaveBeenCalled();
    expect(options.settle).not.toHaveBeenCalled();
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
    expect(retry.error).toContain('Stop again to retry');
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
    expect((await control).success).toBe(false);
    expect((await performTurnInterruption({ ...options, mode: 'stop' })).error).toContain('Stop again to retry');
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
