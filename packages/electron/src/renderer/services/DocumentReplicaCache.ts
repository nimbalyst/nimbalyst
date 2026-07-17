import type {
  DocumentSyncProvider,
  DocumentSyncStatus,
  LocalReplicaIdentity,
  LocalDocumentReplica,
  LocalDocumentReplicaOutboxState,
  LocalDocumentReplicaState,
} from '@nimbalyst/runtime/sync';

const DEFAULT_LRU_CAP = 40;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export interface DocumentReplicaCacheEvents {
  onReplicaStateChange(state: LocalDocumentReplicaState): void;
  onOutboxStateChange(state: LocalDocumentReplicaOutboxState): void;
  onTransportStateChange(state: DocumentSyncStatus): void;
  onRemoteUpdate(origin: unknown): void;
}

export interface DocumentReplicaCacheListener {
  onReplicaStateChange?(state: LocalDocumentReplicaState): void;
  onOutboxStateChange?(state: LocalDocumentReplicaOutboxState): void;
  onTransportStateChange?(state: DocumentSyncStatus): void;
  onRemoteUpdate?(origin: unknown): void;
}

export interface DocumentReplicaCacheResources {
  replica: LocalDocumentReplica;
  syncProvider: DocumentSyncProvider;
  detachProvider(): Promise<void>;
}

export type DocumentReplicaCacheFactory = (
  events: DocumentReplicaCacheEvents,
) => Promise<DocumentReplicaCacheResources>;

export interface DocumentReplicaAcquisition {
  readonly replica: LocalDocumentReplica;
  readonly syncProvider: DocumentSyncProvider;
  release(): void;
  /** Retire this key version without allowing the old provider to linger. */
  supersede(): Promise<void>;
  discardLocalCopy(): Promise<void>;
}

export interface DocumentReplicaCacheOptions {
  lruCap?: number;
  idleTimeoutMs?: number;
}

interface CacheEntry {
  key: string;
  resources: DocumentReplicaCacheResources;
  refCount: number;
  listeners: Set<DocumentReplicaCacheListener>;
  lastReplicaState: LocalDocumentReplicaState;
  lastOutboxState: LocalDocumentReplicaOutboxState;
  lastTransportState: DocumentSyncStatus;
  lastTouchedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  destroying: boolean;
  destroyPromise: Promise<boolean> | null;
  superseded: boolean;
  discardOnRelease: boolean;
}

export function buildDocumentReplicaCacheKey(
  identity: LocalReplicaIdentity,
  keyCustody: string | undefined,
  orgKeyFingerprint: string | undefined,
): string {
  const normalizedKeyCustody = keyCustody ?? 'legacy-e2e';
  const keyVersion = normalizedKeyCustody === 'server-managed'
    ? 'server-managed'
    : orgKeyFingerprint ?? 'missing-fingerprint';
  return [
    identity.accountId,
    identity.orgId,
    identity.documentId,
    normalizedKeyCustody,
    keyVersion,
  ].join('\u0000');
}

/**
 * Per-window owner for warm LocalDocumentReplica + DocumentSyncProvider pairs.
 * Durable storage remains the correctness boundary; this cache only avoids
 * repeated hydration and transport setup on close/reopen.
 */
export class DocumentReplicaCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<CacheEntry>>();
  private readonly lruCap: number;
  private readonly idleTimeoutMs: number;

  constructor(options: DocumentReplicaCacheOptions = {}) {
    this.lruCap = options.lruCap ?? DEFAULT_LRU_CAP;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  async acquire(
    key: string,
    factory: DocumentReplicaCacheFactory,
    listener?: DocumentReplicaCacheListener,
  ): Promise<DocumentReplicaAcquisition> {
    const entry = await this.ensureEntry(key, factory);
    entry.refCount += 1;
    entry.lastTouchedAt = Date.now();
    this.clearIdleTimer(entry);
    if (listener) {
      entry.listeners.add(listener);
      listener.onReplicaStateChange?.(entry.lastReplicaState);
      listener.onOutboxStateChange?.(entry.lastOutboxState);
      listener.onTransportStateChange?.(entry.lastTransportState);
    }
    await this.evictForCap();

    let released = false;
    return {
      replica: entry.resources.replica,
      syncProvider: entry.resources.syncProvider,
      release: () => {
        if (released) return;
        released = true;
        if (listener) entry.listeners.delete(listener);
        this.releaseEntry(entry);
      },
      supersede: async () => {
        if (released) return;
        released = true;
        entry.superseded = true;
        if (listener) entry.listeners.delete(listener);
        this.releaseEntry(entry);
        if (entry.refCount === 0) await this.destroyEntry(entry, true);
      },
      discardLocalCopy: async () => {
        if (released) throw new Error('Cannot discard a released replica acquisition');
        await entry.resources.replica.discardLocalCopy();
        entry.discardOnRelease = true;
      },
    };
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries.values()];
    await Promise.all(entries.map((entry) => this.destroyEntry(entry, true)));
    this.pending.clear();
  }

  private async ensureEntry(
    key: string,
    factory: DocumentReplicaCacheFactory,
  ): Promise<CacheEntry> {
    const existing = this.entries.get(key);
    if (existing) {
      if (!existing.destroyPromise && !existing.superseded) return existing;
      if (existing.destroyPromise) await existing.destroyPromise;
      if (this.entries.get(key) === existing) this.entries.delete(key);
    }
    const pending = this.pending.get(key);
    if (pending) return pending;

    const promise = this.createEntry(key, factory).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  private async createEntry(
    key: string,
    factory: DocumentReplicaCacheFactory,
  ): Promise<CacheEntry> {
    let entry: CacheEntry | null = null;
    let lastReplicaState: LocalDocumentReplicaState = 'loading';
    let lastOutboxState: LocalDocumentReplicaOutboxState = 'clean';
    let lastTransportState: DocumentSyncStatus = 'disconnected';

    const fanOut = <K extends keyof DocumentReplicaCacheListener>(
      callback: K,
      value: Parameters<NonNullable<DocumentReplicaCacheListener[K]>>[0],
    ) => {
      if (!entry) return;
      for (const listener of entry.listeners) {
        try {
          const fn = listener[callback] as ((next: typeof value) => void) | undefined;
          fn?.(value);
        } catch (error) {
          console.warn(`[DocumentReplicaCache] ${String(callback)} listener failed:`, error);
        }
      }
    };

    const resources = await factory({
      onReplicaStateChange: (state) => {
        lastReplicaState = state;
        if (entry) entry.lastReplicaState = state;
        fanOut('onReplicaStateChange', state);
      },
      onOutboxStateChange: (state) => {
        lastOutboxState = state;
        if (entry) entry.lastOutboxState = state;
        fanOut('onOutboxStateChange', state);
      },
      onTransportStateChange: (state) => {
        lastTransportState = state;
        if (entry) entry.lastTransportState = state;
        fanOut('onTransportStateChange', state);
      },
      onRemoteUpdate: (origin) => fanOut('onRemoteUpdate', origin),
    });

    entry = {
      key,
      resources,
      refCount: 0,
      listeners: new Set(),
      lastReplicaState: resources.replica.getState() ?? lastReplicaState,
      lastOutboxState: resources.replica.getOutboxState() ?? lastOutboxState,
      lastTransportState: resources.syncProvider.getStatus() ?? lastTransportState,
      lastTouchedAt: Date.now(),
      idleTimer: null,
      destroying: false,
      destroyPromise: null,
      superseded: false,
      discardOnRelease: false,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private releaseEntry(entry: CacheEntry): void {
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastTouchedAt = Date.now();
    if (entry.refCount !== 0) return;
    if (entry.superseded) {
      void this.destroyEntry(entry, true);
      return;
    }
    if (entry.discardOnRelease) {
      void this.destroyEntry(entry, true);
      return;
    }
    this.scheduleIdleEviction(entry);
  }

  private scheduleIdleEviction(entry: CacheEntry): void {
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      void this.destroyEntry(entry, false).then((destroyed) => {
        if (
          !destroyed &&
          entry.refCount === 0 &&
          this.entries.get(entry.key) === entry
        ) {
          this.scheduleIdleEviction(entry);
        }
      });
    }, this.idleTimeoutMs);
  }

  private async evictForCap(): Promise<void> {
    while (this.entries.size > this.lruCap) {
      const candidates = [...this.entries.values()]
        .filter((entry) => this.isEvictable(entry))
        .sort((left, right) => left.lastTouchedAt - right.lastTouchedAt);
      const oldest = candidates[0];
      if (!oldest) return;
      await this.destroyEntry(oldest, false);
    }
  }

  private isEvictable(entry: CacheEntry): boolean {
    return (
      entry.refCount === 0 &&
      !entry.destroying &&
      entry.resources.replica.getOutboxState() === 'clean'
    );
  }

  private async destroyEntry(entry: CacheEntry, force: boolean): Promise<boolean> {
    if (entry.destroyPromise) return entry.destroyPromise;
    if (!force && !this.isEvictable(entry)) return false;
    entry.destroying = true;
    this.clearIdleTimer(entry);
    entry.destroyPromise = (async () => {
      let failure: unknown = null;
      const attempt = async (operation: () => void | Promise<void>) => {
        try {
          await operation();
        } catch (error) {
          failure ??= error;
        }
      };

      await attempt(() => entry.resources.replica.flush());
      await attempt(() => entry.resources.syncProvider.destroy());
      await attempt(() => entry.resources.replica.destroy());
      await attempt(() => entry.resources.detachProvider());
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);

      if (failure) {
        console.warn('[DocumentReplicaCache] Eviction cleanup failed; entry was retired:', failure);
        return false;
      }
      return true;
    })();
    return entry.destroyPromise;
  }

  private clearIdleTimer(entry: CacheEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }
}

let documentReplicaCache: DocumentReplicaCache | null = null;

export function getDocumentReplicaCache(): DocumentReplicaCache {
  documentReplicaCache ??= new DocumentReplicaCache();
  return documentReplicaCache;
}

export async function resetDocumentReplicaCacheForTests(
  options?: DocumentReplicaCacheOptions,
): Promise<DocumentReplicaCache> {
  await documentReplicaCache?.dispose();
  documentReplicaCache = new DocumentReplicaCache(options);
  return documentReplicaCache;
}
