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
 * `./TrackerEnvelopeCrypto.ts`.
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
  EncryptedTrackerItemEnvelope,
  SyncId,
  TrackerClientMessage,
  TrackerServerMessage,
  TrackerMutationAckMessage,
  TrackerItemPayload,
  TrackerRoomConfig,
  TrackerSyncResponseMessage,
  TrackerDeltaMessage,
  TrackerConfigBroadcastMessage,
  TrackerTransactionRow,
  EncryptedTrackerSchemaEnvelope,
  TrackerSchemaSyncResponseMessage,
  TrackerSchemaDeltaMessage,
  TrackerSchemaMutationAckMessage,
} from './trackerProtocol';
import { SYNC_ID_INITIAL, buildTrackerRoomId } from './trackerProtocol';
import { appendSyncClientParams } from './syncClientInfo';
import {
  encryptTrackerPayload,
  decryptTrackerEnvelope,
  encryptTrackerSchemaPayload,
  decryptTrackerSchemaEnvelope,
} from './TrackerEnvelopeCrypto';
import type { TrackerPersistence, TrackerRowSnapshot } from './trackerPersistence';

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
  itemId: string;
  rejection: NonNullable<TrackerTransactionRow['lastRejection']>;
}

export interface TrackerSchemaLocalChange {
  type: string;
  /** JSON-serialized TrackerDataModel, or null for a tombstone. */
  model: string | null;
  deleted: boolean;
}

export interface AppliedTrackerSchema {
  type: string;
  syncId: SyncId;
  model: string | null;
  isTombstone: boolean;
}

export interface TrackerSchemaSyncHooks {
  getMaxSyncId: () => Promise<SyncId>;
  listUnsynced: () => Promise<TrackerSchemaLocalChange[]>;
  applyRemote: (def: { type: string; model: string | null; syncId: SyncId }) => Promise<unknown>;
}

/**
 * Outcome of a key-refresh callback. Returning `null` indicates the host
 * could not produce a fresh key (e.g. admin hasn't re-shared yet); the
 * engine surfaces the rejection back to the UI.
 */
export interface TrackerKeyMaterial {
  encryptionKey: CryptoKey;
  orgKeyFingerprint: string;
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

  /** The current user's ID (informational; not used in auth). */
  userId: string;

  /** Current org AES-256-GCM encryption key. */
  encryptionKey: CryptoKey;

  /**
   * Fingerprint of the encryption key, carried as `orgKeyFingerprint` on
   * every outgoing mutation so the server can enforce epoch alignment.
   * May be `null` while the host adapter is bootstrapping; the engine
   * declines to upload until a non-null value is set via `setKey()`.
   */
  orgKeyFingerprint: string | null;

  /** PGLite (or in-memory test) storage seam. */
  persistence: TrackerPersistence;

  /** Optional schema sync seam. Electron wires this to tracker_type_defs. */
  schemaSync?: TrackerSchemaSyncHooks;

  /**
   * Resolve a fresh team-scoped JWT. Called on every (re)connect AND
   * during reconnect retries -- the JWT can expire during long
   * disconnections.
   */
  getJwt: () => Promise<string>;

  /**
   * Called when the server rejects a mutation with `staleKeyEpoch`. If the
   * host can fetch the fresh key envelope (typical: trigger
   * `OrgKeyService.fetchAndUnwrapOrgKey` then return its result), the
   * engine swaps the key in and re-sends the same `clientMutationId`.
   *
   * If the host returns `null`, the rejection surfaces to the UI via
   * `onRejection` and the row stays in the queue with `lastRejection`
   * populated.
   */
  refreshKey?: () => Promise<TrackerKeyMaterial | null>;

  // --- Observers (all optional) -------------------------------------------

  /** Connection-state transitions. */
  onStatusChange?: (status: TrackerSyncStatus) => void;

  /** Fires for every applied projection row (remote OR self-originated). */
  onItemApplied?: (item: AppliedTrackerItem) => void;

  /** Fires when the server broadcasts a room-config change. */
  onConfigChange?: (config: TrackerRoomConfig) => void;

  /** Fires when a mutation was rejected and rolled back. */
  onRejection?: (rejection: RejectedTrackerMutation) => void;

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
}

// ============================================================================
// Constants
// ============================================================================

/** Exponential backoff for reconnect. Matches DocumentSync. */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Keep-alive cadence. */
const PING_INTERVAL_MS = 30_000;

// ============================================================================
// TrackerSyncEngine
// ============================================================================

export class TrackerSyncEngine {
  private readonly config: TrackerSyncEngineConfig;
  private readonly persistence: TrackerPersistence;

  private ws: WebSocket | null = null;
  private status: TrackerSyncStatus = 'disconnected';
  private destroyed = false;
  private synced = false;
  private connecting = false;
  private suppressReconnect = false;

  /** Current encryption material; mutated on key rotation. */
  private encryptionKey: CryptoKey;
  private orgKeyFingerprint: string | null;

  /** Reconnect bookkeeping. */
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Keep-alive ping. */
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Rollback snapshots keyed by `clientMutationId`. Held in-memory only;
   * persisted state is captured in `tracker_transactions.payload` so we
   * could rebuild these if needed, but in practice the engine instance
   * lives for the duration of any given mutation's lifecycle so this
   * map is sufficient.
   */
  private readonly rollbackSnapshots = new Map<string, {
    itemId: string;
    snapshot: TrackerRowSnapshot;
  }>();

  constructor(config: TrackerSyncEngineConfig) {
    this.config = config;
    this.persistence = config.persistence;
    this.encryptionKey = config.encryptionKey;
    this.orgKeyFingerprint = config.orgKeyFingerprint;
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
        url = appendSyncClientParams(`${this.config.serverUrl}/sync/${roomId}?token=${encodeURIComponent(jwt)}`);
      }
    } catch (err) {
      this.connecting = false;
      this.setStatus('error');
      this.scheduleReconnect();
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

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
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

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.handleDisconnect();
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      this.handleDisconnect();
    });
  }

  /** Disconnect without scheduling a reconnect. */
  disconnect(): void {
    this.suppressReconnect = true;
    this.cancelReconnect();
    this.stopPing();
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
    this.connecting = false;
    this.synced = false;
    this.setStatus('disconnected');
  }

  /** Destroy the engine. Cannot be reused after this. */
  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    this.rollbackSnapshots.clear();
  }

  /** Current connection status. */
  getStatus(): TrackerSyncStatus {
    return this.status;
  }

  /**
   * Swap in a new encryption key + fingerprint. The host adapter calls
   * this after handling an `orgKeyRotated` event. In-flight mutations
   * (already sent, awaiting ack) will be re-encrypted under the new key
   * if the server rejects them with `staleKeyEpoch`.
   */
  setKey(material: TrackerKeyMaterial): void {
    this.encryptionKey = material.encryptionKey;
    this.orgKeyFingerprint = material.orgKeyFingerprint;
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
  setIssueKeyPrefix(prefix: string): void {
    this.send({
      type: 'trackerSetConfig',
      key: 'issueKeyPrefix',
      value: prefix,
    });
  }

  // --------------------------------------------------------------------------
  // Bootstrap loop + replay
  // --------------------------------------------------------------------------

  private async runBootstrap(): Promise<void> {
    try {
      let cursor: SyncId = await this.persistence.getMaxSyncId();
      // Loop while the server says it has more rows. SYNC_ID_INITIAL (0)
      // is the "send me everything" sentinel.
      let isFirstBatch = cursor === SYNC_ID_INITIAL;
      let staleKeyRefreshTried = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const response = await this.requestSync(cursor);

        // Stale-key-on-connect detection: if the server is shipping us
        // envelopes encrypted under a key whose fingerprint differs from
        // ours, our cached key is stale (the org rotated while we were
        // offline). Trigger a refresh ONCE per bootstrap and re-apply.
        // Without this hook the bootstrap silently skips every envelope
        // and the user sees an empty board until the next reconnect.
        if (!staleKeyRefreshTried && this.shouldRefreshForStaleKey(response.items)) {
          staleKeyRefreshTried = true;
          if (this.config.refreshKey) {
            const fresh = await this.config.refreshKey();
            if (fresh) {
              this.setKey(fresh);
            }
          }
        }

        await this.applyBootstrapBatch(response);
        if (isFirstBatch && response.config) {
          this.config.onConfigChange?.(response.config);
        }
        isFirstBatch = false;
        cursor = response.cursorSyncId;
        if (!response.hasMore) break;
      }

      await this.runSchemaBootstrap();

      this.synced = true;
      this.setStatus('connected');

      // After bootstrap, replay any persisted-but-unconfirmed mutations.
      await this.replayPending();
      await this.pushPendingSchemas();
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
   * True when the batch contains at least one non-tombstone envelope whose
   * `orgKeyFingerprint` does not match our cached one. We compare against
   * a known-non-null fingerprint -- if the server omits the fingerprint we
   * cannot tell (older server) and fall back to per-envelope decrypt
   * tolerance.
   */
  private shouldRefreshForStaleKey(items: EncryptedTrackerItemEnvelope[]): boolean {
    if (!this.orgKeyFingerprint) return false;
    for (const env of items) {
      if (env.encryptedPayload === null) continue;
      if (env.orgKeyFingerprint === null) continue;
      if (env.orgKeyFingerprint !== this.orgKeyFingerprint) return true;
    }
    return false;
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
      this.send({ type: 'trackerSync', sinceSyncId });
    });
  }

  private async runSchemaBootstrap(): Promise<void> {
    const hooks = this.config.schemaSync;
    if (!hooks) return;

    let cursor: SyncId = await hooks.getMaxSyncId();
    let staleKeyRefreshTried = false;
    console.info(`[TrackerSchemaSync] bootstrap start since sync_id=${cursor}`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await this.requestSchemaSync(cursor);
      console.info(
        `[TrackerSchemaSync] bootstrap batch: ${response.schemas.length} schema(s), cursor=${response.cursorSyncId}, hasMore=${response.hasMore}`,
      );

      if (!staleKeyRefreshTried && this.shouldRefreshForStaleSchemaKey(response.schemas)) {
        staleKeyRefreshTried = true;
        if (this.config.refreshKey) {
          const fresh = await this.config.refreshKey();
          if (fresh) {
            this.setKey(fresh);
          }
        }
      }

      await this.applySchemaBootstrapBatch(response);
      cursor = response.cursorSyncId;
      if (!response.hasMore) break;
    }
    console.info(`[TrackerSchemaSync] bootstrap complete at sync_id=${cursor}`);
  }

  private shouldRefreshForStaleSchemaKey(schemas: EncryptedTrackerSchemaEnvelope[]): boolean {
    if (!this.orgKeyFingerprint) return false;
    for (const env of schemas) {
      if (env.encryptedPayload === null) continue;
      if (env.orgKeyFingerprint === null) continue;
      if (env.orgKeyFingerprint !== this.orgKeyFingerprint) return true;
    }
    return false;
  }

  private requestSchemaSync(sinceSyncId: SyncId): Promise<TrackerSchemaSyncResponseMessage> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not open'));
        return;
      }
      const handler = (event: MessageEvent) => {
        const msg = parseServerMessage(event.data);
        if (!msg || msg.type !== 'trackerSchemaSyncResponse') return;
        this.ws?.removeEventListener('message', handler);
        resolve(msg);
      };
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

  private async applyBootstrapBatch(batch: TrackerSyncResponseMessage): Promise<void> {
    for (const envelope of batch.items) {
      // Return value (applied true/false) is informational only here; the
      // bootstrap loop has already done a proactive `refreshKey` pass if a
      // staleness mismatch was detected. A still-undecryptable envelope is
      // left out of the projection and will be re-tried on the next bootstrap.
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
    const pending = await this.persistence.loadPendingTransactions();
    for (const row of pending) {
      try {
        // NIM-602: a `pendingApply` row signals a crash between the queue
        // write and the projection write in `applyAndEnqueueAtomically`.
        // The queue row carries the payload we never finished applying.
        // Apply it now, then promote to `persistedEnqueue` so the driver
        // treats it like any other persisted mutation. `applyOptimistic`
        // is idempotent against an already-applied row, so this is safe
        // if the crash happened after the projection write but before
        // the promotion.
        if (row.state === 'pendingApply') {
          await this.persistence.applyOptimistic(row.itemId, row.payload ?? null);
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
    const msg = parseServerMessage(event.data);
    if (!msg) return;

    switch (msg.type) {
      case 'trackerDelta':
        await this.handleDelta(msg);
        break;
      case 'trackerMutationAck':
        await this.handleAck(msg);
        break;
      case 'trackerSchemaDelta':
        await this.handleSchemaDelta(msg);
        break;
      case 'trackerSchemaMutationAck':
        await this.handleSchemaAck(msg);
        break;
      case 'trackerConfigBroadcast':
        this.handleConfigBroadcast(msg);
        break;
      case 'trackerPong':
        // Keep-alive response; nothing to do.
        break;
      case 'trackerError':
        // Server-level error (not tied to a specific mutation). Surface as
        // a status transition; the connection stays open.
        this.setStatus('error');
        break;
      case 'trackerSyncResponse':
        // The bootstrap loop owns these via its inline `requestSync`
        // listener. Live deltas show up as `trackerDelta`.
        break;
      case 'trackerSchemaSyncResponse':
        // The schema bootstrap loop owns these via `requestSchemaSync`.
        break;
    }
  }

  private async handleDelta(msg: TrackerDeltaMessage): Promise<void> {
    const applied = await this.applyEnvelope(msg.item);
    // Live delta tagged with a fingerprint we don't have: opportunistically
    // refresh and re-apply. Bootstrap-loop staleness has its own check, but
    // a delta that arrives AFTER bootstrap completes still needs this
    // signal so a rotation that lands while we're idle doesn't silently
    // drop deltas until the user issues a mutation.
    if (!applied && msg.item.orgKeyFingerprint && this.orgKeyFingerprint &&
        msg.item.orgKeyFingerprint !== this.orgKeyFingerprint &&
        this.config.refreshKey) {
      const fresh = await this.config.refreshKey();
      if (fresh) {
        this.setKey(fresh);
        await this.applyEnvelope(msg.item);
      }
    }
  }

  private async handleAck(msg: TrackerMutationAckMessage): Promise<void> {
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
      await this.persistence.ackTransaction(clientMutationId, msg.syncId);
      this.rollbackSnapshots.delete(clientMutationId);
      return;
    }

    if (!accepted && msg.error) {
      const snapshot = this.rollbackSnapshots.get(clientMutationId);

      // `staleKeyEpoch` triggers a refresh + re-send under the new key.
      if (msg.error.code === 'staleKeyEpoch' && this.config.refreshKey) {
        const fresh = await this.config.refreshKey();
        if (fresh) {
          this.setKey(fresh);
          if (snapshot) {
            // Reload the transaction row from persistence to find its
            // payload + kind, then re-send.
            const pending = await this.persistence.loadPendingTransactions();
            const row = pending.find(r => r.clientMutationId === clientMutationId);
            if (row) {
              await this.persistence.markTransactionState(clientMutationId, 'queued');
              await this.driveTransaction(row);
              return;
            }
          }
        }
        // Fall through to a normal rejection if we can't refresh.
      }

      const rejection = {
        code: msg.error.code,
        message: msg.error.message,
        occurredAt: Date.now(),
      };
      await this.persistence.rejectTransaction(clientMutationId, rejection);
      if (snapshot) {
        await this.persistence.rollbackOptimistic(snapshot.itemId, snapshot.snapshot);
        this.rollbackSnapshots.delete(clientMutationId);
        this.config.onRejection?.({
          clientMutationId,
          itemId: snapshot.itemId,
          rejection,
        });
      }
    }
  }

  private async handleSchemaDelta(msg: TrackerSchemaDeltaMessage): Promise<void> {
    console.info(
      `[TrackerSchemaSync] delta type=${msg.schema.schemaType} sync_id=${msg.schema.syncId} tombstone=${msg.schema.encryptedPayload === null}`,
    );
    const applied = await this.applySchemaEnvelope(msg.schema);
    if (!applied && msg.schema.orgKeyFingerprint && this.orgKeyFingerprint &&
        msg.schema.orgKeyFingerprint !== this.orgKeyFingerprint &&
        this.config.refreshKey) {
      const fresh = await this.config.refreshKey();
      if (fresh) {
        this.setKey(fresh);
        await this.applySchemaEnvelope(msg.schema);
      }
    }
  }

  private async handleSchemaAck(msg: TrackerSchemaMutationAckMessage): Promise<void> {
    console.info(
      `[TrackerSchemaSync] ack cmid=${msg.clientMutationId} accepted=${msg.accepted}` +
        `${msg.schema ? ` type=${msg.schema.schemaType} sync_id=${msg.schema.syncId}` : ''}` +
        `${msg.error ? ` error=${msg.error.code}` : ''}`,
    );
    if (msg.accepted && msg.schema) {
      await this.applySchemaEnvelope(msg.schema);
      return;
    }

    if (!msg.accepted && msg.error?.code === 'staleKeyEpoch' && this.config.refreshKey) {
      const fresh = await this.config.refreshKey();
      if (fresh) {
        this.setKey(fresh);
        await this.pushPendingSchemas();
      }
    }
  }

  private handleConfigBroadcast(msg: TrackerConfigBroadcastMessage): void {
    this.config.onConfigChange?.(msg.config);
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
  private async applyEnvelope(envelope: EncryptedTrackerItemEnvelope): Promise<boolean> {
    const isTombstone = envelope.encryptedPayload === null;
    let payload: TrackerItemPayload | null = null;
    if (!isTombstone) {
      try {
        payload = await decryptTrackerEnvelope(envelope, this.encryptionKey);
      } catch (err) {
        // OperationError = AES-GCM auth failure. Two causes look the same
        // at this layer:
        //   1. Wrong key (rotation: client holds stale key vs. envelope
        //      written by another client with the new key).
        //   2. Identifier splice -- server rewrote `itemId` /
        //      `issueNumber` / `issueKey` on the envelope without holding
        //      the key, so the AAD bound at encrypt time no longer matches.
        // Per DocumentSync precedent, skip the row and move on -- the
        // bootstrap loop / delta stream keeps progressing. The caller
        // uses the `false` return to trigger a key refresh.
        //
        // We check `err.name === 'OperationError'` instead of `err
        // instanceof DOMException`. Runtime environments expose
        // DOMException from different realms (vitest workers, Cloudflare
        // Workers, V8 isolates), and instanceof can return false even when
        // the constructor name matches. Name-based identification matches
        // the WebCrypto spec contract and is realm-safe.
        if (err !== null && typeof err === 'object' && (err as { name?: string }).name === 'OperationError') {
          return false;
        }
        throw err;
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

  private async applySchemaEnvelope(envelope: EncryptedTrackerSchemaEnvelope): Promise<boolean> {
    const hooks = this.config.schemaSync;
    if (!hooks) return true;

    const isTombstone = envelope.encryptedPayload === null;
    let model: string | null = null;
    if (!isTombstone) {
      try {
        model = await decryptTrackerSchemaEnvelope(envelope, this.encryptionKey);
      } catch (err) {
        if (err !== null && typeof err === 'object' && (err as { name?: string }).name === 'OperationError') {
          return false;
        }
        throw err;
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

  // --------------------------------------------------------------------------
  // Queue drive
  // --------------------------------------------------------------------------

  private async enqueueMutation(
    itemId: string,
    payload: TrackerItemPayload | null,
    kind: 'create' | 'update' | 'delete',
    options: { persistedEnqueue?: boolean },
  ): Promise<{ clientMutationId: string }> {
    const clientMutationId = generateClientMutationId();
    const now = Date.now();

    const row: TrackerTransactionRow = {
      clientMutationId,
      itemId,
      workspacePath: '',  // host adapter fills this in; engine doesn't care
      state: options.persistedEnqueue ? 'persistedEnqueue' : 'created',
      kind,
      payload: payload ?? undefined,
      enqueuedAt: now,
    };

    let snapshot: TrackerRowSnapshot;
    if (options.persistedEnqueue) {
      snapshot = await this.persistence.applyAndEnqueueAtomically(itemId, payload, row);
    } else {
      snapshot = await this.persistence.applyOptimistic(itemId, payload);
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
    if (!this.orgKeyFingerprint) return;

    const startedAt = Date.now();
    await this.persistence.markTransactionState(row.clientMutationId, 'executing', startedAt);

    const isDelete = row.kind === 'delete' || row.payload === undefined;

    if (isDelete) {
      this.send({
        type: 'trackerMutation',
        clientMutationId: row.clientMutationId,
        itemId: row.itemId,
        encryptedPayload: null,
        orgKeyFingerprint: this.orgKeyFingerprint,
      });
      return;
    }

    const enc = await encryptTrackerPayload(row.payload!, this.encryptionKey, row.itemId);
    this.send({
      type: 'trackerMutation',
      clientMutationId: row.clientMutationId,
      itemId: row.itemId,
      encryptedPayload: enc.encryptedPayload,
      iv: enc.iv,
      orgKeyFingerprint: this.orgKeyFingerprint,
      ...(row.payload?.issueNumber !== undefined ? { issueNumber: row.payload.issueNumber } : {}),
      ...(row.payload?.issueKey !== undefined ? { issueKey: row.payload.issueKey } : {}),
    });
  }

  private async pushPendingSchemas(): Promise<void> {
    const hooks = this.config.schemaSync;
    if (!hooks) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.orgKeyFingerprint) return;

    const pending = await hooks.listUnsynced();
    if (pending.length > 0) {
      console.info(`[TrackerSchemaSync] pushing ${pending.length} unsynced schema mutation(s)`);
    }
    for (const def of pending) {
      const clientMutationId = generateClientMutationId();
      if (def.deleted || def.model === null) {
        console.info(`[TrackerSchemaSync] -> mutation (delete) type=${def.type} cmid=${clientMutationId}`);
        this.send({
          type: 'trackerSchemaMutation',
          clientMutationId,
          schemaType: def.type,
          encryptedPayload: null,
          orgKeyFingerprint: this.orgKeyFingerprint,
        });
        continue;
      }

      const enc = await encryptTrackerSchemaPayload(def.model, this.encryptionKey, def.type);
      console.info(`[TrackerSchemaSync] -> mutation (upsert) type=${def.type} cmid=${clientMutationId}`);
      this.send({
        type: 'trackerSchemaMutation',
        clientMutationId,
        schemaType: def.type,
        encryptedPayload: enc.encryptedPayload,
        iv: enc.iv,
        orgKeyFingerprint: this.orgKeyFingerprint,
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

  private handleDisconnect(): void {
    const shouldReconnect = !this.suppressReconnect;
    this.stopPing();
    this.ws = null;
    this.synced = false;
    this.connecting = false;
    this.setStatus('disconnected');
    if (shouldReconnect && !this.destroyed) {
      this.scheduleReconnect();
    }
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
      this.send({ type: 'trackerPing' });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a stable client mutation ID. The format is informational; the
 * server treats it as an opaque string echoed back in
 * `trackerMutationAck`.
 */
function generateClientMutationId(): string {
  // crypto.randomUUID is available in both browsers and Node 19+, which
  // covers every platform the engine runs on.
  const uuid = crypto.randomUUID();
  return `cm-${uuid}`;
}

function parseServerMessage(data: unknown): TrackerServerMessage | null {
  const text =
    typeof data === 'string'
      ? data
      : typeof data === 'object' && data && 'toString' in data
        ? String(data)
        : null;
  if (text === null) return null;
  try {
    return JSON.parse(text) as TrackerServerMessage;
  } catch {
    return null;
  }
}
