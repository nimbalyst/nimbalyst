import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentSyncProvider,
  LocalDocumentReplica,
  LocalDocumentReplicaOutboxState,
} from '@nimbalyst/runtime/sync';
import {
  buildDocumentReplicaCacheKey,
  DocumentReplicaCache,
  type DocumentReplicaCacheFactory,
} from '../DocumentReplicaCache';

function makeFactory(initialOutbox: LocalDocumentReplicaOutboxState = 'clean') {
  const calls = {
    created: 0,
    flushed: 0,
    replicaDestroyed: 0,
    providerDestroyed: 0,
    detached: 0,
    outbox: initialOutbox,
  };
  const factory: DocumentReplicaCacheFactory = async () => {
    calls.created += 1;
    const replica = {
      getState: () => 'ready',
      getOutboxState: () => calls.outbox,
      flush: async () => { calls.flushed += 1; },
      destroy: async () => { calls.replicaDestroyed += 1; },
      discardLocalCopy: async () => { calls.outbox = 'clean'; },
    } as unknown as LocalDocumentReplica;
    const syncProvider = {
      getStatus: () => 'disconnected',
      destroy: () => { calls.providerDestroyed += 1; },
    } as unknown as DocumentSyncProvider;
    return {
      replica,
      syncProvider,
      detachProvider: async () => { calls.detached += 1; },
    };
  };
  return { calls, factory };
}

describe('DocumentReplicaCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses one refcounted replica/provider and evicts only after the last release', async () => {
    vi.useFakeTimers();
    const cache = new DocumentReplicaCache({ idleTimeoutMs: 100 });
    const { calls, factory } = makeFactory();
    const first = await cache.acquire('doc-a', factory);
    const second = await cache.acquire('doc-a', factory);
    expect(first.replica).toBe(second.replica);
    expect(first.syncProvider).toBe(second.syncProvider);
    expect(calls.created).toBe(1);

    first.release();
    await vi.advanceTimersByTimeAsync(200);
    expect(cache.has('doc-a')).toBe(true);
    second.release();
    await vi.advanceTimersByTimeAsync(100);

    expect(cache.has('doc-a')).toBe(false);
    expect(calls).toMatchObject({
      flushed: 1,
      replicaDestroyed: 1,
      providerDestroyed: 1,
      detached: 1,
    });
  });

  it.each(['pending', 'rejected'] as const)(
    'pins an idle %s outbox across TTL eviction until it becomes clean',
    async (outbox) => {
      vi.useFakeTimers();
      const cache = new DocumentReplicaCache({ idleTimeoutMs: 50 });
      const { calls, factory } = makeFactory(outbox);
      const acquisition = await cache.acquire('doc-pinned', factory);
      acquisition.release();
      await vi.advanceTimersByTimeAsync(150);
      expect(cache.has('doc-pinned')).toBe(true);
      expect(calls.flushed).toBe(0);

      calls.outbox = 'clean';
      await vi.advanceTimersByTimeAsync(50);
      expect(cache.has('doc-pinned')).toBe(false);
      expect(calls.flushed).toBe(1);
    },
  );

  it('does not LRU-evict attached editors or idle replicas with rejected edits', async () => {
    const cache = new DocumentReplicaCache({ lruCap: 1, idleTimeoutMs: 60_000 });
    const rejected = makeFactory('rejected');
    const clean = makeFactory('clean');
    const pinned = await cache.acquire('doc-rejected', rejected.factory);
    pinned.release();
    const attached = await cache.acquire('doc-attached', clean.factory);

    expect(cache.has('doc-rejected')).toBe(true);
    expect(cache.has('doc-attached')).toBe(true);
    expect(rejected.calls.providerDestroyed).toBe(0);
    expect(clean.calls.providerDestroyed).toBe(0);

    attached.release();
    await cache.dispose();
  });

  it('waits for an in-flight TTL destroy and returns fresh working resources', async () => {
    vi.useFakeTimers();
    const cache = new DocumentReplicaCache({ idleTimeoutMs: 25 });
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const replicas: LocalDocumentReplica[] = [];
    const factory: DocumentReplicaCacheFactory = async () => {
      const generation = replicas.length + 1;
      const replica = {
        generation,
        getState: () => 'ready',
        getOutboxState: () => 'clean',
        flush: async () => {
          if (generation === 1) await flushGate;
        },
        destroy: async () => {},
      } as unknown as LocalDocumentReplica;
      replicas.push(replica);
      return {
        replica,
        syncProvider: {
          getStatus: () => 'disconnected',
          destroy: () => {},
        } as unknown as DocumentSyncProvider,
        detachProvider: async () => {},
      };
    };

    const first = await cache.acquire('doc-destroy-race', factory);
    first.release();
    await vi.advanceTimersByTimeAsync(25);

    const reopenedPromise = cache.acquire('doc-destroy-race', factory);
    await Promise.resolve();
    expect(replicas).toHaveLength(1);

    releaseFlush();
    const reopened = await reopenedPromise;
    expect(replicas).toHaveLength(2);
    expect(reopened.replica).not.toBe(first.replica);
    expect((reopened.replica as unknown as { generation: number }).generation).toBe(2);
    reopened.release();
    await cache.dispose();
  });

  it('removes a failed destroy instead of resurrecting half-destroyed resources', async () => {
    vi.useFakeTimers();
    const cache = new DocumentReplicaCache({ idleTimeoutMs: 25 });
    let generation = 0;
    const factory: DocumentReplicaCacheFactory = async () => {
      generation += 1;
      const currentGeneration = generation;
      return {
        replica: {
          generation: currentGeneration,
          getState: () => 'ready',
          getOutboxState: () => 'clean',
          flush: async () => {
            if (currentGeneration === 1) throw new Error('flush failed');
          },
          destroy: async () => {},
        } as unknown as LocalDocumentReplica,
        syncProvider: {
          getStatus: () => 'disconnected',
          destroy: () => {},
        } as unknown as DocumentSyncProvider,
        detachProvider: async () => {},
      };
    };

    const first = await cache.acquire('doc-failed-destroy', factory);
    first.release();
    await vi.advanceTimersByTimeAsync(25);
    expect(cache.has('doc-failed-destroy')).toBe(false);

    const reopened = await cache.acquire('doc-failed-destroy', factory);
    expect(reopened.replica).not.toBe(first.replica);
    expect((reopened.replica as unknown as { generation: number }).generation).toBe(2);
    reopened.release();
    await cache.dispose();
  });

  it('keys rotated replicas by actual key fingerprint and supersedes the old provider', async () => {
    const cache = new DocumentReplicaCache({ idleTimeoutMs: 60_000 });
    const oldResources = makeFactory();
    const newResources = makeFactory();
    const identity = { accountId: 'account', orgId: 'org', documentId: 'doc' };
    const oldKey = buildDocumentReplicaCacheKey(identity, 'legacy-e2ee', 'fingerprint-v1');
    const newKey = buildDocumentReplicaCacheKey(identity, 'legacy-e2ee', 'fingerprint-v2');
    expect(newKey).not.toBe(oldKey);

    const oldAcquisition = await cache.acquire(oldKey, oldResources.factory);
    await oldAcquisition.supersede();
    const newAcquisition = await cache.acquire(newKey, newResources.factory);

    expect(newAcquisition.replica).not.toBe(oldAcquisition.replica);
    expect(oldResources.calls).toMatchObject({
      flushed: 1,
      providerDestroyed: 1,
      replicaDestroyed: 1,
      detached: 1,
    });
    expect(newResources.calls.providerDestroyed).toBe(0);
    newAcquisition.release();
    await cache.dispose();
  });
});
