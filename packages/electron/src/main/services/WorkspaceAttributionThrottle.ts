import { logger } from '../utils/logger';

/**
 * Maximum sustained rate of watcher-attribution events per workspace before
 * we assume a build / codegen / dependency-install is running and start
 * dropping events. PGLite is a single-writer; a Swift package build can dump
 * hundreds of `.d` files in under a second, which is enough to saturate the
 * worker and freeze the renderer. Token-bucket gating cuts the burst off at
 * a level a human + AI session can never realistically exceed.
 */
const BUCKET_CAPACITY = 20;
const REFILL_PER_SECOND = 20;

/**
 * After a workspace trips the throttle we suppress the cap-reached warning
 * for this long so the log isn't itself a flood.
 */
const WARN_COOLDOWN_MS = 5_000;

interface BucketState {
  tokens: number;
  lastRefillAt: number;
  /** Timestamp of the most recent throttle warning for this workspace. */
  lastWarnedAt: number;
  /** Events dropped since the last warning, for the next log line. */
  droppedSinceWarn: number;
}

class WorkspaceAttributionThrottleImpl {
  private readonly buckets = new Map<string, BucketState>();
  /**
   * Test/diagnostic seam: lets us swap in a fake clock without pulling a
   * full date library. Defaults to Date.now.
   */
  private nowFn: () => number = Date.now;

  /**
   * Attempt to consume one token for the given workspace. Returns true if
   * the caller should continue with the attribution write, false if the
   * workspace has exceeded its sustained burst budget and the event should
   * be dropped.
   */
  tryAcquire(workspacePath: string): boolean {
    const now = this.nowFn();
    const bucket = this.getOrCreateBucket(workspacePath, now);

    const elapsedMs = now - bucket.lastRefillAt;
    if (elapsedMs > 0) {
      const refill = (elapsedMs / 1000) * REFILL_PER_SECOND;
      bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + refill);
      bucket.lastRefillAt = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    bucket.droppedSinceWarn += 1;
    if (now - bucket.lastWarnedAt >= WARN_COOLDOWN_MS) {
      logger.main.warn('[WorkspaceAttributionThrottle] Burst rate exceeded; dropping attribution events:', {
        workspacePath,
        capacity: BUCKET_CAPACITY,
        refillPerSecond: REFILL_PER_SECOND,
        droppedInWindow: bucket.droppedSinceWarn,
      });
      bucket.lastWarnedAt = now;
      bucket.droppedSinceWarn = 0;
    }
    return false;
  }

  private getOrCreateBucket(workspacePath: string, now: number): BucketState {
    const existing = this.buckets.get(workspacePath);
    if (existing) return existing;
    const fresh: BucketState = {
      tokens: BUCKET_CAPACITY,
      lastRefillAt: now,
      lastWarnedAt: 0,
      droppedSinceWarn: 0,
    };
    this.buckets.set(workspacePath, fresh);
    return fresh;
  }

  /** Test seam: override the clock and reset all bucket state. */
  resetForTesting(nowFn?: () => number): void {
    this.buckets.clear();
    this.nowFn = nowFn ?? Date.now;
  }
}

export const workspaceAttributionThrottle = new WorkspaceAttributionThrottleImpl();
