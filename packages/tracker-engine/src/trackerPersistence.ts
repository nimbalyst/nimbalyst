/**
 * TrackerPersistence
 *
 * Storage seam between the platform-neutral `TrackerSyncEngine` and the
 * underlying database. Electron implements this over the PGLite worker
 * (`TrackerPGLiteStore`), browsers use `IndexedDbTrackerPersistence`, and
 * tests use `InMemoryTrackerPersistence`.
 *
 * The engine owns all writes that go through these methods. The renderer
 * NEVER calls them directly -- it observes engine output via IPC events.
 *
 * Lifecycle invariants:
 *
 * - `applyRemoteItem` is called once per accepted server delta. The implementation
 *   collapses the row in the local projection (`tracker_items` in PGLite).
 *   Tombstones (`payload === null`) mark the row as deleted but keep it so
 *   the engine can replay deltas without re-fetching.
 *
 * - `applyOptimistic` is called when the renderer / MCP requests a write.
 *   The implementation MUST return a snapshot of the pre-write row (or `null`
 *   if there was no prior row) so the engine can roll back on rejection.
 *
 * - `rollbackOptimistic` restores the snapshot. If the snapshot is `null`
 *   the row is deleted outright (it never existed before the optimistic
 *   write).
 *
 * - The four transaction lifecycle methods (`enqueueTransaction`,
 *   `markTransactionExecuting`, `ackTransaction`, `rejectTransaction`)
 *   manage rows in `tracker_transactions`. The PGLite implementation MAY
 *   atomically combine `applyOptimistic` + `enqueueTransaction` in one
 *   SQL transaction when the caller asks for `persistedEnqueue` semantics.
 */

import type {
  TrackerItemEnvelope,
  SyncId,
  TrackerItemPayload,
  TrackerTransactionRow,
  TrackerTransactionState,
  TrackerMutationRejectCode,
} from './trackerProtocol.js';
import type { TeamMemberId } from '@nimbalyst/collab-protocol';
import { mergeLabelMaps } from './trackerLabels.js';

// ============================================================================
// Snapshot for rollback
// ============================================================================

/**
 * The pre-write state of a row, captured by `applyOptimistic` and handed
 * back to `rollbackOptimistic` if the server rejects the mutation. `null`
 * means "the row did not exist before the optimistic write".
 */
export interface TrackerRowSnapshot {
  payload: TrackerItemPayload | null;
  syncId: SyncId | null;
  /** `true` if the prior state was a tombstone (we re-tombstone on rollback). */
  isTombstone: boolean;
}

/**
 * Identity tuple that owns a durable browser mutation.
 *
 * `teamMemberId` is the TEAM-org member id, not the personal one — Stytch B2B
 * issues a different member id per org, so an outbox row keyed by the personal
 * id would replay under an identity the tracker room does not recognize. The
 * branded type makes that mix-up a compile error rather than a sync bug.
 */
export interface TrackerTransactionOwner {
  orgId: string;
  teamProjectId: string;
  teamMemberId: TeamMemberId;
}

/**
 * Browser-only durable fields carried beside the wire-neutral transaction row.
 * They are optional while reading so pre-fix rows fail closed instead of being
 * guessed into the current member's outbox.
 */
export interface PersistedTrackerTransactionRow extends TrackerTransactionRow {
  owner?: TrackerTransactionOwner;
  /** Groups update-many rows so reconnect replay preserves one wire command. */
  batchId?: string;
  rollbackSnapshot?: TrackerRowSnapshot;
  terminalRejection?: boolean;
}

export interface TrackerAtomicMutation {
  itemId: string;
  payload: TrackerItemPayload;
  row: PersistedTrackerTransactionRow;
}

/** Tracker mutation codes that cannot succeed by replaying the same payload. */
export function isPermanentTrackerRejection(code: TrackerMutationRejectCode): boolean {
  return code === 'forbidden'
    || code === 'legacy_encryption_retired'
    || code === 'issueKeyPrefixConflict'
    || code === 'adminRequired'
    || code === 'schemaExists'
    || code === 'malformed';
}

function transactionBelongsTo(
  row: PersistedTrackerTransactionRow,
  owner: TrackerTransactionOwner | undefined,
): boolean {
  if (!owner) return true;
  return row.owner?.orgId === owner.orgId
    && row.owner.teamProjectId === owner.teamProjectId
    && row.owner.teamMemberId === owner.teamMemberId;
}

function transactionIsPending(row: PersistedTrackerTransactionRow): boolean {
  return !row.confirmedSyncId
    && !row.terminalRejection
    && !(row.lastRejection && isPermanentTrackerRejection(row.lastRejection.code));
}

// ============================================================================
// Persistence seam
// ============================================================================

export interface TrackerPersistence {
  // --------------------------------------------------------------------------
  // Watermark for bootstrap / delta
  // --------------------------------------------------------------------------

  /**
   * Largest `sync_id` the local projection has seen. The engine sends
   * this as `sinceSyncId` on the initial `trackerSync` request.
   *
   * Returns `0` (== `SYNC_ID_INITIAL`) when the local projection is empty.
   */
  getMaxSyncId(): Promise<SyncId>;

  // --------------------------------------------------------------------------
  // Projection writes (tracker_items)
  // --------------------------------------------------------------------------

  /**
   * Apply a server-confirmed item (delta or bootstrap row) into the local
   * projection. The envelope carries `syncId` / `deletedAt`; `payload` is
   * the decrypted business data (or `null` for a tombstone).
   *
   * Implementations MUST be idempotent: receiving the same `(itemId, syncId)`
   * twice (e.g. on reconnect mid-stream) results in the same projected row.
   */
  applyRemoteItem(
    envelope: TrackerItemEnvelope,
    payload: TrackerItemPayload | null,
  ): Promise<void>;

  /**
   * Apply a local optimistic write. The implementation MUST return a
   * snapshot of the prior row state so the engine can roll back if the
   * server rejects.
   *
   * For `kind === 'delete'` callers pass `payload: null`. The implementation
   * marks the row tombstoned locally; on ack it is reapplied via
   * `applyRemoteItem` (which carries the server `syncId`).
   */
  applyOptimistic(
    itemId: string,
    payload: TrackerItemPayload | null,
  ): Promise<TrackerRowSnapshot>;

  /**
   * Restore a snapshot taken by `applyOptimistic`. Called when the server
   * rejects the corresponding mutation.
   */
  rollbackOptimistic(itemId: string, snapshot: TrackerRowSnapshot): Promise<void>;

  // --------------------------------------------------------------------------
  // Transaction queue (tracker_transactions)
  // --------------------------------------------------------------------------

  /**
   * Enqueue a new transaction. The row starts in `state: 'created'` so a
   * tab crash mid-enqueue can be detected on relaunch (those rows get
   * promoted to `queued` on next engine start).
   *
   * If `persistedEnqueue` is true, the implementation SHOULD perform this
   * insert in the same SQL transaction as the matching `applyOptimistic`
   * call. The default PGLite implementation does so via a helper that
   * combines the two; the in-memory test impl ignores the hint.
   */
  enqueueTransaction(row: TrackerTransactionRow): Promise<void>;

  /**
   * Atomic: apply the optimistic write AND enqueue the transaction row in
   * one SQL transaction. Used when the caller passes `persistedEnqueue`.
   * Returns the snapshot from the apply for later rollback.
   */
  applyAndEnqueueAtomically(
    itemId: string,
    payload: TrackerItemPayload | null,
    row: TrackerTransactionRow,
  ): Promise<TrackerRowSnapshot>;

  /** Browser update-many seam: all projections and queue rows share one transaction. */
  applyAndEnqueueBatchAtomically?(
    entries: readonly TrackerAtomicMutation[],
  ): Promise<TrackerRowSnapshot[]>;

  /** Move a batch to one lifecycle state in one persistence transaction. */
  markTransactionStates?(
    clientMutationIds: readonly string[],
    state: TrackerTransactionState,
    startedAt?: number,
  ): Promise<void>;

  /**
   * Transition an existing row through its lifecycle. The engine calls
   * `markTransactionState(id, 'queued')` once a queued row is about to be
   * sent, then `'executing'` when the WS send actually happens.
   */
  markTransactionState(
    clientMutationId: string,
    state: TrackerTransactionState,
    startedAt?: number,
  ): Promise<void>;

  /**
   * Delete the transaction row after a successful ack. The projection has
   * already been updated via `applyRemoteItem` carrying the server `syncId`.
   */
  ackTransaction(clientMutationId: string, syncId: SyncId): Promise<void>;

  /**
   * Record a rejection. The row is KEPT (not deleted) so the UI can
   * surface `lastRejection`. The engine separately calls
   * `rollbackOptimistic` to undo the local apply.
   */
  rejectTransaction(
    clientMutationId: string,
    rejection: {
      code: TrackerMutationRejectCode;
      message: string;
      occurredAt: number;
    },
    terminal?: boolean,
  ): Promise<void>;

  /**
   * Load all non-terminal transactions for replay. Called once on engine
   * startup; rows in `pendingApply` / `created` / `queued` / `executing` /
   * `persistedEnqueue` get re-driven through the queue. Order is
   * `enqueued_at ASC` so the server sees writes in roughly the order the
   * user made them.
   */
  loadPendingTransactions(owner?: TrackerTransactionOwner): Promise<PersistedTrackerTransactionRow[]>;

  /**
   * Settle items with several unconfirmed `update` rows before they replay:
   * every update row carries the whole item, so only the newest local state
   * should be sent, and the rows' own timestamps may not say which that is.
   * Must not delete anything; return how many replacement rows were queued.
   * Called once per engine, before the first bootstrap applies remote state
   * (NIM-7336).
   */
  consolidatePendingUpdates?(): Promise<number>;
}

// ============================================================================
// IndexedDB implementation for browsers
// ============================================================================

const INDEXED_DB_VERSION = 1;
const ITEM_STORE = 'items';
const TRANSACTION_STORE = 'transactions';
const SAVED_VIEW_STORE = 'savedViews';

export interface StoredTrackerItem {
  envelope: TrackerItemEnvelope;
  payload: TrackerItemPayload | null;
}

interface IndexedDbTrackerItemRow extends StoredTrackerItem {
  itemId: string;
  syncId: SyncId;
}

export interface IndexedDbTrackerSavedViewRow {
  viewId: string;
  payload: string | null;
  syncId: SyncId;
  unsynced: boolean;
  deleted: boolean;
  /** Present only while this row is a member-owned, unconfirmed local change. */
  owner?: TrackerTransactionOwner;
  lastRejection?: { code: string; occurredAt: number };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB request failed')), {
      once: true,
    });
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error ?? new Error('IndexedDB transaction aborted')),
      { once: true },
    );
    transaction.addEventListener(
      'error',
      () => reject(transaction.error ?? new Error('IndexedDB transaction failed')),
      { once: true },
    );
  });
}

function snapshotStoredItem(existing: IndexedDbTrackerItemRow | undefined): TrackerRowSnapshot {
  return existing
    ? {
        payload: existing.payload,
        syncId: existing.envelope.syncId,
        isTombstone: existing.envelope.encryptedPayload === null,
      }
    : { payload: null, syncId: null, isTombstone: false };
}

function optimisticItemRow(
  itemId: string,
  payload: TrackerItemPayload | null,
  existing: IndexedDbTrackerItemRow | undefined,
): IndexedDbTrackerItemRow {
  const envelope: TrackerItemEnvelope = {
    itemId,
    syncId: existing?.envelope.syncId ?? 0,
    encryptedPayload: payload === null ? null : 'optimistic',
    iv: payload === null ? undefined : 'optimistic-iv',
    updatedAt: Date.now(),
    deletedAt: payload === null ? Date.now() : null,
    orgKeyFingerprint: existing?.envelope.orgKeyFingerprint ?? null,
    issueNumber: existing?.envelope.issueNumber,
    issueKey: existing?.envelope.issueKey,
  };
  return { itemId, syncId: envelope.syncId, envelope, payload };
}

/**
 * Durable browser persistence for one tracker room.
 *
 * Callers must give each team tracker room its own database name. The item
 * projection and mutation queue are separate object stores; the atomic enqueue
 * path opens one read-write transaction across both stores so a tab close cannot
 * preserve only half of an optimistic mutation. A third store holds the
 * server-owned saved-view lane used by the browser data source.
 */
export class IndexedDbTrackerPersistence implements TrackerPersistence {
  private readonly databasePromise: Promise<IDBDatabase>;
  private closed = false;

  constructor(
    readonly databaseName: string,
    indexedDbFactory: IDBFactory = globalThis.indexedDB,
  ) {
    if (!databaseName.trim()) throw new Error('IndexedDB tracker persistence requires a database name');
    if (!indexedDbFactory) throw new Error('IndexedDB is not available in this environment');

    const openRequest = indexedDbFactory.open(databaseName, INDEXED_DB_VERSION);
    openRequest.addEventListener('upgradeneeded', () => {
      const database = openRequest.result;
      if (!database.objectStoreNames.contains(ITEM_STORE)) {
        const items = database.createObjectStore(ITEM_STORE, { keyPath: 'itemId' });
        items.createIndex('syncId', 'syncId');
      }
      if (!database.objectStoreNames.contains(TRANSACTION_STORE)) {
        const transactions = database.createObjectStore(TRANSACTION_STORE, {
          keyPath: 'clientMutationId',
        });
        transactions.createIndex('enqueuedAt', 'enqueuedAt');
      }
      if (!database.objectStoreNames.contains(SAVED_VIEW_STORE)) {
        const savedViews = database.createObjectStore(SAVED_VIEW_STORE, { keyPath: 'viewId' });
        savedViews.createIndex('syncId', 'syncId');
      }
    });
    this.databasePromise = requestResult(openRequest);
  }

  private async openTransaction(
    storeNames: string | string[],
    mode: IDBTransactionMode,
  ): Promise<IDBTransaction | null> {
    const database = await this.databasePromise;
    if (this.closed) return null;
    try {
      return database.transaction(storeNames, mode);
    } catch (error) {
      if (this.closed) return null;
      throw error;
    }
  }

  async getMaxSyncId(): Promise<SyncId> {
    const transaction = await this.openTransaction(ITEM_STORE, 'readonly');
    if (!transaction) return 0;
    const cursor = await requestResult(transaction.objectStore(ITEM_STORE).index('syncId').openCursor(null, 'prev'));
    await transactionComplete(transaction);
    const row = cursor?.value as IndexedDbTrackerItemRow | undefined;
    return row?.syncId ?? 0;
  }

  async applyRemoteItem(
    envelope: TrackerItemEnvelope,
    payload: TrackerItemPayload | null,
  ): Promise<void> {
    const transaction = await this.openTransaction(ITEM_STORE, 'readwrite');
    if (!transaction) return;
    const store = transaction.objectStore(ITEM_STORE);
    const existing = await requestResult(store.get(envelope.itemId)) as IndexedDbTrackerItemRow | undefined;
    if (!existing || existing.envelope.syncId <= envelope.syncId) {
      let mergedPayload = payload;
      if (payload && existing?.payload) {
        mergedPayload = {
          ...payload,
          labels: mergeLabelMaps(existing.payload.labels, payload.labels),
        };
      }
      store.put({
        itemId: envelope.itemId,
        syncId: envelope.syncId,
        envelope,
        payload: mergedPayload,
      } satisfies IndexedDbTrackerItemRow);
    }
    await transactionComplete(transaction);
  }

  async applyOptimistic(
    itemId: string,
    payload: TrackerItemPayload | null,
  ): Promise<TrackerRowSnapshot> {
    const transaction = await this.openTransaction(ITEM_STORE, 'readwrite');
    if (!transaction) return snapshotStoredItem(undefined);
    const store = transaction.objectStore(ITEM_STORE);
    const existing = await requestResult(store.get(itemId)) as IndexedDbTrackerItemRow | undefined;
    const snapshot = snapshotStoredItem(existing);
    store.put(optimisticItemRow(itemId, payload, existing));
    await transactionComplete(transaction);
    return snapshot;
  }

  async rollbackOptimistic(itemId: string, snapshot: TrackerRowSnapshot): Promise<void> {
    const transaction = await this.openTransaction(ITEM_STORE, 'readwrite');
    if (!transaction) return;
    const store = transaction.objectStore(ITEM_STORE);
    if (snapshot.payload === null && !snapshot.isTombstone && snapshot.syncId === null) {
      store.delete(itemId);
    } else {
      const envelope: TrackerItemEnvelope = {
        itemId,
        syncId: snapshot.syncId ?? 0,
        encryptedPayload: snapshot.isTombstone ? null : 'restored',
        iv: snapshot.isTombstone ? undefined : 'restored-iv',
        updatedAt: Date.now(),
        deletedAt: snapshot.isTombstone ? Date.now() : null,
        orgKeyFingerprint: null,
      };
      store.put({ itemId, syncId: envelope.syncId, envelope, payload: snapshot.payload } satisfies IndexedDbTrackerItemRow);
    }
    await transactionComplete(transaction);
  }

  async enqueueTransaction(row: TrackerTransactionRow): Promise<void> {
    const transaction = await this.openTransaction(TRANSACTION_STORE, 'readwrite');
    if (!transaction) return;
    transaction.objectStore(TRANSACTION_STORE).put(row);
    await transactionComplete(transaction);
  }

  async applyAndEnqueueAtomically(
    itemId: string,
    payload: TrackerItemPayload | null,
    row: TrackerTransactionRow,
  ): Promise<TrackerRowSnapshot> {
    const transaction = await this.openTransaction([ITEM_STORE, TRANSACTION_STORE], 'readwrite');
    if (!transaction) return snapshotStoredItem(undefined);
    const itemStore = transaction.objectStore(ITEM_STORE);
    const transactionStore = transaction.objectStore(TRANSACTION_STORE);
    const existing = await requestResult(itemStore.get(itemId)) as IndexedDbTrackerItemRow | undefined;
    const snapshot = snapshotStoredItem(existing);
    transactionStore.put({ ...row, state: 'pendingApply', rollbackSnapshot: snapshot });
    itemStore.put(optimisticItemRow(itemId, payload, existing));
    transactionStore.put({ ...row, state: 'persistedEnqueue', rollbackSnapshot: snapshot });
    await transactionComplete(transaction);
    return snapshot;
  }

  async applyAndEnqueueBatchAtomically(
    entries: readonly TrackerAtomicMutation[],
  ): Promise<TrackerRowSnapshot[]> {
    const transaction = await this.openTransaction([ITEM_STORE, TRANSACTION_STORE], 'readwrite');
    if (!transaction) return entries.map(() => snapshotStoredItem(undefined));
    const itemStore = transaction.objectStore(ITEM_STORE);
    const transactionStore = transaction.objectStore(TRANSACTION_STORE);
    const snapshots: TrackerRowSnapshot[] = [];
    for (const entry of entries) {
      const existing = await requestResult(itemStore.get(entry.itemId)) as IndexedDbTrackerItemRow | undefined;
      const snapshot = snapshotStoredItem(existing);
      snapshots.push(snapshot);
      transactionStore.put({ ...entry.row, state: 'pendingApply', rollbackSnapshot: snapshot });
      itemStore.put(optimisticItemRow(entry.itemId, entry.payload, existing));
      transactionStore.put({ ...entry.row, state: 'persistedEnqueue', rollbackSnapshot: snapshot });
    }
    await transactionComplete(transaction);
    return snapshots;
  }

  async markTransactionStates(
    clientMutationIds: readonly string[],
    state: TrackerTransactionState,
    startedAt?: number,
  ): Promise<void> {
    const transaction = await this.openTransaction(TRANSACTION_STORE, 'readwrite');
    if (!transaction) return;
    const store = transaction.objectStore(TRANSACTION_STORE);
    for (const clientMutationId of clientMutationIds) {
      const row = await requestResult(store.get(clientMutationId)) as TrackerTransactionRow | undefined;
      if (row) store.put({ ...row, state, ...(startedAt === undefined ? {} : { startedAt }) });
    }
    await transactionComplete(transaction);
  }

  async markTransactionState(
    clientMutationId: string,
    state: TrackerTransactionState,
    startedAt?: number,
  ): Promise<void> {
    const transaction = await this.openTransaction(TRANSACTION_STORE, 'readwrite');
    if (!transaction) return;
    const store = transaction.objectStore(TRANSACTION_STORE);
    const row = await requestResult(store.get(clientMutationId)) as TrackerTransactionRow | undefined;
    if (row) store.put({ ...row, state, ...(startedAt === undefined ? {} : { startedAt }) });
    await transactionComplete(transaction);
  }

  async ackTransaction(clientMutationId: string, _syncId: SyncId): Promise<void> {
    const transaction = await this.openTransaction(TRANSACTION_STORE, 'readwrite');
    if (!transaction) return;
    transaction.objectStore(TRANSACTION_STORE).delete(clientMutationId);
    await transactionComplete(transaction);
  }

  async rejectTransaction(
    clientMutationId: string,
    rejection: { code: TrackerMutationRejectCode; message: string; occurredAt: number },
    terminal = isPermanentTrackerRejection(rejection.code),
  ): Promise<void> {
    const transaction = await this.openTransaction(TRANSACTION_STORE, 'readwrite');
    if (!transaction) return;
    const store = transaction.objectStore(TRANSACTION_STORE);
    const row = await requestResult(store.get(clientMutationId)) as PersistedTrackerTransactionRow | undefined;
    if (row) store.put({ ...row, lastRejection: rejection, terminalRejection: terminal });
    await transactionComplete(transaction);
  }

  async loadPendingTransactions(owner?: TrackerTransactionOwner): Promise<PersistedTrackerTransactionRow[]> {
    const transaction = await this.openTransaction(TRANSACTION_STORE, 'readonly');
    if (!transaction) return [];
    const rows = await requestResult(transaction.objectStore(TRANSACTION_STORE).getAll()) as PersistedTrackerTransactionRow[];
    await transactionComplete(transaction);
    return rows
      .filter(row => transactionBelongsTo(row, owner) && transactionIsPending(row))
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }

  async getItem(itemId: string): Promise<StoredTrackerItem | undefined> {
    const transaction = await this.openTransaction(ITEM_STORE, 'readonly');
    if (!transaction) return undefined;
    const row = await requestResult(transaction.objectStore(ITEM_STORE).get(itemId)) as IndexedDbTrackerItemRow | undefined;
    await transactionComplete(transaction);
    return row ? { envelope: row.envelope, payload: row.payload } : undefined;
  }

  async getItems(itemIds: readonly string[]): Promise<Array<StoredTrackerItem | undefined>> {
    const transaction = await this.openTransaction(ITEM_STORE, 'readonly');
    if (!transaction) return itemIds.map(() => undefined);
    const store = transaction.objectStore(ITEM_STORE);
    const rows: Array<StoredTrackerItem | undefined> = [];
    for (const itemId of itemIds) {
      const row = await requestResult(store.get(itemId)) as IndexedDbTrackerItemRow | undefined;
      rows.push(row ? { envelope: row.envelope, payload: row.payload } : undefined);
    }
    await transactionComplete(transaction);
    return rows;
  }

  async listItems(): Promise<StoredTrackerItem[]> {
    const transaction = await this.openTransaction(ITEM_STORE, 'readonly');
    if (!transaction) return [];
    const rows = await requestResult(transaction.objectStore(ITEM_STORE).getAll()) as IndexedDbTrackerItemRow[];
    await transactionComplete(transaction);
    return rows.map(({ envelope, payload }) => ({ envelope, payload }));
  }

  async putItem(item: StoredTrackerItem): Promise<void> {
    const transaction = await this.openTransaction(ITEM_STORE, 'readwrite');
    if (!transaction) return;
    transaction.objectStore(ITEM_STORE).put({
      itemId: item.envelope.itemId,
      syncId: item.envelope.syncId,
      ...item,
    } satisfies IndexedDbTrackerItemRow);
    await transactionComplete(transaction);
  }

  async getTransaction(clientMutationId: string): Promise<TrackerTransactionRow | undefined> {
    const transaction = await this.openTransaction(TRANSACTION_STORE, 'readonly');
    if (!transaction) return undefined;
    const row = await requestResult(transaction.objectStore(TRANSACTION_STORE).get(clientMutationId)) as TrackerTransactionRow | undefined;
    await transactionComplete(transaction);
    return row;
  }

  async getMaxSavedViewSyncId(): Promise<SyncId> {
    const transaction = await this.openTransaction(SAVED_VIEW_STORE, 'readonly');
    if (!transaction) return 0;
    const cursor = await requestResult(transaction.objectStore(SAVED_VIEW_STORE).index('syncId').openCursor(null, 'prev'));
    await transactionComplete(transaction);
    return (cursor?.value as IndexedDbTrackerSavedViewRow | undefined)?.syncId ?? 0;
  }

  async listSavedViews(): Promise<IndexedDbTrackerSavedViewRow[]> {
    const transaction = await this.openTransaction(SAVED_VIEW_STORE, 'readonly');
    if (!transaction) return [];
    const rows = await requestResult(transaction.objectStore(SAVED_VIEW_STORE).getAll()) as IndexedDbTrackerSavedViewRow[];
    await transactionComplete(transaction);
    return rows;
  }

  async putLocalSavedView(
    viewId: string,
    payload: string | null,
    owner?: TrackerTransactionOwner,
  ): Promise<void> {
    const transaction = await this.openTransaction(SAVED_VIEW_STORE, 'readwrite');
    if (!transaction) return;
    const store = transaction.objectStore(SAVED_VIEW_STORE);
    const existing = await requestResult(store.get(viewId)) as IndexedDbTrackerSavedViewRow | undefined;
    store.put({
      viewId,
      payload,
      syncId: existing?.syncId ?? 0,
      unsynced: true,
      deleted: payload === null,
      owner,
    } satisfies IndexedDbTrackerSavedViewRow);
    await transactionComplete(transaction);
  }

  async applyRemoteSavedView(viewId: string, payload: string | null, syncId: SyncId): Promise<void> {
    const transaction = await this.openTransaction(SAVED_VIEW_STORE, 'readwrite');
    if (!transaction) return;
    const store = transaction.objectStore(SAVED_VIEW_STORE);
    const existing = await requestResult(store.get(viewId)) as IndexedDbTrackerSavedViewRow | undefined;
    if (existing && existing.syncId > syncId) {
      await transactionComplete(transaction);
      return;
    }
    const acknowledgesLocalChange = existing?.unsynced && existing.payload === payload;
    store.put({
      viewId,
      payload: existing?.unsynced && !acknowledgesLocalChange ? existing.payload : payload,
      syncId,
      unsynced: !!existing?.unsynced && !acknowledgesLocalChange,
      deleted: existing?.unsynced && !acknowledgesLocalChange ? existing.deleted : payload === null,
      ...(existing?.unsynced && !acknowledgesLocalChange ? { owner: existing.owner } : {}),
    } satisfies IndexedDbTrackerSavedViewRow);
    await transactionComplete(transaction);
  }

  async markSavedViewRejected(viewId: string, code: string): Promise<void> {
    const transaction = await this.openTransaction(SAVED_VIEW_STORE, 'readwrite');
    if (!transaction) return;
    const store = transaction.objectStore(SAVED_VIEW_STORE);
    const existing = await requestResult(store.get(viewId)) as IndexedDbTrackerSavedViewRow | undefined;
    if (existing) {
      store.put({
        ...existing,
        unsynced: false,
        lastRejection: { code, occurredAt: Date.now() },
      } satisfies IndexedDbTrackerSavedViewRow);
    }
    await transactionComplete(transaction);
  }

  /** Purge every plaintext projection and member outbox row for this room. */
  async purgeAll(): Promise<void> {
    const transaction = await this.openTransaction(
      [ITEM_STORE, TRANSACTION_STORE, SAVED_VIEW_STORE],
      'readwrite',
    );
    if (!transaction) return;
    transaction.objectStore(ITEM_STORE).clear();
    transaction.objectStore(TRANSACTION_STORE).clear();
    transaction.objectStore(SAVED_VIEW_STORE).clear();
    await transactionComplete(transaction);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    (await this.databasePromise).close();
  }
}

// ============================================================================
// In-memory implementation for tests
// ============================================================================

/**
 * Test-only `TrackerPersistence` backed by plain `Map`s. Used by the
 * runtime integration tests so they don't need to spin up the PGLite
 * worker. The shape of the stored rows mirrors what the PGLite store
 * will project; assertions in tests can read from `items` / `transactions`
 * directly.
 */
export class InMemoryTrackerPersistence implements TrackerPersistence {
  readonly items = new Map<string, {
    envelope: TrackerItemEnvelope;
    payload: TrackerItemPayload | null;
  }>();

  readonly transactions = new Map<string, PersistedTrackerTransactionRow>();

  async getMaxSyncId(): Promise<SyncId> {
    let max = 0;
    for (const { envelope } of this.items.values()) {
      if (envelope.syncId > max) max = envelope.syncId;
    }
    return max;
  }

  async applyRemoteItem(
    envelope: TrackerItemEnvelope,
    payload: TrackerItemPayload | null,
  ): Promise<void> {
    const existing = this.items.get(envelope.itemId);
    if (existing && existing.envelope.syncId > envelope.syncId) {
      // Stale arrival -- ignore. Real implementations may bail similarly to
      // avoid clobbering a newer projection with an older delta.
      return;
    }
    // Labels CRDT (D3): union the incoming add-wins map with whatever
    // entries the local copy already had. Mirrors the PGLite store's
    // applyRemoteItem so test fixtures and production behave the same.
    let merged = payload;
    if (payload && existing?.payload) {
      merged = {
        ...payload,
        labels: mergeLabelMaps(existing.payload.labels, payload.labels),
      };
    }
    this.items.set(envelope.itemId, { envelope, payload: merged });
  }

  async applyOptimistic(
    itemId: string,
    payload: TrackerItemPayload | null,
  ): Promise<TrackerRowSnapshot> {
    const existing = this.items.get(itemId);
    const snapshot: TrackerRowSnapshot = existing
      ? {
          payload: existing.payload,
          syncId: existing.envelope.syncId,
          isTombstone: existing.envelope.encryptedPayload === null,
        }
      : { payload: null, syncId: null, isTombstone: false };

    // Mint a placeholder envelope; sync_id stays at the existing value (the
    // server-confirmed projection only advances when the ack lands).
    const placeholder: TrackerItemEnvelope = {
      itemId,
      syncId: existing?.envelope.syncId ?? 0,
      encryptedPayload: payload === null ? null : 'optimistic',
      iv: payload === null ? undefined : 'optimistic-iv',
      updatedAt: Date.now(),
      deletedAt: payload === null ? Date.now() : null,
      orgKeyFingerprint: existing?.envelope.orgKeyFingerprint ?? null,
    };
    this.items.set(itemId, { envelope: placeholder, payload });
    return snapshot;
  }

  async rollbackOptimistic(itemId: string, snapshot: TrackerRowSnapshot): Promise<void> {
    if (snapshot.payload === null && !snapshot.isTombstone && snapshot.syncId === null) {
      this.items.delete(itemId);
      return;
    }
    const envelope: TrackerItemEnvelope = {
      itemId,
      syncId: snapshot.syncId ?? 0,
      encryptedPayload: snapshot.isTombstone ? null : 'restored',
      iv: snapshot.isTombstone ? undefined : 'restored-iv',
      updatedAt: Date.now(),
      deletedAt: snapshot.isTombstone ? Date.now() : null,
      orgKeyFingerprint: null,
    };
    this.items.set(itemId, { envelope, payload: snapshot.payload });
  }

  async enqueueTransaction(row: TrackerTransactionRow): Promise<void> {
    this.transactions.set(row.clientMutationId, { ...row });
  }

  async applyAndEnqueueAtomically(
    itemId: string,
    payload: TrackerItemPayload | null,
    row: TrackerTransactionRow,
  ): Promise<TrackerRowSnapshot> {
    // Same ordering as the PGLite store (NIM-602): enqueue `pendingApply`
    // first so a crash here leaves a replayable queue row, then apply the
    // projection, then promote to `persistedEnqueue`. Pure in-memory so
    // there is no actual crash window, but matching the contract keeps
    // tests that observe intermediate states behaviorally identical to
    // production.
    const existing = this.items.get(itemId);
    const snapshot: TrackerRowSnapshot = existing
      ? {
          payload: existing.payload,
          syncId: existing.envelope.syncId,
          isTombstone: existing.envelope.encryptedPayload === null,
        }
      : { payload: null, syncId: null, isTombstone: false };
    const pendingRow: PersistedTrackerTransactionRow = {
      ...row,
      state: 'pendingApply',
      rollbackSnapshot: snapshot,
    };
    await this.enqueueTransaction(pendingRow);
    await this.applyOptimistic(itemId, payload);
    await this.markTransactionState(row.clientMutationId, 'persistedEnqueue');
    return snapshot;
  }

  async applyAndEnqueueBatchAtomically(
    entries: readonly TrackerAtomicMutation[],
  ): Promise<TrackerRowSnapshot[]> {
    const snapshots = entries.map(entry => {
      const existing = this.items.get(entry.itemId);
      return existing
        ? {
            payload: existing.payload,
            syncId: existing.envelope.syncId,
            isTombstone: existing.envelope.encryptedPayload === null,
          }
        : { payload: null, syncId: null, isTombstone: false };
    });
    entries.forEach((entry, index) => {
      this.transactions.set(entry.row.clientMutationId, {
        ...entry.row,
        state: 'persistedEnqueue',
        rollbackSnapshot: snapshots[index],
      });
      const existing = this.items.get(entry.itemId);
      const envelope: TrackerItemEnvelope = {
        itemId: entry.itemId,
        syncId: existing?.envelope.syncId ?? 0,
        encryptedPayload: 'optimistic',
        iv: 'optimistic-iv',
        updatedAt: Date.now(),
        deletedAt: null,
        orgKeyFingerprint: existing?.envelope.orgKeyFingerprint ?? null,
        issueNumber: existing?.envelope.issueNumber,
        issueKey: existing?.envelope.issueKey,
      };
      this.items.set(entry.itemId, {
        envelope,
        payload: entry.payload,
      });
    });
    return snapshots;
  }

  async markTransactionStates(
    clientMutationIds: readonly string[],
    state: TrackerTransactionState,
    startedAt?: number,
  ): Promise<void> {
    for (const clientMutationId of clientMutationIds) {
      await this.markTransactionState(clientMutationId, state, startedAt);
    }
  }

  async markTransactionState(
    clientMutationId: string,
    state: TrackerTransactionState,
    startedAt?: number,
  ): Promise<void> {
    const row = this.transactions.get(clientMutationId);
    if (!row) return;
    row.state = state;
    if (startedAt !== undefined) row.startedAt = startedAt;
  }

  async ackTransaction(clientMutationId: string, syncId: SyncId): Promise<void> {
    const row = this.transactions.get(clientMutationId);
    if (!row) return;
    row.confirmedSyncId = syncId;
    this.transactions.delete(clientMutationId);
  }

  async rejectTransaction(
    clientMutationId: string,
    rejection: { code: TrackerMutationRejectCode; message: string; occurredAt: number },
    terminal = isPermanentTrackerRejection(rejection.code),
  ): Promise<void> {
    const row = this.transactions.get(clientMutationId);
    if (!row) return;
    row.lastRejection = rejection;
    row.terminalRejection = terminal;
  }

  async loadPendingTransactions(owner?: TrackerTransactionOwner): Promise<PersistedTrackerTransactionRow[]> {
    return [...this.transactions.values()]
      .filter(row => transactionBelongsTo(row, owner) && transactionIsPending(row))
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }
}
