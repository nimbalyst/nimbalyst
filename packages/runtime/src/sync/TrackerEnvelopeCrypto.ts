/**
 * TrackerEnvelopeCrypto
 *
 * AES-256-GCM encrypt/decrypt helpers for the tracker metadata wire envelope.
 * The phase-3 TrackerSyncEngine calls these at the upload/download boundary;
 * phase 5 (MCP integration) may reuse them for re-encryption during key
 * rotation outside the engine's normal flow.
 *
 * Mirrors the encryption helpers in DocumentSync.ts so both subsystems use
 * the same algorithm, IV size, and base64 encoding. Kept in its own module
 * (rather than inlined in TrackerSyncEngine) so it can be unit-tested
 * without spinning up a WebSocket and so callers outside the engine can
 * re-encrypt cleanly.
 *
 * The plaintext shape (`TrackerItemPayload`) is JSON-serialized inside the
 * ciphertext. The envelope carries `itemId` / `syncId` / `updatedAt` /
 * `deletedAt` / `orgKeyFingerprint` in plaintext per D7.
 *
 * `itemId` is bound into the AES-GCM AAD on encrypt and required to match
 * on decrypt. This stops a malicious server / DO from taking valid
 * ciphertext for item A and serving it under a plaintext envelope claiming
 * `itemId = B`: AES-GCM authentication fails and the engine skips the row.
 *
 * `issueNumber` and `issueKey` are NOT bound in AAD because the server
 * allocates them on first write, after the client has already encrypted.
 * Splice protection for those fields is instead provided by the projection,
 * which takes them from the decrypted payload (which lives inside the
 * itemId-bound ciphertext) rather than from the plaintext envelope.
 */

import type {
  EncryptedTrackerItemEnvelope,
  EncryptedTrackerSchemaEnvelope,
  TrackerItemPayload,
} from './trackerProtocol';
import { stripLocalOnlyFields } from './trackerProtocol';

/** Chunk size for base64 encoding of large Uint8Arrays without stack overflow. */
const CHUNK_SIZE = 8192;

/** AES-GCM IV size (96 bits, per NIST recommendation). */
const IV_BYTE_LENGTH = 12;

// ============================================================================
// Base64 helpers (browser + Node-safe; same impl as DocumentSync)
// ============================================================================

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

// ============================================================================
// Identifier AAD binding
// ============================================================================

/**
 * Build the AAD bound into AES-GCM for an envelope. Both encrypt and
 * decrypt must derive the same bytes for authentication to succeed, so the
 * shape is fixed here.
 *
 * `issueNumber` / `issueKey` are intentionally NOT in the AAD -- see the
 * file-level comment for why.
 */
function buildItemIdAad(itemId: string): Uint8Array {
  return new TextEncoder().encode(`tracker-item:${itemId}`);
}

function buildSchemaTypeAad(schemaType: string): Uint8Array {
  return new TextEncoder().encode(`tracker-schema:${schemaType}`);
}

// ============================================================================
// Encrypt / decrypt
// ============================================================================

/**
 * Encrypt a `TrackerItemPayload` for upload. Strips device-local fields
 * (per D3 / `LOCAL_ONLY_PAYLOAD_FIELDS`) before serialization so they
 * never cross the wire.
 *
 * The caller MUST supply the `itemId` that will travel as a plaintext
 * envelope field. It is bound into the AES-GCM AAD so the server cannot
 * splice this ciphertext onto a different item without holding the org key.
 *
 * Returns the base64 ciphertext and IV. The caller wraps these in a
 * `trackerMutation` message along with the plaintext envelope fields.
 */
export async function encryptTrackerPayload(
  payload: TrackerItemPayload,
  key: CryptoKey,
  itemId: string,
): Promise<{ encryptedPayload: string; iv: string }> {
  const stripped = stripLocalOnlyFields(payload);
  const cleartext = new TextEncoder().encode(JSON.stringify(stripped));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const aad = buildItemIdAad(itemId);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad as BufferSource },
    key,
    cleartext as BufferSource,
  );
  return {
    encryptedPayload: uint8ArrayToBase64(new Uint8Array(ciphertext)),
    iv: uint8ArrayToBase64(iv),
  };
}

/**
 * Decrypt an envelope received from the server. Throws on AES-GCM auth
 * failure (`OperationError`) -- the engine catches that per-item and
 * skips the row, matching the DocumentSync stale-key-epoch pattern.
 *
 * The envelope's plaintext `itemId` is passed as AAD, so a server-side
 * splice that takes valid ciphertext for item A and serves it under
 * `itemId = B` is rejected by authentication.
 *
 * Tombstones (`encryptedPayload === null`) MUST be filtered by the caller
 * before invoking this function; decrypting a null payload is a programming
 * error.
 */
export async function decryptTrackerEnvelope(
  envelope: EncryptedTrackerItemEnvelope,
  key: CryptoKey,
): Promise<TrackerItemPayload> {
  if (envelope.encryptedPayload === null) {
    throw new Error('decryptTrackerEnvelope called on a tombstone (encryptedPayload=null)');
  }
  if (!envelope.iv) {
    throw new Error('decryptTrackerEnvelope: envelope missing iv');
  }
  const ciphertext = base64ToUint8Array(envelope.encryptedPayload);
  const iv = base64ToUint8Array(envelope.iv);
  const aad = buildItemIdAad(envelope.itemId);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  const json = new TextDecoder().decode(plaintext);
  return JSON.parse(json) as TrackerItemPayload;
}

/**
 * Encrypt a JSON-serialized TrackerDataModel for schema sync. The server never
 * reads the model, and the plaintext schema type is bound into AES-GCM AAD so a
 * ciphertext for one type cannot be replayed under another.
 */
export async function encryptTrackerSchemaPayload(
  modelJson: string,
  key: CryptoKey,
  schemaType: string,
): Promise<{ encryptedPayload: string; iv: string }> {
  const cleartext = new TextEncoder().encode(modelJson);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const aad = buildSchemaTypeAad(schemaType);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad as BufferSource },
    key,
    cleartext as BufferSource,
  );
  return {
    encryptedPayload: uint8ArrayToBase64(new Uint8Array(ciphertext)),
    iv: uint8ArrayToBase64(iv),
  };
}

export async function decryptTrackerSchemaEnvelope(
  envelope: EncryptedTrackerSchemaEnvelope,
  key: CryptoKey,
): Promise<string> {
  if (envelope.encryptedPayload === null) {
    throw new Error('decryptTrackerSchemaEnvelope called on a tombstone (encryptedPayload=null)');
  }
  if (!envelope.iv) {
    throw new Error('decryptTrackerSchemaEnvelope: envelope missing iv');
  }
  const ciphertext = base64ToUint8Array(envelope.encryptedPayload);
  const iv = base64ToUint8Array(envelope.iv);
  const aad = buildSchemaTypeAad(envelope.schemaType);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

// ============================================================================
// Epic H2 — server-managed pass-through (no client-side crypto)
// ============================================================================
//
// In `server-managed` key custody the server holds the per-team DEK and
// encrypts team data at rest. The client sends and receives PLAINTEXT in the
// `encryptedPayload` field (no iv; `orgKeyFingerprint` null). These helpers are
// the identity replacements for encrypt/decrypt so TrackerSyncEngine can branch
// on mode without inlining JSON handling. The itemId/schemaType AAD binding is
// performed server-side in this mode.

/**
 * Serialize a `TrackerItemPayload` to the plaintext wire form for
 * server-managed mode. Strips device-local fields exactly like the encrypted
 * path so they never cross the wire.
 */
export function encodeTrackerPayloadPlaintext(payload: TrackerItemPayload): string {
  return JSON.stringify(stripLocalOnlyFields(payload));
}

/**
 * Parse a plaintext server-managed item envelope back into a payload. Throws
 * (caught per-item by the engine) on malformed JSON or a missing payload.
 */
export function decodeTrackerEnvelopePlaintext(
  envelope: EncryptedTrackerItemEnvelope,
): TrackerItemPayload {
  if (envelope.encryptedPayload === null) {
    throw new Error('decodeTrackerEnvelopePlaintext called on a tombstone (encryptedPayload=null)');
  }
  return JSON.parse(envelope.encryptedPayload) as TrackerItemPayload;
}

/**
 * Parse a plaintext server-managed schema envelope back into its model JSON
 * string. The model is already JSON, so this is a presence/typing guard.
 */
export function decodeTrackerSchemaEnvelopePlaintext(
  envelope: EncryptedTrackerSchemaEnvelope,
): string {
  if (envelope.encryptedPayload === null) {
    throw new Error('decodeTrackerSchemaEnvelopePlaintext called on a tombstone (encryptedPayload=null)');
  }
  return envelope.encryptedPayload;
}

/**
 * Compute a short fingerprint of an AES-256-GCM CryptoKey, suitable for
 * the `orgKeyFingerprint` epoch field on the wire envelope. The server
 * uses this to detect stale-key writes during rotation.
 *
 * Returns the first 32 hex chars of SHA-256(rawKey). Matches the
 * fingerprint format produced by OrgKeyService in electron.
 */
export async function fingerprintTrackerKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  const digest = await crypto.subtle.digest('SHA-256', raw);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex.slice(0, 32);
}
