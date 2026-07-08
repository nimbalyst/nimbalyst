/**
 * DocumentSyncProvider
 *
 * Client-side Yjs document sync with E2E encryption over WebSocket.
 * Connects to a DocumentRoom Durable Object, sends/receives encrypted
 * Yjs updates, and manages awareness state.
 *
 * The provider:
 * - Creates and owns a Y.Doc instance
 * - Encrypts all outgoing Yjs updates with AES-256-GCM
 * - Decrypts incoming updates and applies them to the Y.Doc
 * - Handles sync (initial load), realtime broadcasts, and awareness
 * - Never sends plaintext data over the wire
 *
 * Review Gate:
 * When reviewGateEnabled is true, remote updates are applied to the Y.Doc
 * (for CRDT correctness) but tracked as "unreviewed". The host application
 * should not autosave until acceptRemoteChanges() is called. This mirrors
 * the AI "pending review" pattern for collaborator trust boundaries.
 */

import * as Y from 'yjs';
import type {
  DocumentSyncConfig,
  DocumentSyncStatus,
  AwarenessState,
  ReviewGateState,
  DocClientMessage,
  DocServerMessage,
  DocSyncResponseMessage,
  DocUpdateBroadcastMessage,
  DocAwarenessBroadcastMessage,
  DocUpdateAckMessage,
} from './documentSyncTypes';
import { appendSyncClientParams } from './syncClientInfo';
import { encodeDocumentRoomId, isValidCollabDocumentId } from './collabDocumentId';

// ============================================================================
// Base64 / Encryption Utilities
// ============================================================================

const CHUNK_SIZE = 8192;

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.length < 1024) {
    return btoa(String.fromCharCode(...bytes));
  }
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    result += String.fromCharCode(...chunk);
  }
  return btoa(result);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function encryptBinary(
  data: Uint8Array,
  key: CryptoKey
): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data as BufferSource
  );
  return {
    encrypted: uint8ArrayToBase64(new Uint8Array(ciphertext)),
    iv: uint8ArrayToBase64(iv),
  };
}

async function decryptBinary(
  encrypted: string,
  iv: string,
  key: CryptoKey
): Promise<Uint8Array> {
  const ciphertext = base64ToUint8Array(encrypted);
  const ivBytes = base64ToUint8Array(iv);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes as BufferSource },
    key,
    ciphertext as BufferSource
  );
  return new Uint8Array(plaintext);
}

// ============================================================================
// DocumentSyncProvider
// ============================================================================

/** Origin string used for remote Yjs transactions */
const REMOTE_ORIGIN = 'remote';

/** Origin string used for snapshot Yjs transactions */
const SNAPSHOT_ORIGIN = 'snapshot';

/** Origin string used when restoring persisted local pending updates. */
const PERSISTED_PENDING_ORIGIN = 'persistedPending';

/** Awareness throttle interval: ~2Hz */
const AWARENESS_THROTTLE_MS = 500;

/** Remove awareness state for users who haven't sent an update in this many ms */
const AWARENESS_STALE_TIMEOUT_MS = 30_000;

/**
 * Compaction thresholds.
 *
 * The server stores every encrypted Yjs update forever unless a client sends
 * `docCompact`. Without compaction, initial sync downloads the full update
 * history every time, so heavy docs (and any non-markdown collab doc that
 * generates many small ops, e.g. Excalidraw drags) become slow to open.
 *
 * Triggers (whichever fires first while we are the elector):
 *   1. >= COMPACTION_UPDATE_THRESHOLD updates since last snapshot
 *   2. >= COMPACTION_TIME_MIN_UPDATES updates AND
 *      >= COMPACTION_TIME_THRESHOLD_MS since last attempt
 *
 * Election: lowest userId (string compare) among the local user and all remote
 * users we currently see in awareness. If a remote client hasn't broadcast
 * awareness yet, we may briefly think we are elector when we aren't -- the
 * server accepts the second snapshot harmlessly (older snapshot row is
 * dropped by `DELETE FROM snapshots WHERE replaces_up_to < ?`).
 */
const COMPACTION_UPDATE_THRESHOLD = 200;
const COMPACTION_TIME_THRESHOLD_MS = 5 * 60 * 1000;
const COMPACTION_TIME_MIN_UPDATES = 20;
const COMPACTION_CHECK_INTERVAL_MS = 60 * 1000;

/**
 * A buffered remote update: the raw Yjs update bytes plus metadata.
 * Used by the review gate to track which remote changes are unreviewed.
 */
interface BufferedRemoteUpdate {
  /** Raw decrypted Yjs update bytes */
  updateBytes: Uint8Array;
  /** User who sent this update */
  senderId: string;
  /** Server sequence number */
  sequence: number;
  /** When we received this update locally */
  receivedAt: number;
}

export class DocumentSyncProvider {
  private ydoc: Y.Doc;
  private ws: WebSocket | null = null;
  private config: DocumentSyncConfig;
  private status: DocumentSyncStatus = 'disconnected';
  private lastSeq = 0;
  private synced = false;
  // Last-writer attribution from the server (who/when last edited the content).
  // Populated from docSyncResponse; used by the overwrite confirm before a push.
  private lastWriterUserId: string | null = null;
  private lastUpdatedAt: number | null = null;
  private updateObserverDispose: (() => void) | null = null;
  private awarenessStates: Map<string, AwarenessState> = new Map();
  private awarenessTimestamps: Map<string, number> = new Map();
  private awarenessListeners: Set<(states: Map<string, AwarenessState>) => void> = new Set();
  private destroyed = false;

  // Throttled awareness state
  private pendingAwareness: AwarenessState | null = null;
  private awarenessThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAwarenessSendTime = 0;
  private awarenessCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Review gate state
  private unreviewedUpdates: BufferedRemoteUpdate[] = [];
  /**
   * The Y.Doc state vector at the point of last review acceptance.
   * All state up to this vector has been accepted for autosave.
   * Null until initial sync completes (at which point it's set to the
   * current state vector, since initial sync data is considered accepted).
   */
  private reviewedStateVector: Uint8Array | null = null;

  // Reconnect state
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressReconnect = false;
  /**
   * NIM-949: set when the server rejected the ws upgrade with an auth-style
   * status (proxy forwards a close reason of `auth-rejected:<status>`). The next
   * connect() then requests a freshly-exchanged JWT instead of replaying the
   * cached (wrong-org / expired) token that just got rejected.
   */
  private forceJwtRefreshNextConnect = false;
  private queuedPendingUpdate: Uint8Array | null = null;
  private inflightPendingUpdate: Uint8Array | null = null;
  private pendingPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private replayAckTimer: ReturnType<typeof setTimeout> | null = null;
  private replayingClientUpdateId: string | null = null;
  private surfaceReplayStatus = false;
  private pendingWriteWaiters: Set<() => void> = new Set();
  private static readonly RECONNECT_BASE_MS = 1000;
  private static readonly RECONNECT_MAX_MS = 30_000;
  private static readonly REPLAY_ACK_TIMEOUT_MS = 10_000;

  // Compaction state
  /**
   * Server sequence covered by the latest snapshot we know about. Updated
   * when (a) we apply a server snapshot during sync, and (b) we send our
   * own `docCompact`. Used to compute how many updates have accumulated.
   */
  private lastSnapshotSeq = 0;

  /**
   * True once ANY snapshot/update/broadcast failed to decode and was skipped
   * (the NIM-878 tolerant-skip). `lastSeq` still advances past skipped rows, so
   * this doc is missing server content it can never re-fetch on this provider
   * (resync resumes from `lastSeq`). While set, this client must NEVER win
   * compaction: a `docCompact` of an incomplete doc buries the unread rows
   * behind `replacesUpTo` for every client and prune later deletes them
   * (NIM-1519). Deliberately never reset for the provider's lifetime.
   */
  private skippedUndecodablePayload = false;
  private lastCompactionAttemptAt = 0;
  private compactionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: DocumentSyncConfig) {
    this.config = config;
    this.ydoc = new Y.Doc();
    this.setupUpdateObserver();

    if (config.initialPendingUpdateBase64) {
      try {
        this.queuedPendingUpdate = base64ToUint8Array(config.initialPendingUpdateBase64);
        Y.applyUpdate(
          this.ydoc,
          this.queuedPendingUpdate,
          PERSISTED_PENDING_ORIGIN
        );
        this.setStatus('offline-unsynced');
      } catch (err) {
        console.error('[DocumentSync] Failed to restore pending local update:', err);
        this.queuedPendingUpdate = null;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Connect to the DocumentRoom and begin syncing.
   */
  private connecting = false;

  async connect(): Promise<void> {
    if (this.destroyed) return;
    if (this.ws || this.connecting) return;

    this.suppressReconnect = false;
    this.connecting = true;
    this.setStatus('connecting');

    const { serverUrl, orgId, documentId } = this.config;

    // The documentId goes into the URL path. UUID/hex ids are already URL-safe;
    // legacy filename-shaped ids (spaces, '%', '.') are not, so we URL-encode
    // the segment -- the server decodes it back before addressing the DO. Warn
    // once so legacy ids stay visible without blocking the connection.
    if (!isValidCollabDocumentId(documentId)) {
      console.warn(
        `[DocumentSync] documentId ${JSON.stringify(documentId)} is not a plain ` +
          'URL-safe id (likely a legacy filename); connecting with it URL-encoded.'
      );
    }
    const roomId = encodeDocumentRoomId(orgId, documentId);

    let url: string;
    try {
      if (this.config.buildUrl) {
        url = this.config.buildUrl(roomId);
      } else {
        const forceRefresh = this.forceJwtRefreshNextConnect;
        this.forceJwtRefreshNextConnect = false;
        const jwt = await this.config.getJwt(forceRefresh ? { forceRefresh: true } : undefined);
        url = appendSyncClientParams(`${serverUrl}/sync/${roomId}?token=${encodeURIComponent(jwt)}`);
      }
    } catch (err) {
      console.error('[DocumentSync] Failed to build URL:', err);
      this.connecting = false;
      this.setStatus(this.hasPendingLocalUpdates() ? 'offline-unsynced' : 'disconnected');
      return;
    }

    // Check again after async gap
    if (this.destroyed || this.ws) {
      this.connecting = false;
      return;
    }

    console.log('[DocumentSync] Connecting to:', url.replace(/token=[^&]+/, 'token=<redacted>'));
    const ws = this.config.createWebSocket
      ? this.config.createWebSocket(url)
      : new WebSocket(url);
    this.ws = ws;
    this.connecting = false;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      console.log('[DocumentSync] WebSocket open');
      this.suppressReconnect = false;
      this.reconnectAttempt = 0;
      this.setStatus('syncing');
      this.startAwarenessCleanup();
      this.requestSync();
    });

    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return;
      this.handleMessage(event);
    });

    ws.addEventListener('close', (event) => {
      // Stale close from a socket we already replaced (e.g. via reconnectNow)
      // must not call handleDisconnect() -- that would null out `this.ws` and
      // clobber the new socket.
      if (this.ws !== ws) return;
      console.log('[DocumentSync] WebSocket closed, code:', event.code, 'reason:', event.reason);
      // NIM-949: the proxy encodes an auth-style upgrade rejection as
      // `auth-rejected:<status>`. Force a fresh JWT exchange on the next attempt
      // so we don't re-present the same rejected (wrong-org / expired) token.
      if (typeof event.reason === 'string' && event.reason.startsWith('auth-rejected')) {
        this.forceJwtRefreshNextConnect = true;
      }
      this.handleDisconnect();
    });

    ws.addEventListener('error', (event) => {
      if (this.ws !== ws) return;
      console.error('[DocumentSync] WebSocket error:', event);
      this.handleDisconnect();
    });
  }

  /**
   * Disconnect from the DocumentRoom.
   */
  disconnect(): void {
    this.cancelReconnect();
    this.clearReplayAckTimer();
    this.connecting = false;
    this.suppressReconnect = true;
    this.requeueInflightPendingUpdate();
    this.stopAwarenessCleanup();
    this.clearAwarenessThrottle();
    this.stopCompactionTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.synced = false;
    this.setStatus(
      this.hasPendingLocalUpdates() ? 'offline-unsynced' : 'disconnected'
    );
  }

  /**
   * Destroy the provider and its Y.Doc. Cannot be reused after this.
   */
  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    this.teardownUpdateObserver();
    this.flushPendingPersistImmediately();
    this.ydoc.destroy();
    this.awarenessListeners.clear();
    this.awarenessStates.clear();
    this.unreviewedUpdates = [];
    this.reviewedStateVector = null;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** Get the Y.Doc managed by this provider. */
  getYDoc(): Y.Doc {
    return this.ydoc;
  }

  /**
   * The room-authed userId of whoever last applied a content update, or null if
   * the doc has no updates yet / the server hasn't reported it. Populated from
   * the server's docSyncResponse. Reflects the last *content* edit.
   */
  getLastWriterUserId(): string | null {
    return this.lastWriterUserId;
  }

  /** When the last content update was applied (server clock, ms), or null. */
  getLastUpdatedAt(): number | null {
    return this.lastUpdatedAt;
  }

  /** Check if connected and synced. */
  isConnected(): boolean {
    return this.status === 'connected';
  }

  /** Check if initial sync is complete. */
  isSynced(): boolean {
    return this.synced;
  }

  /** Get current connection status. */
  getStatus(): DocumentSyncStatus {
    return this.status;
  }

  /** Get the last known server sequence number. */
  getLastSeq(): number {
    return this.lastSeq;
  }

  /**
   * True when any snapshot/update/broadcast was skipped as undecodable this
   * provider's lifetime. While true, the Y.Doc looking "empty" does NOT mean
   * the room is empty — server content exists that this client cannot read.
   * Hosts must gate first-open seeding on this (seeding a default document
   * over unreadable-but-real content clobbers it for every client) and this
   * provider will never compact (NIM-1519).
   */
  hasUndecodedContent(): boolean {
    return this.skippedUndecodablePayload;
  }

  /**
   * Wait until all local writes have either been acknowledged or timed out.
   * Returns false when the timeout elapses first.
   */
  async waitForPendingWrites(timeoutMs = 5_000): Promise<boolean> {
    if (!this.hasUnsettledPendingWrites()) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;

      const cleanup = () => {
        this.pendingWriteWaiters.delete(waiter);
        clearTimeout(timeout);
      };

      const waiter = () => {
        if (settled || this.hasUnsettledPendingWrites()) return;
        settled = true;
        cleanup();
        resolve(true);
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      }, timeoutMs);

      this.pendingWriteWaiters.add(waiter);
      waiter();
    });
  }

  /**
   * Set room-level metadata on the server (e.g., custom TTL).
   * Only allowlisted keys are accepted server-side.
   */
  setRoomMetadata(entries: Record<string, string>): void {
    this.send({ type: 'docSetMetadata', entries });
  }

  /** Epic H2: true when the server holds the team DEK (no client crypto). */
  private get serverManaged(): boolean {
    return this.config.keyCustody === 'server-managed';
  }

  /**
   * Ordered candidate keys for decrypting a legacy-e2e (non-empty-iv) row in
   * server-managed mode. Tries the multi-epoch list first (NIM-959), then the
   * singular legacy key, then the document key as a last resort. Duplicates are
   * harmless (a wrong key just throws and we move on), so no dedup is needed.
   */
  private get legacyCandidateKeys(): CryptoKey[] {
    const keys: CryptoKey[] = [];
    if (this.config.legacyDocumentKeys) keys.push(...this.config.legacyDocumentKeys);
    if (this.config.legacyDocumentKey) keys.push(this.config.legacyDocumentKey);
    if (this.config.documentKey) keys.push(this.config.documentKey);
    return keys;
  }

  /**
   * Encrypt bytes for the wire. Legacy: AES-256-GCM with the document key.
   * Server-managed: pass-through (base64 raw bytes, empty-string iv sentinel) —
   * the server encrypts at rest with the team DEK.
   */
  private async encryptForWire(data: Uint8Array): Promise<{ encrypted: string; iv: string }> {
    if (this.serverManaged) {
      return { encrypted: uint8ArrayToBase64(data), iv: '' };
    }
    return encryptBinary(data, this.config.documentKey!);
  }

  /**
   * Decrypt bytes from the wire.
   *
   * Server-managed mode is mixed during/after migration:
   *   - Rows the server decrypted with the team DEK arrive as PLAINTEXT with an
   *     empty-iv sentinel ('') -> just base64-decode.
   *   - PRE-MIGRATION (legacy-e2e) rows are passed through UNCHANGED: AES
   *     ciphertext with their original (non-empty) iv. These must be AES-
   *     decrypted with the legacy org key, or they decode to garbage and Yjs
   *     throws. We fall back to `legacyDocumentKey` (or `documentKey`) for them.
   */
  private async decryptFromWire(encrypted: string, iv: string): Promise<Uint8Array> {
    if (this.serverManaged) {
      // Empty iv sentinel => server already decrypted (plaintext passthrough).
      if (!iv) {
        return base64ToUint8Array(encrypted);
      }
      // Non-empty iv => legacy ciphertext that survived the migration. The row
      // may have been written under any past org-key epoch (the team could have
      // rotated while still legacy-e2e), so try EVERY candidate epoch in turn --
      // current cached key, the singular legacy key, and all archived epochs --
      // until one AES-decrypts. If none match, surface an error so the per-
      // payload catch skips just this row rather than blanking the doc (NIM-959).
      const legacyKeys = this.legacyCandidateKeys;
      if (legacyKeys.length === 0) {
        throw new Error('legacy-e2e row in server-managed doc but no legacy org key available');
      }
      let lastErr: unknown;
      for (const key of legacyKeys) {
        try {
          return await decryptBinary(encrypted, iv, key);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error('legacy-e2e row did not match any candidate org-key epoch');
    }
    return decryptBinary(encrypted, iv, this.config.documentKey!);
  }

  /** Org key fingerprint to attach to a write; null/undefined in server-managed. */
  private get wireOrgKeyFingerprint(): string | undefined {
    return this.serverManaged ? undefined : this.config.orgKeyFingerprint;
  }

  /**
   * Send encrypted awareness state to other connected clients.
   * Sends immediately (no throttling). Use setLocalAwareness() for throttled updates.
   */
  async sendAwareness(state: AwarenessState): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const jsonBytes = new TextEncoder().encode(JSON.stringify(state));
    const { encrypted, iv } = await this.encryptForWire(jsonBytes);

    this.send({
      type: 'docAwareness',
      encryptedState: encrypted,
      iv,
    });
  }

  /**
   * Set local awareness state with throttling (~2Hz).
   * Coalesces rapid updates (e.g., cursor movements while typing) and sends
   * at most once per AWARENESS_THROTTLE_MS.
   */
  setLocalAwareness(state: AwarenessState): void {
    this.pendingAwareness = state;

    const now = Date.now();
    const elapsed = now - this.lastAwarenessSendTime;

    if (elapsed >= AWARENESS_THROTTLE_MS) {
      // Enough time has passed, send immediately
      this.flushAwareness();
    } else if (!this.awarenessThrottleTimer) {
      // Schedule a send after the throttle interval
      const delay = AWARENESS_THROTTLE_MS - elapsed;
      this.awarenessThrottleTimer = setTimeout(() => {
        this.awarenessThrottleTimer = null;
        this.flushAwareness();
      }, delay);
    }
    // If timer already scheduled, the pending state will be sent when it fires
  }

  private flushAwareness(): void {
    if (!this.pendingAwareness) return;
    const state = this.pendingAwareness;
    this.pendingAwareness = null;
    // Set timestamp synchronously before the async send, so rapid
    // calls to setLocalAwareness see the updated time immediately
    this.lastAwarenessSendTime = Date.now();
    this.sendAwareness(state);
  }

  private clearAwarenessThrottle(): void {
    if (this.awarenessThrottleTimer) {
      clearTimeout(this.awarenessThrottleTimer);
      this.awarenessThrottleTimer = null;
    }
    this.pendingAwareness = null;
  }

  /**
   * Subscribe to awareness state changes from remote users.
   * Returns an unsubscribe function.
   */
  onAwarenessChange(
    callback: (states: Map<string, AwarenessState>) => void
  ): () => void {
    this.awarenessListeners.add(callback);
    return () => this.awarenessListeners.delete(callback);
  }

  /**
   * Get current awareness states for all remote users.
   */
  getAwarenessStates(): Map<string, AwarenessState> {
    return new Map(this.awarenessStates);
  }

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
  async flushLocalState(): Promise<void> {
    const update = Y.encodeStateAsUpdate(this.ydoc);
    if (update.length <= 2) return;
    this.enqueuePendingLocalUpdate(update);
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.synced) {
      await this.replayPendingUpdate();
    }
  }

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
  async flushWithAck(timeoutMs = 5_000): Promise<boolean> {
    const update = Y.encodeStateAsUpdate(this.ydoc);
    if (update.length <= 2) return true;
    this.enqueuePendingLocalUpdate(update);
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.synced) {
      await this.replayPendingUpdate();
    }
    return this.waitForPendingWrites(timeoutMs);
  }

  // --------------------------------------------------------------------------
  // Review Gate API
  // --------------------------------------------------------------------------

  /**
   * Whether the review gate is enabled.
   * When enabled, remote changes are tracked as "unreviewed" and the host
   * application should not autosave until they are accepted.
   */
  get reviewGateEnabled(): boolean {
    return this.config.reviewGateEnabled === true;
  }

  /**
   * Whether there are unreviewed remote changes.
   * Always false when reviewGateEnabled is false.
   */
  hasUnreviewedRemoteChanges(): boolean {
    if (!this.reviewGateEnabled) return false;
    return this.unreviewedUpdates.length > 0;
  }

  /**
   * Get the current review gate state.
   */
  getReviewGateState(): ReviewGateState {
    if (!this.reviewGateEnabled) {
      return { hasUnreviewed: false, unreviewedCount: 0, unreviewedAuthors: [] };
    }
    const authors = [...new Set(this.unreviewedUpdates.map(u => u.senderId))];
    return {
      hasUnreviewed: this.unreviewedUpdates.length > 0,
      unreviewedCount: this.unreviewedUpdates.length,
      unreviewedAuthors: authors,
    };
  }

  /**
   * Get the buffered remote update bytes that haven't been reviewed yet.
   * Returns a copy. The UI layer can apply these to a separate Y.Doc
   * to compute diffs for gutter decorations.
   */
  getUnreviewedUpdates(): Uint8Array[] {
    return this.unreviewedUpdates.map(u => u.updateBytes.slice());
  }

  /**
   * Get the Yjs state as it was at the last review acceptance point.
   * The host can compare this to the current Y.Doc state to show diffs.
   * Returns null if no review has occurred yet (initial sync not complete).
   */
  getReviewedStateVector(): Uint8Array | null {
    return this.reviewedStateVector ? this.reviewedStateVector.slice() : null;
  }

  /**
   * Compute the diff between the reviewed state and the current Y.Doc.
   * Returns a Yjs update that, when applied to a Y.Doc at the reviewed state,
   * would bring it to the current state. This represents all unreviewed
   * remote changes (useful for rendering diffs/gutter decorations).
   *
   * Returns null if no review baseline exists or no remote changes pending.
   */
  getUnreviewedDiff(): Uint8Array | null {
    if (!this.reviewGateEnabled || !this.reviewedStateVector) return null;
    if (this.unreviewedUpdates.length === 0) return null;
    return Y.encodeStateAsUpdate(this.ydoc, this.reviewedStateVector);
  }

  /**
   * Accept all unreviewed remote changes.
   * Advances the reviewed state vector to the current Y.Doc state.
   * After this call, hasUnreviewedRemoteChanges() returns false and
   * the host application can safely autosave.
   */
  acceptRemoteChanges(): void {
    if (!this.reviewGateEnabled) return;
    if (this.unreviewedUpdates.length === 0) return;

    this.unreviewedUpdates = [];
    this.reviewedStateVector = Y.encodeStateVector(this.ydoc);
    this.notifyReviewStateChange();
  }

  /**
   * Reject all unreviewed remote changes.
   * Clears the unreviewed buffer without advancing the reviewed state vector.
   *
   * The Y.Doc still contains the remote data (CRDTs can't truly undo merged
   * operations). The host application should:
   * 1. Not autosave the current Y.Doc state
   * 2. Restore the file from its last saved version (which doesn't include
   *    the remote changes, since the review gate prevented autosave)
   *
   * The remote changes still exist on the server and will be re-sent on
   * next sync. To permanently prevent them, the user would need to
   * overwrite the server state (e.g., via compaction with their local state).
   */
  rejectRemoteChanges(): void {
    if (!this.reviewGateEnabled) return;
    if (this.unreviewedUpdates.length === 0) return;
    if (!this.reviewedStateVector) return;

    this.unreviewedUpdates = [];
    // Keep the reviewed SV as-is (don't advance it)
    this.notifyReviewStateChange();
  }

  // --------------------------------------------------------------------------
  // Sync Protocol
  // --------------------------------------------------------------------------

  private requestSync(): void {
    this.send({ type: 'docSyncRequest', sinceSeq: this.lastSeq });
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    try {
      const data =
        typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      const msg: DocServerMessage = JSON.parse(data);

      switch (msg.type) {
        case 'docSyncResponse':
          await this.handleSyncResponse(msg);
          break;
        case 'docUpdateBroadcast':
          await this.handleUpdateBroadcast(msg);
          break;
        case 'docUpdateAck':
          this.handleUpdateAck(msg);
          break;
        case 'docAwarenessBroadcast':
          await this.handleAwarenessBroadcast(msg);
          break;
        case 'keyEnvelope':
          this.config.onKeyEnvelope?.({
            wrappedKey: msg.wrappedKey,
            iv: msg.iv,
            senderPublicKey: msg.senderPublicKey,
            senderUserId: msg.senderUserId,
          });
          break;
        case 'docRoomMoved':
          // Epic H3 P1: the room was relocated to another org. Stop (the old
          // room is frozen) and let the host re-resolve + reconnect.
          this.disconnect();
          this.config.onRoomMoved?.({ destOrgId: msg.destOrgId });
          break;
        case 'error':
          console.error('[DocumentSync] Server error:', msg.code, msg.message);
          break;
      }
    } catch (err) {
      console.error('[DocumentSync] Error handling message:', err);

      // Decryption failures are now handled per-payload inside each sub-
      // handler (handleSyncResponse, handleUpdateBroadcast, handleAwareness-
      // Broadcast). Any OperationError that reaches here is an unexpected
      // escape; log it but never set suppressReconnect. A single bad payload
      // must not permanently kill a room.
      if (err instanceof DOMException && err.name === 'OperationError') {
        console.warn('[DocumentSync] Uncaught OperationError at handleMessage scope -- dropping message.');
        return;
      }
    }
  }

  private async handleSyncResponse(msg: DocSyncResponseMessage): Promise<void> {
    // Capture last-writer attribution (sent on every sync response; the value
    // reflects the latest content update, so it's stable across pagination).
    if (msg.lastWriterUserId !== undefined) {
      this.lastWriterUserId = msg.lastWriterUserId;
    }
    if (msg.lastUpdatedAt !== undefined) {
      this.lastUpdatedAt = msg.lastUpdatedAt;
    }

    // Apply snapshot if present (covers the entire doc state up to replacesUpTo).
    // If the snapshot can't be decrypted (stale key epoch, corruption), skip it
    // and continue with the incremental updates -- a single broken payload
    // must not kill the whole sync. If nothing decrypts, the Y.Doc stays
    // empty and the host can bootstrap from local content, pushing a fresh
    // authoritative update up to the server.
    if (msg.snapshot) {
      try {
        const stateBytes = await this.decryptFromWire(
          msg.snapshot.encryptedState,
          msg.snapshot.iv,
        );
        Y.applyUpdate(this.ydoc, stateBytes, SNAPSHOT_ORIGIN);
      } catch (err) {
        // Any per-payload failure -- stale key epoch (OperationError), an
        // un-migrated legacy-e2e row with no legacy key, or corrupt bytes that
        // make Y.applyUpdate throw (TypeError/RangeError) -- must skip only THIS
        // payload, never abort the whole sync. One bad row must not blank the
        // entire document body. See NIM-878.
        console.warn('[DocumentSync] Skipping undecodable snapshot; sync will continue:', err instanceof Error ? err.message : err);
        this.skippedUndecodablePayload = true;
      }
      this.lastSeq = Math.max(this.lastSeq, msg.snapshot.replacesUpTo);
      this.lastSnapshotSeq = Math.max(this.lastSnapshotSeq, msg.snapshot.replacesUpTo);
    }

    // Apply incremental updates, per-update tolerant of decryption failures.
    for (const update of msg.updates) {
      try {
        const updateBytes = await this.decryptFromWire(
          update.encryptedUpdate,
          update.iv,
        );
        Y.applyUpdate(this.ydoc, updateBytes, REMOTE_ORIGIN);
      } catch (err) {
        // Skip only this update (stale key epoch, un-migrated legacy row, or
        // corrupt bytes); never abort the whole sync. See NIM-878.
        console.warn(`[DocumentSync] Skipping undecodable update at seq ${update.sequence}:`, err instanceof Error ? err.message : err);
        this.skippedUndecodablePayload = true;
      }
      this.lastSeq = Math.max(this.lastSeq, update.sequence);
    }

    // If there are more updates, fetch the next page
    if (msg.hasMore) {
      this.lastSeq = msg.cursor;
      this.requestSync();
      return;
    }

    // Sync complete -- set the initial reviewed state vector.
    // Initial sync data is considered "accepted" because it represents
    // the document state the user chose to open. The review gate only
    // applies to new realtime updates from collaborators.
    if (!this.synced) {
      this.synced = true;

      // Signal to the host whether the server had any content at all.
      // Y.encodeStateAsUpdate encodes to ~2 bytes for a fully empty Y.Doc,
      // so `byteLength > 2` reliably detects server content across paginated
      // sync responses (checking just the last `msg` would miss earlier pages).
      const serverIsEmpty = Y.encodeStateAsUpdate(this.ydoc).byteLength <= 2;
      this.config.onFirstSyncComplete?.(serverIsEmpty);

      if (this.reviewGateEnabled) {
        this.reviewedStateVector = Y.encodeStateVector(this.ydoc);
      }
      if (this.hasPendingLocalUpdates()) {
        await this.replayPendingUpdate();
      } else {
        this.setStatus('connected');

        // After initial sync, push any local state the server is missing.
        // This handles the case where content was bootstrapped into the Y.Doc
        // locally (e.g., initial share) but the WebSocket was not yet open or
        // a previous connection failed before the update could be sent.
        await this.pushLocalState(msg);
      }

      this.startCompactionTimer();
    }

  }

  private async handleUpdateBroadcast(
    msg: DocUpdateBroadcastMessage
  ): Promise<void> {
    // Skip our own updates (server echoes don't happen, but guard anyway)
    if (msg.senderId === this.config.userId) return;

    let updateBytes: Uint8Array;
    try {
      updateBytes = await this.decryptFromWire(
        msg.encryptedUpdate,
        msg.iv,
      );
      Y.applyUpdate(this.ydoc, updateBytes, REMOTE_ORIGIN);
    } catch (err) {
      // Skip only this broadcast (stale key epoch, un-migrated legacy row, or
      // corrupt bytes that make Y.applyUpdate throw); never abort sync. The
      // applyUpdate is INSIDE the try so garbage bytes can't escape. See NIM-878.
      console.warn(`[DocumentSync] Skipping undecodable broadcast at seq ${msg.sequence}:`, err instanceof Error ? err.message : err);
      this.skippedUndecodablePayload = true;
      this.lastSeq = Math.max(this.lastSeq, msg.sequence);
      return;
    }
    this.lastSeq = Math.max(this.lastSeq, msg.sequence);

    // Buffer the update for the review gate
    if (this.reviewGateEnabled && this.synced) {
      this.unreviewedUpdates.push({
        updateBytes: updateBytes.slice(),
        senderId: msg.senderId,
        sequence: msg.sequence,
        receivedAt: Date.now(),
      });
      this.notifyReviewStateChange();
    }

    this.config.onRemoteUpdate?.(REMOTE_ORIGIN);
  }

  private async handleAwarenessBroadcast(
    msg: DocAwarenessBroadcastMessage
  ): Promise<void> {
    if (msg.fromUserId === this.config.userId) return;

    try {
      const stateBytes = await this.decryptFromWire(
        msg.encryptedState,
        msg.iv,
      );
      const state: AwarenessState = JSON.parse(
        new TextDecoder().decode(stateBytes)
      );
      this.awarenessStates.set(msg.fromUserId, state);
      this.awarenessTimestamps.set(msg.fromUserId, Date.now());
      this.notifyAwarenessListeners();
    } catch (err) {
      console.error('[DocumentSync] Failed to decrypt awareness:', err);
    }
  }

  // --------------------------------------------------------------------------
  // Local Update Observation
  // --------------------------------------------------------------------------

  /**
   * Watch the Y.Doc for local updates and send them encrypted to the server.
   */
  private setupUpdateObserver(): void {
    if (this.updateObserverDispose) return;

    const handler = async (update: Uint8Array, origin: unknown) => {
      // Only send updates that originated locally (not remote/snapshot)
      if (
        origin === REMOTE_ORIGIN ||
        origin === SNAPSHOT_ORIGIN ||
        origin === PERSISTED_PENDING_ORIGIN
      ) {
        return;
      }
      this.enqueuePendingLocalUpdate(update);
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.synced) {
        await this.replayPendingUpdate();
      }
    };

    this.ydoc.on('update', handler);
    this.updateObserverDispose = () => this.ydoc.off('update', handler);
  }

  private teardownUpdateObserver(): void {
    this.updateObserverDispose?.();
    this.updateObserverDispose = null;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private send(msg: DocClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private getRoomId(): string {
    return `org:${this.config.orgId}:doc:${this.config.documentId}`;
  }

  private enqueuePendingLocalUpdate(update: Uint8Array): void {
    this.queuedPendingUpdate = this.queuedPendingUpdate
      ? Y.mergeUpdates([this.queuedPendingUpdate, update])
      : update.slice();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.synced) {
      this.setStatus('offline-unsynced');
    } else if (this.replayingClientUpdateId && this.surfaceReplayStatus) {
      this.setStatus('replaying');
    }
    this.schedulePendingPersist();
  }

  private setStatus(status: DocumentSyncStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.config.onStatusChange?.(status);
  }

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
  private async pushLocalState(syncMsg: DocSyncResponseMessage): Promise<void> {
    // Build the server state vector from what we received.
    // If the server sent no updates and no snapshot, it has an empty state.
    const serverHasNoState = syncMsg.updates.length === 0 && !syncMsg.snapshot;
    if (!serverHasNoState) return; // Server already has content, nothing to push

    // Check if our local Y.Doc has any content worth sending
    const diff = Y.encodeStateAsUpdate(this.ydoc);

    // A minimal empty Y.Doc encodes to a very small update (~2 bytes).
    // Only send if there's meaningful content.
    if (diff.length <= 2) return;

    console.log('[DocumentSync] Pushing local state to server after sync, update size:', diff.length);
    this.enqueuePendingLocalUpdate(diff);
    await this.replayPendingUpdate();
  }

  private async replayPendingUpdate(): Promise<void> {
    if (this.replayingClientUpdateId) {
      return;
    }

    if (!this.queuedPendingUpdate) {
      this.setStatus('connected');
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.synced) {
      this.setStatus('offline-unsynced');
      return;
    }

    try {
      const clientUpdateId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pendingUpdate = this.queuedPendingUpdate;
      this.inflightPendingUpdate = pendingUpdate;
      this.queuedPendingUpdate = null;
      this.surfaceReplayStatus = this.status !== 'connected';
      const { encrypted, iv } = await this.encryptForWire(pendingUpdate);
      this.replayingClientUpdateId = clientUpdateId;
      if (this.surfaceReplayStatus) {
        this.setStatus('replaying');
      } else {
        this.setStatus('connected');
      }
      // console.log(
      //   '[DocumentSync] Replaying pending update for room:',
      //   this.getRoomId(),
      //   'clientUpdateId:',
      //   clientUpdateId,
      //   'bytes:',
      //   pendingUpdate.length
      // );
      this.send({
        type: 'docUpdate',
        encryptedUpdate: encrypted,
        iv,
        clientUpdateId,
        orgKeyFingerprint: this.wireOrgKeyFingerprint,
      });
      this.scheduleReplayAckTimeout(clientUpdateId);
    } catch (err) {
      this.clearReplayAckTimer();
      console.error('[DocumentSync] Failed to replay pending local update:', err);
      if (this.inflightPendingUpdate) {
        this.queuedPendingUpdate = this.queuedPendingUpdate
          ? Y.mergeUpdates([this.inflightPendingUpdate, this.queuedPendingUpdate])
          : this.inflightPendingUpdate;
        this.inflightPendingUpdate = null;
      }
      this.replayingClientUpdateId = null;
      this.surfaceReplayStatus = false;
      this.schedulePendingPersist();
      this.setStatus('offline-unsynced');
    }
  }

  private handleUpdateAck(msg: DocUpdateAckMessage): void {
    this.lastSeq = Math.max(this.lastSeq, msg.sequence);
    if (msg.clientUpdateId !== this.replayingClientUpdateId) {
      return;
    }

    // console.log(
    //   '[DocumentSync] Received docUpdateAck for room:',
    //   this.getRoomId(),
    //   'clientUpdateId:',
    //   msg.clientUpdateId,
    //   'sequence:',
    //   msg.sequence
    // );
    this.clearReplayAckTimer();
    this.finishReplayingPendingUpdate();
  }

  private schedulePendingPersist(): void {
    if (!this.config.onPendingUpdateChange) return;
    if (this.pendingPersistTimer) {
      clearTimeout(this.pendingPersistTimer);
    }
    this.pendingPersistTimer = setTimeout(() => {
      this.pendingPersistTimer = null;
      const mergedPendingUpdate = this.getMergedPendingUpdate();
      void this.config.onPendingUpdateChange?.(
        mergedPendingUpdate ? uint8ArrayToBase64(mergedPendingUpdate) : null
      );
    }, 250);
  }

  private flushPendingPersistImmediately(): void {
    if (!this.config.onPendingUpdateChange) return;
    if (this.pendingPersistTimer) {
      clearTimeout(this.pendingPersistTimer);
      this.pendingPersistTimer = null;
    }
    const mergedPendingUpdate = this.getMergedPendingUpdate();
    void this.config.onPendingUpdateChange(
      mergedPendingUpdate ? uint8ArrayToBase64(mergedPendingUpdate) : null
    );
  }

  private handleDisconnect(): void {
    const shouldReconnect = !this.suppressReconnect;
    this.suppressReconnect = false;
    this.clearReplayAckTimer();
    this.ws = null;
    this.synced = false;
    this.connecting = false;
    this.requeueInflightPendingUpdate();
    this.stopAwarenessCleanup();
    this.clearAwarenessThrottle();
    this.stopCompactionTimer();
    // Clear awareness states on disconnect
    this.awarenessStates.clear();
    this.awarenessTimestamps.clear();
    this.notifyAwarenessListeners();
    this.setStatus(
      this.hasPendingLocalUpdates() ? 'offline-unsynced' : 'disconnected'
    );
    // Note: unreviewed updates and reviewedStateVector are preserved across
    // disconnect/reconnect. If the user reconnects, they'll still see the
    // pending review state. On reconnect, initial sync is accepted but
    // buffered unreviewed updates remain.
    if (shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private hasPendingLocalUpdates(): boolean {
    return !!(this.queuedPendingUpdate || this.inflightPendingUpdate);
  }

  private hasUnsettledPendingWrites(): boolean {
    return !!(
      this.queuedPendingUpdate ||
      this.inflightPendingUpdate ||
      this.replayingClientUpdateId
    );
  }

  private notifyPendingWriteWaiters(): void {
    for (const waiter of Array.from(this.pendingWriteWaiters)) {
      waiter();
    }
  }

  private getMergedPendingUpdate(): Uint8Array | null {
    if (this.queuedPendingUpdate && this.inflightPendingUpdate) {
      return Y.mergeUpdates([
        this.inflightPendingUpdate,
        this.queuedPendingUpdate,
      ]);
    }
    return this.queuedPendingUpdate ?? this.inflightPendingUpdate;
  }

  private requeueInflightPendingUpdate(): void {
    this.clearReplayAckTimer();
    if (!this.inflightPendingUpdate) {
      this.surfaceReplayStatus = false;
      this.notifyPendingWriteWaiters();
      return;
    }
    this.queuedPendingUpdate = this.queuedPendingUpdate
      ? Y.mergeUpdates([this.inflightPendingUpdate, this.queuedPendingUpdate])
      : this.inflightPendingUpdate;
    this.inflightPendingUpdate = null;
    this.replayingClientUpdateId = null;
    this.surfaceReplayStatus = false;
    this.schedulePendingPersist();
    this.notifyPendingWriteWaiters();
  }

  private finishReplayingPendingUpdate(): void {
    this.clearReplayAckTimer();
    this.inflightPendingUpdate = null;
    this.replayingClientUpdateId = null;
    this.surfaceReplayStatus = false;
    this.schedulePendingPersist();
    this.notifyPendingWriteWaiters();
    if (this.synced && this.queuedPendingUpdate) {
      void this.replayPendingUpdate();
      return;
    }
    if (this.synced) {
      this.setStatus('connected');
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;

    const delay = Math.min(
      DocumentSyncProvider.RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      DocumentSyncProvider.RECONNECT_MAX_MS
    );
    // Add jitter: 0.5x to 1.5x
    const jittered = delay * (0.5 + Math.random());
    this.reconnectAttempt++;

    console.log(`[DocumentSync] Reconnecting in ${Math.round(jittered / 1000)}s (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) {
        this.connect().catch(err => {
          console.error('[DocumentSync] Reconnect failed:', err);
        });
      }
    }, jittered);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

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
  reconnectNow(): void {
    if (this.destroyed) return;

    // A previous reconnectNow() already started a fresh handshake that hasn't
    // resolved yet. Don't tear it down -- post-wake the broker fires several
    // network-available events in a ~20s burst and we'd otherwise churn through
    // half-finished sockets.
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;

    this.cancelReconnect();
    this.reconnectAttempt = 0;

    // Tear down any existing WS so connect() creates a fresh one.
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.connecting = false;

    console.log('[DocumentSync] Network available, attempting immediate reconnect');
    this.connect().catch(err => {
      console.error('[DocumentSync] reconnectNow failed:', err);
      this.scheduleReconnect();
    });
  }

  private scheduleReplayAckTimeout(clientUpdateId: string): void {
    this.clearReplayAckTimer();
    this.replayAckTimer = setTimeout(() => {
      this.replayAckTimer = null;

      if (this.replayingClientUpdateId !== clientUpdateId) {
        return;
      }

      console.warn(
        '[DocumentSync] Timed out waiting for docUpdateAck, forcing reconnect for pending replay',
        {
          roomId: this.getRoomId(),
          clientUpdateId,
          hasQueuedPendingUpdate: !!this.queuedPendingUpdate,
          hasInflightPendingUpdate: !!this.inflightPendingUpdate,
          lastSeq: this.lastSeq,
        }
      );
      this.setStatus('offline-unsynced');

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.close();
        } catch (err) {
          console.error('[DocumentSync] Failed to close WebSocket after replay timeout:', err);
          this.requeueInflightPendingUpdate();
          this.synced = false;
          this.scheduleReconnect();
        }
        return;
      }

      this.requeueInflightPendingUpdate();
      this.synced = false;
      this.scheduleReconnect();
    }, DocumentSyncProvider.REPLAY_ACK_TIMEOUT_MS);
  }

  private clearReplayAckTimer(): void {
    if (this.replayAckTimer) {
      clearTimeout(this.replayAckTimer);
      this.replayAckTimer = null;
    }
  }

  /**
   * Start periodic cleanup of stale remote awareness states.
   * Removes entries from users who haven't sent an update recently.
   */
  private startAwarenessCleanup(): void {
    this.stopAwarenessCleanup();
    this.awarenessCleanupTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [userId, timestamp] of this.awarenessTimestamps) {
        if (now - timestamp > AWARENESS_STALE_TIMEOUT_MS) {
          this.awarenessStates.delete(userId);
          this.awarenessTimestamps.delete(userId);
          changed = true;
        }
      }
      if (changed) {
        this.notifyAwarenessListeners();
      }
    }, AWARENESS_STALE_TIMEOUT_MS / 2);
  }

  private stopAwarenessCleanup(): void {
    if (this.awarenessCleanupTimer) {
      clearInterval(this.awarenessCleanupTimer);
      this.awarenessCleanupTimer = null;
    }
  }

  private notifyAwarenessListeners(): void {
    const snapshot = this.getAwarenessStates();
    for (const listener of this.awarenessListeners) {
      listener(snapshot);
    }
  }

  private notifyReviewStateChange(): void {
    this.config.onReviewStateChange?.(this.getReviewGateState());
  }

  // --------------------------------------------------------------------------
  // Compaction
  // --------------------------------------------------------------------------

  private startCompactionTimer(): void {
    if (this.compactionTimer) return;
    // First eligibility window doesn't fire immediately -- give awareness from
    // other clients time to flow so the election picks a stable elector.
    this.lastCompactionAttemptAt = Date.now();
    this.compactionTimer = setInterval(() => {
      void this.maybeCompact();
    }, COMPACTION_CHECK_INTERVAL_MS);
  }

  private stopCompactionTimer(): void {
    if (this.compactionTimer) {
      clearInterval(this.compactionTimer);
      this.compactionTimer = null;
    }
  }

  /**
   * Lowest userId wins. Awareness misses (a connected user who hasn't sent
   * awareness yet) can briefly cause both candidates to elect themselves;
   * the server tolerates duplicate snapshots (older row is dropped by
   * `DELETE FROM snapshots WHERE replaces_up_to < ?`).
   */
  private amCompactionElector(): boolean {
    let lowest = this.config.userId;
    for (const remoteUserId of this.awarenessStates.keys()) {
      if (remoteUserId < lowest) lowest = remoteUserId;
    }
    return lowest === this.config.userId;
  }

  private async maybeCompact(): Promise<void> {
    if (this.destroyed) return;
    if (!this.synced) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Skip while we have unacked local writes -- otherwise the snapshot would
    // include local state beyond `replacesUpTo`, and that state would also
    // appear in the subsequent update once acked, doubling the payload (benign
    // for CRDTs but wasteful).
    if (this.queuedPendingUpdate || this.inflightPendingUpdate) return;
    if (this.replayingClientUpdateId) return;
    // NIM-1519: this doc is missing rows we could not decode; a snapshot from
    // us would bury them behind replacesUpTo for every other client.
    if (this.skippedUndecodablePayload) return;

    const updatesSinceSnapshot = this.lastSeq - this.lastSnapshotSeq;
    if (updatesSinceSnapshot <= 0) return;

    const now = Date.now();
    const timeSinceLastAttempt = now - this.lastCompactionAttemptAt;
    const updateThresholdReached =
      updatesSinceSnapshot >= COMPACTION_UPDATE_THRESHOLD;
    const timeThresholdReached =
      updatesSinceSnapshot >= COMPACTION_TIME_MIN_UPDATES &&
      timeSinceLastAttempt >= COMPACTION_TIME_THRESHOLD_MS;

    if (!updateThresholdReached && !timeThresholdReached) return;

    if (!this.amCompactionElector()) return;

    await this.sendCompactionSnapshot();
  }

  private async sendCompactionSnapshot(): Promise<void> {
    const currentSeq = this.lastSeq;
    const stateBytes = Y.encodeStateAsUpdate(this.ydoc);

    // NIM-1519: never replace server rows with an EMPTY snapshot. An empty doc
    // with a non-zero lastSeq means we hold none of the content those rows
    // carry (undecodable rows, or a doc we never applied) -- compacting would
    // hide it from every client and prune would delete it.
    if (stateBytes.byteLength <= 2) {
      console.warn(
        `[DocumentSync] Refusing empty-doc compaction (lastSeq=${currentSeq}); leaving server rows untouched`
      );
      return;
    }

    try {
      const { encrypted, iv } = await this.encryptForWire(stateBytes);
      this.send({
        type: 'docCompact',
        encryptedState: encrypted,
        iv,
        replacesUpTo: currentSeq,
        orgKeyFingerprint: this.wireOrgKeyFingerprint,
      });
      this.lastSnapshotSeq = currentSeq;
      this.lastCompactionAttemptAt = Date.now();
      console.log(
        `[DocumentSync] Sent docCompact: replacesUpTo=${currentSeq}, snapshotBytes=${stateBytes.byteLength}`
      );
    } catch (err) {
      // Optimistic: leave lastSnapshotSeq untouched so the next check retries.
      console.warn('[DocumentSync] Failed to send compaction snapshot:', err);
    }
  }
}

/**
 * Create a DocumentSyncProvider instance.
 */
export function createDocumentSyncProvider(
  config: DocumentSyncConfig
): DocumentSyncProvider {
  return new DocumentSyncProvider(config);
}
