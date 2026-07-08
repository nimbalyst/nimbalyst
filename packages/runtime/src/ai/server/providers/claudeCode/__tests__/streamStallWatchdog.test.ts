import { describe, it, expect } from 'vitest';
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

describe('raceNextChunkWithStallWatchdog', () => {
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
