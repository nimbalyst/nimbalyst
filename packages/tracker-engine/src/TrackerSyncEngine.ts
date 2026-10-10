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

import type {
  TrackerItemEnvelope,
  SyncId,
  TrackerClientMessage,
  TrackerServerMessage,
  TrackerMutationAckMessage,
  TrackerMutationBatchAckMessage,
  TrackerItemPayload,
  TrackerRoomConfig,
  TrackerSyncResponseMessage,
  TrackerDeltaMessage,
  TrackerConfigBroadcastMessage,
  TrackerTransactionRow,
  TrackerSchemaEnvelope,
  TrackerSchemaSyncResponseMessage,
  TrackerSchemaDeltaMessage,
  TrackerSchemaMutationAckMessage,
  TrackerNavigationEnvelope,
  TrackerNavigationSyncResponseMessage,
  TrackerNavigationDeltaMessage,
  TrackerNavigationMutationAckMessage,
  TrackerSavedViewEnvelope,
  TrackerSavedViewSyncResponseMessage,
  TrackerSavedViewDeltaMessage,
  TrackerSavedViewMutationAckMessage,
  TrackerPresenceRosterMessage,
  TrackerPresenceDeltaMessage,
  TrackerRoomMovedMessage,
  TrackerErrorMessage,
  TrackerMutationRejectCode,
} from './trackerProtocol.js';
import { SYNC_ID_INITIAL, buildTrackerRoomId } from './trackerProtocol.js';
import { appendSyncClientParams } from '@nimbalyst/collab-protocol';
import {
  encodeTrackerPayloadPlaintext,
  decodeTrackerEnvelopePlaintext,
  decodeTrackerSchemaEnvelopePlaintext,
  decodeTrackerNavigationEnvelopePlaintext,
  decodeTrackerSavedViewEnvelopePlaintext,
} from './trackerEnvelopeCodec.js';
import { classifyTrackerClose, type TrackerAccessTermination } from './trackerAccessTermination.js';
import { TrackerSchemaOutbox } from './trackerSchemaOutbox.js';
import { generateClientMutationId, parseServerMessage } from './trackerWireHelpers.js';
import {
  planTrackerIdentityRecovery,
  type StrandedIdentityFacts,
  type TrackerIdentityRecoveryPlan,
} from './trackerIdentityRecovery.js';
import {
  isPermanentTrackerRejection,
  type PersistedTrackerTransactionRow,
  type TrackerPersistence,
  type TrackerRowSnapshot,
  type TrackerTransactionOwner,
} from './trackerPersistence.js';
import { asTeamMemberId, type TeamJwt, type TeamMemberId } from '@nimbalyst/collab-protocol';

// ============================================================================
// Public types
// ============================================================================

export type TrackerSyncStatus =
  | 'disconnected'
  | 'connecting'
  | 'syncing'
  | 'connected'
  | 'error';

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
  error?: { code: string; message: string };
}

export interface AppliedTrackerSchema {
  type: string;
  syncId: SyncId;
  model: string | null;
  isTombstone: boolean;
}

export interface TrackerSchemaSyncHooks {
  // No `getMaxSyncId`: schemas bootstrap from zero every connect so the server's
  // definition can repair a diverged row. See runSchemaBootstrap (#1178).
  listUnsynced: () => Promise<TrackerSchemaLocalChange[]>;
  applyRemote: (def: { type: string; model: string | null; syncId: SyncId }) => Promise<unknown>;
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
  applyRemote: (def: { entryId: string; payload: string | null; syncId: SyncId }) => Promise<unknown>;
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
  applyRemote: (def: { viewId: string; payload: string | null; syncId: SyncId }) => Promise<unknown>;
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

  // --- Observers (all optional) -------------------------------------------

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
  onRoomMoved?: (dest: { destOrgId: string; destTeamProjectId: string }) => void;

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

// ============================================================================
// Constants
// ============================================================================

/** Exponential backoff for reconnect. Matches DocumentSync. */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Keep-alive cadence. */
const PING_INTERVAL_MS = 30_000;

/**
 * How long the schema bootstrap waits for a `trackerSchemaSyncResponse`.
 *
 * The schema lane runs BEFORE items so the team's definitions are in place when
 * rows land -- which also means an unanswered `trackerSchemaSync` (a server too
 * old to implement it, say) would hang the whole bootstrap and leave a fresh
 * client with an empty tracker. Bounded, the same failure degrades to "items
 * load, schemas are whatever this machine already knows".
 */
const SCHEMA_BOOTSTRAP_TIMEOUT_MS = 15_000;

/** Thrown by a bootstrap request whose response never arrived. */
class SyncRequestTimeoutError extends Error {}

// ============================================================================
// TrackerSyncEngine
// ============================================================================

export class TrackerSyncEngine {
  private readonly config: TrackerSyncEngineConfig;
  private readonly persistence: TrackerPersistence;

  private ws: WebSocket | null = null;
  private status: TrackerSyncStatus = 'disconnected';
  /** Set once and never cleared: a refused client stays refused for this engine. */
  private accessTermination: TrackerAccessTermination | null = null;
  private destroyed = false;
  private synced = false;
  private connecting = false;
  private suppressReconnect = false;

  /** Reconnect bookkeeping. */
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Keep-alive ping. */
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Remote viewers only; the local authenticated member is excluded. */
  private readonly presence = new Map<TeamMemberId, TrackerPresenceParticipant>();

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
  private readonly pendingLaneIds = new Map<string, string>();

  private schemaApplyChain: Promise<unknown> = Promise.resolve();

  private readonly schemaOutbox = new TrackerSchemaOutbox({
    hooks: () => this.config.schemaSync,
    isOpen: () => this.ws?.readyState === WebSocket.OPEN,
    send: (message) => this.send(message),
    newMutationId: generateClientMutationId,
    pendingLaneIds: this.pendingLaneIds,
    createOnlySupported: () => this.schemaCreateOnlySupported,
  });
  /** Whether this connection's room advertised `schemaCreateOnly`; re-learned every bootstrap. */
  private schemaCreateOnlySupported = false;

  private readonly rollbackSnapshots = new Map<string, {
    itemId: string;
    snapshot: TrackerRowSnapshot;
  }>();

  /** Set once `consolidatePendingUpdates` has run for this engine. */
  private outboxConsolidated = false;

  private readonly pendingConfigChanges = new Map<string, {
    requestedPrefix: string;
    resolve: (result: TrackerConfigSetResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(config: TrackerSyncEngineConfig) {
    this.config = config;
    this.persistence = config.persistence;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Open the WebSocket and run the bootstrap loop. Idempotent: calling
   * `connect()` while already connected is a no-op.
   */
  async connect(): Promise<void> {
    if (this.destroyed) return;
    // Do not fake recovery. The room has already refused this client with a
    // terminal code; dialling it again can only be refused the same way, and a
    // surface watching `status` would flicker back to `connecting` and imply
    // that waiting might help.
    if (this.accessTermination) return;
    if (this.ws || this.connecting) return;

    this.suppressReconnect = false;
    this.connecting = true;
    this.setStatus('connecting');

    const roomId = buildTrackerRoomId(this.config.orgId, this.config.teamProjectId);

    let url: string;
    try {
      if (this.config.buildUrl) {
        url = this.config.buildUrl(roomId);
      } else {
        const jwt = await this.config.getJwt();
        const termination = await this.config.authorizeConnection?.(jwt) ?? null;
        if (termination) {
          this.connecting = false;
          this.recordAccessTermination(termination);
          return;
        }
        url = appendSyncClientParams(`${this.config.serverUrl}/sync/${roomId}?token=${encodeURIComponent(jwt)}`);
      }
    } catch (err) {
      this.connecting = false;
      this.setStatus('error');
      if (!this.accessTermination) this.scheduleReconnect();
      throw err;
    }

    if (this.destroyed || this.ws) {
      this.connecting = false;
      return;
    }

    const ws = this.config.createWebSocket
      ? this.config.createWebSocket(url)
      : new WebSocket(url);
    this.ws = ws;
    this.connecting = false;
    let opened = false;
    let upgradeCheckStarted = false;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      opened = true;
      this.config.onAuthorized?.();
      this.suppressReconnect = false;
      this.reconnectAttempt = 0;
      this.setStatus('syncing');
      this.startPing();
      void this.runBootstrap();
    });

    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return;
      void this.handleMessage(event);
    });

    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return;
      const closeEvent = event as CloseEvent;
      const termination = classifyTrackerClose(closeEvent?.code ?? 0, closeEvent?.reason ?? '');
      if (termination) {
        this.handleDisconnect(termination);
        return;
      }
      if (!opened && this.config.authorizeConnection) {
        if (upgradeCheckStarted) return;
        upgradeCheckStarted = true;
        void this.revalidateFailedUpgrade(ws);
        return;
      }
      this.handleDisconnect();
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      if (!opened && this.config.authorizeConnection) {
        if (upgradeCheckStarted) return;
        upgradeCheckStarted = true;
        void this.revalidateFailedUpgrade(ws);
        return;
      }
      this.handleDisconnect();
    });
  }

  /** Re-run the room gate when the browser hides a failed upgrade's HTTP status. */
  private async revalidateFailedUpgrade(ws: WebSocket): Promise<void> {
    try {
      const jwt = await this.config.getJwt();
      const termination = await this.config.authorizeConnection?.(jwt) ?? null;
      if (this.ws !== ws) return;
      this.handleDisconnect(termination);
    } catch {
      if (this.ws === ws && !this.accessTermination) this.handleDisconnect();
    }
  }

  /** Disconnect without scheduling a reconnect. */
  disconnect(): void {
    this.closeSocket();
    // A refused engine stays at `error`. Reporting `disconnected` afterwards
    // would read as "offline, retrying" for a connection that will not retry.
    if (!this.accessTermination) this.setStatus('disconnected');
  }

  /**
   * Stop for good, because this client may not be in this room.
   *
   * Called by the engine itself for a terminal close code, and by a host that
   * learned the same thing before a socket existed -- notably a team JWT that
   * cannot be minted because the browser session expired, which otherwise
   * retries silently forever and presents as an empty tracker rather than as
   * being signed out.
   */
  terminateAccess(termination: TrackerAccessTermination): void {
    if (this.accessTermination) return;
    this.closeSocket();
    this.recordAccessTermination(termination);
  }

  /** The refusal that stopped this engine, or null while it is still trying. */
  getAccessTermination(): TrackerAccessTermination | null {
    return this.accessTermination;
  }

  /** Teardown shared by an ordinary disconnect and a terminal refusal. */
  private closeSocket(): void {
    this.suppressReconnect = true;
    this.cancelReconnect();
    this.stopPing();
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
    this.connecting = false;
    this.synced = false;
    this.schemaOutbox.reset();
    if (this.presence.size > 0) {
      this.presence.clear();
      this.notifyPresenceChange();
    }
    this.resolvePendingConfigChanges({
      success: false,
      code: 'disconnected',
      message: 'Tracker sync disconnected before the prefix change was confirmed.',
    });
  }

  /** Destroy the engine. Cannot be reused after this. */
  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    this.rollbackSnapshots.clear();
    this.pendingLaneIds.clear();
  }

  /** Current connection status. */
  getStatus(): TrackerSyncStatus {
    return this.status;
  }

  /** Current remote-viewer roster. Returns a defensive snapshot. */
  getPresence(): TrackerPresenceParticipant[] {
    return [...this.presence.values()];
  }

  /** Flush locally-pending shared saved views while connected. */
  async flushSavedViews(): Promise<void> {
    await this.pushPendingSavedViews();
  }

  /** Flush locally-pending tracker navigation entries while connected. */
  async flushNavigation(): Promise<void> {
    await this.pushPendingNavigation();
  }

  /** Push a schema saved mid-session; before bootstrap finishes, bootstrap pushes it (NIM-6654). */
  async flushSchemas(): Promise<void> {
    if (this.synced) await this.schemaOutbox.push();
  }

  // --------------------------------------------------------------------------
  // Mutation API
  // --------------------------------------------------------------------------

  /**
   * Optimistically apply an upsert locally and enqueue it for upload.
   *
   * @param payload The full decrypted item payload. Device-local fields
   *   (`linkedSessions` etc.) are stripped at encryption time, not here.
   * @param options.persistedEnqueue When true, the apply + enqueue happen
   *   in a single SQL transaction (`TrackerPersistence.applyAndEnqueueAtomically`).
   */
  async upsertItem(
    payload: TrackerItemPayload,
    options: { persistedEnqueue?: boolean } = {},
  ): Promise<{ clientMutationId: string }> {
    return this.enqueueMutation(payload.itemId, payload, 'update', options);
  }

  /** Optimistically apply and send an update-many command as one coherent batch. */
  async upsertItems(
    payloads: readonly TrackerItemPayload[],
  ): Promise<{ clientMutationIds: string[] }> {
    if (payloads.length === 0) return { clientMutationIds: [] };
    if (payloads.length > 100) throw new Error('Tracker mutation batches are limited to 100 items');
    const itemIds = new Set(payloads.map(payload => payload.itemId));
    if (itemIds.size !== payloads.length) throw new Error('Tracker mutation batches require unique item ids');
    const applyBatch = this.persistence.applyAndEnqueueBatchAtomically;
    if (!applyBatch) throw new Error('Tracker persistence does not support atomic mutation batches');
    for (const payload of payloads) encodeTrackerPayloadPlaintext(payload);

    const now = Date.now();
    const batchId = generateClientMutationId();
    const rows: PersistedTrackerTransactionRow[] = payloads.map((payload, index) => ({
      clientMutationId: generateClientMutationId(),
      itemId: payload.itemId,
      workspacePath: '',
      state: 'persistedEnqueue',
      kind: 'update',
      payload,
      enqueuedAt: now + index,
      batchId,
      owner: {
        orgId: this.config.orgId,
        teamProjectId: this.config.teamProjectId,
        teamMemberId: this.config.teamMemberId,
      },
    }));
    const snapshots = await applyBatch.call(
      this.persistence,
      rows.map((row, index) => ({ itemId: row.itemId, payload: payloads[index], row })),
    );
    rows.forEach((row, index) => {
      this.rollbackSnapshots.set(row.clientMutationId, {
        itemId: row.itemId,
        snapshot: snapshots[index],
      });
    });
    await this.driveTransactionBatch(rows);
    return { clientMutationIds: rows.map(row => row.clientMutationId) };
  }

  /**
   * Optimistically apply a delete (tombstone) and enqueue it for upload.
   */
  async deleteItem(
    itemId: string,
    options: { persistedEnqueue?: boolean } = {},
  ): Promise<{ clientMutationId: string }> {
    return this.enqueueMutation(itemId, null, 'delete', options);
  }

  /**
   * Push a room-level config change (currently: issue-key prefix). Server
   * broadcasts the change to all connections including the originator
   * via `trackerConfigBroadcast` -- the engine surfaces it through
   * `onConfigChange`.
   */
  setIssueKeyPrefix(
    prefix: string,
    assignmentMode: 'auto' | 'explicit' = 'explicit',
  ): Promise<TrackerConfigSetResult> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        success: false,
        code: 'disconnected',
        message: 'Tracker sync must be connected before changing the issue-key prefix.',
      });
    }
    const clientMutationId = generateClientMutationId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingConfigChanges.delete(clientMutationId);
        resolve({
          success: false,
          code: 'timeout',
          message: 'Timed out waiting for the server to confirm the issue-key prefix.',
        });
      }, 5_000);
      (timer as { unref?: () => void }).unref?.();
      this.pendingConfigChanges.set(clientMutationId, { requestedPrefix: prefix, resolve, timer });
      try {
        this.send({
          type: 'trackerSetConfig',
          key: 'issueKeyPrefix',
          value: prefix,
          clientMutationId,
          assignmentMode,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pendingConfigChanges.delete(clientMutationId);
        resolve({ success: false, code: 'sendFailed', message: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  // --------------------------------------------------------------------------
  // Bootstrap loop + replay
  // --------------------------------------------------------------------------

  private async runBootstrap(): Promise<void> {
    try {
      // Before any remote item lands: the store reads the local rows as the
      // newest local state, which a remote apply would overwrite.
      if (!this.outboxConsolidated && this.persistence.consolidatePendingUpdates) {
        await this.persistence.consolidatePendingUpdates().catch(err => this.config.onBootstrapError?.(err));
        this.outboxConsolidated = true;
      }
      await this.runSchemaBootstrap();

      let cursor: SyncId = await this.persistence.getMaxSyncId();
      // Loop while the server says it has more rows. SYNC_ID_INITIAL (0)
      // is the "send me everything" sentinel.
      let isFirstBatch = cursor === SYNC_ID_INITIAL;
      const isInitialBootstrap = isFirstBatch;
      let receivedItems = false;
      let initialConfig: TrackerRoomConfig | undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const response = await this.requestSync(cursor);
        receivedItems ||= response.items.length > 0;

        await this.applyBootstrapBatch(response);
        if (isFirstBatch && response.config) {
          initialConfig = response.config;
          this.config.onConfigChange?.(response.config);
        }
        isFirstBatch = false;
        cursor = response.cursorSyncId;
        if (!response.hasMore) break;
      }

      const desiredPrefix = this.config.initializeIssueKeyPrefix;
      if (
        isInitialBootstrap &&
        !receivedItems &&
        desiredPrefix &&
        initialConfig?.issueKeyPrefix === 'NIM' &&
        desiredPrefix !== initialConfig.issueKeyPrefix
      ) {
        // WebSocket messages are ordered, so the config reaches the room
        // before replayPending can ask it to allocate the first issue key.
        const result = await this.setIssueKeyPrefix(desiredPrefix, 'auto');
        if (!result.success) {
          console.warn(`[TrackerSync] automatic issue-key prefix assignment failed: ${result.message ?? result.code}`);
        }
      }

      await this.runIdentityRecovery(cursor);

      await this.runNavigationBootstrap();
      await this.runSavedViewBootstrap();

      this.synced = true;
      this.setStatus('connected');
      this.announcePresence();

      // After bootstrap, replay any persisted-but-unconfirmed mutations. A
      // replay failure must not cost the other lanes their push (NIM-7336).
      await this.replayPending().catch(err => this.config.onBootstrapError?.(err));
      await this.schemaOutbox.push();
      await this.pushPendingNavigation();
      await this.pushPendingSavedViews();
    } catch (err) {
      // Bootstrap failures (e.g. socket drop mid-loop) fall through to the
      // disconnect path, which triggers a reconnect. Don't tear down here.
      // Surface the error to the host so it doesn't disappear into the void
      // -- without this hook the engine sits at `syncing` forever with no
      // symptom an operator can see.
      this.config.onBootstrapError?.(err);
    }
  }

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
  private async runIdentityRecovery(localMaxSyncId: SyncId): Promise<void> {
    const hooks = this.config.identityRecovery;
    if (!hooks) return;

    let plan: TrackerIdentityRecoveryPlan;
    try {
      plan = planTrackerIdentityRecovery({ ...(await hooks.getFacts()), localMaxSyncId });
    } catch (err) {
      this.config.onBootstrapError?.(err);
      return;
    }
    if (plan.action === 'none') return;

    console.warn(
      `[TrackerSync] ${plan.strandedCount} synced item(s) carry no issue key; re-requesting`,
      `the changelog from sync_id ${plan.sinceSyncId} (${plan.rewindDistance} entries behind`,
      `the cursor) so the room can re-assert their identity`,
    );
    try {
      let cursor: SyncId = plan.sinceSyncId;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const response = await this.requestSync(cursor);
        await this.applyBootstrapBatch(response);
        cursor = response.cursorSyncId;
        if (!response.hasMore) break;
      }
    } catch (err) {
      this.config.onBootstrapError?.(err);
    } finally {
      await hooks.markAttempted().catch((err) => this.config.onBootstrapError?.(err));
    }
  }

  private requestSync(sinceSyncId: SyncId): Promise<TrackerSyncResponseMessage> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not open'));
        return;
      }
      const handler = (event: MessageEvent) => {
        const msg = parseServerMessage(event.data);
        if (!msg || msg.type !== 'trackerSyncResponse') return;
        this.ws?.removeEventListener('message', handler);
        resolve(msg);
      };
      this.ws.addEventListener('message', handler);
      this.send({
        type: 'trackerSync',
        sinceSyncId,
        ...(sinceSyncId === SYNC_ID_INITIAL && this.config.initializeIssueKeyPrefix
          ? { initializeIssueKeyPrefix: this.config.initializeIssueKeyPrefix }
          : {}),
      });
    });
  }

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
  private async runSchemaBootstrap(): Promise<void> {
    const hooks = this.config.schemaSync;
    if (!hooks) return;

    let cursor: SyncId = 0 as SyncId;
    this.schemaCreateOnlySupported = false;
    console.info('[TrackerSchemaSync] bootstrap start (full snapshot since sync_id=0)');

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const response = await this.requestSchemaSync(cursor);
        console.info(
          `[TrackerSchemaSync] bootstrap batch: ${response.schemas.length} schema(s), cursor=${response.cursorSyncId}, hasMore=${response.hasMore}`,
        );

        if (response.schemaCreateOnly === true) this.schemaCreateOnlySupported = true;
        await this.applySchemaBootstrapBatch(response);
        cursor = response.cursorSyncId;
        if (!response.hasMore) break;
      }
    } catch (err) {
      if (!(err instanceof SyncRequestTimeoutError)) throw err;
      // Degrade, don't abort: this lane runs ahead of the item bootstrap, and
      // aborting here would trade "schemas are stale" for "the tracker is
      // empty". The next connect re-requests the full snapshot anyway.
      console.warn(
        `[TrackerSchemaSync] ${err.message}; continuing with locally-known schemas`,
      );
      return;
    }
    console.info(`[TrackerSchemaSync] bootstrap complete at sync_id=${cursor}`);
  }

  private requestSchemaSync(sinceSyncId: SyncId): Promise<TrackerSchemaSyncResponseMessage> {
    const timeoutMs = this.config.schemaBootstrapTimeoutMs ?? SCHEMA_BOOTSTRAP_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not open'));
        return;
      }
      const handler = (event: MessageEvent) => {
        const msg = parseServerMessage(event.data);
        if (!msg || msg.type !== 'trackerSchemaSyncResponse') return;
        clearTimeout(timer);
        this.ws?.removeEventListener('message', handler);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        this.ws?.removeEventListener('message', handler);
        reject(new SyncRequestTimeoutError(
          `schema bootstrap timed out after ${timeoutMs}ms waiting for trackerSchemaSyncResponse`,
        ));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.ws.addEventListener('message', handler);
      this.send({ type: 'trackerSchemaSync', sinceSyncId });
    });
  }

  private async applySchemaBootstrapBatch(batch: TrackerSchemaSyncResponseMessage): Promise<void> {
    for (const envelope of batch.schemas) {
      try {
        await this.applySchemaEnvelope(envelope);
      } catch (err) {
        this.config.onBootstrapError?.(err);
      }
    }
  }

  private async runNavigationBootstrap(): Promise<void> {
    const hooks = this.config.navigationSync;
    if (!hooks) return;
    let cursor = await hooks.getMaxSyncId();
    while (true) {
      const response = await this.requestNavigationSync(cursor);
      for (const envelope of response.entries) {
        try {
          await this.applyNavigationEnvelope(envelope);
        } catch (err) {
          this.config.onBootstrapError?.(err);
        }
      }
      cursor = response.cursorSyncId;
      if (!response.hasMore) break;
    }
  }

  private async runSavedViewBootstrap(): Promise<void> {
    const hooks = this.config.savedViewSync;
    if (!hooks) return;
    let cursor = await hooks.getMaxSyncId();
    while (true) {
      const response = await this.requestSavedViewSync(cursor);
      for (const envelope of response.views) {
        try {
          await this.applySavedViewEnvelope(envelope);
        } catch (err) {
          // One undecryptable view must not abort the whole bootstrap.
          this.config.onBootstrapError?.(err);
        }
      }
      cursor = response.cursorSyncId;
      if (!response.hasMore) break;
    }
  }

  private requestSavedViewSync(sinceSyncId: SyncId): Promise<TrackerSavedViewSyncResponseMessage> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not open'));
        return;
      }
      const handler = (event: MessageEvent) => {
        const msg = parseServerMessage(event.data);
        if (!msg || msg.type !== 'trackerSavedViewSyncResponse') return;
        this.ws?.removeEventListener('message', handler);
        resolve(msg);
      };
      this.ws.addEventListener('message', handler);
      this.send({ type: 'trackerSavedViewSync', sinceSyncId });
    });
  }

  private requestNavigationSync(sinceSyncId: SyncId): Promise<TrackerNavigationSyncResponseMessage> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not open'));
        return;
      }
      const handler = (event: MessageEvent) => {
        const msg = parseServerMessage(event.data);
        if (!msg || msg.type !== 'trackerNavigationSyncResponse') return;
        this.ws?.removeEventListener('message', handler);
        resolve(msg);
      };
      this.ws.addEventListener('message', handler);
      this.send({ type: 'trackerNavigationSync', sinceSyncId });
    });
  }

  private async applyBootstrapBatch(batch: TrackerSyncResponseMessage): Promise<void> {
    for (const envelope of batch.items) {
      // Return value (applied true/false) is informational only here: a
      // still-unreadable envelope is left out of the projection and will be
      // re-tried on the next bootstrap.
      //
      // Defense in depth: one bad envelope must not kill the whole batch.
      // A unique-constraint violation on `issue_number` collisions, a
      // single corrupted payload, or a transient DB error on one row used
      // to throw out of the for-loop and tank the entire bootstrap (the
      // engine then sat at `syncing` forever). Surface the failure via
      // `onBootstrapError` so the host can log it, then keep going.
      try {
        await this.applyEnvelope(envelope);
      } catch (err) {
        this.config.onBootstrapError?.(err);
      }
    }
  }

  private async replayPending(): Promise<void> {
    const owner: TrackerTransactionOwner = {
      orgId: this.config.orgId,
      teamProjectId: this.config.teamProjectId,
      teamMemberId: this.config.teamMemberId,
    };
    // Persistence implementations may retain rejected rows for diagnostics.
    // Enforce the terminal policy again at the driver boundary so a host store
    // that predates the browser tombstone cannot re-offer the mutation.
    const pending = (await this.persistence.loadPendingTransactions(owner))
      .filter(row => !(row.lastRejection && isPermanentTrackerRejection(row.lastRejection.code)));
    const replayedBatchIds = new Set<string>();
    for (const row of pending) {
      try {
        if (row.batchId && !replayedBatchIds.has(row.batchId)) {
          replayedBatchIds.add(row.batchId);
          const batch = pending.filter(candidate => candidate.batchId === row.batchId);
          for (const batchRow of batch) {
            if (batchRow.rollbackSnapshot) {
              this.rollbackSnapshots.set(batchRow.clientMutationId, {
                itemId: batchRow.itemId,
                snapshot: batchRow.rollbackSnapshot,
              });
            }
          }
          await this.driveTransactionBatch(batch);
          continue;
        }
        if (row.batchId) continue;
        if (row.rollbackSnapshot) {
          this.rollbackSnapshots.set(row.clientMutationId, {
            itemId: row.itemId,
            snapshot: row.rollbackSnapshot,
          });
        }
        // NIM-602: a `pendingApply` row signals a crash between the queue
        // write and the projection write in `applyAndEnqueueAtomically`.
        // The queue row carries the payload we never finished applying.
        // Apply it now, then promote to `persistedEnqueue` so the driver
        // treats it like any other persisted mutation. `applyOptimistic`
        // is idempotent against an already-applied row, so this is safe
        // if the crash happened after the projection write but before
        // the promotion.
        if (row.state === 'pendingApply') {
          const snapshot = await this.persistence.applyOptimistic(row.itemId, row.payload ?? null);
          if (!row.rollbackSnapshot) {
            this.rollbackSnapshots.set(row.clientMutationId, { itemId: row.itemId, snapshot });
          }
          await this.persistence.markTransactionState(row.clientMutationId, 'persistedEnqueue');
          row.state = 'persistedEnqueue';
        }
        await this.driveTransaction(row);
      } catch {
        // A single bad row must not stop the replay. The engine will see
        // it again on the next reconnect; if it stays broken, the user
        // will see `lastRejection` populated on the transaction row.
      }
    }
  }

  // --------------------------------------------------------------------------
  // Message dispatch
  // --------------------------------------------------------------------------

  private async handleMessage(event: MessageEvent): Promise<void> {
    if (this.destroyed) return;
    const msg = parseServerMessage(event.data);
    if (!msg) return;

    switch (msg.type) {
      case 'trackerDelta':
        await this.handleDelta(msg);
        break;
      case 'trackerMutationAck':
        await this.handleAck(msg);
        break;
      case 'trackerMutationBatchAck':
        await this.handleBatchAck(msg);
        break;
      case 'trackerSchemaDelta':
        await this.handleSchemaDelta(msg);
        break;
      case 'trackerSchemaMutationAck':
        await this.handleSchemaAck(msg);
        break;
      case 'trackerSavedViewDelta':
        await this.handleSavedViewDelta(msg);
        break;
      case 'trackerSavedViewMutationAck':
        await this.handleSavedViewAck(msg);
        break;
      case 'trackerNavigationDelta':
        await this.handleNavigationDelta(msg);
        break;
      case 'trackerNavigationMutationAck':
        await this.handleNavigationAck(msg);
        break;
      case 'trackerConfigBroadcast':
        this.handleConfigBroadcast(msg);
        break;
      case 'trackerPresenceRoster':
        this.handlePresenceRoster(msg);
        break;
      case 'trackerPresenceDelta':
        this.handlePresenceDelta(msg);
        break;
      case 'trackerPong':
        // Keep-alive response; nothing to do.
        break;
      case 'trackerRoomMoved':
        this.handleRoomMoved(msg);
        break;
      case 'trackerError':
        this.handleServerError(msg);
        break;
      case 'trackerSyncResponse':
        // The bootstrap loop owns these via its inline `requestSync`
        // listener. Live deltas show up as `trackerDelta`.
        break;
      case 'trackerSchemaSyncResponse':
        // The schema bootstrap loop owns these via `requestSchemaSync`.
        break;
      case 'trackerSavedViewSyncResponse':
        // The saved-view bootstrap loop owns these via `requestSavedViewSync`.
        break;
      case 'trackerNavigationSyncResponse':
        // The navigation bootstrap loop owns these via `requestNavigationSync`.
        break;
    }
  }

  /**
   * Epic H3 P1: the server reports this room was relocated to another org. The
   * old room is frozen/tombstoned, so stop reconnecting and hand the
   * destination to the host, which re-resolves routing (the project now lives
   * at a new org-scoped room) and spins up a fresh engine pointed there.
   */
  private handleRoomMoved(msg: TrackerRoomMovedMessage): void {
    this.disconnect();
    this.config.onRoomMoved?.({ destOrgId: msg.destOrgId, destTeamProjectId: msg.destTeamProjectId });
  }

  private async handleDelta(msg: TrackerDeltaMessage): Promise<void> {
    await this.applyEnvelope(msg.item);
  }

  private async handleAck(msg: TrackerMutationAckMessage): Promise<void> {
    if (this.destroyed) return;
    const { clientMutationId, accepted } = msg;

    if (accepted && msg.syncId !== undefined && msg.item) {
      // The projection has already been advanced via `applyEnvelope` if a
      // delta also arrived; defensively call it once more with the
      // server-confirmed envelope to make sure `sync_id` and issue
      // identity get carried into the local row. Return value is
      // informational -- a stale-key ack would still need persistence-level
      // ack to advance, but in practice the server only acks when the key
      // fingerprint matched on the mutation.
      await this.applyEnvelope(msg.item);
      if (this.destroyed) return;
      await this.persistence.ackTransaction(clientMutationId, msg.syncId);
      if (this.destroyed) return;
      this.rollbackSnapshots.delete(clientMutationId);
      return;
    }

    if (!accepted && msg.error) {
      const snapshot = this.rollbackSnapshots.get(clientMutationId);

      const rejection = {
        code: msg.error.code,
        message: msg.error.message,
        occurredAt: Date.now(),
      };
      await this.persistence.rejectTransaction(
        clientMutationId,
        rejection,
        isPermanentTrackerRejection(rejection.code),
      );
      if (this.destroyed) return;
      if (snapshot) {
        await this.persistence.rollbackOptimistic(snapshot.itemId, snapshot.snapshot);
        if (this.destroyed) return;
        this.rollbackSnapshots.delete(clientMutationId);
        this.config.onRejection?.({
          clientMutationId,
          itemId: snapshot.itemId,
          rejection,
        });
      }
    }
  }

  private async handleBatchAck(msg: TrackerMutationBatchAckMessage): Promise<void> {
    if (this.destroyed) return;
    if (msg.accepted) {
      for (const entry of msg.entries) {
        if (entry.syncId !== undefined && entry.item) {
          await this.applyEnvelope(entry.item);
          if (this.destroyed) return;
          await this.persistence.ackTransaction(entry.clientMutationId, entry.syncId);
          if (this.destroyed) return;
          this.rollbackSnapshots.delete(entry.clientMutationId);
        }
      }
      return;
    }

    if (!msg.error) return;
    for (const entry of msg.entries) {
      const snapshot = this.rollbackSnapshots.get(entry.clientMutationId);
      const rejection = {
        code: msg.error.code,
        message: msg.error.message,
        occurredAt: Date.now(),
      };
      await this.persistence.rejectTransaction(
        entry.clientMutationId,
        rejection,
        isPermanentTrackerRejection(rejection.code),
      );
      if (this.destroyed) return;
      if (!snapshot) continue;
      await this.persistence.rollbackOptimistic(snapshot.itemId, snapshot.snapshot);
      if (this.destroyed) return;
      this.rollbackSnapshots.delete(entry.clientMutationId);
      this.config.onRejection?.({
        clientMutationId: entry.clientMutationId,
        itemId: snapshot.itemId,
        rejection,
      });
    }
  }

  private async handleSchemaDelta(msg: TrackerSchemaDeltaMessage): Promise<void> {
    console.info(
      `[TrackerSchemaSync] delta type=${msg.schema.schemaType} sync_id=${msg.schema.syncId} tombstone=${msg.schema.encryptedPayload === null}`,
    );
    await this.applySchemaEnvelope(msg.schema);
  }

  private async handleSchemaAck(msg: TrackerSchemaMutationAckMessage): Promise<void> {
    console.info(
      `[TrackerSchemaSync] ack cmid=${msg.clientMutationId} accepted=${msg.accepted}` +
        `${msg.schema ? ` type=${msg.schema.schemaType} sync_id=${msg.schema.syncId}` : ''}` +
        `${msg.error ? ` error=${msg.error.code}` : ''}`,
    );
    const sent = this.schemaOutbox.settle(msg.clientMutationId);
    if (sent) {
      try {
        this.config.schemaSync?.onSettled?.({
          type: sent.type,
          model: sent.model,
          accepted: msg.accepted,
          ...(msg.error ? { error: { code: msg.error.code, message: msg.error.message } } : {}),
        });
      } catch (err) {
        this.config.onBootstrapError?.(err);
      }
    }
    if (msg.accepted && msg.schema) {
      this.pendingLaneIds.delete(msg.clientMutationId);
      await this.applySchemaEnvelope(msg.schema);
      return;
    }
    await this.retireRefusedLaneChange(
      'schema',
      msg.clientMutationId,
      msg.error,
      this.config.schemaSync?.markRejected,
    );
  }

  private async handleSavedViewDelta(msg: TrackerSavedViewDeltaMessage): Promise<void> {
    await this.applySavedViewEnvelope(msg.view);
  }

  private async handleSavedViewAck(msg: TrackerSavedViewMutationAckMessage): Promise<void> {
    if (msg.accepted && msg.view) {
      await this.applySavedViewEnvelope(msg.view);
      return;
    }
    await this.retireRefusedLaneChange(
      'savedView',
      msg.clientMutationId,
      msg.error,
      this.config.savedViewSync?.markRejected,
    );
  }

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
  private async retireRefusedLaneChange(
    lane: 'savedView' | 'navigation' | 'schema',
    clientMutationId: string,
    error: { code: TrackerMutationRejectCode; message: string } | undefined,
    markRejected: ((id: string, code: string) => Promise<unknown>) | undefined,
  ): Promise<void> {
    // A rejection ack carries only the mutation id -- the server builds it
    // without the view/entry/schema it refused -- so the subject comes from
    // what we recorded when the mutation went out.
    const id = this.pendingLaneIds.get(clientMutationId);
    this.pendingLaneIds.delete(clientMutationId);
    if (!error || id === undefined) return;
    if (!isPermanentTrackerRejection(error.code)) return;

    if (markRejected) {
      try {
        await markRejected(id, error.code);
      } catch (err) {
        // Retiring is best-effort: if the store write fails the row stays
        // queued and we retry next connect, which is the old behaviour rather
        // than a new failure mode. The host still hears about the refusal.
        this.config.onBootstrapError?.(err);
      }
    }
    this.config.onRejection?.({
      clientMutationId,
      itemId: id,
      lane,
      rejection: { code: error.code, message: error.message, occurredAt: Date.now() },
    });
  }

  private async handleNavigationDelta(msg: TrackerNavigationDeltaMessage): Promise<void> {
    await this.applyNavigationEnvelope(msg.entry);
  }

  private async handleNavigationAck(msg: TrackerNavigationMutationAckMessage): Promise<void> {
    if (msg.accepted && msg.entry) {
      await this.applyNavigationEnvelope(msg.entry);
      return;
    }
    await this.retireRefusedLaneChange(
      'navigation',
      msg.clientMutationId,
      msg.error,
      this.config.navigationSync?.markRejected,
    );
  }

  private handleConfigBroadcast(msg: TrackerConfigBroadcastMessage): void {
    this.config.onConfigChange?.(msg.config);
    for (const [id, pending] of this.pendingConfigChanges) {
      if (
        pending.requestedPrefix === msg.config.issueKeyPrefix ||
        pending.requestedPrefix === msg.config.issueKeyPrefixAssignment?.requestedPrefix
      ) {
        clearTimeout(pending.timer);
        this.pendingConfigChanges.delete(id);
        pending.resolve({ success: true, config: msg.config });
      }
    }
  }

  private handlePresenceRoster(msg: TrackerPresenceRosterMessage): void {
    this.presence.clear();
    for (const member of msg.members) {
      const teamMemberId = asTeamMemberId(member.teamMemberId);
      if (teamMemberId === this.config.teamMemberId) continue;
      this.presence.set(teamMemberId, { ...member, teamMemberId });
    }
    this.notifyPresenceChange();
  }

  private handlePresenceDelta(msg: TrackerPresenceDeltaMessage): void {
    const teamMemberId = asTeamMemberId(msg.member.teamMemberId);
    if (teamMemberId === this.config.teamMemberId) return;
    if (msg.connected) {
      this.presence.set(teamMemberId, { ...msg.member, teamMemberId });
    } else {
      this.presence.delete(teamMemberId);
    }
    this.notifyPresenceChange();
  }

  private notifyPresenceChange(): void {
    this.config.onPresenceChange?.(this.getPresence());
  }

  private handleServerError(msg: TrackerErrorMessage): void {
    this.config.onServerError?.(msg);
    // `guardConnection` says this in words before it closes the socket with
    // 4003. The close code is the primary signal, but a client that only saw
    // the words must not go back to retrying either.
    if (msg.code === 'access_revoked') {
      this.terminateAccess({
        reason: 'tracker-access-revoked',
        closeCode: 4003,
        message: msg.message || 'Your access to this tracker was revoked.',
      });
      return;
    }
    const pending = msg.clientMutationId
      ? this.pendingConfigChanges.get(msg.clientMutationId)
      : this.pendingConfigChanges.size === 1
        ? this.pendingConfigChanges.values().next().value
        : undefined;
    if (pending) {
      clearTimeout(pending.timer);
      if (msg.clientMutationId) this.pendingConfigChanges.delete(msg.clientMutationId);
      else {
        for (const [id, candidate] of this.pendingConfigChanges) {
          if (candidate === pending) this.pendingConfigChanges.delete(id);
        }
      }
      pending.resolve({
        success: false,
        code: msg.code,
        message: msg.message,
        conflictingProjectName: msg.conflictingProjectName,
        suggestedPrefix: msg.suggestedPrefix,
      });
    }
    if (!msg.code.startsWith('issueKeyPrefix') && msg.code !== 'invalid_config') {
      this.setStatus('error');
    }
  }

  private resolvePendingConfigChanges(result: TrackerConfigSetResult): void {
    for (const pending of this.pendingConfigChanges.values()) {
      clearTimeout(pending.timer);
      pending.resolve(result);
    }
    this.pendingConfigChanges.clear();
  }

  // --------------------------------------------------------------------------
  // Apply / project
  // --------------------------------------------------------------------------

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
  private async applyEnvelope(envelope: TrackerItemEnvelope): Promise<boolean> {
    const isTombstone = envelope.encryptedPayload === null;
    let payload: TrackerItemPayload | null = null;
    if (!isTombstone) {
      try {
        payload = decodeTrackerEnvelopePlaintext(envelope);
      } catch (err) {
        console.warn('[TrackerSync] failed to parse item payload; skipping', err);
        return false;
      }
    }

    await this.persistence.applyRemoteItem(envelope, payload);
    this.config.onItemApplied?.({
      itemId: envelope.itemId,
      syncId: envelope.syncId,
      payload,
      isTombstone,
      issueNumber: envelope.issueNumber,
      issueKey: envelope.issueKey,
    });
    return true;
  }

  /**
   * Socket messages are dispatched without awaiting each other, and a host's
   * `applyRemote` awaits file writes. Unserialized, an older delivery can finish
   * after a newer one and leave the older content and syncId in place.
   */
  private applySchemaEnvelope(envelope: TrackerSchemaEnvelope): Promise<boolean> {
    const run = this.schemaApplyChain.then(() => this.applySchemaEnvelopeNow(envelope));
    this.schemaApplyChain = run.catch(() => undefined);
    return run;
  }

  private async applySchemaEnvelopeNow(envelope: TrackerSchemaEnvelope): Promise<boolean> {
    const hooks = this.config.schemaSync;
    if (!hooks) return true;

    const isTombstone = envelope.encryptedPayload === null;
    let model: string | null = null;
    if (!isTombstone) {
      try {
        model = decodeTrackerSchemaEnvelopePlaintext(envelope);
      } catch (err) {
        console.warn('[TrackerSchemaSync] failed to parse schema payload; skipping', err);
        return false;
      }
    }

    await hooks.applyRemote({
      type: envelope.schemaType,
      model,
      syncId: envelope.syncId,
    });
    this.config.onSchemaApplied?.({
      type: envelope.schemaType,
      syncId: envelope.syncId,
      model,
      isTombstone,
    });
    return true;
  }

  private async applySavedViewEnvelope(envelope: TrackerSavedViewEnvelope): Promise<boolean> {
    const hooks = this.config.savedViewSync;
    if (!hooks) return true;
    const isTombstone = envelope.encryptedPayload === null;
    let payload: string | null = null;
    if (!isTombstone) {
      try {
        payload = decodeTrackerSavedViewEnvelopePlaintext(envelope);
      } catch {
        return false;
      }
    }

    await hooks.applyRemote({ viewId: envelope.viewId, payload, syncId: envelope.syncId });
    return true;
  }

  private async applyNavigationEnvelope(envelope: TrackerNavigationEnvelope): Promise<boolean> {
    const hooks = this.config.navigationSync;
    if (!hooks) return true;
    const isTombstone = envelope.encryptedPayload === null;
    let payload: string | null = null;
    if (!isTombstone) {
      try {
        payload = decodeTrackerNavigationEnvelopePlaintext(envelope);
      } catch {
        return false;
      }
    }

    await hooks.applyRemote({ entryId: envelope.entryId, payload, syncId: envelope.syncId });
    return true;
  }

  // --------------------------------------------------------------------------
  // Queue drive
  // --------------------------------------------------------------------------

  private async enqueueMutation(
    itemId: string,
    payload: TrackerItemPayload | null,
    kind: 'create' | 'update' | 'delete',
    options: { persistedEnqueue?: boolean },
  ): Promise<{ clientMutationId: string }> {
    // Encode before touching anything: an item the room can never accept must
    // not get a local apply or an outbox row. It used to get both, and a row
    // per reconnect piled up to 257 MB (NIM-7336). A host that saves its own
    // copy first must run the same check before that save.
    if (payload) encodeTrackerPayloadPlaintext(payload);
    const clientMutationId = generateClientMutationId();
    const now = Date.now();

    const row: PersistedTrackerTransactionRow = {
      clientMutationId,
      itemId,
      workspacePath: '',  // host adapter fills this in; engine doesn't care
      state: options.persistedEnqueue ? 'persistedEnqueue' : 'created',
      kind,
      payload: payload ?? undefined,
      enqueuedAt: now,
      owner: {
        orgId: this.config.orgId,
        teamProjectId: this.config.teamProjectId,
        teamMemberId: this.config.teamMemberId,
      },
    };

    let snapshot: TrackerRowSnapshot;
    if (options.persistedEnqueue) {
      snapshot = await this.persistence.applyAndEnqueueAtomically(itemId, payload, row);
    } else {
      snapshot = await this.persistence.applyOptimistic(itemId, payload);
      row.rollbackSnapshot = snapshot;
      await this.persistence.enqueueTransaction(row);
    }
    this.rollbackSnapshots.set(clientMutationId, { itemId, snapshot });

    // Promote `created` -> `queued`. (For `persistedEnqueue` rows we leave
    // the state as `persistedEnqueue` -- the durability marker stays sticky
    // until the row is acked.)
    if (row.state === 'created') {
      await this.persistence.markTransactionState(clientMutationId, 'queued');
      row.state = 'queued';
    }

    await this.driveTransaction(row);
    return { clientMutationId };
  }

  /**
   * Move a transaction through the wire. If the socket is closed, leave
   * the row in `queued` for the next reconnect. Encryption happens HERE,
   * not at enqueue, so a key rotation between enqueue and send uses the
   * fresh key.
   */
  private async driveTransaction(row: TrackerTransactionRow): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const startedAt = Date.now();
    await this.persistence.markTransactionState(row.clientMutationId, 'executing', startedAt);

    const isDelete = row.kind === 'delete' || row.payload === undefined;

    if (isDelete) {
      this.send({
        type: 'trackerMutation',
        clientMutationId: row.clientMutationId,
        itemId: row.itemId,
        encryptedPayload: null,
      });
      return;
    }

    // The payload travels as PLAINTEXT; the server encrypts it at rest with
    // the team DEK.
    this.send({
      type: 'trackerMutation',
      clientMutationId: row.clientMutationId,
      itemId: row.itemId,
      encryptedPayload: encodeTrackerPayloadPlaintext(row.payload!),
      ...(row.payload?.issueNumber !== undefined ? { issueNumber: row.payload.issueNumber } : {}),
      ...(row.payload?.issueKey !== undefined ? { issueKey: row.payload.issueKey } : {}),
    });
  }

  private async driveTransactionBatch(rows: readonly TrackerTransactionRow[]): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const startedAt = Date.now();
    if (this.persistence.markTransactionStates) {
      await this.persistence.markTransactionStates(
        rows.map(row => row.clientMutationId),
        'executing',
        startedAt,
      );
    } else {
      for (const row of rows) {
        await this.persistence.markTransactionState(row.clientMutationId, 'executing', startedAt);
      }
    }
    this.send({
      type: 'trackerMutationBatch',
      mutations: rows.map(row => ({
        clientMutationId: row.clientMutationId,
        itemId: row.itemId,
        encryptedPayload: encodeTrackerPayloadPlaintext(row.payload!),
        ...(row.payload?.issueNumber !== undefined ? { issueNumber: row.payload.issueNumber } : {}),
        ...(row.payload?.issueKey !== undefined ? { issueKey: row.payload.issueKey } : {}),
      })),
    });
  }

  private async pushPendingSavedViews(): Promise<void> {
    const hooks = this.config.savedViewSync;
    if (!hooks || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const pending = await hooks.listUnsynced();
    for (const view of pending) {
      const clientMutationId = generateClientMutationId();
      this.pendingLaneIds.set(clientMutationId, view.viewId);
      if (view.deleted || view.payload === null) {
        this.send({
          type: 'trackerSavedViewMutation',
          clientMutationId,
          viewId: view.viewId,
          encryptedPayload: null,
        });
        continue;
      }
      this.send({
        type: 'trackerSavedViewMutation',
        clientMutationId,
        viewId: view.viewId,
        encryptedPayload: view.payload,
      });
    }
  }

  private async pushPendingNavigation(): Promise<void> {
    const hooks = this.config.navigationSync;
    if (!hooks || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const pending = await hooks.listUnsynced();
    for (const entry of pending) {
      const clientMutationId = generateClientMutationId();
      this.pendingLaneIds.set(clientMutationId, entry.entryId);
      if (entry.deleted || entry.payload === null) {
        this.send({
          type: 'trackerNavigationMutation',
          clientMutationId,
          entryId: entry.entryId,
          encryptedPayload: null,
        });
        continue;
      }
      this.send({
        type: 'trackerNavigationMutation',
        clientMutationId,
        entryId: entry.entryId,
        encryptedPayload: entry.payload,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Connection plumbing
  // --------------------------------------------------------------------------

  private send(message: TrackerClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private setStatus(status: TrackerSyncStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.config.onStatusChange?.(status);
  }

  private handleDisconnect(termination: TrackerAccessTermination | null = null): void {
    const shouldReconnect = !this.suppressReconnect && !termination;
    this.stopPing();
    this.ws = null;
    this.synced = false;
    this.connecting = false;
    if (this.presence.size > 0) {
      this.presence.clear();
      this.notifyPresenceChange();
    }
    this.resolvePendingConfigChanges({
      success: false,
      code: 'disconnected',
      message: 'Tracker sync disconnected before the prefix change was confirmed.',
    });
    if (termination) {
      // Deliberately never `disconnected`: that status is the one the host
      // renders as "offline, reconnecting", and this connection is not coming
      // back.
      this.recordAccessTermination(termination);
      return;
    }
    this.setStatus('disconnected');
    if (shouldReconnect && !this.destroyed) {
      this.scheduleReconnect();
    }
  }

  private recordAccessTermination(termination: TrackerAccessTermination): void {
    if (this.accessTermination) return;
    this.accessTermination = termination;
    this.suppressReconnect = true;
    this.cancelReconnect();
    this.setStatus('error');
    this.config.onAccessTerminated?.(termination);
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    const base = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS,
    );
    const jittered = base * (0.5 + Math.random());
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed) return;
      void this.connect();
    }, jittered);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      // Presence doubles as an authorization heartbeat. A member whose room
      // access was revoked is closed and removed by the server on this frame.
      this.announcePresence();
      this.send({ type: 'trackerPing' });
    }, PING_INTERVAL_MS);
  }

  private announcePresence(): void {
    const configured = this.config.presenceIdentity;
    const displayName = configured?.displayName.trim() || this.config.teamMemberId;
    this.send({
      type: 'trackerPresence',
      displayName,
      avatarUrl: configured?.avatarUrl ?? null,
    });
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
