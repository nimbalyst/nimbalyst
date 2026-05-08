/**
 * TrackerSyncProvider
 *
 * Client-side tracker item sync with E2E encryption over WebSocket.
 * Connects to a TrackerRoom Durable Object, sends/receives encrypted
 * tracker items, and handles field-level LWW conflict resolution.
 *
 * The provider:
 * - Encrypts all outgoing tracker items with AES-256-GCM
 * - Decrypts incoming items and delivers them via callbacks
 * - Handles sync (initial load + delta), realtime broadcasts, and deletes
 * - Queues mutations while offline and replays on reconnect
 * - Never sends plaintext data over the wire
 */

import type {
  TrackerSyncConfig,
  TrackerSyncStatus,
  TrackerItemPayload,
  TrackerSyncResult,
  TrackerClientMessage,
  TrackerServerMessage,
  TrackerSyncResponseMessage,
  TrackerUpsertBroadcastMessage,
  TrackerDeleteBroadcastMessage,
  TrackerConfigBroadcastMessage,
  EncryptedTrackerItem,
  TrackerRoomConfig,
  TrackerComment,
} from './trackerSyncTypes';
import type { TrackerActivity } from '../core/DocumentService';

// ============================================================================
// Encryption Utilities
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
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function encryptPayload(
  payload: TrackerItemPayload,
  key: CryptoKey
): Promise<{ encryptedPayload: string; iv: string }> {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );
  return {
    encryptedPayload: uint8ArrayToBase64(new Uint8Array(ciphertext)),
    iv: uint8ArrayToBase64(iv),
  };
}

async function decryptPayload(
  encryptedPayload: string,
  iv: string,
  key: CryptoKey
): Promise<TrackerItemPayload> {
  const ciphertext = base64ToUint8Array(encryptedPayload);
  const ivBytes = base64ToUint8Array(iv);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes as BufferSource },
    key,
    ciphertext as BufferSource
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ============================================================================
// Field-Level LWW Merge
// ============================================================================

/**
 * Merge two versions of the same tracker item using per-field Last-Write-Wins.
 * For each field key, the version with the more recent `fieldUpdatedAt` timestamp wins.
 * This is fully generic -- it merges all keys in `fields` and `system` without
 * hardcoding field names.
 */
export function mergeTrackerItems(
  local: TrackerItemPayload,
  remote: TrackerItemPayload
): TrackerItemPayload {
  const mergedFields: Record<string, unknown> = { ...local.fields };
  const mergedSystem = { ...local.system };
  const mergedTimestamps: Record<string, number> = { ...local.fieldUpdatedAt };

  // Merge user-defined fields
  const allFieldKeys = new Set([
    ...Object.keys(local.fields),
    ...Object.keys(remote.fields),
  ]);
  for (const key of allFieldKeys) {
    const localTs = local.fieldUpdatedAt[key] ?? 0;
    const remoteTs = remote.fieldUpdatedAt[key] ?? 0;
    if (remoteTs > localTs) {
      mergedFields[key] = remote.fields[key];
      mergedTimestamps[key] = remoteTs;
    }
  }

  // Merge system fields
  const systemKeys = [
    'authorIdentity', 'lastModifiedBy', 'createdByAgent',
    'linkedCommitSha', 'documentId',
    'createdAt', 'updatedAt',
  ] as const;
  for (const key of systemKeys) {
    const localTs = local.fieldUpdatedAt[key] ?? 0;
    const remoteTs = remote.fieldUpdatedAt[key] ?? 0;
    if (remoteTs > localTs) {
      (mergedSystem as any)[key] = (remote.system as any)[key];
      mergedTimestamps[key] = remoteTs;
    }
  }

  // Merge top-level routing fields (LWW by timestamp)
  const routingKeys = ['issueNumber', 'issueKey', 'archived'] as const;
  const merged: TrackerItemPayload = {
    ...local,
    fields: mergedFields,
    system: mergedSystem,
    fieldUpdatedAt: mergedTimestamps,
  };
  for (const key of routingKeys) {
    const localTs = local.fieldUpdatedAt[key] ?? 0;
    const remoteTs = remote.fieldUpdatedAt[key] ?? 0;
    if (remoteTs > localTs) {
      (merged as any)[key] = (remote as any)[key];
      mergedTimestamps[key] = remoteTs;
    }
  }

  // Comments: union by ID, keep newer version per comment
  const commentMap = new Map<string, TrackerComment>();
  for (const c of local.comments ?? []) commentMap.set(c.id, c);
  for (const c of remote.comments ?? []) {
    const existing = commentMap.get(c.id);
    if (!existing || (c.updatedAt ?? c.createdAt) >= (existing.updatedAt ?? existing.createdAt)) {
      commentMap.set(c.id, c);
    }
  }
  merged.comments = Array.from(commentMap.values()).sort((a, b) => a.createdAt - b.createdAt);
  mergedTimestamps.comments = Math.max(local.fieldUpdatedAt.comments ?? 0, remote.fieldUpdatedAt.comments ?? 0);

  // Activity: union by ID, append-only, bounded to 100
  const activityMap = new Map<string, TrackerActivity>();
  for (const a of local.activity ?? []) activityMap.set(a.id, a);
  for (const a of remote.activity ?? []) activityMap.set(a.id, a);
  merged.activity = Array.from(activityMap.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-100);
  mergedTimestamps.activity = Math.max(local.fieldUpdatedAt.activity ?? 0, remote.fieldUpdatedAt.activity ?? 0);

  // Content: LWW by timestamp
  const localContentTs = local.fieldUpdatedAt.content ?? 0;
  const remoteContentTs = remote.fieldUpdatedAt.content ?? 0;
  if (remoteContentTs > localContentTs) {
    merged.content = remote.content;
    mergedTimestamps.content = remoteContentTs;
  } else {
    merged.content = local.content;
    mergedTimestamps.content = localContentTs;
  }

  return merged;
}

// ============================================================================
// TrackerSyncProvider
// ============================================================================

/** Queued mutation for offline replay */
interface QueuedMutation {
  type: 'upsert' | 'delete';
  itemId: string;
  payload?: TrackerItemPayload;
}

function applyIssueIdentity(
  payload: TrackerItemPayload,
  encryptedItem: EncryptedTrackerItem,
): TrackerItemPayload {
  return {
    ...payload,
    issueNumber: encryptedItem.issueNumber ?? payload.issueNumber,
    serverCreatedAt: encryptedItem.createdAt,
    serverUpdatedAt: encryptedItem.updatedAt,
    issueKey: encryptedItem.issueKey ?? payload.issueKey,
    fieldUpdatedAt: {
      ...payload.fieldUpdatedAt,
      issueNumber: Number.MAX_SAFE_INTEGER - 1,
      issueKey: Number.MAX_SAFE_INTEGER,
    },
  };
}

export class TrackerSyncProvider {
  private config: TrackerSyncConfig;
  private ws: WebSocket | null = null;
  private status: TrackerSyncStatus = 'disconnected';
  private synced = false;
  private destroyed = false;

  /** Server sequence cursor for delta sync */
  private lastSequence = 0;

  /** Offline mutation queue -- replayed on reconnect */
  private offlineQueue: QueuedMutation[] = [];

  /** Local cache of decrypted items (itemId -> payload) for LWW merge */
  private localItems: Map<string, TrackerItemPayload> = new Map();

  /** Aggregate counts observed during the initial sync window */
  private initialSyncRemoteItemCount = 0;
  private initialSyncRemoteDeletedCount = 0;

  /** Reconnect state */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private static readonly BASE_RECONNECT_DELAY_MS = 1000;
  private static readonly MAX_RECONNECT_DELAY_MS = 30000;

  constructor(config: TrackerSyncConfig) {
    this.config = config;
  }

  // --------------------------------------------------------------------------
  // Connection Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Connect to the TrackerRoom and begin syncing.
   */
  async connect(): Promise<void> {
    if (this.destroyed) throw new Error('Provider has been destroyed');
    if (this.ws) return;

    this.cancelReconnect();
    this.setStatus('connecting');
    this.initialSyncRemoteItemCount = 0;
    this.initialSyncRemoteDeletedCount = 0;

    const { serverUrl, orgId, projectId } = this.config;
    const roomId = `org:${orgId}:tracker:${projectId}`;

    let url: string;
    if (this.config.buildUrl) {
      url = this.config.buildUrl(roomId);
    } else {
      const jwt = await this.config.getJwt();
      url = `${serverUrl}/sync/${roomId}?token=${encodeURIComponent(jwt)}`;
    }

    console.log('[TrackerSync] Connecting to:', url.replace(/token=[^&]+/, 'token=<redacted>'));

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      console.log('[TrackerSync] WebSocket connected, requesting sync...');
      this.reconnectAttempts = 0; // Reset on successful connection
      this.setStatus('syncing');
      this.requestSync();
    });

    ws.addEventListener('message', (event) => {
      this.handleMessage(event);
    });

    let closeReceived = false;

    ws.addEventListener('error', (evt: any) => {
      console.error('[TrackerSync] WebSocket error:', evt?.message || '(no details)');
      // If close doesn't arrive within 2s, trigger reconnect manually.
      // Some environments don't fire close after error when connection never opened.
      setTimeout(() => {
        if (!closeReceived && this.ws === ws) {
          console.warn('[TrackerSync] No close event after error, forcing reconnect');
          this.handleDisconnect();
        }
      }, 2000);
    });

    ws.addEventListener('close', (event) => {
      closeReceived = true;
      console.log('[TrackerSync] WebSocket closed:', event.code, event.reason || '');
      this.handleDisconnect();
    });
  }

  /**
   * Disconnect from the TrackerRoom.
   */
  disconnect(): void {
    this.cancelReconnect(true);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.synced = false;
    this.setStatus('disconnected');
  }

  /**
   * Immediately reconnect, cancelling any pending backoff and resetting attempts.
   * Called externally when the network has been confirmed available (e.g. after
   * the CollabV3 index has reached `synced`). Falls back to normal backoff if
   * the connect attempt fails.
   */
  reconnectNow(): void {
    if (this.destroyed) return;
    // Already have a connection -- nothing to do. If the WS is open and healthy,
    // we don't need to churn; if it's in a zombie state, disconnect() first.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.cancelReconnect(true);

    // Tear down any half-open WS so connect() creates a fresh one.
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }

    console.log('[TrackerSync] Network available, attempting immediate reconnect');
    this.connect().catch(err => {
      console.error('[TrackerSync] reconnectNow failed:', err);
      this.handleDisconnect();
    });
  }

  /**
   * Destroy the provider. Cannot be reused after this.
   */
  destroy(): void {
    this.cancelReconnect(true);
    this.disconnect();
    this.localItems.clear();
    this.offlineQueue = [];
    this.destroyed = true;
  }

  /**
   * Get the current connection status.
   */
  getStatus(): TrackerSyncStatus {
    return this.status;
  }

  /**
   * Get the current sequence cursor.
   */
  getLastSequence(): number {
    return this.lastSequence;
  }

  // --------------------------------------------------------------------------
  // Public API: Mutations
  // --------------------------------------------------------------------------

  /**
   * Upsert a tracker item. Encrypts and sends to server.
   * If offline, queues the mutation for replay on reconnect.
   */
  async upsertItem(payload: TrackerItemPayload): Promise<void> {
    // Update local cache
    this.localItems.set(payload.itemId, payload);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.offlineQueue.push({ type: 'upsert', itemId: payload.itemId, payload });
      return;
    }

    const { encryptedPayload, iv } = await encryptPayload(payload, this.config.encryptionKey);
    console.log('[TrackerSync] Sending upsert for item:', payload.itemId);
    this.send({
      type: 'trackerUpsert',
      itemId: payload.itemId,
      encryptedPayload,
      iv,
      issueNumber: payload.issueNumber,
      issueKey: payload.issueKey,
      orgKeyFingerprint: this.config.orgKeyFingerprint,
    });
  }

  /**
   * Delete a tracker item. Sends delete to server.
   * If offline, queues the mutation for replay on reconnect.
   */
  async deleteItem(itemId: string): Promise<void> {
    this.localItems.delete(itemId);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.offlineQueue.push({ type: 'delete', itemId });
      return;
    }

    this.send({ type: 'trackerDelete', itemId, orgKeyFingerprint: this.config.orgKeyFingerprint });
  }

  /**
   * Batch upsert tracker items. Encrypts and sends all at once.
   * If offline, queues each item individually.
   */
  async batchUpsertItems(payloads: TrackerItemPayload[]): Promise<void> {
    for (const payload of payloads) {
      this.localItems.set(payload.itemId, payload);
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      for (const payload of payloads) {
        this.offlineQueue.push({ type: 'upsert', itemId: payload.itemId, payload });
      }
      return;
    }

    const items = await Promise.all(
      payloads.map(async (payload) => {
        const { encryptedPayload, iv } = await encryptPayload(payload, this.config.encryptionKey);
        return {
          itemId: payload.itemId,
          encryptedPayload,
          iv,
          issueNumber: payload.issueNumber,
          issueKey: payload.issueKey,
          orgKeyFingerprint: this.config.orgKeyFingerprint,
        };
      })
    );

    this.send({ type: 'trackerBatchUpsert', items });
  }

  // --------------------------------------------------------------------------
  // Message Handling
  // --------------------------------------------------------------------------

  private async handleMessage(event: MessageEvent): Promise<void> {
    try {
      const message: TrackerServerMessage = JSON.parse(String(event.data));
      console.log('[TrackerSync] Received message:', message.type);

      switch (message.type) {
        case 'trackerSyncResponse':
          await this.handleSyncResponse(message);
          break;
        case 'trackerUpsertBroadcast':
          await this.handleUpsertBroadcast(message);
          break;
        case 'trackerDeleteBroadcast':
          this.handleDeleteBroadcast(message);
          break;
        case 'trackerConfigBroadcast':
          this.handleConfigBroadcast(message);
          break;
        case 'error':
          console.error('[TrackerSync] Server error:', message.code, message.message);
          break;
      }
    } catch (err) {
      console.error('[TrackerSync] Error handling message:', err);
    }
  }

  private async handleSyncResponse(msg: TrackerSyncResponseMessage): Promise<void> {
    console.log('[TrackerSync] Sync response:', msg.items.length, 'items,', msg.deletedItemIds.length, 'deletions, sequence:', msg.sequence, 'hasMore:', msg.hasMore);
    this.initialSyncRemoteItemCount += msg.items.length;
    this.initialSyncRemoteDeletedCount += msg.deletedItemIds.length;
    // Decrypt all items
    for (const encryptedItem of msg.items) {
      try {
        // Check fingerprint before attempting decrypt (if available)
        if (encryptedItem.orgKeyFingerprint && this.config.orgKeyFingerprint &&
            encryptedItem.orgKeyFingerprint !== this.config.orgKeyFingerprint) {
          console.warn('[TrackerSync] Item encrypted with different key version:',
            encryptedItem.itemId, 'item fp:', encryptedItem.orgKeyFingerprint,
            'local fp:', this.config.orgKeyFingerprint);
          continue;
        }

        const payload = await decryptPayload(
          encryptedItem.encryptedPayload,
          encryptedItem.iv,
          this.config.encryptionKey
        );
        const payloadWithIssueIdentity = applyIssueIdentity(payload, encryptedItem);

        // Check for conflict with local version
        const localItem = this.localItems.get(payloadWithIssueIdentity.itemId);
        if (localItem) {
          const merged = mergeTrackerItems(localItem, payloadWithIssueIdentity);
          this.localItems.set(payloadWithIssueIdentity.itemId, merged);
          this.config.onItemUpserted?.(merged);
        } else {
          this.localItems.set(payloadWithIssueIdentity.itemId, payloadWithIssueIdentity);
          this.config.onItemUpserted?.(payloadWithIssueIdentity);
        }
      } catch (err) {
        console.error('[TrackerSync] Failed to decrypt item:', encryptedItem.itemId, err);
        if (this.config.onDecryptFailed) {
          this.corruptItemIds.add(encryptedItem.itemId);
        }
      }
    }

    // Process deletions
    for (const itemId of msg.deletedItemIds) {
      this.localItems.delete(itemId);
      this.config.onItemDeleted?.(itemId);
    }

    this.lastSequence = msg.sequence;

    // If there are more items, request next batch
    if (msg.hasMore) {
      this.requestSync();
      return;
    }

    // Emit config from sync response (if present)
    if (msg.config) {
      this.config.onConfigChanged?.(msg.config);
    }

    // Sync complete
    if (!this.synced) {
      this.synced = true;
      this.setStatus('connected');
      await this.config.onInitialSyncComplete?.({
        remoteItemCount: this.initialSyncRemoteItemCount,
        remoteDeletedCount: this.initialSyncRemoteDeletedCount,
        sequence: msg.sequence,
      });
      console.log('[TrackerSync] Initial sync complete, now connected. Local items:', this.localItems.size);
      // Replay offline queue after initial sync
      await this.replayOfflineQueue();
      // Repair any corrupt items encountered during sync
      await this.repairCorruptItems();
    }
  }

  private async handleUpsertBroadcast(msg: TrackerUpsertBroadcastMessage): Promise<void> {
    console.log('[TrackerSync] Received upsert broadcast for item:', msg.item.itemId, 'sequence:', msg.item.sequence);
    try {
      // Check fingerprint before attempting decrypt (if available)
      if (msg.item.orgKeyFingerprint && this.config.orgKeyFingerprint &&
          msg.item.orgKeyFingerprint !== this.config.orgKeyFingerprint) {
        console.warn('[TrackerSync] Broadcast item encrypted with different key version:',
          msg.item.itemId, 'item fp:', msg.item.orgKeyFingerprint,
          'local fp:', this.config.orgKeyFingerprint);
        return;
      }

      const payload = await decryptPayload(
        msg.item.encryptedPayload,
        msg.item.iv,
        this.config.encryptionKey
      );
      const payloadWithIssueIdentity = applyIssueIdentity(payload, msg.item);

      // Check for conflict with local version
      const localItem = this.localItems.get(payloadWithIssueIdentity.itemId);
      if (localItem) {
        const merged = mergeTrackerItems(localItem, payloadWithIssueIdentity);
        this.localItems.set(payloadWithIssueIdentity.itemId, merged);
        this.config.onItemUpserted?.(merged);
      } else {
        this.localItems.set(payloadWithIssueIdentity.itemId, payloadWithIssueIdentity);
        this.config.onItemUpserted?.(payloadWithIssueIdentity);
      }

      // Advance sequence
      if (msg.item.sequence > this.lastSequence) {
        this.lastSequence = msg.item.sequence;
      }
    } catch (err) {
      console.error('[TrackerSync] Failed to decrypt broadcast item:', msg.item.itemId, err);
      if (this.config.onDecryptFailed) {
        this.repairCorruptItem(msg.item.itemId);
      }
    }
  }

  /**
   * After initial sync completes and the offline queue is replayed,
   * repair any corrupt items we encountered during sync.
   */
  private async repairCorruptItems(): Promise<void> {
    if (this.corruptItemIds.size === 0) return;
    const ids = [...this.corruptItemIds];
    this.corruptItemIds.clear();
    console.log('[TrackerSync] Repairing', ids.length, 'corrupt items from local data');
    for (const itemId of ids) {
      await this.repairCorruptItem(itemId);
    }
  }

  private handleDeleteBroadcast(msg: TrackerDeleteBroadcastMessage): void {
    this.localItems.delete(msg.itemId);
    this.config.onItemDeleted?.(msg.itemId);

    if (msg.sequence > this.lastSequence) {
      this.lastSequence = msg.sequence;
    }
  }

  private handleConfigBroadcast(msg: TrackerConfigBroadcastMessage): void {
    console.log('[TrackerSync] Config broadcast received:', msg.config);
    this.config.onConfigChanged?.(msg.config);
  }

  // --------------------------------------------------------------------------
  // Public API: Configuration
  // --------------------------------------------------------------------------

  /**
   * Update a tracker room config value (e.g., issue key prefix).
   * Sends the update to the server, which validates and broadcasts.
   */
  setConfig(key: string, value: string): void {
    this.send({ type: 'trackerSetConfig', key, value });
  }

  // --------------------------------------------------------------------------
  // Corrupt Item Repair
  // --------------------------------------------------------------------------

  private repairedItemIds = new Set<string>();
  private corruptItemIds = new Set<string>();

  private async repairCorruptItem(itemId: string): Promise<void> {
    if (this.repairedItemIds.has(itemId)) return;
    this.repairedItemIds.add(itemId);

    try {
      const payload = await this.config.onDecryptFailed?.(itemId, null);
      if (!payload) {
        console.warn('[TrackerSync] No local data for corrupt item, cannot repair:', itemId);
        return;
      }
      console.log('[TrackerSync] Repairing corrupt server item from local data:', itemId);
      await this.upsertItem(payload);
    } catch (err) {
      console.error('[TrackerSync] Failed to repair corrupt item:', itemId, err);
    }
  }

  // --------------------------------------------------------------------------
  // Sync Protocol
  // --------------------------------------------------------------------------

  private requestSync(): void {
    this.send({ type: 'trackerSync', sinceSequence: this.lastSequence });
  }

  private async replayOfflineQueue(): Promise<void> {
    const queue = [...this.offlineQueue];
    this.offlineQueue = [];

    for (const mutation of queue) {
      if (mutation.type === 'upsert' && mutation.payload) {
        await this.upsertItem(mutation.payload);
      } else if (mutation.type === 'delete') {
        await this.deleteItem(mutation.itemId);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Internal Helpers
  // --------------------------------------------------------------------------

  private send(message: TrackerClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private setStatus(status: TrackerSyncStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.config.onStatusChange?.(status);
  }

  private handleDisconnect(): void {
    this.ws = null;
    this.synced = false;
    this.setStatus('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) return; // already scheduled
    // Exponential backoff with jitter, capped at MAX_RECONNECT_DELAY_MS.
    // Never gives up -- sync must survive transient network outages, server
    // deploys, laptop sleep/wake, etc. The backoff caps at 60s so reconnect
    // attempts are cheap in the steady state.
    const delay = Math.min(
      TrackerSyncProvider.BASE_RECONNECT_DELAY_MS * Math.pow(2, Math.min(this.reconnectAttempts, 6)) + Math.random() * 1000,
      TrackerSyncProvider.MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempts++;

    console.log(`[TrackerSync] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.destroyed || this.ws) return;
      try {
        await this.connect();
      } catch (err) {
        console.error('[TrackerSync] Reconnect failed:', err);
        // Keep retrying -- getJwt() fetches fresh tokens, so even auth
        // errors may resolve on the next attempt (e.g., expired JWT that
        // gets refreshed).
        this.handleDisconnect();
      }
    }, delay);
  }

  private cancelReconnect(resetAttempts = false): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (resetAttempts) {
      this.reconnectAttempts = 0;
    }
  }
}
