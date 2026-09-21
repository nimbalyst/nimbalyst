// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetPushOutcomeWarnings, warnIfUnpublished } from '../pushOutcome';

const log = vi.fn();
afterEach(() => { resetPushOutcomeWarnings(); vi.useRealTimers(); vi.restoreAllMocks(); });
beforeEach(() => {
  resetPushOutcomeWarnings();
  log.mockClear();
});

it('skips deliberate omissions and legacy void outcomes without suppressing an actionable failure', () => {
  warnIfUnpublished(log, 's1', 'Publish', undefined);
  warnIfUnpublished(log, 's1', 'Publish', { published: false, retryable: false, reason: 'disabled' });
  expect(log).not.toHaveBeenCalled();
  warnIfUnpublished(log, 's1', 'Publish', { published: false, reason: 'disabled' });
  expect(log).toHaveBeenCalledWith('Publish for session s1: disabled');
});

it('preserves publisher and session attribution while throttling repeated failures', () => {
  const otherLog = vi.fn();
  const failure = { published: false, retryable: true, reason: 'gate closed' };
  warnIfUnpublished(log, 's1', 'Message', failure);
  warnIfUnpublished(otherLog, 's2', 'Metadata', failure);
  warnIfUnpublished(otherLog, 's3', 'Metadata', failure);
  warnIfUnpublished(otherLog, 's2', 'Metadata', failure);
  warnIfUnpublished(log, 's1', 'Message', { published: false, reason: 'socket closed' });
  expect(log).toHaveBeenCalledTimes(2);
  expect(otherLog).toHaveBeenCalledTimes(2);
  expect(otherLog).toHaveBeenCalledWith('Metadata for session s3: gate closed');
  warnIfUnpublished(log, 's1', 'Message', { published: true });
  warnIfUnpublished(otherLog, 's2', 'Metadata', failure);
  expect(otherLog).toHaveBeenCalledTimes(2);
  expect(otherLog).toHaveBeenCalledWith('Metadata for session s2: gate closed');
});

it('does not let message successes reset metadata failures, but reports again after the interval', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const failure = { published: false, reason: 'index disconnected' };
    warnIfUnpublished(log, 's1', 'Metadata', failure);
    for (let i = 0; i < 10; i++) {
      warnIfUnpublished(log, 's1', 'Message', { published: true });
      warnIfUnpublished(log, 's1', 'Metadata', failure);
    }
    expect(log).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(61000);
    warnIfUnpublished(log, 's1', 'Metadata', failure);
    expect(log).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});

it('uses a deduplicated fallback when the provider supplies no reason', () => {
  warnIfUnpublished(log, 's1', 'Publish', { published: false });
  warnIfUnpublished(log, 's1', 'Publish', { published: false });
  expect(log).toHaveBeenCalledExactlyOnceWith('Publish for session s1: not published');
});

it('preserves live keys at capacity, aggregates overflow, and sweeps expired keys', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const failure = { published: false, reason: 'offline' };
  for (let i = 0; i < 256; i++) warnIfUnpublished(log, `s${i}`, 'Publish', failure);
  for (let i = 0; i < 500; i++) warnIfUnpublished(log, `overflow${i}`, 'Publish', failure);
  warnIfUnpublished(log, 's0', 'Publish', failure);
  expect(log).toHaveBeenCalledTimes(256);
  await vi.advanceTimersByTimeAsync(60000);
  expect(log).toHaveBeenLastCalledWith('[sync] suppressed 500 further publish failures');
  expect(log).toHaveBeenCalledTimes(257);
  warnIfUnpublished(log, 'fresh', 'Publish', failure);
  expect(log).toHaveBeenLastCalledWith('Publish for session fresh: offline');
});

it('expires a warning when the wall clock moves backward', () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(100000);
  warnIfUnpublished(log, 's1', 'Publish', { published: false });
  now.mockReturnValue(1);
  warnIfUnpublished(log, 's1', 'Publish', { published: false });
  expect(log).toHaveBeenCalledTimes(2);
});
