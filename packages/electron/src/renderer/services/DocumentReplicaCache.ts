import {
  COLLAB_CONNECTION_DIAGNOSTICS_COMPILED,
  emitCollabConnectionEvent,
  getCollabConnectionInstanceId,
  setCollabConnectionDiagnosticContext,
} from '@nimbalyst/runtime/sync/collabConnectionDiagnostics';
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

export function buildDocumentReplicaCacheKey(identity: LocalReplicaIdentity): string {
  return [
    identity.accountId,
    identity.orgId,
    identity.documentId,
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
    const previousRefCount = entry.refCount;
    entry.refCount += 1;
    entry.lastTouchedAt = Date.now();
    if (COLLAB_CONNECTION_DIAGNOSTICS_COMPILED) {
      emitCollabConnectionEvent(entry.resources.syncProvider, 'DocumentReplicaCache', 'acquire', {
        fromRefCount: previousRefCount,
        refCount: entry.refCount,
      });
    }
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
        if (COLLAB_CONNECTION_DIAGNOSTICS_COMPILED) {
          emitCollabConnectionEvent(entry.resources.syncProvider, 'DocumentReplicaCache', 'supersede', {
            refCount: entry.refCount,
          });
        }
        if (listener) entry.listeners.delete(listener);
        this.releaseEntry(entry);
        if (entry.refCount === 0) await this.destroyEntry(entry, true, 'superseded');
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
    await Promise.all(entries.map((entry) => this.destroyEntry(entry, true, 'dispose')));
    this.pending.clear();
  }

  private async ensureEntry(
    key: string,
    factory: DocumentReplicaCacheFactory,
  ): Promise<CacheEntry> {
    const existing = this.entries.get(key);
    if (existing) {
      if (!existing.destroyPromise && !existing.superseded) {
        if (COLLAB_CONNECTION_DIAGNOSTICS_COMPILED) {
          emitCollabConnectionEvent(existing.resources.syncProvider, 'DocumentReplicaCache', 'warm-hit', {
            refCount: existing.refCount,
            idleTimerActive: existing.idleTimer !== null,
          });
        }
        return existing;
      }
      if (existing.destroyPromise) await existing.destroyPromise;
      if (this.entries.get(key) === existing) this.entries.delete(key);
    }
    const pending = this.pending.get(key);
    if (pending) {
      if (COLLAB_CONNECTION_DIAGNOSTICS_COMPILED) {
        emitCollabConnectionEvent(this, 'DocumentReplicaCache', 'pending-hit', {
          cache: 'document-replica',
          cacheKey: key,
          documentId: key.split('\u0000')[2],
        });
      }
      return pending;
    }

    if (COLLAB_CONNECTION_DIAGNOSTICS_COMPILED) {
      emitCollabConnectionEvent(this, 'DocumentReplicaCache', 'cold-construct-start', {
        cache: 'document-replica',
        cacheKey: key,
        documentId: key.split('\u0000')[2],
      });
    }

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

    if (COLLAB_CONNECTION_DIAGNOSTICS_COMPILED) {
      setCollabConnectionDiagnosticContext(resources.syncProvider, {
        cache: 'document-replica',
        cacheKey: key,
        documentId: key.split('\u0000')[2],
        shared: true,
      });
      emitCollabConnectionEvent(resources.syncProvider, 'DocumentReplicaCache', 'cold-construct', {
        refCount: 0,
        syncProviderId: getCollabConnectionInstanceId(
          resources.syncProvider,
          'DocumentSyncProvider',
        ),
      });
    }

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
    const previousRefCount = entry.refCount;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastTouchedAt = Date.now();
    if (COLLAB_CONNECTION_DIAGNOSTICS_COMPILED) {
      emitCollabConnectionEvent(entry.resources.syncProvider, 'DocumentReplicaCache', 'release', {
        fromRefCount: previousRefCount,
        refCount: entry.refCount,
      });
    }
    if (entry.refCount !== 0) return;
    if (entry.superseded) {
      void this.destroyEntry(entry, true, 'superseded');
      return;
    }
    if (entry.discardOnRelease) {
      void this.destroyEntry(entry, true, 'discard-local-copy');
      return;
    }
    this.scheduleIdleEviction(entry);
  }

  private scheduleIdleEviction(entry: CacheEntry): void {
    this.clearIdleTimer(entry);
    if (COLLAB_CONNECTION_DIAGNOSTICS_COMPILED) {
      emitCollabConnectionEvent(entry.resources.syncProvider, 'DocumentReplicaCache', 'idle-timer-start', {
        refCount: entry.refCount,
        timeoutMs: this.idleTimeoutMs,
      });
    }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (COLLAB_CONNECTION_DIAGNOSTICS_COMPILED) {
        emitCollabConnectionEvent(entry.resources.syncProvider, 'DocumentReplicaCache', 'idle-timer-expire', {
          refCount: entry.refCount,
        });
      }
      void this.destroyEntry(entry, false, 'idle-timeout').then((destroyed) => {
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
      if (COLLAB_CONNECTION_DIAGNOSTICS_COMPILED) {
        emitCollabConnectionEvent(oldest.resources.syncProvider, 'DocumentReplicaCache', 'lru-evict', {
          refCount: oldest.refCount,
          cacheSize: this.entries.size,
          lruCap: this.lruCap,
        });
      }
      await this.destroyEntry(oldest, false, 'lru-cap');
    }
  }

  private isEvictable(entry: CacheEntry): boolean {
    return (
      entry.refCount === 0 &&
      !entry.destroying &&
      entry.resources.replica.getOutboxState() === 'clean'
    );
  }

  private async destroyEntry(
    entry: CacheEntry,
    force: boolean,
    reason: string,
  ): Promise<boolean> {
    if (entry.destroyPromise) return entry.destroyPromise;
    if (!force && !this.isEvictable(entry)) return false;
    if (COLLAB_CONNECTION_DIAGNOSTICS_COMPILED) {
      emitCollabConnectionEvent(entry.resources.syncProvider, 'DocumentReplicaCache', 'destroy', {
        reason,
        refCount: entry.refCount,
        force,
      });
    }
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
      if (COLLAB_CONNECTION_DIAGNOSTICS_COMPILED) {
        emitCollabConnectionEvent(entry.resources.syncProvider, 'DocumentReplicaCache', 'idle-timer-cancel', {
          refCount: entry.refCount,
        });
      }
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
