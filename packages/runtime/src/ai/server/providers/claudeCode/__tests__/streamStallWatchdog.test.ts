import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  raceNextChunkWithStallWatchdog,
  resolveStreamStallMs,
  DEFAULT_STREAM_STALL_MS,
  shouldArmStreamStallWatchdog,
} from '../streamStallWatchdog';

// A promise that never resolves -- models an SDK iterator that goes silent
// mid-turn (the NIM-1481 stall: heartbeats stop, no result, no error, no done).
const forever = <T>(): Promise<T> => new Promise<T>(() => {});

describe('resolveStreamStallMs', () => {
  it('defaults when unset', () => {
    expect(resolveStreamStallMs({})).toBe(DEFAULT_STREAM_STALL_MS);
  });
  it('honors a positive override', () => {
    expect(resolveStreamStallMs({ NIMBALYST_CC_STREAM_STALL_MS: '25' })).toBe(25);
  });
  it('ignores non-positive / invalid overrides', () => {
    expect(resolveStreamStallMs({ NIMBALYST_CC_STREAM_STALL_MS: '0' })).toBe(DEFAULT_STREAM_STALL_MS);
    expect(resolveStreamStallMs({ NIMBALYST_CC_STREAM_STALL_MS: 'nope' })).toBe(DEFAULT_STREAM_STALL_MS);
  });
});

describe('DEFAULT_STREAM_STALL_MS window (#802)', () => {
  it('covers the measured worst-case intra-turn heartbeat gap', () => {
    // `thinking_tokens` is a variable-cadence estimated-token progress tick, not a
    // ~1Hz wall-clock keepalive. Measured against real persisted chunks the intra-turn
    // gap averaged ~5s but reached ~589s; the old 120s window reaped legitimate long
    // thinking turns (#802). The window must sit comfortably above that observed max.
    expect(DEFAULT_STREAM_STALL_MS).toBeGreaterThanOrEqual(600_000);
  });
});

describe('raceNextChunkWithStallWatchdog', () => {
  it('a sparse heartbeat gap that tripped the old 120s window survives a 10-min window (#802)', async () => {
    // Scaled 1000x (ms stand in for seconds): a heartbeat arrives after a ~200s gap.
    // Under the old 120s window it was reaped; under the raised window it is delivered.
    const gapMs = 200;
    const makeTick = () =>
      new Promise<IteratorResult<string>>(resolve =>
        setTimeout(() => resolve({ value: 'thinking-tick', done: false }), gapMs),
      );

    const underOldWindow = await raceNextChunkWithStallWatchdog<string>({
      nextPromise: makeTick(),
      interruptPromise: forever<'interrupted'>(),
      watchdogActive: true,
      stallMs: 120,
    });
    expect(underOldWindow.kind).toBe('stalled');

    const underNewWindow = await raceNextChunkWithStallWatchdog<string>({
      nextPromise: makeTick(),
      interruptPromise: forever<'interrupted'>(),
      watchdogActive: true,
      stallMs: 600,
    });
    expect(underNewWindow.kind).toBe('chunk');
    if (underNewWindow.kind === 'chunk') expect(underNewWindow.result.value).toBe('thinking-tick');
  });

  it('reports stalled when the stream goes silent and the watchdog is armed', async () => {
    const outcome = await raceNextChunkWithStallWatchdog<string>({
      nextPromise: forever<IteratorResult<string>>(),
      interruptPromise: forever<'interrupted'>(),
      watchdogActive: true,
      stallMs: 20,
    });
    expect(outcome.kind).toBe('stalled');
  });

  it('never reports stalled when the watchdog is disarmed (long tool / drain)', async () => {
    // A real chunk arrives after the stall window would have elapsed; because the
    // watchdog is disarmed it must be delivered, not reaped.
    const outcome = await raceNextChunkWithStallWatchdog<string>({
      nextPromise: new Promise<IteratorResult<string>>(resolve =>
        setTimeout(() => resolve({ value: 'late', done: false }), 40),
      ),
      interruptPromise: forever<'interrupted'>(),
      watchdogActive: false,
      stallMs: 20,
    });
    expect(outcome.kind).toBe('chunk');
    if (outcome.kind === 'chunk') expect(outcome.result.value).toBe('late');
  });

  it('delivers a chunk that arrives before the stall window', async () => {
    const outcome = await raceNextChunkWithStallWatchdog<string>({
      nextPromise: Promise.resolve({ value: 'hi', done: false }),
      interruptPromise: forever<'interrupted'>(),
      watchdogActive: true,
      stallMs: 1_000,
    });
    expect(outcome.kind).toBe('chunk');
    if (outcome.kind === 'chunk') expect(outcome.result.value).toBe('hi');
  });

  it('reports interrupted when the interrupt wins the race', async () => {
    const outcome = await raceNextChunkWithStallWatchdog<string>({
      nextPromise: forever<IteratorResult<string>>(),
      interruptPromise: Promise.resolve('interrupted'),
      watchdogActive: true,
      stallMs: 1_000,
    });
    expect(outcome.kind).toBe('interrupted');
  });

  it('surfaces an iterator rejection as chunk-error (loop rethrows)', async () => {
    const boom = new Error('iterator exploded');
    const outcome = await raceNextChunkWithStallWatchdog<string>({
      nextPromise: Promise.reject(boom),
      interruptPromise: forever<'interrupted'>(),
      watchdogActive: true,
      stallMs: 1_000,
    });
    expect(outcome.kind).toBe('chunk-error');
    if (outcome.kind === 'chunk-error') expect(outcome.error).toBe(boom);
  });
});

describe('raceNextChunkWithStallWatchdog across system sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Models macOS sleep: nothing runs while asleep, then every overdue timer fires
  // at once on wake, with the wall clock already at the wake time.
  const sleep = async (ms: number): Promise<void> => {
    const wake = Date.now() + ms;
    const now = vi.spyOn(Date, 'now').mockReturnValue(wake);
    await vi.advanceTimersByTimeAsync(ms);
    now.mockRestore();
  };

  it('does not reap a healthy turn when the machine wakes from a 15-min sleep', async () => {
    let chunk!: (r: IteratorResult<string>) => void;
    const race = raceNextChunkWithStallWatchdog<string>({
      nextPromise: new Promise<IteratorResult<string>>(resolve => { chunk = resolve; }),
      interruptPromise: forever<'interrupted'>(),
      watchdogActive: true,
      stallMs: DEFAULT_STREAM_STALL_MS,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await sleep(15 * 60_000);
    await vi.advanceTimersByTimeAsync(2_000);
    chunk({ value: 'after-wake', done: false });
    const outcome = await race;
    expect(outcome.kind).toBe('chunk');
  });

  it('still reports stalled after the window of real awake silence', async () => {
    let settled = false;
    const race = raceNextChunkWithStallWatchdog<string>({
      nextPromise: forever<IteratorResult<string>>(),
      interruptPromise: forever<'interrupted'>(),
      watchdogActive: true,
      stallMs: DEFAULT_STREAM_STALL_MS,
    }).finally(() => { settled = true; });
    await sleep(15 * 60_000);
    await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_STALL_MS - 15_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await race).kind).toBe('stalled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a backward wall-clock jump does not extend the stall window', async () => {
    let settled = false;
    const race = raceNextChunkWithStallWatchdog<string>({
      nextPromise: forever<IteratorResult<string>>(),
      interruptPromise: forever<'interrupted'>(),
      watchdogActive: true,
      stallMs: DEFAULT_STREAM_STALL_MS,
    }).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_STALL_MS / 2);
    vi.setSystemTime(Date.now() - 60 * 60_000);
    await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_STALL_MS / 2 + 15_000);
    expect(settled).toBe(true);
    expect((await race).kind).toBe('stalled');
  });
});

describe('shouldArmStreamStallWatchdog', () => {
  it('arms only when the model is expected to be producing output', () => {
    expect(shouldArmStreamStallWatchdog({
      resultReceivedTime: null,
      outstandingToolCalls: 0,
      hasRunningTasks: false,
      hasPendingUserInteraction: false,
    })).toBe(true);
  });

  it('stays disarmed after result, during tools, subagent drains, and user prompts', () => {
    const base = {
      resultReceivedTime: null,
      outstandingToolCalls: 0,
      hasRunningTasks: false,
      hasPendingUserInteraction: false,
    };

    expect(shouldArmStreamStallWatchdog({
      ...base,
      resultReceivedTime: Date.now(),
    })).toBe(false);
    expect(shouldArmStreamStallWatchdog({
      ...base,
      outstandingToolCalls: 1,
    })).toBe(false);
    expect(shouldArmStreamStallWatchdog({
      ...base,
      hasRunningTasks: true,
    })).toBe(false);
    expect(shouldArmStreamStallWatchdog({
      ...base,
      hasPendingUserInteraction: true,
    })).toBe(false);
  });
});
