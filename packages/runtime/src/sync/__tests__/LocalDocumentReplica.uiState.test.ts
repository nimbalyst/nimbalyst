import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { LocalDocumentReplica } from '../LocalDocumentReplica';
import type {
  LoadedLocalReplica,
  LocalReplicaOutboxEntry,
  LocalReplicaStore,
} from '../LocalReplicaStore';

const identity = {
  accountId: 'account-a',
  orgId: 'org-a',
  documentId: 'document-a',
};

function makeUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('body').insert(0, text);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function makeStore(
  loaded: LoadedLocalReplica | null,
  durableOutbox: LocalReplicaOutboxEntry[] = loaded?.outbox ?? [],
): LocalReplicaStore {
  return {
    load: vi.fn(async () => loaded),
    appendLocalUpdate: vi.fn(async () => {}),
    appendRemoteUpdates: vi.fn(async () => {}),
    setOutboxState: vi.fn(async () => {}),
    claimOutboxBatch: vi.fn(async () => true),
    loadOutbox: vi.fn(async () => durableOutbox),
    recordOutboxError: vi.fn(async () => {}),
    acknowledgeOutbox: vi.fn(async () => {}),
    replaceSnapshot: vi.fn(async () => true),
    markIncomplete: vi.fn(async () => {}),
    markComplete: vi.fn(async () => {}),
    quarantine: vi.fn(async () => {}),
    resetForCleanHydration: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    purgeByAccount: vi.fn(async () => {}),
    purgeByOrg: vi.fn(async () => {}),
    getStorageUsage: vi.fn(async () => ({ replicaCount: 0, encryptedBytes: 0, replicas: [] })),
    listPendingOutboxes: vi.fn(async () => []),
  };
}

describe('LocalDocumentReplica UI state', () => {
  it('coalesces realtime remote persistence into one durable batch', async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore(null);
      const replica = new LocalDocumentReplica({
        identity,
        documentType: 'markdown',
        store,
        compaction: { remotePersistenceWindowMs: 150 },
      });
      await replica.whenReady;
      const first = replica.applyRemoteUpdates([{
        update: makeUpdate('first'),
        source: 'remote',
        serverSequence: 1,
      }], 0, { coalescePersistence: true });
      const second = replica.applyRemoteUpdates([{
        update: makeUpdate('second'),
        source: 'remote',
        serverSequence: 2,
      }], 0, { coalescePersistence: true });

      expect(store.appendRemoteUpdates).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(150);
      await Promise.all([first, second]);
      expect(store.appendRemoteUpdates).toHaveBeenCalledOnce();
      expect(vi.mocked(store.appendRemoteUpdates).mock.calls[0][0].updates).toHaveLength(2);
      await replica.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains a broadcast that arrives while a coalesced transaction is in flight', async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore(null);
      let releaseFirst!: () => void;
      let firstStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      vi.mocked(store.appendRemoteUpdates)
        .mockImplementationOnce(async () => {
          firstStarted();
          await blocked;
        })
        .mockResolvedValue(undefined);
      const replica = new LocalDocumentReplica({
        identity,
        documentType: 'markdown',
        store,
        compaction: { remotePersistenceWindowMs: 150 },
      });
      await replica.whenReady;
      const first = replica.applyRemoteUpdates([{
        update: makeUpdate('first'),
        source: 'remote',
        serverSequence: 1,
      }], 0, { coalescePersistence: true });
      await vi.advanceTimersByTimeAsync(150);
      await started;

      const second = replica.applyRemoteUpdates([{
        update: makeUpdate('second'),
        source: 'remote',
        serverSequence: 2,
      }], 0, { coalescePersistence: true });
      releaseFirst();
      await Promise.all([first, second]);

      expect(store.appendRemoteUpdates).toHaveBeenCalledTimes(2);
      expect(vi.mocked(store.appendRemoteUpdates).mock.calls[1][0].updates).toHaveLength(1);
      await replica.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a durable sibling-window update once without creating another outbox row', async () => {
    const store = makeStore(null);
    let siblingListener: ((update: Uint8Array) => void) | null = null;
    store.subscribeToSiblingLocalUpdates = vi.fn((_identity, listener) => {
      siblingListener = listener;
      return () => {
        siblingListener = null;
      };
    });
    const replica = new LocalDocumentReplica({ identity, documentType: 'markdown', store });
    await replica.whenReady;
    const update = makeUpdate('offline sibling edit');

    siblingListener!(update);
    await replica.applyRemoteUpdates([{
      update,
      source: 'remote',
      serverSequence: 7,
    }], 0);

    expect(replica.getYDoc().getText('body').toString()).toBe('offline sibling edit');
    expect(store.appendLocalUpdate).not.toHaveBeenCalled();
    expect(store.appendRemoteUpdates).toHaveBeenCalledOnce();
    await replica.destroy();
    expect(siblingListener).toBeNull();
  });

  it('converges edits from two offline window replicas without a server', async () => {
    const store = makeStore(null);
    const siblingListeners = new Set<(update: Uint8Array) => void>();
    store.subscribeToSiblingLocalUpdates = vi.fn((_identity, listener) => {
      siblingListeners.add(listener);
      return () => siblingListeners.delete(listener);
    });
    vi.mocked(store.appendLocalUpdate).mockImplementation(async (input) => {
      for (const listener of siblingListeners) listener(input.update.slice());
    });
    const firstWindow = new LocalDocumentReplica({
      identity,
      documentType: 'markdown',
      store,
    });
    const secondWindow = new LocalDocumentReplica({
      identity,
      documentType: 'markdown',
      store,
    });
    await Promise.all([firstWindow.whenReady, secondWindow.whenReady]);

    firstWindow.getYDoc().getText('body').insert(0, 'first');
    await firstWindow.flush();
    secondWindow.getYDoc().getText('body').insert(5, ' second');
    await secondWindow.flush();

    expect(firstWindow.getYDoc().getText('body').toString()).toBe('first second');
    expect(secondWindow.getYDoc().getText('body').toString()).toBe('first second');
    await Promise.all([firstWindow.destroy(), secondWindow.destroy()]);
  });

  it('includes a durable remote row missing from the compacting window Y.Doc', async () => {
    const durable: LoadedLocalReplica = {
      identity,
      documentType: 'markdown',
      encodingVersion: 1,
      snapshot: null,
      snapshotGeneration: 0,
      lastServerSeq: 0,
      completeness: 'complete',
      updates: [],
      outbox: [],
    };
    const store = makeStore(durable);
    vi.mocked(store.appendRemoteUpdates).mockImplementation(async (input) => {
      for (const update of input.updates) {
        durable.updates.push({
          ...update,
          update: update.update.slice(),
          snapshotGeneration: durable.snapshotGeneration,
          createdAt: Date.now(),
        });
      }
      durable.lastServerSeq = Math.max(durable.lastServerSeq, input.lastServerSeq);
    });
    const connectedWindow = new LocalDocumentReplica({
      identity,
      documentType: 'markdown',
      store,
    });
    const laggingWindow = new LocalDocumentReplica({
      identity,
      documentType: 'markdown',
      store,
    });
    await Promise.all([connectedWindow.whenReady, laggingWindow.whenReady]);
    const durableOnlyUpdate = makeUpdate('remote durable basis');
    await connectedWindow.applyRemoteUpdates([{
      update: durableOnlyUpdate,
      source: 'remote',
      serverSequence: 21,
    }], 21);
    expect(laggingWindow.getYDoc().getText('body').toString()).toBe('');

    try {
      await expect(laggingWindow.compactNow()).resolves.toBe(true);
      const replacement = vi.mocked(store.replaceSnapshot).mock.calls[0][0];
      expect(replacement.coveredUpdateIds).toEqual([
        durable.updates[0].updateId,
      ]);
      const compactedBytes = replacement.snapshot;
      const restarted = new Y.Doc();
      Y.applyUpdate(restarted, compactedBytes);
      expect(restarted.getText('body').toString()).toBe('remote durable basis');
      restarted.destroy();
    } finally {
      await Promise.all([connectedWindow.destroy(), laggingWindow.destroy()]);
    }
  });

  it('compacts a complete replica from a stable persisted basis', async () => {
    const base = makeUpdate('persisted base');
    const loaded: LoadedLocalReplica = {
      identity,
      documentType: 'markdown',
      encodingVersion: 1,
      snapshot: null,
      snapshotGeneration: 3,
      lastServerSeq: 19,
      completeness: 'complete',
      updates: [{
        updateId: 'basis-row',
        update: base,
        source: 'remote',
        serverSequence: 19,
        snapshotGeneration: 3,
        createdAt: 1,
      }],
      outbox: [],
    };
    const store = makeStore(loaded);
    const replica = new LocalDocumentReplica({ identity, documentType: 'markdown', store });
    await replica.whenReady;

    await expect(replica.compactNow()).resolves.toBe(true);
    expect(store.replaceSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      expectedGeneration: 3,
      nextGeneration: 4,
      lastServerSeq: 19,
      coveredUpdateIds: ['basis-row'],
    }));
    const snapshot = vi.mocked(store.replaceSnapshot).mock.calls[0][0].snapshot;
    const restored = new Y.Doc();
    Y.applyUpdate(restored, snapshot);
    expect(restored.getText('body').toString()).toBe('persisted base');
    restored.destroy();
    await replica.destroy();
  });

  it.each([
    ['update count', { updateCountThreshold: 1, byteThreshold: Number.MAX_SAFE_INTEGER }],
    ['tail bytes', { updateCountThreshold: Number.MAX_SAFE_INTEGER, byteThreshold: 1 }],
  ])('triggers local compaction at the %s threshold', async (_label, thresholds) => {
    const loaded: LoadedLocalReplica = {
      identity,
      documentType: 'markdown',
      encodingVersion: 1,
      snapshot: null,
      snapshotGeneration: 0,
      lastServerSeq: 0,
      completeness: 'complete',
      updates: [],
      outbox: [],
    };
    const store = makeStore(loaded);
    const replica = new LocalDocumentReplica({
      identity,
      documentType: 'markdown',
      store,
      compaction: { ...thresholds, idleIntervalMs: 60_000 },
    });
    await replica.whenReady;

    replica.getYDoc().getText('body').insert(0, 'threshold edit');
    await replica.flush();

    expect(store.replaceSnapshot).toHaveBeenCalledOnce();
    await replica.destroy();
  });

  it('triggers local compaction after an idle interval', async () => {
    vi.useFakeTimers();
    try {
      const loaded: LoadedLocalReplica = {
        identity,
        documentType: 'markdown',
        encodingVersion: 1,
        snapshot: null,
        snapshotGeneration: 2,
        lastServerSeq: 5,
        completeness: 'complete',
        updates: [{
          updateId: 'idle-tail',
          update: makeUpdate('idle'),
          source: 'remote',
          serverSequence: 5,
          snapshotGeneration: 2,
          createdAt: 1,
        }],
        outbox: [],
      };
      const store = makeStore(loaded);
      const replica = new LocalDocumentReplica({
        identity,
        documentType: 'markdown',
        store,
        compaction: {
          updateCountThreshold: Number.MAX_SAFE_INTEGER,
          byteThreshold: Number.MAX_SAFE_INTEGER,
          idleIntervalMs: 25,
        },
      });
      await replica.whenReady;

      await vi.advanceTimersByTimeAsync(25);
      await replica.flush();

      expect(store.replaceSnapshot).toHaveBeenCalledOnce();
      await replica.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('compacts an already-over-threshold tail after startup hydration', async () => {
    const loaded: LoadedLocalReplica = {
      identity,
      documentType: 'markdown',
      encodingVersion: 1,
      snapshot: null,
      snapshotGeneration: 1,
      lastServerSeq: 2,
      completeness: 'complete',
      updates: [{
        updateId: 'startup-tail',
        update: makeUpdate('startup tail'),
        source: 'remote',
        serverSequence: 2,
        snapshotGeneration: 1,
        createdAt: 1,
      }],
      outbox: [],
    };
    const store = makeStore(loaded);
    const replica = new LocalDocumentReplica({
      identity,
      documentType: 'markdown',
      store,
      compaction: { updateCountThreshold: 1, idleIntervalMs: 60_000 },
    });
    await replica.whenReady;
    await replica.flush();

    expect(store.replaceSnapshot).toHaveBeenCalledOnce();
    await replica.destroy();
  });

  it('stamps edits made during hydration with the loaded snapshot generation', async () => {
    let resolveLoad!: (loaded: LoadedLocalReplica) => void;
    const loadPromise = new Promise<LoadedLocalReplica>((resolve) => {
      resolveLoad = resolve;
    });
    const store = makeStore(null);
    vi.mocked(store.load).mockReturnValueOnce(loadPromise);
    const replica = new LocalDocumentReplica({
      identity,
      documentType: 'markdown',
      store,
    });

    replica.getYDoc().getText('body').insert(0, 'typed while opening');
    resolveLoad({
      identity,
      documentType: 'markdown',
      encodingVersion: 1,
      snapshot: null,
      snapshotGeneration: 5,
      lastServerSeq: 12,
      completeness: 'complete',
      updates: [],
      outbox: [],
    });

    await replica.whenReady;
    await replica.flush();
    expect(store.appendLocalUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotGeneration: 5 }),
    );
    await replica.destroy();
  });

  it('reports local edits as pending immediately and durably flushes them', async () => {
    const store = makeStore(null);
    const outboxStates: string[] = [];
    const replica = new LocalDocumentReplica({
      identity,
      documentType: 'markdown',
      store,
      onOutboxStateChange: (state) => outboxStates.push(state),
    });
    await replica.whenReady;

    replica.getYDoc().getText('body').insert(0, 'offline edit');
    expect(replica.getOutboxState()).toBe('pending');
    expect(outboxStates.at(-1)).toBe('pending');
    await replica.flush();
    expect(store.appendLocalUpdate).toHaveBeenCalledOnce();
    await replica.destroy();
  });

  it('keeps rejected edits through corrupt-replica clean hydration', async () => {
    const update = makeUpdate('preserved local edit');
    const rejected: LocalReplicaOutboxEntry = {
      batchId: 'rejected-a',
      update,
      state: 'rejected',
      attemptCount: 1,
      lastErrorCode: 'MEMBERSHIP_REVOKED',
      createdAt: 1,
      updatedAt: 2,
    };
    const loaded: LoadedLocalReplica = {
      identity,
      documentType: 'markdown',
      encodingVersion: 1,
      snapshot: null,
      snapshotGeneration: 0,
      lastServerSeq: 4,
      completeness: 'corrupt',
      updates: [],
      outbox: [],
    };
    const store = makeStore(loaded, [rejected]);
    const replica = new LocalDocumentReplica({
      identity,
      documentType: 'markdown',
      store,
    });
    await replica.whenReady;
    expect(replica.getState()).toBe('corrupt');
    expect(replica.getOutboxState()).toBe('rejected');

    await replica.beginCleanServerHydration();
    expect(store.resetForCleanHydration).toHaveBeenCalledWith(identity);
    expect(replica.getYDoc().getText('body').toString()).toBe('preserved local edit');
    expect(replica.getState()).toBe('corrupt');

    await replica.completeCleanServerHydration(true);
    expect(store.markComplete).toHaveBeenCalledWith(identity);
    expect(replica.getState()).toBe('ready');
    expect(replica.getOutboxState()).toBe('rejected');
    await replica.destroy();
  });

  it('repairs an incomplete replica after one clean full server hydration', async () => {
    const loaded: LoadedLocalReplica = {
      identity,
      documentType: 'markdown',
      encodingVersion: 1,
      snapshot: null,
      snapshotGeneration: 3,
      lastServerSeq: 11,
      completeness: 'incomplete',
      updates: [],
      outbox: [],
    };
    const store = makeStore(loaded);
    const replica = new LocalDocumentReplica({ identity, documentType: 'markdown', store });
    await replica.whenReady;
    expect(replica.getState()).toBe('unavailable');
    expect(replica.needsCleanServerHydration()).toBe(true);

    await replica.beginCleanServerHydration();
    await replica.completeCleanServerHydration(false);
    await replica.beginCleanServerHydration();
    const serverSnapshot = makeUpdate('clean server state');
    await expect(replica.applyRemoteUpdates([{
      update: serverSnapshot,
      source: 'server-snapshot',
      serverSequence: null,
    }], 12)).resolves.toBe(true);
    await replica.completeCleanServerHydration(true);

    expect(store.resetForCleanHydration).toHaveBeenCalledTimes(2);
    expect(store.resetForCleanHydration).toHaveBeenCalledWith(identity);
    expect(store.markComplete).toHaveBeenCalledWith(identity);
    expect(replica.needsCleanServerHydration()).toBe(false);
    expect(replica.getState()).toBe('ready');
    expect(replica.getYDoc().getText('body').toString()).toBe('clean server state');
    await replica.destroy();
  });

  it('never compacts a corrupt or incomplete replica', async () => {
    for (const completeness of ['corrupt', 'incomplete'] as const) {
      const loaded: LoadedLocalReplica = {
        identity,
        documentType: 'markdown',
        encodingVersion: 1,
        snapshot: null,
        snapshotGeneration: 4,
        lastServerSeq: 8,
        completeness,
        updates: [],
        outbox: [],
      };
      const store = makeStore(loaded);
      const replica = new LocalDocumentReplica({ identity, documentType: 'markdown', store });
      await replica.whenReady;

      await expect(replica.compactNow()).resolves.toBe(false);
      expect(store.replaceSnapshot).not.toHaveBeenCalled();
      await replica.destroy();
    }
  });

  it('surfaces unavailable immediately even when persisting the incomplete marker fails', async () => {
    const store = makeStore(null);
    vi.mocked(store.markIncomplete).mockRejectedValueOnce(new Error('persistence down'));
    const replica = new LocalDocumentReplica({ identity, documentType: 'markdown', store });
    await replica.whenReady;

    await expect(replica.markIncomplete()).rejects.toThrow('persistence down');
    expect(replica.getState()).toBe('unavailable');
    expect(replica.needsCleanServerHydration()).toBe(true);
    await replica.destroy();
  });

  it('drops the offline-safety state when the account budget cannot be recovered', async () => {
    const store = makeStore(null);
    vi.mocked(store.appendLocalUpdate).mockRejectedValueOnce(
      new Error('LOCAL_REPLICA_STORAGE_BUDGET_EXCEEDED'),
    );
    const replica = new LocalDocumentReplica({ identity, documentType: 'markdown', store });
    await replica.whenReady;

    replica.getYDoc().getText('body').insert(0, 'cannot persist');
    await replica.flush();

    expect(replica.getState()).toBe('unavailable');
    await replica.destroy();
  });
});
