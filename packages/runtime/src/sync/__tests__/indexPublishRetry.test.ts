// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  INDEX_STATE_CHANGED_REASON,
  MAX_INDEX_PUBLISH_ATTEMPTS,
  publishWithBoundedRetry,
} from '../indexPublishRetry';

describe('publishWithBoundedRetry', () => {
  it('stops after the attempt cap and reports the give-up as non-retryable', async () => {
    const attempt = vi.fn(async () => ({
      published: false,
      reason: INDEX_STATE_CHANGED_REASON,
      retryable: true,
    }));
    const yieldBetweenAttempts = vi.fn(async () => {});

    const outcome = await publishWithBoundedRetry(attempt, {
      shouldRetry: () => true,
      yieldBetweenAttempts,
    });

    expect(attempt).toHaveBeenCalledTimes(MAX_INDEX_PUBLISH_ATTEMPTS);
    // One yield between each pair of attempts, never after the last.
    expect(yieldBetweenAttempts).toHaveBeenCalledTimes(MAX_INDEX_PUBLISH_ATTEMPTS - 1);
    expect(outcome.published).toBe(false);
    expect(outcome.retryable).toBe(false);
    expect(outcome.reason).toContain(INDEX_STATE_CHANGED_REASON);
  });

  /**
   * The fence must be re-read AFTER the yield, with the real timer. A reconnect
   * lands during the backoff, and an attempt that starts after it publishes
   * this obsolete intent onto the replacement socket -- the reviewer watched a
   * newer title get overwritten while the call still returned published: true.
   */
  it('abandons the publish when the connection moves during the yield', async () => {
    let connectionIntact = true;
    const attempt = vi.fn(async () => {
      // The reconnect fires while publishWithBoundedRetry is inside its yield.
      setTimeout(() => { connectionIntact = false; }, 0);
      return { published: false, reason: INDEX_STATE_CHANGED_REASON, retryable: true };
    });

    const outcome = await publishWithBoundedRetry(attempt, {
      shouldRetry: () => connectionIntact,
    });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(outcome.published).toBe(false);
    expect(outcome.retryable).toBe(false);
    expect(outcome.reason).toContain('connection');
  });

  it('returns the first settled outcome and stops when the connection moves on', async () => {
    const outcomes = [
      { published: false, reason: INDEX_STATE_CHANGED_REASON, retryable: true },
      { published: true, publishedSessionIds: [] } as unknown as { published: boolean },
    ];
    const attempt = vi.fn(async () => outcomes.shift()!);
    expect(await publishWithBoundedRetry(attempt, { shouldRetry: () => true, yieldBetweenAttempts: async () => {} }))
      .toEqual({ published: true, publishedSessionIds: [] });
    expect(attempt).toHaveBeenCalledTimes(2);

    const losing = vi.fn(async () => ({ published: false, reason: INDEX_STATE_CHANGED_REASON, retryable: true }));
    expect(await publishWithBoundedRetry(losing, { shouldRetry: () => false })).toEqual({
      published: false,
      reason: INDEX_STATE_CHANGED_REASON,
      retryable: true,
    });
    expect(losing).toHaveBeenCalledTimes(1);
  });
});
