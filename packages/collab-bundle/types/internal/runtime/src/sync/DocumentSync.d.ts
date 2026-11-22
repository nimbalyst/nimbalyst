/**
 * DocumentSyncProvider
 *
 * Client-side Yjs document sync over WebSocket. Connects to a DocumentRoom
 * Durable Object, sends/receives Yjs updates, and manages awareness state.
 *
 * Custody is server-managed: team documents are PLAINTEXT over TLS, the
 * server holds the team DEK and encrypts at rest, and the client holds no
 * team key. `encodeForWire` is a base64 pass-through. The wire field is
 * still named `encrypted` and the local replica on disk IS genuinely
 * encrypted -- wire and at-rest are different axes. Before changing
 * anything named `encrypt*` here, read the lane table in
 * docs/IDENTITY_AUTH_AND_ROOMS.md section 6.
 *
 * The provider:
 * - Attaches to a LocalDocumentReplica/Y.Doc (or creates one for back-compat)
 * - Encodes outgoing Yjs updates for the wire and applies inbound ones
 * - Handles sync (initial load), realtime broadcasts, and awareness
 *
 * Remote updates merge and land like any other CRDT update -- a shared room is
 * shared, so there is no per-collaborator accept/reject step. Recovering an
 * earlier state is an explicit user action (resync / restore), not a gate on
 * every inbound edit.
 */
import * as Y from 'yjs';
import type { DocumentDecisionCommand, DocumentDecisionDeliveryState, DocumentDecisionAuthority, DocumentDecisionResult } from '@nimbalyst/collab-protocol';
import type { DocumentSyncConfig, DocumentSyncStatus, AwarenessState } from './documentSyncTypes';
/**
 * The room's refusal of a commenter update that changed more than the comment
 * threads. Mirrors collabv3 `documentBody/commentOnlyUpdate.ts`.
 */
export declare const COMMENT_UPDATE_REFUSED_CODE = "document_comment_update_refused";
export declare const COMMENT_UPDATE_REFUSED_CLOSE = 4009;
/**
 * Sent on an open socket when its user is demoted from editor to commenter.
 * Mirrors collabv3 `COMMENT_ONLY_VERDICT_CODE`.
 */
export declare const COMMENT_ONLY_VERDICT_CODE = "document_comment_only";
/**
 * Sent on an open socket when its user gains body write (a commenter granted
 * project-editor). May be resent after hibernation to a socket that already
 * writes.
 */
export declare const WRITABLE_VERDICT_CODE = "document_writable";
/** The room's per-connection verdict from `docSyncResponse`. */
export interface DocumentAccessVerdict {
    canWrite: boolean;
    /** Null from a server that predates the comment tier. */
    canComment: boolean | null;
}
export declare class DocumentSyncProvider {
    private ydoc;
    private readonly ownsYDoc;
    private ws;
    private config;
    private readonly memberId;
    private status;
    private lastSeq;
    private lastSyncRequestSeq;
    private serverCapability;
    private cursorLagRecordedForConnection;
    private synced;
    private lastWriterUserId;
    /**
     * The room's write verdict from the latest sync response; null until one
     * arrives or from a server that predates it. False for read-only viewers and
     * commenters, whose `docCompact` the room refuses (a commenter's with
     * `document_comment_forbidden`; the socket stays open, but the compaction
     * is wasted).
     */
    private serverCanWrite;
    /** The room's comment verdict from the latest sync response; null when absent. */
    private serverCanComment;
    private accessVerdictListeners;
    /**
     * Set when the room refused a commenter's update for changing more than the
     * comment threads (`document_comment_update_refused`, close 4009). Terminal
     * for this provider: Yjs updates from one clientID are clock-sequential, so
     * every later update from this Y.Doc depends on the refused structs and the
     * room can never integrate it. The provider stops and never reconnects or
     * resends; the host discards the local copy and reopens with a fresh Y.Doc.
     */
    private commentUpdateRefused;
    private commentRefusalListeners;
    private commentRefusalSettling;
    private lastUpdatedAt;
    private updateObserverDispose;
    private awarenessStates;
    private awarenessTimestamps;
    private awarenessListeners;
    private statusListeners;
    private destroyed;
    private pendingAwareness;
    private awarenessThrottleTimer;
    private lastAwarenessSendTime;
    private awarenessCleanupTimer;
    private reconnectAttempt;
    private reconnectTimer;
    private suppressReconnect;
    /**
     * NIM-949: set when the server rejected the ws upgrade with an auth-style
     * status (proxy forwards a close reason of `auth-rejected:<status>`). The next
     * connect() then requests a freshly-exchanged JWT instead of replaying the
     * cached (wrong-org / expired) token that just got rejected.
     */
    private forceJwtRefreshNextConnect;
    /**
     * Upgrade-rejection status from the most recent close, or null if the last
     * close wasn't an auth rejection.
     *
     * Lets a caller that connects for one bounded operation (the headless seed)
     * distinguish "the server refused this room" from "still connecting" instead
     * of polling `getStatus()` until its timeout expires. A 404 here means the
     * document id is not in the org's index yet (NIM-2472).
     */
    private lastAuthRejectionStatus;
    private queuedPendingUpdate;
    private inflightPendingUpdate;
    private pendingPersistTimer;
    private replayAckTimer;
    private replayingClientUpdateId;
    private replayingReplicaOutboxIds;
    private replayStartedAt;
    private replayAttemptCount;
    private surfaceReplayStatus;
    private pendingWriteWaiters;
    private static readonly RECONNECT_BASE_MS;
    private static readonly RECONNECT_MAX_MS;
    private static readonly REPLAY_ACK_TIMEOUT_MS;
    /**
     * Server sequence covered by the latest snapshot we know about. Updated
     * when (a) we apply a server snapshot during sync, and (b) the server
     * acknowledges our own `docCompact`. Used to compute how many updates have
     * accumulated.
     */
    private lastSnapshotSeq;
    private pendingCompactionId;
    private compactionAckTimer;
    private static readonly COMPACTION_ACK_TIMEOUT_MS;
    /**
     * Resolver for an in-flight `forceReplaceServerState` awaiting its
     * `docCompactAck`. Distinct from routine compaction (which is fire-and-forget)
     * because the recovery caller must know whether the server accepted the
     * replacement snapshot.
     */
    private forceReplaceWaiter;
    private forceReplaceCounter;
    /**
     * True once ANY snapshot/update/broadcast failed to decode and was skipped
     * (the NIM-878 tolerant-skip). `lastSeq` still advances past skipped rows, so
     * this doc is missing server content it can never re-fetch on this provider
     * (resync resumes from `lastSeq`). While set, this client must NEVER win
     * compaction: a `docCompact` of an incomplete doc buries the unread rows
     * behind `replacesUpTo` for every client and prune later deletes them
     * (NIM-1519). Deliberately never reset for the provider's lifetime.
     *
     * The trigger is "content we do not hold", NOT "something threw while
     * applying". A Y.Doc listener that throws AFTER `Y.applyUpdate` integrated
     * the update (an editor binding hitting an unregistered node type, say) does
     * not set this flag: yjs commits the transaction and then calls observers via
     * `lib0/function.callAll`, which runs every listener and rethrows at the end,
     * so the CRDT already holds the full update. Vetoing compaction there would
     * degrade a whole room's sync on the strength of a client-side rendering bug.
     * See `applyDecodedUpdate` for how the two are told apart.
     */
    private skippedUndecodablePayload;
    private lastCompactionAttemptAt;
    private compactionTimer;
    constructor(config: DocumentSyncConfig);
    /**
     * Connect to the DocumentRoom and begin syncing.
     */
    private connecting;
    connect(): Promise<void>;
    /**
     * Disconnect from the DocumentRoom.
     */
    disconnect(): void;
    /** Destroy this network attachment. Externally supplied Y.Docs survive. */
    destroy(): void;
    /** Get the Y.Doc managed by this provider. */
    getYDoc(): Y.Doc;
    /**
     * The room-authenticated member id of whoever last applied a content update, or null if
     * the doc has no updates yet / the server hasn't reported it. Populated from
     * the server's docSyncResponse. Reflects the last *content* edit.
     */
    getLastWriterUserId(): string | null;
    /** When the last content update was applied (server clock, ms), or null. */
    getLastUpdatedAt(): number | null;
    /** Check if connected and synced. */
    isConnected(): boolean;
    /** Check if initial sync is complete. */
    isSynced(): boolean;
    /** Get current connection status. */
    getStatus(): DocumentSyncStatus;
    /**
     * HTTP status of the most recent upgrade rejection, or null when the last
     * close wasn't one. 404 means the server does not consider this document to
     * exist for this user -- for a freshly created document, that its index row
     * has not landed yet (NIM-2472).
     */
    getLastAuthRejectionStatus(): number | null;
    /** Get the last known server sequence number. */
    getLastSeq(): number;
    /**
     * True when any snapshot/update/broadcast was skipped as undecodable this
     * provider's lifetime. While true, the Y.Doc looking "empty" does NOT mean
     * the room is empty — server content exists that this client cannot read.
     * Hosts must gate first-open seeding on this (seeding a default document
     * over unreadable-but-real content clobbers it for every client) and this
     * provider will never compact (NIM-1519).
     */
    hasUndecodedContent(): boolean;
    /**
     * Wait until all local writes have either been acknowledged or timed out.
     * Returns false when the timeout elapses first.
     */
    waitForPendingWrites(timeoutMs?: number): Promise<boolean>;
    /** Synchronous close guard; only a server acknowledgement clears unsettled writes. */
    hasPendingWrites(): boolean;
    /**
     * Set room-level metadata on the server (e.g., custom TTL).
     * Only allowlisted keys are accepted server-side.
     */
    setRoomMetadata(entries: Record<string, string>): void;
    /**
     * Encode bytes for the wire: pass-through (base64 raw bytes, empty-string iv
     * sentinel). The server encrypts at rest with the team DEK; the client holds
     * no team key.
     */
    private encodeForWire;
    /**
     * Decode bytes from the wire.
     *
     * The server decrypts rows it owns and sends them as PLAINTEXT with the
     * empty-iv sentinel (''). A NON-EMPTY iv means the row is pre-cutover
     * ciphertext from the retired client-managed lane: no supported client holds
     * the key for it, so throw rather than hand Yjs bytes that decode to garbage.
     * The per-payload catch skips just that row instead of blanking the document.
     */
    private decodeFromWire;
    private sendAwarenessImmediately;
    /**
     * Send awareness state to other connected clients. Awareness is plaintext
     * over TLS now that team custody is server-managed; the empty-iv sentinel
     * keeps the wire shape unchanged.
     * Sends immediately (no throttling). Use setLocalAwareness() for throttled updates.
     */
    sendAwareness(state: AwarenessState): Promise<void>;
    /**
     * Synchronously put an additive departure marker on the open socket.
     *
     * This deliberately bypasses both the 500ms awareness throttle and the
     * async encodeForWire seam: awareness is already plaintext-over-TLS with
     * an empty IV. Teardown can therefore send this frame before closing the
     * socket, including from pagehide where awaiting is unreliable.
     */
    sendAwarenessDeparture(user: AwarenessState['user']): boolean;
    /**
     * Set local awareness state with throttling (~2Hz).
     * Coalesces rapid updates (e.g., cursor movements while typing) and sends
     * at most once per AWARENESS_THROTTLE_MS.
     */
    setLocalAwareness(state: AwarenessState): void;
    private flushAwareness;
    private clearAwarenessThrottle;
    /**
     * Subscribe to awareness state changes from remote users.
     * Returns an unsubscribe function.
     */
    onAwarenessChange(callback: (states: Map<string, AwarenessState>) => void): () => void;
    /**
     * Get current awareness states for all remote users.
     */
    getAwarenessStates(): Map<string, AwarenessState>;
    /**
     * Subscribe to transport status changes. Returns an unsubscribe function.
     *
     * `DocumentSyncConfig.onStatusChange` is a single slot owned by whichever
     * host constructed the provider. This is the multi-listener seam for things
     * that attach to an already-built provider -- the extension awareness bridge
     * needs it to re-announce presence when a reconnect completes.
     */
    onStatusChange(listener: (status: DocumentSyncStatus) => void): () => void;
    /**
     * The room's latest write/comment verdict for this connection, or null until
     * a sync response carries one (or from a server that predates it).
     */
    getServerAccessVerdict(): DocumentAccessVerdict | null;
    /**
     * Called with every verdict a sync response carries, and immediately with
     * the current one if already known. The room is the authority: a host's own
     * role projection can be stale.
     */
    onAccessVerdict(listener: (verdict: DocumentAccessVerdict) => void): () => void;
    /** True once the room refused a commenter update; see `commentUpdateRefused`. */
    isCommentUpdateRefused(): boolean;
    /**
     * Called once when the room refuses a commenter update (immediately if it
     * already has). The provider has stopped; the host should discard the local
     * copy and reopen the document with a fresh provider and Y.Doc.
     */
    onCommentUpdateRefused(listener: () => void): () => void;
    /**
     * Force the provider to treat the current Y.Doc as local state that should
     * be persisted upstream.
     *
     * Used by custom-editor collaboration bootstrap after a first-open seed from
     * in-memory share payloads. This avoids depending on observer/replay timing
     * when the seed happens after the initial empty sync completes.
     *
     * @deprecated Fire-and-forget: this resolves after the socket write, NOT
     * after the server confirms persistence, so a teardown immediately after can
     * lose the seed (the mindmap seed data-loss race). Prefer {@link flushWithAck},
     * which awaits a server-persisted `docUpdateAck`.
     */
    flushLocalState(): Promise<void>;
    /**
     * Flush the current Y.Doc state upstream and resolve ONLY after the server
     * acknowledges persistence (`docUpdateAck`), not merely after the socket
     * write. This is the durability guarantee for first-open seeds and headless
     * re-uploads: content the user sees locally must reach the server before the
     * provider tears down.
     *
     * Returns `true` when the server ack'd within `timeoutMs`, `false` on timeout
     * or when not connected/synced — the caller decides whether to warn / retry
     * rather than silently discarding the seed. An empty doc (encoded state
     * <= 2 bytes) resolves `true` immediately (nothing to persist).
     *
     * The server-ack semantics come from `waitForPendingWrites`, which settles
     * only once the inflight `docUpdate` is cleared by a matching `docUpdateAck`
     * (the DocumentRoom persists synchronously to DO storage before acking).
     */
    flushWithAck(timeoutMs?: number): Promise<boolean>;
    private readonly decisionClient;
    requestDecision(command: DocumentDecisionCommand): Promise<DocumentDecisionResult>;
    getDecisionState: () => DocumentDecisionDeliveryState[];
    onDecisionState: (listener: (state: DocumentDecisionDeliveryState[], authority: DocumentDecisionAuthority) => void) => (() => void);
    private requestSync;
    private handleMessage;
    /**
     * Apply already-decrypted bytes to the Y.Doc, separating the two very
     * different ways `Y.applyUpdate` can throw:
     *
     *  - `integrated: false` -- the bytes could not be read/integrated. The
     *    payload is bad and the Y.Doc may hold only part of it.
     *  - `integrated: true` -- the update was fully integrated into the CRDT and
     *    then a Y.Doc *listener* threw (e.g. an editor binding hitting an
     *    unregistered node type). The document content is complete; the failure
     *    is downstream of sync.
     *
     * The discriminator is exact rather than heuristic. `Y.applyUpdate` opens its
     * own transaction; nesting it inside one of ours makes the inner call a no-op
     * nest (yjs reuses the open transaction), so observers fire only when the
     * OUTER transaction unwinds. `integrated` is therefore set if and only if
     * `readUpdate` completed, before any observer has run. `local: false` matches
     * what `applyUpdate` sets on the transaction itself.
     */
    private applyDecodedUpdate;
    /** Matches the shape the existing skip logs pass as their second argument. */
    private static logDetail;
    private handleSyncResponse;
    private handleUpdateBroadcast;
    private handleAwarenessBroadcast;
    /**
     * Watch the Y.Doc for local updates and send them to the server.
     */
    private setupUpdateObserver;
    private teardownUpdateObserver;
    private notifyContentChanged;
    private send;
    private getRoomId;
    private enqueuePendingLocalUpdate;
    private setStatus;
    /**
     * After initial sync, check if the local Y.Doc has content that the
     * server doesn't know about. This happens when content was bootstrapped
     * locally (e.g., initial share seeding) before the WebSocket connected,
     * or when a previous connection failed after bootstrap but before the
     * update could be sent.
     *
     * We compute the diff between what the server sent us and our local state
     * and send it as an update.
     */
    private pushLocalState;
    private replayPendingUpdate;
    private handleUpdateAck;
    private handleWriteRejection;
    private schedulePendingPersist;
    private flushPendingPersistImmediately;
    private persistLegacyPendingUpdate;
    private setServerAccessVerdict;
    private markCommentUpdateRefused;
    private handleDisconnect;
    private hasPendingLocalUpdates;
    private hasUnsettledPendingWrites;
    private notifyPendingWriteWaiters;
    private getMergedPendingUpdate;
    private requeueInflightPendingUpdate;
    private finishReplayingPendingUpdate;
    private scheduleReconnect;
    private cancelReconnect;
    /**
     * Immediately reconnect, cancelling any pending backoff and resetting attempts.
     * Called externally when the network has been confirmed available (e.g. after
     * the CollabV3 index has reached `synced`). This intentionally tears down any
     * existing socket first: after sleep/wake a WebSocket can remain "open" while
     * the underlying transport is dead, and a forced reconnect is cheaper than
     * waiting for that zombie socket to notice.
     *
     * Falls back to normal backoff on failure.
     */
    reconnectNow(): void;
    private scheduleReplayAckTimeout;
    private clearReplayAckTimer;
    /**
     * Start periodic cleanup of stale remote awareness states.
     * Removes entries from users who haven't sent an update recently.
     */
    private startAwarenessCleanup;
    private stopAwarenessCleanup;
    private notifyAwarenessListeners;
    private startCompactionTimer;
    private stopCompactionTimer;
    /**
     * Lowest scoped member id wins. Awareness misses (a connected member who hasn't sent
     * awareness yet) can briefly cause both candidates to elect themselves;
     * the server tolerates duplicate snapshots (older row is dropped by
     * `DELETE FROM snapshots WHERE replaces_up_to < ?`).
     */
    private amCompactionElector;
    private maybeCompact;
    private sendCompactionSnapshot;
    /**
     * Deliberately replace the server's authoritative state for this room with the
     * CURRENT local Y.Doc, dropping every prior server row -- including rows this
     * client could not decrypt. This is the recovery override for a room whose
     * server state became undecryptable (backup review HIGH finding 1): after a
     * plaintext backup is applied into the otherwise-empty Y.Doc, this promotes it
     * to the sole authoritative snapshot via `docCompact(replacesUpTo = lastSeq)`.
     *
     * Unlike routine compaction it bypasses the `hasUndecodedContent()` guard --
     * that guard protects against ACCIDENTALLY burying unreadable rows, but here
     * discarding them is the whole point. It still refuses an empty snapshot so a
     * blank Y.Doc can never wipe a room. Resolves true once the server acks.
     */
    forceReplaceServerState(timeoutMs?: number): Promise<boolean>;
    /**
     * Finalize a successfully decoded pre-migration room under server-managed
     * custody. Unlike the disaster-recovery override above, this refuses to bury
     * any payload the client could not decrypt. Empty Y.Docs are allowed because
     * a decoded-but-empty legacy room still needs a current DEK snapshot.
     */
    finalizeServerManagedState(timeoutMs?: number): Promise<boolean>;
    private sendAuthoritativeSnapshot;
    private handleCompactionAck;
    private scheduleCompactionAckTimeout;
    private clearCompactionAckTimer;
}
/**
 * Create a DocumentSyncProvider instance.
 */
export declare function createDocumentSyncProvider(config: DocumentSyncConfig): DocumentSyncProvider;
