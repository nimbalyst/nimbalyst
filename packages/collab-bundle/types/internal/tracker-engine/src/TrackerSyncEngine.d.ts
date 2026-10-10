/**
 * TrackerSyncEngine
 *
 * Client engine for the tracker metadata sync layer. Connects to a single
 * `TeamTrackerRoom` Durable Object over WebSocket, decrypts incoming
 * envelopes, projects them into the host's local store, and ships local
 * mutations through a four-state transaction queue.
 *
 * This is the phase-3 deliverable of the rewrite specified in
 * `design/Collaboration/tracker-sync-redesign.md`. The wire protocol lives
 * in `./trackerProtocol.ts`; the storage seam lives in
 * `./trackerPersistence.ts`; the AES-256-GCM helpers live in
 * `./trackerEnvelopeCodec.ts`.
 *
 * Platform notes
 * --------------
 * The engine is platform-neutral. It uses the `WebSocket` global, which
 * works in:
 *   - Electron main process (Node.js 22+ ships a built-in `WebSocket`).
 *   - Renderer / browser contexts (native `WebSocket`).
 *   - Mobile (Capacitor / iOS) once we wire it up.
 *
 * The Electron host adapter (`TrackerSyncManager`) instantiates one engine
 * per workspace and bridges it to PGLite + IPC.
 *
 * Lifecycle invariants
 * --------------------
 * - `connect()` opens the WebSocket, runs the bootstrap loop, then replays
 *   any persisted-but-unconfirmed transactions.
 * - All mutations go through the four-state queue (`created` -> `queued`
 *   -> `executing` -> ack). On reconnect, non-terminal rows in
 *   `loadPendingTransactions()` are re-driven.
 * - Encryption happens at the `executing` transition (not at enqueue),
 *   so a key rotation mid-queue uses the new key for the re-send.
 */
import type { SyncId, TrackerItemPayload, TrackerRoomConfig, TrackerTransactionRow, TrackerErrorMessage } from './trackerProtocol.js';
import { type TrackerAccessTermination } from './trackerAccessTermination.js';
import { type StrandedIdentityFacts } from './trackerIdentityRecovery.js';
import { type TrackerPersistence } from './trackerPersistence.js';
import { type TeamJwt, type TeamMemberId } from '@nimbalyst/collab-protocol';
export type TrackerSyncStatus = 'disconnected' | 'connecting' | 'syncing' | 'connected' | 'error';
/**
 * Material handed back to the host adapter for each item the engine
 * applied to the projection. `payload === null` indicates a tombstone.
 * The host typically forwards this to renderer atoms via IPC.
 */
export interface AppliedTrackerItem {
    itemId: string;
    syncId: SyncId;
    payload: TrackerItemPayload | null;
    isTombstone: boolean;
    issueNumber?: number;
    issueKey?: string;
}
/**
 * Material handed back when the server rejects a mutation. The engine
 * has already rolled back the optimistic projection and persisted
 * `lastRejection` on the transaction row.
 */
export interface RejectedTrackerMutation {
    clientMutationId: string;
    /** The item, view, entry or schema type the refusal is about. */
    itemId: string;
    /**
     * Which lane refused. Absent means the item lane, so existing consumers that
     * predate the other three keep reading the same shape.
     */
    lane?: 'item' | 'savedView' | 'navigation' | 'schema';
    rejection: NonNullable<TrackerTransactionRow['lastRejection']>;
}
export interface TrackerConfigSetResult {
    success: boolean;
    config?: TrackerRoomConfig;
    code?: string;
    message?: string;
    conflictingProjectName?: string;
    suggestedPrefix?: string;
}
/** Public, branded projection of one remote member viewing this tracker room. */
export interface TrackerPresenceParticipant {
    teamMemberId: TeamMemberId;
    displayName: string;
    avatarUrl: string | null;
}
/** The only identity fields a tracker connection publishes for presence. */
export interface TrackerPresenceIdentity {
    displayName: string;
    avatarUrl?: string | null;
}
export interface TrackerSchemaLocalChange {
    type: string;
    /** JSON-serialized TrackerDataModel, or null for a tombstone. */
    model: string | null;
    deleted: boolean;
    /**
     * A new type that must not replace a definition another client created.
     * `required`: never sent to a room that cannot refuse an existing type; it
     * settles as refused (`createOnlyUnsupported`) instead. `whenSupported`: an
     * older room gets the plain upsert it always got.
     */
    createOnly?: 'required' | 'whenSupported';
}
/** How the room answered one schema mutation this client sent. */
export interface TrackerSchemaMutationOutcome {
    type: string;
    model: string | null;
    accepted: boolean;
    error?: {
        code: string;
        message: string;
    };
}
export interface AppliedTrackerSchema {
    type: string;
    syncId: SyncId;
    model: string | null;
    isTombstone: boolean;
}
export interface TrackerSchemaSyncHooks {
    listUnsynced: () => Promise<TrackerSchemaLocalChange[]>;
    applyRemote: (def: {
        type: string;
        model: string | null;
        syncId: SyncId;
    }) => Promise<unknown>;
    /**
     * Retire a local change the server refused for good.
     *
     * This lane pushes whatever `listUnsynced` returns at the end of every
     * bootstrap, and a row leaves that queue only when `applyRemote` overwrites
     * it. Without this seam a settled refusal -- a read-only role, most often --
     * is re-sent on every single reconnect, forever. Optional so a host that has
     * no notion of a retired row simply keeps the old behaviour.
     */
    markRejected?: (type: string, code: string) => Promise<unknown>;
    /**
     * The room's answer to one mutation this client sent, matched by its own
     * mutation id. A broadcast of someone else's definition of the same type is
     * not an answer, which is why a pending creation must settle here and not in
     * `applyRemote`.
     */
    onSettled?: (outcome: TrackerSchemaMutationOutcome) => void;
}
export interface TrackerIdentityRecoveryHooks {
    /** Everything the plan needs except the bootstrap cursor, which the engine holds. */
    getFacts: () => Promise<Omit<StrandedIdentityFacts, 'localMaxSyncId'>>;
    /** Record that this workspace has had its one attempt. */
    markAttempted: () => Promise<void>;
}
export interface TrackerNavigationLocalChange {
    entryId: string;
    payload: string | null;
    deleted: boolean;
}
export interface TrackerNavigationSyncHooks {
    getMaxSyncId: () => Promise<SyncId>;
    listUnsynced: () => Promise<TrackerNavigationLocalChange[]>;
    applyRemote: (def: {
        entryId: string;
        payload: string | null;
        syncId: SyncId;
    }) => Promise<unknown>;
    /** Retire a refused change; see the note on `TrackerSchemaSyncHooks`. */
    markRejected?: (entryId: string, code: string) => Promise<unknown>;
}
export interface TrackerSavedViewLocalChange {
    viewId: string;
    payload: string | null;
    deleted: boolean;
}
/**
 * Team-shared saved views. Its own lane (and its own syncId cursor) rather
 * than riding the navigation channel, so "a shared view" stays a first-class
 * concept on the wire instead of an overloaded navigation entry.
 */
export interface TrackerSavedViewSyncHooks {
    getMaxSyncId: () => Promise<SyncId>;
    listUnsynced: () => Promise<TrackerSavedViewLocalChange[]>;
    applyRemote: (def: {
        viewId: string;
        payload: string | null;
        syncId: SyncId;
    }) => Promise<unknown>;
    /** Retire a refused change; see the note on `TrackerSchemaSyncHooks`. */
    markRejected?: (viewId: string, code: string) => Promise<unknown>;
}
export interface TrackerSyncEngineConfig {
    /** WebSocket server URL, e.g. `wss://sync.nimbalyst.com`. */
    serverUrl: string;
    /** B2B org ID; namespace prefix of the room ID. */
    orgId: string;
    /**
     * Server-minted UUID that names the tracker room (D8). Must be the value
     * pulled from `TeamState.metadata.teamProjectId`. Routing is keyed off
     * THIS, not `gitRemoteHash` -- per NIM-404 the old hash routing was
     * destructive.
     */
    teamProjectId: string;
    /** The current user's member id in this team organization. */
    teamMemberId: TeamMemberId;
    /** PGLite (or in-memory test) storage seam. */
    persistence: TrackerPersistence;
    /** Optional schema sync seam. Electron wires this to tracker_type_defs. */
    schemaSync?: TrackerSchemaSyncHooks;
    /** Optional shared tracker-sidebar navigation sync seam. */
    navigationSync?: TrackerNavigationSyncHooks;
    /** Optional team-shared saved-view sync seam. */
    savedViewSync?: TrackerSavedViewSyncHooks;
    /**
     * Prefix to install when the first bootstrap proves the tracker room is
     * empty and still has the historical NIM default. Existing rooms and custom
     * server prefixes are never changed.
     */
    initializeIssueKeyPrefix?: string;
    /**
     * Resolve a fresh team-scoped JWT. Called on every (re)connect AND
     * during reconnect retries -- the JWT can expire during long
     * disconnections.
     */
    getJwt: () => Promise<TeamJwt>;
    /**
     * Authoritative browser preflight against the same room gate as the upgrade.
     * A terminal result stops before a socket or cached projection is exposed;
     * thrown failures remain retryable.
     */
    authorizeConnection?: (jwt: TeamJwt) => Promise<TrackerAccessTermination | null>;
    /** Fires only after the authorized WebSocket has opened. */
    onAuthorized?: () => void;
    /** Ephemeral viewer identity. Member id always comes from the team JWT. */
    presenceIdentity?: TrackerPresenceIdentity;
    /** Connection-state transitions. */
    onStatusChange?: (status: TrackerSyncStatus) => void;
    /** Full remote-viewer roster after every join, update, leave, or disconnect. */
    onPresenceChange?: (members: readonly TrackerPresenceParticipant[]) => void;
    /** Fires for every applied projection row (remote OR self-originated). */
    onItemApplied?: (item: AppliedTrackerItem) => void;
    /** Fires when the server broadcasts a room-config change. */
    onConfigChange?: (config: TrackerRoomConfig) => void;
    /** Fires when a mutation was rejected and rolled back. */
    onRejection?: (rejection: RejectedTrackerMutation) => void;
    /** Fires for server diagnostics that are not item-mutation acknowledgements. */
    onServerError?: (error: TrackerErrorMessage) => void;
    /**
     * Fires once when the room refuses this client for good. Status is `error`
     * at this point and no reconnect is scheduled; the engine will not reconnect
     * again, so the host must state the reason rather than show a retry.
     */
    onAccessTerminated?: (termination: TrackerAccessTermination) => void;
    /** Fires for every applied schema definition (remote OR self-originated ack). */
    onSchemaApplied?: (schema: AppliedTrackerSchema) => void;
    /**
     * Fires when the bootstrap loop throws and is silently caught. Without
     * this hook the engine can sit at `syncing` indefinitely with no visible
     * symptom -- this surface lets the host adapter log it / show a banner /
     * decide to force a reconnect.
     */
    onBootstrapError?: (err: unknown) => void;
    /**
     * Repair for rows the old issue-key collision branch stranded. Optional: a
     * host that does not track stranded rows simply never runs the pass.
     */
    identityRecovery?: TrackerIdentityRecoveryHooks;
    /**
     * Epic H3 P1: fires when the server reports this tracker room was relocated
     * to another org by the move engine. The engine stops (the old room is
     * frozen/tombstoned); the host re-resolves routing and reconnects the
     * project to its new org-scoped room.
     */
    onRoomMoved?: (dest: {
        destOrgId: string;
        destTeamProjectId: string;
    }) => void;
    /**
     * Test seam: override the URL builder. The default appends `?token=...`
     * to a `/sync/<roomId>` path. Tests use this to drive `test_user_id` /
     * `test_org_id` bypass query params (matches the phase-2 harness).
     */
    buildUrl?: (roomId: string) => string;
    /**
     * Test seam: provide a custom WebSocket constructor. Defaults to the
     * `WebSocket` global. Lets tests inject the Node `ws` package, a mock,
     * or the `partysocket` reconnecting client used elsewhere.
     */
    createWebSocket?: (url: string) => WebSocket;
    /**
     * How long the schema bootstrap waits for one `trackerSchemaSyncResponse`
     * before giving up on the schema lane. Defaults to
     * {@link SCHEMA_BOOTSTRAP_TIMEOUT_MS}; tests shorten it.
     */
    schemaBootstrapTimeoutMs?: number;
}
export declare class TrackerSyncEngine {
    private readonly config;
    private readonly persistence;
    private ws;
    private status;
    /** Set once and never cleared: a refused client stays refused for this engine. */
    private accessTermination;
    private destroyed;
    private synced;
    private connecting;
    private suppressReconnect;
    /** Reconnect bookkeeping. */
    private reconnectAttempt;
    private reconnectTimer;
    /** Keep-alive ping. */
    private pingTimer;
    /** Remote viewers only; the local authenticated member is excluded. */
    private readonly presence;
    /**
     * Rollback snapshots keyed by `clientMutationId`. Held in-memory only;
     * persisted state is captured in `tracker_transactions.payload` so we
     * could rebuild these if needed, but in practice the engine instance
     * lives for the duration of any given mutation's lifecycle so this
     * map is sufficient.
     */
    /**
     * clientMutationId -> the saved view / navigation entry / schema type it is
     * about. Rejection acks on those lanes carry only the mutation id, so this is
     * the only way to know what the server refused. Entries are removed on the
     * matching ack, so it holds at most the in-flight pushes.
     */
    private readonly pendingLaneIds;
    private schemaApplyChain;
    private readonly schemaOutbox;
    /** Whether this connection's room advertised `schemaCreateOnly`; re-learned every bootstrap. */
    private schemaCreateOnlySupported;
    private readonly rollbackSnapshots;
    /** Set once `consolidatePendingUpdates` has run for this engine. */
    private outboxConsolidated;
    private readonly pendingConfigChanges;
    constructor(config: TrackerSyncEngineConfig);
    /**
     * Open the WebSocket and run the bootstrap loop. Idempotent: calling
     * `connect()` while already connected is a no-op.
     */
    connect(): Promise<void>;
    /** Re-run the room gate when the browser hides a failed upgrade's HTTP status. */
    private revalidateFailedUpgrade;
    /** Disconnect without scheduling a reconnect. */
    disconnect(): void;
    /**
     * Stop for good, because this client may not be in this room.
     *
     * Called by the engine itself for a terminal close code, and by a host that
     * learned the same thing before a socket existed -- notably a team JWT that
     * cannot be minted because the browser session expired, which otherwise
     * retries silently forever and presents as an empty tracker rather than as
     * being signed out.
     */
    terminateAccess(termination: TrackerAccessTermination): void;
    /** The refusal that stopped this engine, or null while it is still trying. */
    getAccessTermination(): TrackerAccessTermination | null;
    /** Teardown shared by an ordinary disconnect and a terminal refusal. */
    private closeSocket;
    /** Destroy the engine. Cannot be reused after this. */
    destroy(): void;
    /** Current connection status. */
    getStatus(): TrackerSyncStatus;
    /** Current remote-viewer roster. Returns a defensive snapshot. */
    getPresence(): TrackerPresenceParticipant[];
    /** Flush locally-pending shared saved views while connected. */
    flushSavedViews(): Promise<void>;
    /** Flush locally-pending tracker navigation entries while connected. */
    flushNavigation(): Promise<void>;
    /** Push a schema saved mid-session; before bootstrap finishes, bootstrap pushes it (NIM-6654). */
    flushSchemas(): Promise<void>;
    /**
     * Optimistically apply an upsert locally and enqueue it for upload.
     *
     * @param payload The full decrypted item payload. Device-local fields
     *   (`linkedSessions` etc.) are stripped at encryption time, not here.
     * @param options.persistedEnqueue When true, the apply + enqueue happen
     *   in a single SQL transaction (`TrackerPersistence.applyAndEnqueueAtomically`).
     */
    upsertItem(payload: TrackerItemPayload, options?: {
        persistedEnqueue?: boolean;
    }): Promise<{
        clientMutationId: string;
    }>;
    /** Optimistically apply and send an update-many command as one coherent batch. */
    upsertItems(payloads: readonly TrackerItemPayload[]): Promise<{
        clientMutationIds: string[];
    }>;
    /**
     * Optimistically apply a delete (tombstone) and enqueue it for upload.
     */
    deleteItem(itemId: string, options?: {
        persistedEnqueue?: boolean;
    }): Promise<{
        clientMutationId: string;
    }>;
    /**
     * Push a room-level config change (currently: issue-key prefix). Server
     * broadcasts the change to all connections including the originator
     * via `trackerConfigBroadcast` -- the engine surfaces it through
     * `onConfigChange`.
     */
    setIssueKeyPrefix(prefix: string, assignmentMode?: 'auto' | 'explicit'): Promise<TrackerConfigSetResult>;
    private runBootstrap;
    /**
     * Re-request a span of the changelog for rows the old collision branch
     * stranded without an issue key.
     *
     * Those rows are `synced` and carry a `sync_id`, so the ordinary bootstrap
     * -- which starts at `MAX(sync_id)` -- can never reach them again. See
     * `trackerIdentityRecovery.ts` for why, and for the pure decision this only
     * executes.
     *
     * The attempt is marked whether or not it succeeds. The alternative, marking
     * only on success, retries a multi-thousand-row rewind on every launch for
     * any workspace whose rows the room cannot re-assert, which is a worse
     * failure than one repair that did not take. A workspace stuck that way is
     * diagnosable from the warning below.
     */
    private runIdentityRecovery;
    private requestSync;
    /**
     * Bootstrap schemas from ZERO, not from the local cursor.
     *
     * Items page from `MAX(sync_id)` because there can be tens of thousands of
     * them. Schemas are a handful of rows, and an incremental cursor makes the
     * client unrepairable: one workspace-wide MAX means any type whose version
     * sits BELOW the cursor is never re-sent, so a row that was clobbered or
     * never applied stays stale forever with no way back (#1178). A full snapshot
     * every connect is cheap and makes the server's definition self-healing --
     * `applyRemote` is version-gated and content-gated, so re-delivering what we
     * already have is a no-op.
     */
    private runSchemaBootstrap;
    private requestSchemaSync;
    private applySchemaBootstrapBatch;
    private runNavigationBootstrap;
    private runSavedViewBootstrap;
    private requestSavedViewSync;
    private requestNavigationSync;
    private applyBootstrapBatch;
    private replayPending;
    private handleMessage;
    /**
     * Epic H3 P1: the server reports this room was relocated to another org. The
     * old room is frozen/tombstoned, so stop reconnecting and hand the
     * destination to the host, which re-resolves routing (the project now lives
     * at a new org-scoped room) and spins up a fresh engine pointed there.
     */
    private handleRoomMoved;
    private handleDelta;
    private handleAck;
    private handleBatchAck;
    private handleSchemaDelta;
    private handleSchemaAck;
    private handleSavedViewDelta;
    private handleSavedViewAck;
    /**
     * Retire a saved-view / navigation / schema change the server has settled on,
     * and tell the host.
     *
     * Only *terminal* codes retire the row. A write barrier like `rotationLocked`
     * or a missing key is temporary, and dropping the user's change on one would
     * turn a momentary refusal into silent data loss -- so anything not in the
     * tracker-specific permanent vocabulary stays queued and is retried, exactly
     * as before. Tracker codes deliberately do not inherit the document outbox
     * policy: `adminRequired`, `malformed`, and `legacy_encryption_retired` exist
     * only here and replaying them cannot make the payload valid.
     */
    private retireRefusedLaneChange;
    private handleNavigationDelta;
    private handleNavigationAck;
    private handleConfigBroadcast;
    private handlePresenceRoster;
    private handlePresenceDelta;
    private notifyPresenceChange;
    private handleServerError;
    private resolvePendingConfigChanges;
    /**
     * Decrypt (if needed) and project a server envelope. Tolerant of
     * per-item decryption failures: a single unreadable envelope (e.g. a
     * stale-key-epoch payload arriving before our `staleKeyEpoch` rejection
     * has triggered a refresh) is skipped, not fatal.
     *
     * Returns `true` when the envelope was applied (or was a tombstone), and
     * `false` when decryption failed and the row was skipped. Callers use
     * this signal to detect a stale-key bootstrap and trigger `refreshKey()`.
     */
    private applyEnvelope;
    /**
     * Socket messages are dispatched without awaiting each other, and a host's
     * `applyRemote` awaits file writes. Unserialized, an older delivery can finish
     * after a newer one and leave the older content and syncId in place.
     */
    private applySchemaEnvelope;
    private applySchemaEnvelopeNow;
    private applySavedViewEnvelope;
    private applyNavigationEnvelope;
    private enqueueMutation;
    /**
     * Move a transaction through the wire. If the socket is closed, leave
     * the row in `queued` for the next reconnect. Encryption happens HERE,
     * not at enqueue, so a key rotation between enqueue and send uses the
     * fresh key.
     */
    private driveTransaction;
    private driveTransactionBatch;
    private pushPendingSavedViews;
    private pushPendingNavigation;
    private send;
    private setStatus;
    private handleDisconnect;
    private recordAccessTermination;
    private scheduleReconnect;
    private cancelReconnect;
    private startPing;
    private announcePresence;
    private stopPing;
}
