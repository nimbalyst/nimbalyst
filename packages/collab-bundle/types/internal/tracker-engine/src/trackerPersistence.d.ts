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
import type { TrackerItemEnvelope, SyncId, TrackerItemPayload, TrackerTransactionRow, TrackerTransactionState, TrackerMutationRejectCode } from './trackerProtocol.js';
import type { TeamMemberId } from '@nimbalyst/collab-protocol';
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
export declare function isPermanentTrackerRejection(code: TrackerMutationRejectCode): boolean;
export interface TrackerPersistence {
    /**
     * Largest `sync_id` the local projection has seen. The engine sends
     * this as `sinceSyncId` on the initial `trackerSync` request.
     *
     * Returns `0` (== `SYNC_ID_INITIAL`) when the local projection is empty.
     */
    getMaxSyncId(): Promise<SyncId>;
    /**
     * Apply a server-confirmed item (delta or bootstrap row) into the local
     * projection. The envelope carries `syncId` / `deletedAt`; `payload` is
     * the decrypted business data (or `null` for a tombstone).
     *
     * Implementations MUST be idempotent: receiving the same `(itemId, syncId)`
     * twice (e.g. on reconnect mid-stream) results in the same projected row.
     */
    applyRemoteItem(envelope: TrackerItemEnvelope, payload: TrackerItemPayload | null): Promise<void>;
    /**
     * Apply a local optimistic write. The implementation MUST return a
     * snapshot of the prior row state so the engine can roll back if the
     * server rejects.
     *
     * For `kind === 'delete'` callers pass `payload: null`. The implementation
     * marks the row tombstoned locally; on ack it is reapplied via
     * `applyRemoteItem` (which carries the server `syncId`).
     */
    applyOptimistic(itemId: string, payload: TrackerItemPayload | null): Promise<TrackerRowSnapshot>;
    /**
     * Restore a snapshot taken by `applyOptimistic`. Called when the server
     * rejects the corresponding mutation.
     */
    rollbackOptimistic(itemId: string, snapshot: TrackerRowSnapshot): Promise<void>;
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
    applyAndEnqueueAtomically(itemId: string, payload: TrackerItemPayload | null, row: TrackerTransactionRow): Promise<TrackerRowSnapshot>;
    /** Browser update-many seam: all projections and queue rows share one transaction. */
    applyAndEnqueueBatchAtomically?(entries: readonly TrackerAtomicMutation[]): Promise<TrackerRowSnapshot[]>;
    /** Move a batch to one lifecycle state in one persistence transaction. */
    markTransactionStates?(clientMutationIds: readonly string[], state: TrackerTransactionState, startedAt?: number): Promise<void>;
    /**
     * Transition an existing row through its lifecycle. The engine calls
     * `markTransactionState(id, 'queued')` once a queued row is about to be
     * sent, then `'executing'` when the WS send actually happens.
     */
    markTransactionState(clientMutationId: string, state: TrackerTransactionState, startedAt?: number): Promise<void>;
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
    rejectTransaction(clientMutationId: string, rejection: {
        code: TrackerMutationRejectCode;
        message: string;
        occurredAt: number;
    }, terminal?: boolean): Promise<void>;
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
export interface StoredTrackerItem {
    envelope: TrackerItemEnvelope;
    payload: TrackerItemPayload | null;
}
export interface IndexedDbTrackerSavedViewRow {
    viewId: string;
    payload: string | null;
    syncId: SyncId;
    unsynced: boolean;
    deleted: boolean;
    /** Present only while this row is a member-owned, unconfirmed local change. */
    owner?: TrackerTransactionOwner;
    lastRejection?: {
        code: string;
        occurredAt: number;
    };
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
export declare class IndexedDbTrackerPersistence implements TrackerPersistence {
    readonly databaseName: string;
    private readonly databasePromise;
    private closed;
    constructor(databaseName: string, indexedDbFactory?: IDBFactory);
    private openTransaction;
    getMaxSyncId(): Promise<SyncId>;
    applyRemoteItem(envelope: TrackerItemEnvelope, payload: TrackerItemPayload | null): Promise<void>;
    applyOptimistic(itemId: string, payload: TrackerItemPayload | null): Promise<TrackerRowSnapshot>;
    rollbackOptimistic(itemId: string, snapshot: TrackerRowSnapshot): Promise<void>;
    enqueueTransaction(row: TrackerTransactionRow): Promise<void>;
    applyAndEnqueueAtomically(itemId: string, payload: TrackerItemPayload | null, row: TrackerTransactionRow): Promise<TrackerRowSnapshot>;
    applyAndEnqueueBatchAtomically(entries: readonly TrackerAtomicMutation[]): Promise<TrackerRowSnapshot[]>;
    markTransactionStates(clientMutationIds: readonly string[], state: TrackerTransactionState, startedAt?: number): Promise<void>;
    markTransactionState(clientMutationId: string, state: TrackerTransactionState, startedAt?: number): Promise<void>;
    ackTransaction(clientMutationId: string, _syncId: SyncId): Promise<void>;
    rejectTransaction(clientMutationId: string, rejection: {
        code: TrackerMutationRejectCode;
        message: string;
        occurredAt: number;
    }, terminal?: boolean): Promise<void>;
    loadPendingTransactions(owner?: TrackerTransactionOwner): Promise<PersistedTrackerTransactionRow[]>;
    getItem(itemId: string): Promise<StoredTrackerItem | undefined>;
    getItems(itemIds: readonly string[]): Promise<Array<StoredTrackerItem | undefined>>;
    listItems(): Promise<StoredTrackerItem[]>;
    putItem(item: StoredTrackerItem): Promise<void>;
    getTransaction(clientMutationId: string): Promise<TrackerTransactionRow | undefined>;
    getMaxSavedViewSyncId(): Promise<SyncId>;
    listSavedViews(): Promise<IndexedDbTrackerSavedViewRow[]>;
    putLocalSavedView(viewId: string, payload: string | null, owner?: TrackerTransactionOwner): Promise<void>;
    applyRemoteSavedView(viewId: string, payload: string | null, syncId: SyncId): Promise<void>;
    markSavedViewRejected(viewId: string, code: string): Promise<void>;
    /** Purge every plaintext projection and member outbox row for this room. */
    purgeAll(): Promise<void>;
    close(): Promise<void>;
}
/**
 * Test-only `TrackerPersistence` backed by plain `Map`s. Used by the
 * runtime integration tests so they don't need to spin up the PGLite
 * worker. The shape of the stored rows mirrors what the PGLite store
 * will project; assertions in tests can read from `items` / `transactions`
 * directly.
 */
export declare class InMemoryTrackerPersistence implements TrackerPersistence {
    readonly items: Map<string, {
        envelope: TrackerItemEnvelope;
        payload: TrackerItemPayload | null;
    }>;
    readonly transactions: Map<string, PersistedTrackerTransactionRow>;
    getMaxSyncId(): Promise<SyncId>;
    applyRemoteItem(envelope: TrackerItemEnvelope, payload: TrackerItemPayload | null): Promise<void>;
    applyOptimistic(itemId: string, payload: TrackerItemPayload | null): Promise<TrackerRowSnapshot>;
    rollbackOptimistic(itemId: string, snapshot: TrackerRowSnapshot): Promise<void>;
    enqueueTransaction(row: TrackerTransactionRow): Promise<void>;
    applyAndEnqueueAtomically(itemId: string, payload: TrackerItemPayload | null, row: TrackerTransactionRow): Promise<TrackerRowSnapshot>;
    applyAndEnqueueBatchAtomically(entries: readonly TrackerAtomicMutation[]): Promise<TrackerRowSnapshot[]>;
    markTransactionStates(clientMutationIds: readonly string[], state: TrackerTransactionState, startedAt?: number): Promise<void>;
    markTransactionState(clientMutationId: string, state: TrackerTransactionState, startedAt?: number): Promise<void>;
    ackTransaction(clientMutationId: string, syncId: SyncId): Promise<void>;
    rejectTransaction(clientMutationId: string, rejection: {
        code: TrackerMutationRejectCode;
        message: string;
        occurredAt: number;
    }, terminal?: boolean): Promise<void>;
    loadPendingTransactions(owner?: TrackerTransactionOwner): Promise<PersistedTrackerTransactionRow[]>;
}
