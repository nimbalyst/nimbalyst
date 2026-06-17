/**
 * KeyRotationService
 *
 * Orchestrates full key rotation with re-encryption when a team member
 * is removed. Ensures existing server-side data (doc index titles,
 * document snapshots/updates) is re-encrypted with the new key before
 * the old key is discarded.
 *
 * Also creates plaintext backups of all shared document content before
 * rotation, so data is recoverable even if re-encryption fails.
 *
 * Architecture:
 * 1. Archive old key (never discard)
 * 2. Download and decrypt all data with old key
 * 3. Write plaintext backup to userData
 * 4. Generate new key, re-encrypt everything
 * 5. Upload re-encrypted data
 * 6. Distribute new key to remaining members
 *
 * On failure at any step, the old key remains in history and rotation
 * can be retried via retryKeyRotation().
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { logger } from '../utils/logger';
import {
  archiveCurrentOrgKey,
  restoreArchivedOrgKey,
  getOrgKey,
  generateAndStoreOrgKey,
  getOrgKeyFingerprint,
  wrapOrgKeyForMember,
  uploadEnvelope,
  deleteAllEnvelopes,
  fetchMemberPublicKey,
} from './OrgKeyService';
import type {
  EncryptedTrackerItemEnvelope,
  TrackerSyncResponseMessage,
  TrackerItemPayload,
} from '@nimbalyst/runtime/sync';
import { encryptTrackerPayload, decryptTrackerEnvelope, appendSyncClientParams } from '@nimbalyst/runtime/sync';

// ============================================================================
// Types
// ============================================================================

/** Encrypted document index entry as received from TeamRoom */
interface EncryptedDocIndexEntry {
  documentId: string;
  encryptedTitle: string;
  titleIv: string;
  documentType: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** TeamSync response (subset we need) */
interface TeamSyncResponse {
  type: 'teamSyncResponse';
  team: {
    metadata: {
      orgId: string;
      name: string;
      gitRemoteHash: string | null;
      /**
       * Server-minted UUID that names this team's tracker room
       * (NIM-404 / tracker-sync-redesign D8). Used as the routing key for
       * tracker rotation; gitRemoteHash above is only a discovery hint.
       */
      teamProjectId: string | null;
    } | null;
    documents: EncryptedDocIndexEntry[];
  };
}

/** DocumentSync response (subset we need) */
interface DocSyncResponse {
  type: 'docSyncResponse';
  updates: Array<{
    sequence: number;
    encryptedUpdate: string;
    iv: string;
    senderId: string;
  }>;
  snapshot?: {
    encryptedState: string;
    iv: string;
    replacesUpTo: number;
  };
  hasMore: boolean;
  cursor: number;
}

/** Document asset metadata from DocumentRoom */
interface StoredAssetMetadata {
  assetId: string;
  r2Key: string;
  ciphertextSize: number;
  plaintextSize: number | null;
  mimeType: string | null;
  encryptedMetadata: string | null;
  metadataIv: string | null;
  createdAt: number;
  updatedAt: number;
  keyFingerprint?: string | null;
  rotatedAt?: number | null;
}

interface RotationProgress {
  status: 'in-progress' | 'completed' | 'failed';
  phase: 'download' | 'backup' | 'reencrypt' | 'upload' | 'distribute';
  orgId: string;
  reason: string;
  oldKeyFingerprint: string;
  newKeyFingerprint: string | null;
  docIndexDone: boolean;
  documentsCompleted: string[];
  documentsFailed: string[];
  trackerItemsCompleted: number;
  trackerItemsFailed: number;
  assetsCompleted: number;
  assetsFailed: number;
  error: string | null;
  backupDir: string;
}

interface DecryptedDocEntry {
  documentId: string;
  title: string;
  documentType: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

interface DecryptedDocContent {
  documentId: string;
  yjsState: Uint8Array;     // Full Y.Doc state as Yjs update
  maxSequence: number;       // Max sequence from sync response
}

// ============================================================================
// Crypto Utilities (mirror of DocumentSync/TeamSync, for main process)
// ============================================================================

function uint8ArrayToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToUint8Array(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
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

async function encryptTitle(
  title: string,
  key: CryptoKey
): Promise<{ encryptedTitle: string; titleIv: string }> {
  const plaintext = new TextEncoder().encode(title);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext as BufferSource
  );
  return {
    encryptedTitle: uint8ArrayToBase64(new Uint8Array(ciphertext)),
    titleIv: uint8ArrayToBase64(iv),
  };
}

async function decryptTitle(
  encryptedTitle: string,
  titleIv: string,
  key: CryptoKey
): Promise<string> {
  const ciphertext = base64ToUint8Array(encryptedTitle);
  const ivBytes = base64ToUint8Array(titleIv);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes as BufferSource },
    key,
    ciphertext as BufferSource
  );
  return new TextDecoder().decode(plaintext);
}

// ============================================================================
// WebSocket Helpers
// ============================================================================

const WS_TIMEOUT_MS = 30_000;

/**
 * Connect to a sync room, send a request, and collect the response.
 * Auto-disconnects after receiving the expected response type.
 */
async function wsRoundTrip<T>(
  serverUrl: string,
  roomId: string,
  jwt: string,
  request: object,
  responseType: string,
  timeoutMs = WS_TIMEOUT_MS
): Promise<T> {
  const wsUrl = serverUrl.replace(/^http/, 'ws');
  const url = appendSyncClientParams(`${wsUrl}/sync/${roomId}?token=${encodeURIComponent(jwt)}`);

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`WebSocket timeout waiting for ${responseType} from ${roomId}`));
    }, timeoutMs);

    const ws = new WebSocket(url);

    ws.on('open', () => {
      ws.send(JSON.stringify(request));
    });

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === responseType) {
          clearTimeout(timeout);
          ws.close();
          resolve(msg as T);
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`Server error: ${msg.code} - ${msg.message}`));
        }
        // Ignore other message types (broadcasts, etc.)
      } catch (err) {
        // Parse error -- ignore non-JSON messages
      }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error for ${roomId}: ${err.message}`));
    });

    ws.on('close', (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      // Only reject if we haven't resolved yet (close after resolve is normal)
    });
  });
}

/**
 * Connect to a room, send messages, wait for processing, and disconnect.
 * Rejects if the server sends an error message for any of the sent messages.
 */
async function wsSendAndClose(
  serverUrl: string,
  roomId: string,
  jwt: string,
  ...messages: object[]
): Promise<void> {
  const wsUrl = serverUrl.replace(/^http/, 'ws');
  const url = appendSyncClientParams(`${wsUrl}/sync/${roomId}?token=${encodeURIComponent(jwt)}`);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const timeout = setTimeout(() => {
      ws.close();
      settle(() => reject(new Error(`WebSocket timeout for send-and-close to ${roomId}`)));
    }, WS_TIMEOUT_MS);

    const ws = new WebSocket(url);

    ws.on('open', () => {
      for (const msg of messages) {
        ws.send(JSON.stringify(msg));
      }
      // Wait for server to process and check for error responses
      setTimeout(() => {
        clearTimeout(timeout);
        ws.close();
        settle(() => resolve());
      }, 500);
    });

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'error') {
          clearTimeout(timeout);
          ws.close();
          settle(() => reject(new Error(`Server rejected message for ${roomId}: ${msg.code} - ${msg.message}`)));
        }
      } catch { /* ignore parse errors */ }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      settle(() => reject(new Error(`WebSocket error for ${roomId}: ${err.message}`)));
    });
  });
}

/**
 * Download full document state from a DocumentRoom.
 * Handles pagination (hasMore) for large documents.
 */
async function downloadDocumentState(
  serverUrl: string,
  orgId: string,
  documentId: string,
  orgKey: CryptoKey,
  jwt: string
): Promise<DecryptedDocContent> {
  const roomId = `org:${orgId}:doc:${documentId}`;
  const wsUrl = serverUrl.replace(/^http/, 'ws');
  const url = appendSyncClientParams(`${wsUrl}/sync/${roomId}?token=${encodeURIComponent(jwt)}`);

  return new Promise<DecryptedDocContent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout downloading document ${documentId}`));
    }, 60_000); // Longer timeout for large docs

    const doc = new Y.Doc();
    let maxSeq = 0;
    let sinceSeq = 0;

    const ws = new WebSocket(url);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'docSyncRequest', sinceSeq }));
    });

    ws.on('message', async (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'docSyncResponse') {
          // Decrypt and apply snapshot
          if (msg.snapshot) {
            const stateBytes = await decryptBinary(
              msg.snapshot.encryptedState,
              msg.snapshot.iv,
              orgKey
            );
            Y.applyUpdate(doc, stateBytes, 'rotation-download');
            maxSeq = Math.max(maxSeq, msg.snapshot.replacesUpTo);
          }

          // Decrypt and apply incremental updates
          for (const update of msg.updates) {
            const updateBytes = await decryptBinary(
              update.encryptedUpdate,
              update.iv,
              orgKey
            );
            Y.applyUpdate(doc, updateBytes, 'rotation-download');
            maxSeq = Math.max(maxSeq, update.sequence);
          }

          if (msg.hasMore) {
            // Request next batch
            sinceSeq = msg.cursor;
            ws.send(JSON.stringify({ type: 'docSyncRequest', sinceSeq }));
          } else {
            // All data received
            clearTimeout(timeout);
            ws.close();
            const yjsState = Y.encodeStateAsUpdate(doc);
            doc.destroy();
            resolve({ documentId, yjsState, maxSequence: maxSeq });
          }
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          ws.close();
          doc.destroy();
          reject(new Error(`Server error for ${documentId}: ${msg.code} - ${msg.message}`));
        }
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        doc.destroy();
        reject(err);
      }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      doc.destroy();
      reject(new Error(`WebSocket error downloading ${documentId}: ${err.message}`));
    });
  });
}

/**
 * Decrypted live tracker item used by the re-encrypt step. Tombstones
 * have no payload and travel through a separate bucket (see `DecryptedTrackerTombstone`).
 */
interface DecryptedTrackerLiveItem {
  itemId: string;
  decryptedPayload: string;
  issueNumber?: number;
  issueKey?: string;
}

/**
 * Tombstone envelope carried from download to upload unchanged. We keep
 * the original syncId only for logging; the server mints a new one when
 * the rotation upsert lands.
 */
interface DecryptedTrackerTombstone {
  itemId: string;
  deletedAt: number;
  issueNumber?: number;
  issueKey?: string;
  /** Server syncId at download time. Diagnostic only. */
  originalSyncId: number;
}

/**
 * Download all tracker items from a TrackerRoom. Handles pagination
 * (`hasMore`) for large datasets.
 *
 * Speaks the new tracker wire protocol from
 * `@nimbalyst/runtime/sync/trackerProtocol`:
 *   - Client sends `{ type: 'trackerSync', sinceSyncId }` (server reads
 *     `sinceSyncId`; old field name `sinceSequence` is silently ignored
 *     and the server returns zero rows -- this used to be the silent
 *     failure mode that left trackers under the old key after rotation).
 *   - Server returns `cursorSyncId` for pagination (not `sequence`).
 *   - Tombstones arrive as envelopes with `encryptedPayload: null` and
 *     `deletedAt` set, not as a separate `deletedItemIds` array. We
 *     bucket them separately so the re-encrypt step doesn't try to
 *     decrypt a null payload, and so the upload step can re-emit them
 *     with their `deletedAt` preserved.
 */
async function downloadTrackerItems(
  serverUrl: string,
  orgId: string,
  projectId: string,
  orgKey: CryptoKey,
  jwt: string
): Promise<{
  liveItems: DecryptedTrackerLiveItem[];
  tombstones: DecryptedTrackerTombstone[];
  rawEncrypted: EncryptedTrackerItemEnvelope[];
}> {
  const roomId = `org:${orgId}:tracker:${projectId}`;
  const wsUrl = serverUrl.replace(/^http/, 'ws');
  const url = appendSyncClientParams(`${wsUrl}/sync/${roomId}?token=${encodeURIComponent(jwt)}`);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout downloading tracker items for project ${projectId}`));
    }, 60_000);

    const liveItems: DecryptedTrackerLiveItem[] = [];
    const tombstones: DecryptedTrackerTombstone[] = [];
    const allRawEncrypted: EncryptedTrackerItemEnvelope[] = [];
    let sinceSyncId = 0;

    const ws = new WebSocket(url);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'trackerSync', sinceSyncId }));
    });

    ws.on('message', async (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'trackerSyncResponse') {
          const resp = msg as TrackerSyncResponseMessage;

          // Fail-loud guard: the new protocol always carries `cursorSyncId`
          // (a number). If the server is older than the rewrite the field
          // will be missing; previously this looped forever sending
          // `sinceSyncId: undefined` and the orchestrator silently
          // concluded "no tracker items" -- exactly the silent regression
          // NIM-590 was tracking. Reject the response instead.
          if (typeof resp.cursorSyncId !== 'number') {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(
              `Tracker rotation server response missing cursorSyncId for project ${projectId}; ` +
              `refusing to proceed against an unrecognized wire protocol.`,
            ));
            return;
          }

          for (const item of resp.items) {
            allRawEncrypted.push(item);

            // Tombstone envelopes carry `encryptedPayload: null` and
            // `deletedAt` set. There's nothing to decrypt; we just carry
            // the deletion forward.
            if (item.encryptedPayload === null || item.deletedAt !== null) {
              tombstones.push({
                itemId: item.itemId,
                deletedAt: item.deletedAt ?? Date.now(),
                issueNumber: item.issueNumber,
                issueKey: item.issueKey,
                originalSyncId: item.syncId,
              });
              continue;
            }

            try {
              if (!item.iv) {
                throw new Error('live envelope missing iv');
              }
              // Decrypt via the envelope helper so the identifier AAD bind
              // (itemId / issueNumber / issueKey) is enforced. Splice attempts
              // surface as OperationError here and we skip those rows.
              const payload = await decryptTrackerEnvelope(item, orgKey);
              liveItems.push({
                itemId: item.itemId,
                decryptedPayload: JSON.stringify(payload),
                issueNumber: item.issueNumber,
                issueKey: item.issueKey,
              });
            } catch (err) {
              logger.main.warn('[KeyRotationService] Failed to decrypt tracker item:', item.itemId, err);
            }
          }

          if (resp.hasMore) {
            sinceSyncId = resp.cursorSyncId;
            ws.send(JSON.stringify({ type: 'trackerSync', sinceSyncId }));
          } else {
            clearTimeout(timeout);
            ws.close();
            resolve({ liveItems, tombstones, rawEncrypted: allRawEncrypted });
          }
        } else if (msg.type === 'error' || msg.type === 'trackerError') {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`Server error for tracker ${projectId}: ${msg.code} - ${msg.message}`));
        }
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error downloading tracker ${projectId}: ${err.message}`));
    });
  });
}

// ============================================================================
// Asset Download / Re-encryption Helpers
// ============================================================================

/**
 * List all assets for a document via the collab server HTTP API.
 * Uses GET /api/collab/docs/{documentId}/assets which routes to
 * DocumentRoom's handleInternalListAssets endpoint.
 */
async function listDocumentAssets(
  serverUrl: string,
  documentId: string,
  jwt: string
): Promise<StoredAssetMetadata[]> {
  const { net } = await import('electron');
  const url = `${serverUrl}/api/collab/docs/${documentId}/assets`;
  const resp = await net.fetch(url, {
    headers: { 'Authorization': `Bearer ${jwt}` },
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} listing assets for document ${documentId}`);
  }
  const data = await resp.json() as { assets: StoredAssetMetadata[] };
  return data.assets || [];
}

/**
 * Download an encrypted asset binary from the collab server.
 */
async function downloadAsset(
  serverUrl: string,
  orgId: string,
  documentId: string,
  assetId: string,
  jwt: string
): Promise<{ encryptedBody: ArrayBuffer; iv: string; encryptedMetadata: string | null; metadataIv: string | null; mimeType: string | null; plaintextSize: number | null }> {
  const { net } = await import('electron');
  const url = `${serverUrl}/api/collab/docs/${documentId}/assets/${assetId}`;
  const resp = await net.fetch(url, {
    headers: { 'Authorization': `Bearer ${jwt}` },
  });
  if (!resp.ok) throw new Error(`Failed to download asset ${assetId}: ${resp.status}`);

  const encryptedBody = await resp.arrayBuffer();
  const iv = resp.headers.get('X-Collab-Asset-Iv') || '';
  const encryptedMetadata = resp.headers.get('X-Collab-Asset-Metadata');
  const metadataIv = resp.headers.get('X-Collab-Asset-Metadata-Iv');
  const mimeType = resp.headers.get('X-Collab-Asset-Mime-Type');
  const plaintextSizeStr = resp.headers.get('X-Collab-Asset-Plaintext-Size');
  const plaintextSize = plaintextSizeStr ? parseInt(plaintextSizeStr, 10) : null;

  return { encryptedBody, iv, encryptedMetadata, metadataIv, mimeType, plaintextSize };
}

/**
 * Upload a re-encrypted asset binary to the collab server.
 *
 * `newKeyFingerprint` and `rotatedAt` are stored in DocumentRoom so future
 * rotations can skip assets already encrypted under the current key.
 */
async function uploadReEncryptedAsset(
  serverUrl: string,
  documentId: string,
  assetId: string,
  reEncryptedBody: ArrayBuffer,
  newIv: string,
  reEncryptedMetadata: string | null,
  newMetadataIv: string | null,
  mimeType: string | null,
  plaintextSize: number | null,
  jwt: string,
  newKeyFingerprint: string | null,
  rotatedAt: number | null
): Promise<void> {
  const { net } = await import('electron');
  const url = `${serverUrl}/api/collab/docs/${documentId}/assets/${assetId}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${jwt}`,
    'X-Collab-Asset-Iv': newIv,
  };
  if (reEncryptedMetadata) headers['X-Collab-Asset-Metadata'] = reEncryptedMetadata;
  if (newMetadataIv) headers['X-Collab-Asset-Metadata-Iv'] = newMetadataIv;
  if (mimeType) headers['X-Collab-Asset-Mime-Type'] = mimeType;
  if (plaintextSize !== null) headers['X-Collab-Asset-Plaintext-Size'] = String(plaintextSize);
  if (newKeyFingerprint) headers['X-Collab-Asset-Key-Fingerprint'] = newKeyFingerprint;
  if (rotatedAt !== null) headers['X-Collab-Asset-Rotated-At'] = String(rotatedAt);

  const resp = await net.fetch(url, {
    method: 'PUT',
    headers,
    body: reEncryptedBody,
  });
  if (!resp.ok) throw new Error(`Failed to upload re-encrypted asset ${assetId}: ${resp.status}`);
}

/**
 * Re-encrypt a single asset: download, decrypt with old key, re-encrypt with new key, upload.
 */
async function reEncryptAsset(
  serverUrl: string,
  orgId: string,
  documentId: string,
  assetId: string,
  oldKey: CryptoKey,
  newKey: CryptoKey,
  newKeyFingerprint: string | null,
  jwt: string
): Promise<void> {
  // Download encrypted binary + metadata
  const asset = await downloadAsset(serverUrl, orgId, documentId, assetId, jwt);

  // Decrypt binary body with old key
  const ivBytes = base64ToUint8Array(asset.iv);
  const decryptedBody = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes as BufferSource },
    oldKey,
    asset.encryptedBody
  );

  // Re-encrypt binary body with new key
  const newIv = crypto.getRandomValues(new Uint8Array(12));
  const reEncryptedBody = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: newIv },
    newKey,
    decryptedBody
  );

  // Re-encrypt metadata if present
  let reEncryptedMetadata: string | null = null;
  let newMetadataIv: string | null = null;
  if (asset.encryptedMetadata && asset.metadataIv) {
    const metaIvBytes = base64ToUint8Array(asset.metadataIv);
    const decryptedMeta = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: metaIvBytes as BufferSource },
      oldKey,
      base64ToUint8Array(asset.encryptedMetadata) as BufferSource
    );
    const newMetaIvBytes = crypto.getRandomValues(new Uint8Array(12));
    const reEncMeta = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: newMetaIvBytes },
      newKey,
      decryptedMeta
    );
    reEncryptedMetadata = uint8ArrayToBase64(new Uint8Array(reEncMeta));
    newMetadataIv = uint8ArrayToBase64(newMetaIvBytes);
  }

  // Upload re-encrypted asset, tagging it with the new key fingerprint so
  // future rotations can skip it on resume.
  await uploadReEncryptedAsset(
    serverUrl,
    documentId,
    assetId,
    reEncryptedBody,
    uint8ArrayToBase64(newIv),
    reEncryptedMetadata,
    newMetadataIv,
    asset.mimeType,
    asset.plaintextSize,
    jwt,
    newKeyFingerprint,
    Date.now()
  );
}

// ============================================================================
// Encrypted Backup (at-rest encryption via safeStorage-derived key)
// ============================================================================

function getBackupBaseDir(): string {
  return path.join(app.getPath('userData'), 'key-rotation-backups');
}

function createBackupDir(orgId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(getBackupBaseDir(), orgId, timestamp);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(path.join(backupDir, 'documents'), { recursive: true });
  return backupDir;
}

/**
 * Derive a local-only AES-GCM key from Electron's safeStorage.
 * safeStorage encrypts a fixed seed using OS keychain (Keychain on macOS,
 * DPAPI on Windows, libsecret on Linux). The encrypted seed is deterministic
 * per machine, so we use it as HKDF input material.
 */
async function getLocalBackupKey(): Promise<CryptoKey | null> {
  try {
    const { safeStorage } = await import('electron');
    if (!safeStorage.isEncryptionAvailable()) {
      logger.main.warn('[KeyRotationService] safeStorage not available, backup will be unencrypted');
      return null;
    }
    // Encrypt a fixed seed -- the output is deterministic per machine
    const seed = safeStorage.encryptString('nimbalyst-backup-key-v1');
    // Use first 32 bytes of the encrypted seed as key material
    const keyMaterial = await crypto.subtle.importKey(
      'raw', seed.subarray(0, 32) as BufferSource, { name: 'HKDF' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('nimbalyst-backup-v1'), info: new Uint8Array(0) },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  } catch (err) {
    logger.main.warn('[KeyRotationService] Failed to derive backup key:', err);
    return null;
  }
}

/**
 * Encrypt data with the local backup key. Returns IV + ciphertext concatenated.
 * Falls back to plaintext if safeStorage is unavailable.
 */
async function encryptForBackup(data: Uint8Array, backupKey: CryptoKey | null): Promise<Buffer> {
  if (!backupKey) return Buffer.from(data);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, backupKey, data as BufferSource);
  // Format: 12 bytes IV + ciphertext
  const result = Buffer.alloc(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result;
}

async function writePlaintextBackup(
  backupDir: string,
  orgId: string,
  reason: string,
  oldFingerprint: string,
  newFingerprint: string | null,
  docIndex: DecryptedDocEntry[],
  documentContents: Map<string, Uint8Array>,
  trackerItems: Array<{ itemId: string; decryptedPayload: string; issueNumber?: number; issueKey?: string }>
): Promise<void> {
  const backupKey = await getLocalBackupKey();
  const isEncrypted = !!backupKey;

  // Manifest (always plaintext -- contains no document content)
  const manifest = {
    orgId,
    reason,
    createdAt: new Date().toISOString(),
    oldKeyFingerprint: oldFingerprint,
    newKeyFingerprint: newFingerprint,
    documentCount: docIndex.length,
    trackerItemCount: trackerItems.length,
    encrypted: isEncrypted,
  };
  fs.writeFileSync(
    path.join(backupDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  // Doc index (encrypted if possible)
  const docIndexBytes = new TextEncoder().encode(JSON.stringify(docIndex, null, 2));
  const docIndexBuf = await encryptForBackup(docIndexBytes, backupKey);
  fs.writeFileSync(
    path.join(backupDir, isEncrypted ? 'doc-index.enc' : 'doc-index.json'),
    docIndexBuf
  );

  // Document content (raw Yjs state bytes, encrypted if possible)
  for (const [documentId, yjsState] of documentContents) {
    const encrypted = await encryptForBackup(yjsState, backupKey);
    fs.writeFileSync(
      path.join(backupDir, 'documents', `${documentId}${isEncrypted ? '.enc' : '.bin'}`),
      encrypted
    );
  }

  // Tracker items (encrypted if possible)
  if (trackerItems.length > 0) {
    fs.mkdirSync(path.join(backupDir, 'tracker'), { recursive: true });
    const trackerBytes = new TextEncoder().encode(JSON.stringify(trackerItems, null, 2));
    const trackerBuf = await encryptForBackup(trackerBytes, backupKey);
    fs.writeFileSync(
      path.join(backupDir, 'tracker', isEncrypted ? 'items.enc' : 'items.json'),
      trackerBuf
    );
  }

  logger.main.info('[KeyRotationService] Backup written to:', backupDir, isEncrypted ? '(encrypted at rest)' : '(unencrypted)');
}

function writeProgress(backupDir: string, progress: RotationProgress): void {
  fs.writeFileSync(
    path.join(backupDir, 'rotation-progress.json'),
    JSON.stringify(progress, null, 2)
  );
}

// ============================================================================
// Main Rotation Orchestrator
// ============================================================================

/**
 * Perform full key rotation with re-encryption.
 *
 * This is called after a member has already been removed from the org.
 * It archives the old key, downloads all data, creates a backup,
 * re-encrypts everything with a new key, uploads the re-encrypted data,
 * and distributes the new key to remaining members.
 *
 * @param orgId - The organization ID
 * @param reason - Human-readable reason (e.g., 'member-removal:memberId')
 * @param orgJwt - Org-scoped JWT for API calls
 * @param serverUrl - Collab server URL (https)
 * @param listMembers - Function to list remaining team members
 */
export async function performKeyRotation(
  orgId: string,
  reason: string,
  orgJwt: string,
  serverUrl: string,
  listMembers: () => Promise<{ members: Array<{ memberId: string; status: string }> }>
): Promise<{ backupDir: string }> {
  logger.main.info('[KeyRotationService] Starting key rotation for:', orgId, 'reason:', reason);

  // Phase 1: Archive old key
  const archived = archiveCurrentOrgKey(orgId, reason);
  if (!archived) {
    throw new Error('No org key to rotate -- cannot proceed without current key');
  }
  const oldKey = await getOrgKey(orgId);
  if (!oldKey) {
    throw new Error('Failed to load current org key after archiving');
  }
  const oldFingerprint = archived.fingerprint;

  const backupDir = createBackupDir(orgId);
  const progress: RotationProgress = {
    status: 'in-progress',
    phase: 'download',
    orgId,
    reason,
    oldKeyFingerprint: oldFingerprint,
    newKeyFingerprint: null,
    docIndexDone: false,
    documentsCompleted: [],
    documentsFailed: [],
    trackerItemsCompleted: 0,
    trackerItemsFailed: 0,
    assetsCompleted: 0,
    assetsFailed: 0,
    error: null,
    backupDir,
  };
  writeProgress(backupDir, progress);

  try {
    // Phase 1b: Set write barrier on all rooms BEFORE downloading.
    // This prevents concurrent old-key writes from creating split-brain state.
    // Rotation uploads use HTTP internal endpoints which bypass the barrier.
    logger.main.info('[KeyRotationService] Setting write barrier on all rooms...');
    try {
      const { net } = await import('electron');
      const lockResp = await net.fetch(`${serverUrl}/api/teams/${orgId}/rotation-lock`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${orgJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ locked: true }),
      });
      if (!lockResp.ok) {
        throw new Error(`Failed to set write barrier: HTTP ${lockResp.status}`);
      }
    } catch (err) {
      // Write barrier is critical -- fail if it can't be set
      throw new Error(`Cannot proceed with rotation: write barrier failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Phase 2: Download and decrypt everything with old key
    logger.main.info('[KeyRotationService] Phase 2: Downloading and decrypting data...');

    // Get team state (includes doc index)
    const teamRoomId = `org:${orgId}:team`;
    const teamState = await wsRoundTrip<TeamSyncResponse>(
      serverUrl, teamRoomId, orgJwt,
      { type: 'teamSync' },
      'teamSyncResponse'
    );

    const encryptedDocs = teamState.team.documents;
    logger.main.info('[KeyRotationService] Found', encryptedDocs.length, 'documents to re-encrypt');

    // Decrypt doc index titles
    const decryptedIndex: DecryptedDocEntry[] = [];
    for (const doc of encryptedDocs) {
      try {
        const title = await decryptTitle(doc.encryptedTitle, doc.titleIv, oldKey);
        decryptedIndex.push({
          documentId: doc.documentId,
          title,
          documentType: doc.documentType,
          createdBy: doc.createdBy,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        });
      } catch (err) {
        logger.main.warn('[KeyRotationService] Failed to decrypt title for:', doc.documentId, err);
        // Include with placeholder title so we still try the content
        decryptedIndex.push({
          documentId: doc.documentId,
          title: `[undecryptable: ${doc.documentId}]`,
          documentType: doc.documentType,
          createdBy: doc.createdBy,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        });
      }
    }

    // Download and decrypt document content
    const documentContents = new Map<string, Uint8Array>();
    const documentMaxSeqs = new Map<string, number>();

    for (const entry of decryptedIndex) {
      try {
        const content = await downloadDocumentState(
          serverUrl, orgId, entry.documentId, oldKey, orgJwt
        );
        documentContents.set(entry.documentId, content.yjsState);
        documentMaxSeqs.set(entry.documentId, content.maxSequence);
        logger.main.info('[KeyRotationService] Downloaded:', entry.documentId, `(${content.yjsState.length} bytes, seq ${content.maxSequence})`);
      } catch (err) {
        logger.main.error('[KeyRotationService] Failed to download document:', entry.documentId, err);
        progress.documentsFailed.push(entry.documentId);
      }
    }

    // Download and decrypt tracker items. NIM-404 routing: the tracker room
    // ID is keyed by the server-minted teamProjectId, NOT gitRemoteHash. A
    // team without a teamProjectId predates the D8 migration (the server
    // backfills on TeamRoom init, so this should be null only if the team
    // metadata hasn't been touched since the upgrade); we skip rotation for
    // tracker items in that case rather than rotate the wrong room.
    const projectId = teamState.team.metadata?.teamProjectId;
    let decryptedTrackerItems: DecryptedTrackerLiveItem[] = [];
    let trackerTombstones: DecryptedTrackerTombstone[] = [];
    let trackerDecryptFailures = 0;
    if (projectId) {
      try {
        logger.main.info('[KeyRotationService] Downloading tracker items for project:', projectId);
        const trackerResult = await downloadTrackerItems(serverUrl, orgId, projectId, oldKey, orgJwt);
        decryptedTrackerItems = trackerResult.liveItems;
        trackerTombstones = trackerResult.tombstones;
        // Count: total envelopes received minus those that decrypted (live) or
        // were tombstones (no decrypt attempted). Anything else is a failure.
        const accountedFor = trackerResult.liveItems.length + trackerResult.tombstones.length;
        trackerDecryptFailures = trackerResult.rawEncrypted.length - accountedFor;
        if (trackerDecryptFailures > 0) {
          logger.main.error('[KeyRotationService]', trackerDecryptFailures, 'tracker items failed to decrypt');
          progress.trackerItemsFailed = trackerDecryptFailures;
        }
        logger.main.info(
          '[KeyRotationService] Downloaded',
          decryptedTrackerItems.length,
          'live tracker items,',
          trackerTombstones.length,
          'tombstones,',
          trackerDecryptFailures,
          'failed',
        );
      } catch (err) {
        logger.main.error('[KeyRotationService] Failed to download tracker items:', err);
        // Mark as failed so the fail-closed check blocks key distribution
        progress.trackerItemsFailed = 1;
      }
    } else {
      logger.main.info('[KeyRotationService] No project identity (git remote) on team -- skipping tracker re-encryption');
    }

    // Phase 3: Plaintext backup
    progress.phase = 'backup';
    writeProgress(backupDir, progress);
    logger.main.info('[KeyRotationService] Phase 3: Writing plaintext backup...');

    await writePlaintextBackup(
      backupDir, orgId, reason, oldFingerprint, null,
      decryptedIndex, documentContents, decryptedTrackerItems
    );

    // Phase 4: Generate new key and re-encrypt
    progress.phase = 'reencrypt';
    writeProgress(backupDir, progress);
    logger.main.info('[KeyRotationService] Phase 4: Generating new key and re-encrypting...');

    const newKey = await generateAndStoreOrgKey(orgId);
    const newFingerprint = getOrgKeyFingerprint(orgId);
    progress.newKeyFingerprint = newFingerprint;

    // Re-encrypt doc index titles
    const reEncryptedTitles = new Map<string, { encryptedTitle: string; titleIv: string }>();
    for (const entry of decryptedIndex) {
      const { encryptedTitle, titleIv } = await encryptTitle(entry.title, newKey);
      reEncryptedTitles.set(entry.documentId, { encryptedTitle, titleIv });
    }

    // Re-encrypt document content
    const reEncryptedDocs = new Map<string, { encrypted: string; iv: string }>();
    for (const [documentId, yjsState] of documentContents) {
      const { encrypted, iv } = await encryptBinary(yjsState, newKey);
      reEncryptedDocs.set(documentId, { encrypted, iv });
    }

    // Re-encrypt tracker items. Live items get re-encrypted under the new
    // key with the new fingerprint. Tombstones travel through unchanged --
    // there's no payload to encrypt, and the wire-protocol invariant
    // (trackerProtocol.ts:131-137) is that orgKeyFingerprint is null only
    // for tombstones.
    interface RotationTrackerUploadItem {
      itemId: string;
      encryptedPayload: string | null;
      iv?: string;
      deletedAt?: number;
      issueNumber?: number;
      issueKey?: string;
      orgKeyFingerprint: string | null;
    }
    const reEncryptedTrackerItems: RotationTrackerUploadItem[] = [];
    for (const item of decryptedTrackerItems) {
      // Re-encrypt through the envelope helper so the new ciphertext is
      // AAD-bound to the same identifiers (itemId / issueNumber / issueKey)
      // that travel as plaintext envelope fields. encryptBinary would skip
      // the AAD and produce ciphertext that fails to decrypt post-rotation.
      const payload = JSON.parse(item.decryptedPayload) as TrackerItemPayload;
      const { encryptedPayload, iv } = await encryptTrackerPayload(payload, newKey, item.itemId);
      reEncryptedTrackerItems.push({
        itemId: item.itemId,
        encryptedPayload,
        iv,
        issueNumber: item.issueNumber,
        issueKey: item.issueKey,
        orgKeyFingerprint: newFingerprint ?? null,
      });
    }
    for (const tombstone of trackerTombstones) {
      reEncryptedTrackerItems.push({
        itemId: tombstone.itemId,
        encryptedPayload: null,
        deletedAt: tombstone.deletedAt,
        issueNumber: tombstone.issueNumber,
        issueKey: tombstone.issueKey,
        orgKeyFingerprint: null,
      });
    }

    // Phase 5: Upload re-encrypted data
    progress.phase = 'upload';
    writeProgress(backupDir, progress);
    logger.main.info('[KeyRotationService] Phase 5: Uploading re-encrypted data...');

    // All uploads use HTTP internal endpoints which bypass the write barrier.
    // This is critical: the write barrier blocks WebSocket writes from regular
    // clients, but rotation uploads must go through.
    const { net } = await import('electron');
    const httpUrl = serverUrl.replace('wss://', 'https://').replace('ws://', 'http://');
    const authHeaders = {
      'Authorization': `Bearer ${orgJwt}`,
      'Content-Type': 'application/json',
    };

    // Update doc index titles + bump TeamRoom fingerprint atomically via HTTP
    // (bypasses the rotation lock that we set on TeamRoom in step 1). Previously
    // this path used a regular WebSocket `docIndexUpdate`, which let stale-key
    // clients race the rotation and overwrite freshly re-encrypted titles
    // because TeamRoom had no rotation lock. See security review Issue 5.
    if (reEncryptedTitles.size > 0 && newFingerprint) {
      const entries = Array.from(reEncryptedTitles.entries()).map(
        ([documentId, { encryptedTitle, titleIv }]) => ({ documentId, encryptedTitle, titleIv }),
      );
      const titleResp = await net.fetch(`${httpUrl}/api/teams/${orgId}/rotation-update-doc-index`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ entries, newFingerprint }),
      });
      if (!titleResp.ok) {
        const body = await titleResp.text();
        throw new Error(`Doc-index rotation update failed: HTTP ${titleResp.status} ${body}`);
      }
      progress.docIndexDone = true;
      writeProgress(backupDir, progress);
      logger.main.info('[KeyRotationService] Re-encrypted', entries.length, 'doc index titles atomically');
    }

    // Upload re-encrypted document snapshots via HTTP (bypasses write barrier).
    for (const [documentId, { encrypted, iv }] of reEncryptedDocs) {
      try {
        const downloadedMaxSeq = documentMaxSeqs.get(documentId) ?? 0;
        const compactResp = await net.fetch(`${httpUrl}/api/teams/${orgId}/rotation-compact-doc`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            documentId,
            encryptedState: encrypted,
            iv,
            replacesUpTo: downloadedMaxSeq,
          }),
        });
        if (!compactResp.ok) {
          const errText = await compactResp.text();
          throw new Error(`HTTP ${compactResp.status}: ${errText}`);
        }
        progress.documentsCompleted.push(documentId);
        writeProgress(backupDir, progress);
        logger.main.info('[KeyRotationService] Re-encrypted document:', documentId);
      } catch (err) {
        logger.main.error('[KeyRotationService] Failed to upload re-encrypted document:', documentId, err);
        progress.documentsFailed.push(documentId);
        writeProgress(backupDir, progress);
      }
    }

    // Re-encrypt document assets (binaries in R2 + metadata in DocumentRoom).
    // Assets already tagged with the new fingerprint (i.e. rotated by a
    // previous attempt that failed mid-flight) are skipped -- this makes
    // rotation safely resumable after partial failures.
    for (const entry of decryptedIndex) {
      try {
        const assets = await listDocumentAssets(serverUrl, entry.documentId, orgJwt);
        const toRotate = assets.filter(a => (a.keyFingerprint ?? null) !== newFingerprint);
        const skipped = assets.length - toRotate.length;
        if (skipped > 0) {
          logger.main.info('[KeyRotationService] Skipping', skipped, 'assets already rotated for document:', entry.documentId);
        }
        if (toRotate.length > 0) {
          logger.main.info('[KeyRotationService] Re-encrypting', toRotate.length, 'assets for document:', entry.documentId);
          for (const asset of toRotate) {
            try {
              await reEncryptAsset(serverUrl, orgId, entry.documentId, asset.assetId, oldKey, newKey, newFingerprint ?? null, orgJwt);
              progress.assetsCompleted++;
            } catch (assetErr) {
              logger.main.error('[KeyRotationService] Failed to re-encrypt asset:', asset.assetId, 'in doc:', entry.documentId, assetErr);
              progress.assetsFailed++;
            }
          }
          writeProgress(backupDir, progress);
        }
      } catch (err) {
        logger.main.error('[KeyRotationService] Failed to list/re-encrypt assets for document:', entry.documentId, err);
        progress.assetsFailed++;
      }
    }

    // Upload re-encrypted tracker items via HTTP (bypasses write barrier).
    if (reEncryptedTrackerItems.length > 0 && projectId) {
      try {
        const BATCH_SIZE = 50;
        for (let i = 0; i < reEncryptedTrackerItems.length; i += BATCH_SIZE) {
          const batch = reEncryptedTrackerItems.slice(i, i + BATCH_SIZE);
          const upsertResp = await net.fetch(`${httpUrl}/api/teams/${orgId}/rotation-batch-upsert-tracker`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ projectId, items: batch }),
          });
          if (!upsertResp.ok) {
            const errText = await upsertResp.text();
            throw new Error(`HTTP ${upsertResp.status}: ${errText}`);
          }
        }
        progress.trackerItemsCompleted = reEncryptedTrackerItems.length;
        writeProgress(backupDir, progress);
        logger.main.info('[KeyRotationService] Re-encrypted', reEncryptedTrackerItems.length, 'tracker items');
      } catch (err) {
        logger.main.error('[KeyRotationService] Failed to upload re-encrypted tracker items:', err);
        progress.trackerItemsFailed = reEncryptedTrackerItems.length;
        writeProgress(backupDir, progress);
      }
    }

    // FAIL CLOSED: Check for any re-encryption failures before distributing the new key.
    // If any document, asset, or tracker item failed, we cannot safely switch to the
    // new key because those objects are still encrypted with the old key.
    const failedDocs = progress.documentsFailed.length;
    const failedAssets = progress.assetsFailed;
    const failedTrackers = progress.trackerItemsFailed;
    const totalFailed = failedDocs + failedAssets + failedTrackers;

    if (totalFailed > 0) {
      const msg = `Re-encryption incomplete: ${failedDocs} doc(s), ${failedAssets} asset(s), ${failedTrackers} tracker item(s) failed. ` +
        'New key will NOT be distributed. Old key remains active. Retry with retryKeyRotation().';
      logger.main.error('[KeyRotationService]', msg);
      progress.status = 'failed';
      progress.error = msg;
      writeProgress(backupDir, progress);
      throw new Error(msg);
    }

    // Phase 5a-2: Truncate tracker changelog (old entries encrypted with old key)
    if (reEncryptedTrackerItems.length > 0 && projectId) {
      logger.main.info('[KeyRotationService] Truncating tracker changelog...');
      try {
        const { net } = await import('electron');
        const httpUrl = serverUrl.replace('wss://', 'https://').replace('ws://', 'http://');
        const truncResp = await net.fetch(`${httpUrl}/api/teams/${orgId}/truncate-tracker-changelog`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${orgJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ projectId }),
        });
        if (!truncResp.ok) {
          logger.main.warn('[KeyRotationService] Failed to truncate tracker changelog:', truncResp.status);
        }
      } catch (err) {
        logger.main.warn('[KeyRotationService] Failed to truncate tracker changelog:', err);
      }
    }

    // Write barrier was set in Phase 1b and remains active.
    // Rotation uploads used WebSocket which go through locked rooms -- but
    // since we're about to propagate the fingerprint and unlock, any upload
    // failures were already caught by the fail-closed check above.

    // Phase 5b: Propagate new fingerprint to all document and tracker rooms.
    // This enables key epoch enforcement on future writes.
    // FAIL-CLOSED: If propagation fails, rotation fails. Rooms without the
    // new fingerprint would accept old-key writes.
    logger.main.info('[KeyRotationService] Propagating new fingerprint to rooms...');
    const propResp = await net.fetch(`${serverUrl}/api/teams/${orgId}/propagate-fingerprint`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ fingerprint: newFingerprint }),
    });
    if (!propResp.ok) {
      const errText = await propResp.text();
      throw new Error(`Fingerprint propagation failed: HTTP ${propResp.status}: ${errText}`);
    }

    // Phase 5c: Clear write barrier now that fingerprint is propagated
    logger.main.info('[KeyRotationService] Clearing write barrier...');
    try {
      const unlockResp = await net.fetch(`${serverUrl}/api/teams/${orgId}/rotation-lock`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ locked: false }),
      });
      if (!unlockResp.ok) {
        logger.main.warn('[KeyRotationService] Failed to clear write barrier:', unlockResp.status);
      }
    } catch (err) {
      logger.main.warn('[KeyRotationService] Failed to clear write barrier:', err);
    }

    // Phase 6: Distribute new key to remaining members
    // IMPORTANT: Envelopes are uploaded BEFORE posting the fingerprint.
    // The fingerprint triggers orgKeyRotated broadcast -- clients must be
    // able to fetch their new envelope immediately when they receive it.
    progress.phase = 'distribute';
    writeProgress(backupDir, progress);
    logger.main.info('[KeyRotationService] Phase 6: Distributing new key...');

    // Delete all old envelopes first
    await deleteAllEnvelopes(orgId, orgJwt);

    // Wrap and upload new envelopes for each remaining member.
    // FAIL-CLOSED: If any member fails to get their envelope, abort.
    // Old envelopes are already deleted, so publishing the fingerprint
    // without all envelopes would lock those members out.
    const { members } = await listMembers();
    const envelopeFailures: string[] = [];
    for (const member of members) {
      if (member.status === 'pending') continue;
      try {
        const memberPubKey = await fetchMemberPublicKey(member.memberId, orgJwt);
        const envelope = await wrapOrgKeyForMember(orgId, memberPubKey);
        await uploadEnvelope(orgId, member.memberId, envelope, orgJwt);
      } catch (wrapErr) {
        logger.main.error('[KeyRotationService] Could not wrap key for member:', member.memberId, wrapErr);
        envelopeFailures.push(member.memberId);
      }
    }
    if (envelopeFailures.length > 0) {
      const msg = `Failed to distribute new key to ${envelopeFailures.length} member(s): ${envelopeFailures.join(', ')}. ` +
        'Fingerprint will NOT be published. Members may need manual key re-share.';
      logger.main.error('[KeyRotationService]', msg);
      progress.status = 'failed';
      progress.error = msg;
      writeProgress(backupDir, progress);
      throw new Error(msg);
    }

    // NOW post the new fingerprint. This broadcasts orgKeyRotated to all
    // connected clients. They will fetch their envelope (which we just uploaded).
    // FAIL-CLOSED: If this fails, clients won't switch to the new key.
    const fpResp = await net.fetch(`${serverUrl}/api/teams/${orgId}/org-key-fingerprint`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ fingerprint: newFingerprint }),
    });
    if (!fpResp.ok) {
      throw new Error(`Failed to publish fingerprint to TeamRoom: HTTP ${fpResp.status}`);
    }

    // Update manifest with final fingerprint
    await writePlaintextBackup(
      backupDir, orgId, reason, oldFingerprint, newFingerprint!,
      decryptedIndex, documentContents, decryptedTrackerItems
    );

    // Done
    progress.status = 'completed';
    writeProgress(backupDir, progress);
    logger.main.info('[KeyRotationService] Key rotation completed successfully');

    return { backupDir };
  } catch (err) {
    progress.status = 'failed';
    progress.error = err instanceof Error ? err.message : String(err);
    writeProgress(backupDir, progress);
    logger.main.error('[KeyRotationService] Key rotation failed:', err);

    // Phase-aware key recovery:
    // - Before upload phase: server data is still old-key encrypted, restore old key.
    // - During/after upload: server may have new-key data, keep the new key so
    //   admin can still decrypt what was written. Manual retry can complete rotation.
    const safeToRestoreOldKey = progress.phase === 'download' || progress.phase === 'backup' || progress.phase === 'reencrypt';
    if (safeToRestoreOldKey && restoreArchivedOrgKey(orgId)) {
      logger.main.info('[KeyRotationService] Restored previous org key (failure before server writes)');
    } else if (!safeToRestoreOldKey) {
      logger.main.warn('[KeyRotationService] Failure after server writes began (phase:', progress.phase, '). Keeping new key. Manual retry needed.');
    }

    // Only clear the write barrier if failure happened before server writes began.
    // If server writes started but fingerprint propagation did NOT succeed,
    // rooms must stay locked to prevent stale clients writing old-key data
    // into rooms that may now contain new-key snapshots/items.
    // Locked rooms require manual retry or recovery to unlock.
    if (safeToRestoreOldKey) {
      try {
        const { net } = await import('electron');
        await net.fetch(`${serverUrl}/api/teams/${orgId}/rotation-lock`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${orgJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ locked: false }),
        });
      } catch {
        logger.main.warn('[KeyRotationService] Failed to clear write barrier during error recovery');
      }
    } else {
      logger.main.warn('[KeyRotationService] Rooms remain locked (failure after server writes). Manual retry needed to unlock.');
    }

    throw err;
  }
}

// ============================================================================
// Orphaned Document Cleanup
// ============================================================================

/**
 * Clean up documents encrypted with a lost key. Connects to TeamRoom,
 * tries to decrypt each title with the current key, and removes entries
 * that fail (their data is unrecoverable).
 */
export async function cleanupOrphanedDocuments(
  orgId: string,
  orgJwt: string,
  serverUrl: string
): Promise<{ removed: string[]; kept: string[] }> {
  logger.main.info('[KeyRotationService] Cleaning up orphaned documents for:', orgId);

  const currentKey = await getOrgKey(orgId);
  if (!currentKey) {
    throw new Error('No current org key -- cannot determine which documents are orphaned');
  }

  // Get doc index
  const teamRoomId = `org:${orgId}:team`;
  const teamState = await wsRoundTrip<TeamSyncResponse>(
    serverUrl, teamRoomId, orgJwt,
    { type: 'teamSync' },
    'teamSyncResponse'
  );

  const removed: string[] = [];
  const kept: string[] = [];

  for (const doc of teamState.team.documents) {
    try {
      await decryptTitle(doc.encryptedTitle, doc.titleIv, currentKey);
      kept.push(doc.documentId);
    } catch {
      // Cannot decrypt with current key -- orphaned
      removed.push(doc.documentId);
    }
  }

  // Remove orphaned entries from the doc index AND delete the DocumentRoom DO data.
  // Just removing from the index leaves stale old-key-encrypted data in the DO
  // which causes decryption failures if the document is re-shared with the same ID.
  if (removed.length > 0) {
    // TeamRoom now enforces key-epoch on doc-index writes (Issue 5). At this
    // point in the rotation flow the lock is cleared and the new fingerprint
    // is published, so attach it to the orphan-cleanup messages.
    const currentFingerprint = await getOrgKeyFingerprint(orgId);
    const removeMessages = removed.map(documentId => ({
      type: 'docIndexRemove',
      documentId,
      orgKeyFingerprint: currentFingerprint,
    }));
    await wsSendAndClose(serverUrl, teamRoomId, orgJwt, ...removeMessages);

    // Delete the DocumentRoom DO data for each orphan
    const { net } = await import('electron');
    const httpUrl = serverUrl.replace('wss://', 'https://').replace('ws://', 'http://');
    for (const documentId of removed) {
      try {
        const roomId = `org:${orgId}:doc:${documentId}`;
        const resp = await net.fetch(`${httpUrl}/sync/${roomId}/delete?token=${encodeURIComponent(orgJwt)}`, {
          method: 'DELETE',
        });
        if (!resp.ok) {
          logger.main.warn('[KeyRotationService] Failed to delete DocumentRoom for:', documentId, resp.status);
        }
      } catch (err) {
        logger.main.warn('[KeyRotationService] Failed to delete DocumentRoom for:', documentId, err);
      }
    }
    logger.main.info('[KeyRotationService] Removed', removed.length, 'orphaned documents (index + DO data):', removed);
  }

  logger.main.info('[KeyRotationService] Cleanup complete. Kept:', kept.length, 'Removed:', removed.length);
  return { removed, kept };
}

// ============================================================================
// Tracker Data Recovery from Local Database
// ============================================================================

/**
 * Re-encrypt all tracker items from the local PGLite database and push them
 * to the server. Used when server data is encrypted with a lost key but local
 * decrypted copies still exist.
 *
 * This reads decrypted tracker items from PGLite, encrypts each payload with
 * the current org key, and uploads via the rotation-batch-upsert HTTP endpoint.
 */
export async function reEncryptTrackerFromLocal(
  orgId: string,
  projectId: string,
  orgJwt: string,
  serverUrl: string,
  workspacePath: string,
  database: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> }
): Promise<{ reEncrypted: number; failed: number }> {
  logger.main.info('[KeyRotationService] Re-encrypting tracker items from local database...');

  const currentKey = await getOrgKey(orgId);
  if (!currentKey) {
    throw new Error('No current org key available');
  }
  const fingerprint = getOrgKeyFingerprint(orgId);

  // Read all synced tracker items from local PGLite
  const result = await database.query<{
    id: string;
    data: string;
    issue_number: number | null;
    issue_key: string | null;
  }>(
    `SELECT id, data, issue_number, issue_key FROM tracker_items WHERE workspace = $1`,
    [workspacePath]
  );

  const items = result.rows;
  logger.main.info('[KeyRotationService] Found', items.length, 'local tracker items to re-encrypt');

  let reEncrypted = 0;
  let failed = 0;

  // Encrypt and upload in batches via WebSocket (works with existing production server)
  const BATCH_SIZE = 50;
  const trackerRoomId = `org:${orgId}:tracker:${projectId}`;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const encryptedBatch: Array<{
      itemId: string;
      encryptedPayload: string;
      iv: string;
      issueNumber?: number;
      issueKey?: string;
      orgKeyFingerprint?: string;
    }> = [];

    for (const item of batch) {
      try {
        const plaintext = new TextEncoder().encode(item.data);
        const { encrypted, iv } = await encryptBinary(plaintext, currentKey);
        encryptedBatch.push({
          itemId: item.id,
          encryptedPayload: encrypted,
          iv,
          issueNumber: item.issue_number ?? undefined,
          issueKey: item.issue_key ?? undefined,
          orgKeyFingerprint: fingerprint ?? undefined,
        });
      } catch (err) {
        logger.main.error('[KeyRotationService] Failed to encrypt item:', item.id, err);
        failed++;
      }
    }

    if (encryptedBatch.length > 0) {
      try {
        await wsSendAndClose(serverUrl, trackerRoomId, orgJwt, {
          type: 'trackerBatchUpsert',
          items: encryptedBatch,
        });
        reEncrypted += encryptedBatch.length;
      } catch (err) {
        logger.main.error('[KeyRotationService] Batch upload failed:', err);
        failed += encryptedBatch.length;
      }
    }

    logger.main.info(`[KeyRotationService] Progress: ${reEncrypted + failed}/${items.length}`);
  }

  logger.main.info('[KeyRotationService] Recovery complete. Re-encrypted:', reEncrypted, 'Failed:', failed);
  return { reEncrypted, failed };
}
