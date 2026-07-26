/**
 * Volume guard for product analytics emitted from high-frequency seams.
 *
 * Several authoritative seams in this app are reached by debounced autosave
 * rather than by a discrete user action -- a tracker field save fires every
 * 500ms of typing pause, an outbox cycle completes every time a local edit
 * drains, and a flapping WebSocket can restart a connection attempt in a tight
 * loop. Emitting one PostHog event per occurrence would make the "meaningful
 * mutation" events that anchor activation and retention unusable (and the bill
 * unpleasant), so those seams throttle through this helper.
 *
 * The keys passed in are LOCAL ONLY -- item ids, workspace paths, document ids.
 * They are used to decide whether to emit; they are never part of the payload.
 */
export class AnalyticsEmissionThrottle {
  private readonly lastEmittedAt = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly maxTrackedKeys = 500,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * True when `key` has not emitted within the configured window. Recording the
   * emission is part of the check, so callers must only call this when they are
   * about to emit.
   */
  shouldEmit(key: string): boolean {
    const at = this.now();
    const previous = this.lastEmittedAt.get(key);
    if (previous !== undefined && at - previous < this.windowMs) return false;
    // Map preserves insertion order, so deleting first keeps the re-inserted
    // key at the end and makes the eviction below least-recently-emitted.
    this.lastEmittedAt.delete(key);
    this.lastEmittedAt.set(key, at);
    if (this.lastEmittedAt.size > this.maxTrackedKeys) {
      const oldest = this.lastEmittedAt.keys().next();
      if (!oldest.done) this.lastEmittedAt.delete(oldest.value);
    }
    return true;
  }

  /** Drop a key so the next occurrence emits immediately (e.g. on close). */
  forget(key: string): void {
    this.lastEmittedAt.delete(key);
  }

  reset(): void {
    this.lastEmittedAt.clear();
  }
}
