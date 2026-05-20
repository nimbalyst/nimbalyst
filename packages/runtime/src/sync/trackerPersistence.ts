/**
 * TrackerPersistence
 *
 * Storage seam between the platform-neutral `TrackerSyncEngine` and the
 * underlying database. Electron implements this over the PGLite worker
 * (`TrackerPGLiteStore`); tests use `InMemoryTrackerPersistence`.
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
  EncryptedTrackerItemEnvelope,
  SyncId,
  TrackerItemPayload,
  TrackerTransactionRow,
  TrackerTransactionState,
  TrackerMutationRejectCode,
} from './trackerProtocol';
import { mergeLabelMaps } from './trackerLabels';

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
    envelope: EncryptedTrackerItemEnvelope,
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
  ): Promise<void>;

  /**
   * Load all non-terminal transactions for replay. Called once on engine
   * startup; rows in `pendingApply` / `created` / `queued` / `executing` /
   * `persistedEnqueue` get re-driven through the queue. Order is
   * `enqueued_at ASC` so the server sees writes in roughly the order the
   * user made them.
   */
  loadPendingTransactions(): Promise<TrackerTransactionRow[]>;
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
    envelope: EncryptedTrackerItemEnvelope;
    payload: TrackerItemPayload | null;
  }>();

  readonly transactions = new Map<string, TrackerTransactionRow>();

  async getMaxSyncId(): Promise<SyncId> {
    let max = 0;
    for (const { envelope } of this.items.values()) {
      if (envelope.syncId > max) max = envelope.syncId;
    }
    return max;
  }

  async applyRemoteItem(
    envelope: EncryptedTrackerItemEnvelope,
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
    const placeholder: EncryptedTrackerItemEnvelope = {
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
    const envelope: EncryptedTrackerItemEnvelope = {
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
    await this.enqueueTransaction({ ...row, state: 'pendingApply' });
    await this.applyOptimistic(itemId, payload);
    await this.markTransactionState(row.clientMutationId, 'persistedEnqueue');
    return snapshot;
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
  ): Promise<void> {
    const row = this.transactions.get(clientMutationId);
    if (!row) return;
    row.lastRejection = rejection;
  }

  async loadPendingTransactions(): Promise<TrackerTransactionRow[]> {
    return [...this.transactions.values()]
      .filter(r => !r.confirmedSyncId)
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }
}
