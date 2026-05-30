import { describe, it, expect, vi } from 'vitest';
import { MigrationProgressReporter, CHANNEL_PROGRESS, CHANNEL_PHASE, CHANNEL_COMPLETE, CHANNEL_FAILED } from '../MigrationProgressReporter';
import type { MigrationProgress, MigrationSummary } from '../PGLiteToSQLiteMigrator';

function progress(over: Partial<MigrationProgress> = {}): MigrationProgress {
  return {
    phase: 'copying',
    currentTable: 'ai_sessions',
    rowsCopied: 0,
    rowsExpected: 100,
    tableRowsCopied: 0,
    tableRowsExpected: 100,
    tablesCompleted: 0,
    tablesTotal: 1,
    percentOfTotal: 0,
    elapsedMs: 0,
    ...over,
  };
}

describe('MigrationProgressReporter', () => {
  it('throttles bursts of progress events to one emit per window + final flush', async () => {
    const broadcast = vi.fn();
    const r = new MigrationProgressReporter({ throttleMs: 50, broadcast });

    // First event always fires immediately.
    r.onProgress(progress({ rowsCopied: 1 }));
    // Burst of 10 within the window.
    for (let i = 2; i <= 11; i++) r.onProgress(progress({ rowsCopied: i }));

    // Phase channel was emitted exactly once (one phase transition).
    const phaseCalls = broadcast.mock.calls.filter((c) => c[0] === CHANNEL_PHASE);
    expect(phaseCalls.length).toBe(1);

    // Progress channel: 1 immediate + at most 1 scheduled = 2.
    await new Promise((res) => setTimeout(res, 100));
    const progressCalls = broadcast.mock.calls.filter((c) => c[0] === CHANNEL_PROGRESS);
    expect(progressCalls.length).toBe(2);
    expect((progressCalls[progressCalls.length - 1][1] as MigrationProgress).rowsCopied).toBe(11);
  });

  it('emits a phase event on every distinct phase transition', () => {
    const broadcast = vi.fn();
    const r = new MigrationProgressReporter({ throttleMs: 10_000, broadcast });

    r.onProgress(progress({ phase: 'preparing' }));
    r.onProgress(progress({ phase: 'copying' }));
    r.onProgress(progress({ phase: 'copying' })); // no transition
    r.onProgress(progress({ phase: 'verifying-counts' }));
    r.onProgress(progress({ phase: 'finalizing' }));

    const phaseCalls = broadcast.mock.calls.filter((c) => c[0] === CHANNEL_PHASE);
    expect(phaseCalls.map((c) => (c[1] as { phase: string }).phase)).toEqual([
      'preparing', 'copying', 'verifying-counts', 'finalizing',
    ]);
  });

  it('emitComplete flushes pending progress then broadcasts complete', () => {
    const broadcast = vi.fn();
    const r = new MigrationProgressReporter({ throttleMs: 10_000, broadcast });
    r.onProgress(progress({ rowsCopied: 50 }));
    r.onProgress(progress({ rowsCopied: 100 }));

    const summary: MigrationSummary = {
      totalRowsCopied: 100,
      tablesCopied: [{ name: 'ai_sessions', rows: 100 }],
      durationMs: 123,
      integrityCheck: 'ok',
      foreignKeyViolations: 0,
      spotCheckCount: 1,
    };
    r.emitComplete(summary);

    const channels = broadcast.mock.calls.map((c) => c[0]);
    expect(channels).toContain(CHANNEL_PROGRESS);
    expect(channels).toContain(CHANNEL_COMPLETE);
    // Last progress emit reflects the latest event (rowsCopied=100).
    const lastProgress = [...broadcast.mock.calls].reverse().find((c) => c[0] === CHANNEL_PROGRESS);
    expect((lastProgress?.[1] as MigrationProgress).rowsCopied).toBe(100);
  });

  it('emitFailed cancels pending timer and broadcasts failure payload', async () => {
    const broadcast = vi.fn();
    const r = new MigrationProgressReporter({ throttleMs: 50, broadcast });
    r.onProgress(progress({ rowsCopied: 1 }));
    r.onProgress(progress({ rowsCopied: 2 })); // scheduled for ~50ms

    r.emitFailed({ phase: 'copying', message: 'kaboom' });
    await new Promise((res) => setTimeout(res, 100));

    // The throttled timer should not fire after emitFailed cancelled it.
    const progressCalls = broadcast.mock.calls.filter((c) => c[0] === CHANNEL_PROGRESS);
    // Exactly one (the immediate first); the second was throttled and then cancelled.
    expect(progressCalls.length).toBe(1);
    const failedCall = broadcast.mock.calls.find((c) => c[0] === CHANNEL_FAILED);
    expect(failedCall).toBeTruthy();
    expect((failedCall?.[1] as { message: string }).message).toBe('kaboom');
  });
});
