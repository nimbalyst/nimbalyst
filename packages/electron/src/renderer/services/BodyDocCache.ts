/**
 * BodyDocCache
 *
 * Per-window singleton that owns the lifecycle of tracker-body
 * `DocumentSyncProvider` instances. Phase 4a of the rewrite spec'd in
 * `design/Collaboration/tracker-sync-redesign.md` (section D5).
 *
 * Purpose
 * -------
 * Without this cache, every tracker-detail open mints a fresh
 * `DocumentSyncProvider`, opens a fresh WebSocket to the DocumentRoom DO,
 * and waits for the server's initial sync. Close → reopen repeats the
 * cost. Kanban hover / quick-glance flows would be impossibly slow.
 *
 * The cache:
 *   - Shares a single `DocumentSyncProvider` across all detail panels for
 *     the same itemId within the window (refcounted).
 *   - Keeps the provider warm for an idle timeout (default 5 min) after
 *     the last consumer releases, so close→reopen hits a warm socket.
 *   - Caps total warm entries with LRU eviction (default 100 per window).
 *   - Exposes `prewarm(itemIds, factory)` so the kanban / list view can
 *     opportunistically warm visible rows; throttled to N concurrent
 *     constructions.
 *
 * What it does NOT do (4b territory)
 * ----------------------------------
 *   - Cold-instant boot from `tracker_body_cache` (phase 4b).
 *   - `bodyVersion` semantics; the wire bumps it but nothing reads it
 *     today (phase 4b).
 *
 * Lifecycle invariants
 * --------------------
 *   - One entry per itemId. Two `acquire(itemId)` calls return the same
 *     `DocumentSyncProvider` and share its Y.Doc / WebSocket.
 *   - On `acquire()`: refCount++, idle timer cleared, LRU bumped to MRU.
 *   - On `release()`: refCount--; when refCount==0 a 5-min idle timer
 *     starts. Re-acquire within the window cancels the timer.
 *   - On idle expiry: provider destroyed, entry evicted.
 *   - On LRU eviction (warm count > cap): the LRU entry whose refCount
 *     is 0 is destroyed. Entries with refCount > 0 are never evicted;
 *     they pin the cache. (If the cap is hit with all entries pinned the
 *     cap is exceeded -- the cap is a soft target.)
 *   - On `dispose()`: every entry destroyed, every timer cleared.
 *
 * Provider sharing model
 * ----------------------
 * A `DocumentSyncProvider` owns its Y.Doc and emits onStatusChange /
 * onRemoteUpdate / onReviewStateChange callbacks set at construction
 * time. The cache wires its own callbacks at construction and fans out
 * to a per-entry event bus; consumers subscribe to the bus via
 * `entry.on(...)`. This lets the cache support N simultaneous consumers
 * of the same provider.
 *
 * Each consumer creates its own `CollabLexicalProvider` wrapping the
 * shared Y.Doc -- `CollabLexicalProvider` is a thin Lexical adapter and
 * NOT shareable across mounts. Callers do not need to think about this:
 * they get a `Provider` from `entry.makeCollabProvider()` per acquire,
 * destroy it on release.
 */

import { DocumentSyncProvider } from '@nimbalyst/runtime/sync';
import { CollabLexicalProvider } from '@nimbalyst/runtime/collab-lexical';
import type {
  DocumentSyncConfig,
  DocumentSyncStatus,
  ReviewGateState,
} from '@nimbalyst/runtime/sync';

// ============================================================================
// Tunables
// ============================================================================

const DEFAULT_LRU_CAP = 100;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PREWARM_CONCURRENCY = 5;

// ============================================================================
// Types
// ============================================================================

/**
 * Caller-supplied factory for `DocumentSyncConfig`. The cache invokes it
 * once per itemId on first acquire / prewarm. Construction is async
 * because the team-org / JWT resolution itself is async.
 *
 * The factory's `onStatusChange` / `onRemoteUpdate` / `onReviewStateChange`
 * callbacks are IGNORED -- the cache wires its own and dispatches to
 * subscribers via the entry's event bus. Callers should pass `undefined`
 * (or stub no-ops) for these fields.
 */
export type BodyDocConfigFactory = (itemId: string) => Promise<DocumentSyncConfig | null>;

export interface BodyDocEntryListener {
  onStatusChange?: (status: DocumentSyncStatus) => void;
  onRemoteUpdate?: (origin: string) => void;
  /**
   * Fires on every review-gate transition. `null` is delivered to new
   * subscribers when the gate hasn't fired yet for this entry, so a
   * late-mount detail panel can render a neutral initial state instead
   * of waiting on the first server update.
   */
  onReviewStateChange?: (state: ReviewGateState | null) => void;
}

export interface BodyDocAcquisition {
  /** The shared sync provider. Read-only -- do NOT call destroy(). */
  readonly syncProvider: DocumentSyncProvider;
  /**
   * Construct a fresh `CollabLexicalProvider` bound to this entry's
   * Y.Doc. Each Lexical mount needs its own wrapper; the underlying
   * `DocumentSyncProvider` is shared.
   */
  makeCollabProvider(options?: { deferInitialSync?: boolean }): CollabLexicalProvider;
  /**
   * Release this acquisition. Idempotent. After release the caller MUST
   * NOT call any methods on this acquisition or its providers.
   */
  release(): void;
}

export interface BodyDocCacheOptions {
  lruCap?: number;
  idleTimeoutMs?: number;
  prewarmConcurrency?: number;
}

// ============================================================================
// Internal entry shape
// ============================================================================

interface CacheEntry {
  itemId: string;
  syncProvider: DocumentSyncProvider;
  refCount: number;
  /** Last status delivered to subscribers; new subscribers get this synchronously. */
  lastStatus: DocumentSyncStatus;
  /** Last review-gate state; new subscribers get this synchronously. */
  lastReviewState: ReviewGateState | null;
  /** Listener fan-out for status / remote-update / review-state. */
  listeners: Set<BodyDocEntryListener>;
  /** Set to a timer when refCount hits 0; cleared on next acquire. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Bumped on every acquire/release; used for LRU ordering. */
  lastTouchedAt: number;
}

// ============================================================================
// BodyDocCache
// ============================================================================

export class BodyDocCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** In-flight creates, so two concurrent acquires of the same itemId share one provider. */
  private readonly pending = new Map<string, Promise<CacheEntry>>();

  private readonly lruCap: number;
  private readonly idleTimeoutMs: number;
  private readonly prewarmConcurrency: number;

  /** Active prewarm budget. */
  private prewarmInFlight = 0;
  private readonly prewarmQueue: Array<() => void> = [];

  constructor(options: BodyDocCacheOptions = {}) {
    this.lruCap = options.lruCap ?? DEFAULT_LRU_CAP;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.prewarmConcurrency = options.prewarmConcurrency ?? DEFAULT_PREWARM_CONCURRENCY;
  }

  /**
   * Acquire (or create) a warm `DocumentSyncProvider` for `itemId`.
   * Returns `null` when `factory(itemId)` resolves to `null` (no team /
   * not collab-eligible).
   */
  async acquire(
    itemId: string,
    factory: BodyDocConfigFactory,
    listener?: BodyDocEntryListener,
  ): Promise<BodyDocAcquisition | null> {
    const entry = await this.ensureEntry(itemId, factory);
    if (!entry) return null;

    entry.refCount += 1;
    entry.lastTouchedAt = Date.now();
    this.clearIdleTimer(entry);
    // Pinning is done; safe to evict other unpinned entries now.
    this.maybeEvictForCap();

    if (listener) {
      entry.listeners.add(listener);
      // Replay the latest known state so new subscribers don't miss an
      // already-delivered status / review notification.
      if (listener.onStatusChange) listener.onStatusChange(entry.lastStatus);
      if (listener.onReviewStateChange) listener.onReviewStateChange(entry.lastReviewState);
    }

    let released = false;
    return {
      syncProvider: entry.syncProvider,
      makeCollabProvider: (options) => new CollabLexicalProvider(entry.syncProvider, options),
      release: () => {
        if (released) return;
        released = true;
        if (listener) entry.listeners.delete(listener);
        this.releaseEntry(entry);
      },
    };
  }

  /**
   * Best-effort pre-warm of a set of items. Each itemId is ensured to
   * have a warm `DocumentSyncProvider`, throttled to
   * `prewarmConcurrency` concurrent constructions. Items already warm
   * are no-ops. Errors are swallowed (a single warm-up failure must not
   * stop the rest of the kanban from warming).
   *
   * No refcount is added; entries enter the idle-timeout grace period
   * immediately after construction. A detail-open within the grace
   * window hits the warm provider.
   */
  async prewarm(itemIds: string[], factory: BodyDocConfigFactory): Promise<void> {
    const seen = new Set<string>();
    const tasks: Array<Promise<void>> = [];
    for (const itemId of itemIds) {
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      // Skip if already cached -- no work to do, and don't bump LRU
      // (prewarm should not displace user-interacted items).
      if (this.entries.has(itemId)) continue;
      tasks.push(this.runPrewarm(itemId, factory));
    }
    await Promise.all(tasks);
  }

  /** Number of entries currently held (warm + pinned). For tests. */
  get size(): number {
    return this.entries.size;
  }

  /** Whether `itemId` has a warm entry. For tests / debug. */
  has(itemId: string): boolean {
    return this.entries.has(itemId);
  }

  /**
   * Tear down everything. Called when the window unloads. Safe to call
   * multiple times.
   */
  dispose(): void {
    for (const entry of this.entries.values()) {
      this.clearIdleTimer(entry);
      try { entry.syncProvider.destroy(); } catch { /* ignore */ }
    }
    this.entries.clear();
    this.pending.clear();
    this.prewarmQueue.length = 0;
    this.prewarmInFlight = 0;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async ensureEntry(
    itemId: string,
    factory: BodyDocConfigFactory,
  ): Promise<CacheEntry | null> {
    const existing = this.entries.get(itemId);
    if (existing) return existing;

    const inflight = this.pending.get(itemId);
    if (inflight) return inflight.catch(() => null);

    const promise = this.createEntry(itemId, factory).finally(() => {
      this.pending.delete(itemId);
    });
    this.pending.set(itemId, promise as unknown as Promise<CacheEntry>);
    try {
      return await promise;
    } catch (err) {
      console.error('[BodyDocCache] entry creation failed for', itemId, err);
      return null;
    }
  }

  private async createEntry(
    itemId: string,
    factory: BodyDocConfigFactory,
  ): Promise<CacheEntry> {
    const config = await factory(itemId);
    if (!config) {
      // Throw so the pending promise rejects; callers swallow via ensureEntry's catch.
      throw new Error(`BodyDocCache: factory returned null for ${itemId}`);
    }

    const entry: CacheEntry = {
      itemId,
      syncProvider: null as unknown as DocumentSyncProvider, // assigned below
      refCount: 0,
      lastStatus: 'disconnected',
      lastReviewState: null,
      listeners: new Set(),
      idleTimer: null,
      lastTouchedAt: Date.now(),
    };

    // Wire the cache's own callbacks; fan out to entry.listeners. The
    // factory's callbacks (if any) are intentionally ignored -- the
    // cache is the sole owner of the provider's lifecycle signals.
    const cacheConfig: DocumentSyncConfig = {
      ...config,
      onStatusChange: (status) => {
        entry.lastStatus = status;
        for (const l of entry.listeners) {
          try { l.onStatusChange?.(status); } catch (err) {
            console.warn('[BodyDocCache] status listener threw:', err);
          }
        }
      },
      onRemoteUpdate: (origin) => {
        for (const l of entry.listeners) {
          try { l.onRemoteUpdate?.(origin); } catch (err) {
            console.warn('[BodyDocCache] remoteUpdate listener threw:', err);
          }
        }
      },
      onReviewStateChange: (state) => {
        entry.lastReviewState = state;
        for (const l of entry.listeners) {
          try { l.onReviewStateChange?.(state); } catch (err) {
            console.warn('[BodyDocCache] reviewState listener threw:', err);
          }
        }
      },
    };

    entry.syncProvider = new DocumentSyncProvider(cacheConfig);
    this.entries.set(itemId, entry);
    // Do NOT evict here -- the caller (acquire/prewarm) has not had a
    // chance to bump refCount or otherwise mark the entry as "wanted".
    // Eviction at this point would happily destroy the entry we just
    // built. Caller invokes `maybeEvictForCap()` after marking the entry.
    return entry;
  }

  private releaseEntry(entry: CacheEntry): void {
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastTouchedAt = Date.now();
    if (entry.refCount === 0) {
      // Start the idle timer. On expiry the entry is destroyed.
      this.clearIdleTimer(entry);
      entry.idleTimer = setTimeout(() => {
        // Guard: a late acquire may have raced the timer.
        if (entry.refCount === 0) {
          this.destroyEntry(entry);
        }
      }, this.idleTimeoutMs);
    }
  }

  private clearIdleTimer(entry: CacheEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private destroyEntry(entry: CacheEntry): void {
    this.clearIdleTimer(entry);
    try { entry.syncProvider.destroy(); } catch (err) {
      console.warn('[BodyDocCache] destroy threw for', entry.itemId, err);
    }
    this.entries.delete(entry.itemId);
  }

  /**
   * Soft LRU enforcement. Walks entries oldest-first and destroys the
   * first whose refCount is 0. Repeats until under cap or no evictable
   * entries remain. Entries with refCount > 0 are pinned and never
   * evicted; the cap is a soft target.
   */
  private maybeEvictForCap(): void {
    while (this.entries.size > this.lruCap) {
      let oldest: CacheEntry | null = null;
      for (const entry of this.entries.values()) {
        if (entry.refCount > 0) continue;
        if (!oldest || entry.lastTouchedAt < oldest.lastTouchedAt) {
          oldest = entry;
        }
      }
      if (!oldest) return; // every entry pinned; soft cap exceeded
      this.destroyEntry(oldest);
    }
  }

  private async runPrewarm(itemId: string, factory: BodyDocConfigFactory): Promise<void> {
    await this.acquirePrewarmSlot();
    try {
      // Re-check after slot acquired -- a concurrent acquire may have
      // already populated the entry while we were waiting.
      if (this.entries.has(itemId)) return;
      const entry = await this.ensureEntry(itemId, factory);
      if (entry) {
        // No refCount bump for prewarm: the entry enters idle-timeout
        // immediately, but the construction itself opened the WebSocket
        // and the Y.Doc is now warm.
        entry.lastTouchedAt = Date.now();
        this.maybeEvictForCap();
        // Start the idle timer right away so prewarm-only entries don't
        // pin the cache indefinitely.
        if (entry.refCount === 0 && entry.idleTimer === null) {
          entry.idleTimer = setTimeout(() => {
            if (entry.refCount === 0) this.destroyEntry(entry);
          }, this.idleTimeoutMs);
        }
      }
    } catch (err) {
      // Single-item warm-up failure must not block the queue.
      console.debug('[BodyDocCache] prewarm failed for', itemId, err);
    } finally {
      this.releasePrewarmSlot();
    }
  }

  private acquirePrewarmSlot(): Promise<void> {
    if (this.prewarmInFlight < this.prewarmConcurrency) {
      this.prewarmInFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.prewarmQueue.push(() => {
        this.prewarmInFlight += 1;
        resolve();
      });
    });
  }

  private releasePrewarmSlot(): void {
    this.prewarmInFlight = Math.max(0, this.prewarmInFlight - 1);
    const next = this.prewarmQueue.shift();
    if (next) next();
  }
}

// ============================================================================
// Per-window singleton
// ============================================================================

let _cache: BodyDocCache | null = null;

/**
 * Singleton accessor. Constructs the cache lazily on first call.
 * Renderer windows share this instance; the renderer is per-window, so
 * the singleton is naturally per-window.
 */
export function getBodyDocCache(): BodyDocCache {
  if (!_cache) {
    _cache = new BodyDocCache();
  }
  return _cache;
}

/**
 * Test-only reset. NOT exported through the package barrel.
 */
export function _resetBodyDocCacheForTests(options?: BodyDocCacheOptions): BodyDocCache {
  if (_cache) {
    _cache.dispose();
  }
  _cache = new BodyDocCache(options);
  return _cache;
}
