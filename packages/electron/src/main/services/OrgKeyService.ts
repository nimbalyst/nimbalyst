/**
 * OrgKeyService - Manages ECDH identity key pairs and per-org encryption keys.
 *
 * Architecture:
 * - One ECDH P-256 identity key pair per device (stored in safeStorage)
 * - One AES-256-GCM org encryption key per team (stored in safeStorage)
 * - Identity public key uploaded to server per-org for key exchange
 * - Org keys wrapped/unwrapped via ECDH between admin and members
 * - Never touches global auth state (uses per-org JWTs from TeamService)
 *
 * Storage:
 * - ecdh-identity-keypair.enc: Serialized ECDH P-256 key pair (JWK)
 * - org-encryption-keys.enc: Map<orgId, base64 raw AES-256 key bytes>
 * - trust-verifications.enc: Map<orgId:memberId, TrustRecord> for local trust decisions
 */

import { safeStorage, app, net } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ECDHKeyManager, type SerializedECDHKeyPair, type KeyEnvelope } from '@nimbalyst/runtime/sync';
import { logger } from '../utils/logger';
import { getCollabSyncHttpUrl } from '../utils/collabSyncUrl';
import { getSessionJwt, isAuthenticated } from './StytchAuthService';
import { getOrgScopedJwt } from './TeamService';
import { safeHandle } from '../utils/ipcRegistry';

// Re-export under the original local name so the many call sites in this
// module don't churn. Canonical helper lives in utils/collabSyncUrl.ts.
const getCollabServerUrl = getCollabSyncHttpUrl;

// ============================================================================
// Storage Constants
// ============================================================================

const IDENTITY_KEYPAIR_FILE = 'ecdh-identity-keypair.enc';
const ORG_KEYS_FILE = 'org-encryption-keys.enc';
const ORG_KEY_HISTORY_FILE = 'org-key-history.enc';
const TRUST_VERIFICATIONS_FILE = 'trust-verifications.enc';

// ============================================================================
// Module State
// ============================================================================

let keyManager: ECDHKeyManager | null = null;
interface OrgKeyEntry {
  rawKeyBase64: string;
  fingerprint: string;
}

let orgKeysCache: Map<string, OrgKeyEntry> = new Map(); // orgId -> key + fingerprint
let orgKeysCacheLoaded = false;

// Key history: archived keys from previous rotations (append-only, never pruned)
interface ArchivedOrgKey {
  rawKeyBase64: string;
  fingerprint: string;
  archivedAt: string;   // ISO timestamp
  reason: string;       // e.g., 'member-removal:userId'
}

let keyHistoryCache: Map<string, ArchivedOrgKey[]> = new Map(); // orgId -> archived keys
let keyHistoryCacheLoaded = false;

// Trust verification state (local, per-device)
interface TrustRecord {
  fingerprint: string;  // Fingerprint at time of verification
  verifiedAt: string;   // ISO timestamp
}

let trustCache: Map<string, TrustRecord> = new Map(); // `${orgId}:${memberId}` -> TrustRecord
let trustCacheLoaded = false;

// ============================================================================
// SafeStorage Helpers (same pattern as CredentialService)
// ============================================================================

function getStoragePath(filename: string): string {
  return path.join(app.getPath('userData'), filename);
}

function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function saveEncrypted(filename: string, data: string): void {
  const filePath = getStoragePath(filename);
  if (isSafeStorageAvailable()) {
    fs.writeFileSync(filePath, safeStorage.encryptString(data));
  } else {
    logger.main.warn(`[OrgKeyService] safeStorage unavailable, saving ${filename} unencrypted`);
    fs.writeFileSync(filePath, data, 'utf8');
  }
}

function loadEncrypted(filename: string): string | null {
  const filePath = getStoragePath(filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    const fileData = fs.readFileSync(filePath);
    if (isSafeStorageAvailable()) {
      return safeStorage.decryptString(fileData);
    }
    return fileData.toString('utf8');
  } catch (err) {
    logger.main.error(`[OrgKeyService] Failed to load ${filename}:`, err);
    return null;
  }
}

// ============================================================================
// Identity Key Pair Management
// ============================================================================

/**
 * Get or create the device's ECDH P-256 identity key pair.
 * Generated once, persisted in safeStorage.
 */
export async function getOrCreateIdentityKeyPair(): Promise<ECDHKeyManager> {
  if (keyManager?.getKeyPair()) return keyManager;

  keyManager = new ECDHKeyManager();

  // Try to load existing key pair
  const saved = loadEncrypted(IDENTITY_KEYPAIR_FILE);
  if (saved) {
    try {
      const serialized: SerializedECDHKeyPair = JSON.parse(saved);
      await keyManager.deserializeKeyPair(serialized);
      logger.main.info('[OrgKeyService] Loaded existing identity key pair');
      return keyManager;
    } catch (err) {
      logger.main.error('[OrgKeyService] Failed to deserialize identity key pair, generating new:', err);
    }
  }

  // Generate new key pair
  await keyManager.generateKeyPair();
  const serialized = await keyManager.serializeKeyPair();
  saveEncrypted(IDENTITY_KEYPAIR_FILE, JSON.stringify(serialized));
  logger.main.info('[OrgKeyService] Generated and saved new identity key pair');

  return keyManager;
}

/**
 * Export the public key as a JWK string.
 */
export async function exportPublicKeyJwk(): Promise<string> {
  const km = await getOrCreateIdentityKeyPair();
  return km.exportPublicKeyJwk();
}

// ============================================================================
// Key Fingerprint Generation
// ============================================================================

/**
 * Compute a human-readable fingerprint from a public key JWK string.
 * SHA-256 hash formatted as colon-separated uppercase hex pairs.
 * Example: "A3:B7:C2:D8:E1:F0:94:2A:..."
 */
export function computeKeyFingerprint(publicKeyJwk: string): string {
  const hash = createHash('sha256').update(publicKeyJwk).digest();
  return Array.from(hash)
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':');
}

/**
 * Compute a compact fingerprint for an org encryption key (raw AES-256 bytes as base64).
 * Uses first 16 bytes (128 bits) of SHA-256 as lowercase hex -- sufficient for collision
 * resistance, short enough for wire protocol and logging.
 */
export function computeOrgKeyFingerprint(rawKeyBase64: string): string {
  const hash = createHash('sha256').update(rawKeyBase64).digest();
  return hash.subarray(0, 16).toString('hex');
}

// ============================================================================
// Org Encryption Key Storage
// ============================================================================

function loadOrgKeysFromDisk(): void {
  if (orgKeysCacheLoaded) return;
  orgKeysCacheLoaded = true;

  const saved = loadEncrypted(ORG_KEYS_FILE);
  if (saved) {
    try {
      const entries: Array<[string, string | OrgKeyEntry]> = JSON.parse(saved);
      orgKeysCache = new Map();
      let migrated = false;
      for (const [orgId, value] of entries) {
        if (typeof value === 'string') {
          // Legacy format: plain base64 string without fingerprint -- auto-migrate
          orgKeysCache.set(orgId, {
            rawKeyBase64: value,
            fingerprint: computeOrgKeyFingerprint(value),
          });
          migrated = true;
        } else {
          orgKeysCache.set(orgId, value);
        }
      }
      logger.main.info(`[OrgKeyService] Loaded ${orgKeysCache.size} org encryption keys`);
      if (migrated) {
        saveOrgKeysToDisk();
        logger.main.info('[OrgKeyService] Migrated org keys to fingerprinted format');
      }
    } catch {
      orgKeysCache = new Map();
    }
  }
}

function saveOrgKeysToDisk(): void {
  const entries = Array.from(orgKeysCache.entries());
  saveEncrypted(ORG_KEYS_FILE, JSON.stringify(entries));
}

/**
 * Store an org encryption key locally (raw AES-256 key as base64).
 */
function storeOrgKeyRaw(orgId: string, rawKeyBase64: string): void {
  loadOrgKeysFromDisk();
  orgKeysCache.set(orgId, {
    rawKeyBase64,
    fingerprint: computeOrgKeyFingerprint(rawKeyBase64),
  });
  saveOrgKeysToDisk();
}

// ============================================================================
// Org Key History (Append-Only Archive of Rotated Keys)
// ============================================================================

function loadKeyHistoryFromDisk(): void {
  if (keyHistoryCacheLoaded) return;
  keyHistoryCacheLoaded = true;

  const saved = loadEncrypted(ORG_KEY_HISTORY_FILE);
  if (saved) {
    try {
      const entries: Array<[string, ArchivedOrgKey[]]> = JSON.parse(saved);
      keyHistoryCache = new Map(entries);
      const totalKeys = Array.from(keyHistoryCache.values()).reduce((sum, arr) => sum + arr.length, 0);
      logger.main.info(`[OrgKeyService] Loaded key history: ${totalKeys} archived keys across ${keyHistoryCache.size} orgs`);
    } catch {
      keyHistoryCache = new Map();
    }
  }
}

function saveKeyHistoryToDisk(): void {
  const entries = Array.from(keyHistoryCache.entries());
  saveEncrypted(ORG_KEY_HISTORY_FILE, JSON.stringify(entries));
}

/**
 * Archive the current org key before rotation. Must be called BEFORE
 * generating a new key, so the old key is preserved in history.
 * Returns the archived entry, or null if no key was cached for this org.
 */
export function archiveCurrentOrgKey(orgId: string, reason: string): ArchivedOrgKey | null {
  loadOrgKeysFromDisk();
  loadKeyHistoryFromDisk();

  const current = orgKeysCache.get(orgId);
  if (!current) {
    logger.main.warn('[OrgKeyService] No current key to archive for:', orgId);
    return null;
  }

  const archived: ArchivedOrgKey = {
    rawKeyBase64: current.rawKeyBase64,
    fingerprint: current.fingerprint,
    archivedAt: new Date().toISOString(),
    reason,
  };

  const history = keyHistoryCache.get(orgId) || [];
  history.push(archived);
  keyHistoryCache.set(orgId, history);
  saveKeyHistoryToDisk();

  logger.main.info('[OrgKeyService] Archived org key for:', orgId, 'fingerprint:', current.fingerprint, 'reason:', reason);
  return archived;
}

/**
 * Get the most recently archived key for an org (the one that was active
 * right before the current key). Used for re-encryption during rotation.
 */
export async function getLatestArchivedOrgKey(orgId: string): Promise<{ key: CryptoKey; fingerprint: string } | null> {
  loadKeyHistoryFromDisk();
  const history = keyHistoryCache.get(orgId);
  if (!history || history.length === 0) return null;

  const latest = history[history.length - 1];
  const keyBytes = base64ToUint8Array(latest.rawKeyBase64);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  return { key, fingerprint: latest.fingerprint };
}

/**
 * Get an archived key by fingerprint. Useful for decrypting data encrypted
 * with a specific old key when multiple rotations have occurred.
 */
export async function getArchivedOrgKeyByFingerprint(orgId: string, fingerprint: string): Promise<CryptoKey | null> {
  loadKeyHistoryFromDisk();
  const history = keyHistoryCache.get(orgId);
  if (!history) return null;

  const entry = history.find(h => h.fingerprint === fingerprint);
  if (!entry) return null;

  const keyBytes = base64ToUint8Array(entry.rawKeyBase64);
  return crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Get all archived keys for an org (for diagnostics / manual recovery).
 */
export function getArchivedOrgKeys(orgId: string): ArchivedOrgKey[] {
  loadKeyHistoryFromDisk();
  return keyHistoryCache.get(orgId) || [];
}

/**
 * Get an org encryption key as a CryptoKey, or null if not stored.
 */
export async function getOrgKey(orgId: string): Promise<CryptoKey | null> {
  loadOrgKeysFromDisk();
  const entry = orgKeysCache.get(orgId);
  if (!entry) return null;

  const keyBytes = base64ToUint8Array(entry.rawKeyBase64);
  return crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'AES-GCM', length: 256 },
    true, // extractable for wrapping
    ['encrypt', 'decrypt']
  );
}

/**
 * Check if we have an org key stored locally.
 */
export function hasOrgKey(orgId: string): boolean {
  loadOrgKeysFromDisk();
  return orgKeysCache.has(orgId);
}

/**
 * Get the fingerprint of the locally cached org key, or null if not stored.
 */
export function getOrgKeyFingerprint(orgId: string): string | null {
  loadOrgKeysFromDisk();
  const entry = orgKeysCache.get(orgId);
  return entry?.fingerprint ?? null;
}

/**
 * Restore the most recently archived key as the current key.
 * Used to roll back after a failed key rotation. Removes the archive entry
 * to prevent confusion about which key is "current".
 */
export function restoreArchivedOrgKey(orgId: string): boolean {
  loadOrgKeysFromDisk();
  loadKeyHistoryFromDisk();

  const history = keyHistoryCache.get(orgId);
  if (!history || history.length === 0) {
    logger.main.warn('[OrgKeyService] No archived keys to restore for:', orgId);
    return false;
  }

  const latest = history[history.length - 1];
  // Restore as current key
  storeOrgKeyRaw(orgId, latest.rawKeyBase64);
  // Remove from archive (it's now the current key again)
  history.pop();
  saveKeyHistoryToDisk();
  logger.main.info('[OrgKeyService] Restored archived key as current:', latest.fingerprint, 'for:', orgId);
  return true;
}

/**
 * Clear the locally cached org key (e.g., when detected as stale).
 */
export function clearOrgKey(orgId: string): void {
  loadOrgKeysFromDisk();
  if (orgKeysCache.delete(orgId)) {
    saveOrgKeysToDisk();
    logger.main.info('[OrgKeyService] Cleared stale org key for:', orgId);
  }
}

// ============================================================================
// Trust Verification Persistence (Local, Per-Device)
// ============================================================================

function loadTrustFromDisk(): void {
  if (trustCacheLoaded) return;
  trustCacheLoaded = true;

  const saved = loadEncrypted(TRUST_VERIFICATIONS_FILE);
  if (saved) {
    try {
      const entries: Array<[string, TrustRecord]> = JSON.parse(saved);
      trustCache = new Map(entries);
      logger.main.info(`[OrgKeyService] Loaded ${trustCache.size} trust verifications`);
    } catch {
      trustCache = new Map();
    }
  }
}

function saveTrustToDisk(): void {
  const entries = Array.from(trustCache.entries());
  saveEncrypted(TRUST_VERIFICATIONS_FILE, JSON.stringify(entries));
}

function trustKey(orgId: string, memberId: string): string {
  return `${orgId}:${memberId}`;
}

/**
 * Mark a member as verified locally. Stores the fingerprint at time of verification.
 */
export function markMemberVerified(orgId: string, memberId: string, fingerprint: string): void {
  loadTrustFromDisk();
  trustCache.set(trustKey(orgId, memberId), {
    fingerprint,
    verifiedAt: new Date().toISOString(),
  });
  saveTrustToDisk();
  logger.main.info('[OrgKeyService] Marked member as verified:', memberId, 'in org:', orgId);
}

/**
 * Revoke local trust for a member.
 */
export function revokeMemberTrust(orgId: string, memberId: string): void {
  loadTrustFromDisk();
  trustCache.delete(trustKey(orgId, memberId));
  saveTrustToDisk();
  logger.main.info('[OrgKeyService] Revoked trust for member:', memberId, 'in org:', orgId);
}

/**
 * Get the local trust status for a member.
 * - 'verified': fingerprint matches stored record
 * - 'fingerprint-changed': stored fingerprint doesn't match current (key was rotated)
 * - 'unverified': no stored record
 */
export function getMemberTrustStatus(
  orgId: string,
  memberId: string,
  currentFingerprint: string
): 'verified' | 'fingerprint-changed' | 'unverified' {
  loadTrustFromDisk();
  const record = trustCache.get(trustKey(orgId, memberId));
  if (!record) return 'unverified';
  if (record.fingerprint === currentFingerprint) return 'verified';
  return 'fingerprint-changed';
}

/**
 * Compute a stable fingerprint for an ECDH public key JWK -- the same shape
 * stored in `TrustRecord.fingerprint`. SHA-256 over a canonical-JSON
 * projection of the JWK's curve params, taking the first 32 hex chars to
 * match the org-key fingerprint format. Both `getMemberTrustStatus` and
 * `markMemberVerified` expect this representation.
 */
export async function fingerprintIdentityKey(publicKeyJwk: string): Promise<string> {
  const jwk = JSON.parse(publicKeyJwk) as { kty?: string; crv?: string; x?: string; y?: string };
  const canonical = JSON.stringify({
    kty: jwk.kty ?? null,
    crv: jwk.crv ?? null,
    x: jwk.x ?? null,
    y: jwk.y ?? null,
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
  return hex.slice(0, 32);
}

/**
 * Get all trust records for an org (for batch UI display).
 */
export function getAllTrustRecords(orgId: string): Map<string, TrustRecord> {
  loadTrustFromDisk();
  const result = new Map<string, TrustRecord>();
  const prefix = `${orgId}:`;
  for (const [key, record] of trustCache) {
    if (key.startsWith(prefix)) {
      const memberId = key.slice(prefix.length);
      result.set(memberId, record);
    }
  }
  return result;
}

// ============================================================================
// Org Key Generation
// ============================================================================

/**
 * Generate a new AES-256-GCM org encryption key and store it locally.
 */
export async function generateAndStoreOrgKey(orgId: string): Promise<CryptoKey> {
  const key = await ECDHKeyManager.generateDocumentKey();
  const rawBytes = await crypto.subtle.exportKey('raw', key);
  storeOrgKeyRaw(orgId, uint8ArrayToBase64(new Uint8Array(rawBytes)));
  logger.main.info('[OrgKeyService] Generated and stored new org key for:', orgId);
  return key;
}

// ============================================================================
// Key Wrapping / Unwrapping
// ============================================================================

/**
 * Wrap the org key for a target member using ECDH.
 */
export async function wrapOrgKeyForMember(
  orgId: string,
  recipientPublicKeyJwk: string
): Promise<KeyEnvelope> {
  const km = await getOrCreateIdentityKeyPair();
  const orgKey = await getOrgKey(orgId);
  if (!orgKey) throw new Error(`No org key stored for ${orgId}`);
  return km.wrapDocumentKey(orgKey, recipientPublicKeyJwk);
}

/**
 * Unwrap an org key from a key envelope and store it locally.
 *
 * Sender-binding verification is REQUIRED. The caller must supply the
 * sender's identity-key JWK (fetched from `/api/identity-key/:userId`) so
 * `unwrapDocumentKeyVerified` can confirm the envelope was wrapped by the
 * claimed sender. Without this check, a malicious server can swap the
 * envelope's plaintext `senderPublicKey` and ECDH still derives *some*
 * shared secret -- the recipient would unknowingly accept a poisoned org
 * key. There is no fallback unverified branch.
 */
export async function unwrapAndStoreOrgKey(
  orgId: string,
  envelope: KeyEnvelope,
  expectedSenderPublicKeyJwk: string
): Promise<CryptoKey> {
  const km = await getOrCreateIdentityKeyPair();
  const orgKey = await km.unwrapDocumentKeyVerified(envelope, expectedSenderPublicKeyJwk);
  const rawBytes = await crypto.subtle.exportKey('raw', orgKey);
  storeOrgKeyRaw(orgId, uint8ArrayToBase64(new Uint8Array(rawBytes)));
  logger.main.info('[OrgKeyService] Unwrapped and stored org key for:', orgId);
  return orgKey;
}

// ============================================================================
// Server Communication (Key Envelopes)
// ============================================================================

/**
 * Make an authenticated call to the collabv3 API.
 * Uses org-scoped JWT when available, falls back to personal JWT.
 */
async function fetchApi(apiPath: string, method: string, body?: unknown, orgScopedJwt?: string): Promise<any> {
  const jwt = orgScopedJwt || getSessionJwt();
  if (!jwt) throw new Error('Not authenticated');

  const httpUrl = getCollabServerUrl();

  const headers: Record<string, string> = { 'Authorization': `Bearer ${jwt}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await net.fetch(`${httpUrl}${apiPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
    throw new Error(errData.error || `API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Upload the device's public key to the server for a given org.
 * Requires an org-scoped JWT so the key is stored under the correct org.
 */
export async function uploadIdentityKeyToOrg(orgScopedJwt: string): Promise<void> {
  const publicKeyJwk = await exportPublicKeyJwk();
  await fetchApi('/api/identity-key', 'PUT', { publicKeyJwk }, orgScopedJwt);
  logger.main.info('[OrgKeyService] Uploaded identity public key to org');
}

/**
 * Fetch a member's public key from the server (same org).
 */
export async function fetchMemberPublicKey(userId: string, orgScopedJwt: string): Promise<string> {
  const data = await fetchApi(`/api/identity-key/${userId}`, 'GET', undefined, orgScopedJwt) as {
    publicKeyJwk: string;
  };
  return data.publicKeyJwk;
}

/**
 * Upload a key envelope to the server.
 */
export async function uploadEnvelope(
  orgId: string,
  targetUserId: string,
  envelope: KeyEnvelope,
  orgScopedJwt: string
): Promise<void> {
  await fetchApi(`/api/teams/${orgId}/key-envelopes`, 'POST', {
    targetUserId,
    wrappedKey: envelope.wrappedKey,
    iv: envelope.iv,
    senderPublicKey: envelope.senderPublicKey,
  }, orgScopedJwt);
}

/**
 * Fetch the caller's own key envelope from the server.
 * Returns a KeyEnvelope extended with senderUserId for verification.
 */
export async function fetchOwnEnvelope(orgId: string, orgScopedJwt: string): Promise<(KeyEnvelope & { senderUserId?: string }) | null> {
  try {
    const data = await fetchApi(`/api/teams/${orgId}/key-envelope`, 'GET', undefined, orgScopedJwt) as {
      wrappedKey: string;
      iv: string;
      senderPublicKey: string;
      senderUserId?: string;
    };
    return {
      wrappedKey: data.wrappedKey,
      iv: data.iv,
      senderPublicKey: data.senderPublicKey,
      senderUserId: data.senderUserId,
    };
  } catch (err) {
    // 404 = no envelope yet
    if (err instanceof Error && err.message.includes('No key envelope found')) {
      return null;
    }
    throw err;
  }
}

/**
 * Fetch all envelopes for an org (admin only, for listing who has keys).
 */
export async function fetchAllEnvelopes(orgId: string, orgScopedJwt: string): Promise<Array<{ targetUserId: string; createdAt: string }>> {
  const data = await fetchApi(`/api/teams/${orgId}/key-envelopes`, 'GET', undefined, orgScopedJwt) as {
    envelopes: Array<{ targetUserId: string; createdAt: string }>;
  };
  return data.envelopes;
}

/**
 * Delete a user's key envelope from the server (admin only).
 */
export async function deleteEnvelope(orgId: string, targetUserId: string, orgScopedJwt: string): Promise<void> {
  await fetchApi(`/api/teams/${orgId}/key-envelopes/${targetUserId}`, 'DELETE', undefined, orgScopedJwt);
}

/**
 * Delete ALL key envelopes for an org (admin only, for key rotation).
 */
export async function deleteAllEnvelopes(orgId: string, orgScopedJwt: string): Promise<void> {
  await fetchApi(`/api/teams/${orgId}/key-envelopes`, 'DELETE', undefined, orgScopedJwt);
}

/**
 * Epic H2 key-custody mode for a team.
 *  - `legacy-e2e`: client-side zero-knowledge ECDH envelope model (default).
 *  - `server-managed`: the server holds the per-team DEK and encrypts at rest;
 *    the client syncs PLAINTEXT and needs no org key envelope.
 */
export type TeamKeyCustodyMode = 'legacy-e2e' | 'server-managed';

export interface TeamKeyStatus {
  mode: TeamKeyCustodyMode;
  dekEpoch: number | null;
  dekFingerprint: string | null;
}

/**
 * Fetch a team's key-custody status (Epic H2). The sync managers call this on
 * team-room open to pick their sync lane: `server-managed` skips the ECDH
 * unwrap entirely. Falls back to `legacy-e2e` on any error so a transient
 * failure never silently downgrades a legacy team's encryption.
 *
 * TEAM lane only — never call this for personal/mobile rooms (those stay
 * zero-knowledge and have no team DEK).
 */
export async function fetchTeamKeyStatus(orgId: string, orgScopedJwt: string): Promise<TeamKeyStatus> {
  try {
    const data = await fetchApi(`/api/teams/${orgId}/key-status`, 'GET', undefined, orgScopedJwt) as {
      mode?: string; dekEpoch?: number | null; dekFingerprint?: string | null;
    };
    const mode: TeamKeyCustodyMode = data.mode === 'server-managed' ? 'server-managed' : 'legacy-e2e';
    return { mode, dekEpoch: data.dekEpoch ?? null, dekFingerprint: data.dekFingerprint ?? null };
  } catch (err) {
    logger.main.warn('[OrgKeyService] fetchTeamKeyStatus failed for', orgId, '-- defaulting to legacy-e2e:', err);
    return { mode: 'legacy-e2e', dekEpoch: null, dekFingerprint: null };
  }
}

/**
 * Epic H2 migration cutover: flip a team's key custody to `server-managed`
 * (admin-gated server-side). After this, the server holds the per-team DEK and
 * encrypts team data at rest; clients sync PLAINTEXT. The caller is responsible
 * for re-uploading the team's existing (locally-decrypted) data as plaintext so
 * legacy ciphertext rows are replaced — see `migrateTeamToServerManaged`.
 */
export async function setTeamKeyCustodyMode(
  orgId: string,
  mode: TeamKeyCustodyMode,
  orgScopedJwt: string,
): Promise<void> {
  await fetchApi(`/api/teams/${orgId}/set-key-custody-mode`, 'POST', { mode }, orgScopedJwt);
  logger.main.info('[OrgKeyService] Set key custody mode for', orgId, '->', mode);
}

/**
 * Fetch and unwrap the org key (for non-admin members joining a team).
 *
 * Verifies the envelope's sender against the sender's registered identity
 * key. Both checks fail closed:
 *   - If the envelope lacks `senderUserId`, throw -- the server is supposed
 *     to populate that field on upload (see `uploadEnvelope`).
 *   - If fetching the sender's public key fails, propagate the error. Do
 *     NOT log-and-continue: a transient network failure or a malicious
 *     backend response is enough to bypass sender binding otherwise.
 */
export async function fetchAndUnwrapOrgKey(orgId: string, orgScopedJwt: string): Promise<CryptoKey | null> {
  const envelope = await fetchOwnEnvelope(orgId, orgScopedJwt);
  if (!envelope) return null;

  if (!envelope.senderUserId) {
    throw new Error(
      `Key envelope for org ${orgId} is missing senderUserId; refusing to unwrap without sender binding. ` +
      `Ask an admin to re-wrap the key envelope.`,
    );
  }

  const expectedSenderKey = await fetchMemberPublicKey(envelope.senderUserId, orgScopedJwt);
  return unwrapAndStoreOrgKey(orgId, envelope, expectedSenderKey);
}

// ============================================================================
// IPC Handler Registration
// ============================================================================

export function registerOrgKeyHandlers(): void {
  safeHandle('team:ensure-org-key', async (_event, orgId: string) => {
    if (!isAuthenticated()) return { success: false, error: 'Not authenticated' };

    try {
      // Check if we already have it
      if (hasOrgKey(orgId)) {
        return { success: true, hasKey: true };
      }

      // Use org-scoped JWT for envelope fetch
      const orgJwt = await getOrgScopedJwt(orgId);

      // Ensure identity key pair exists and is uploaded
      await getOrCreateIdentityKeyPair();
      await uploadIdentityKeyToOrg(orgJwt);

      const key = await fetchAndUnwrapOrgKey(orgId, orgJwt);
      return { success: true, hasKey: key !== null };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:get-org-key-status', async (_event, orgId: string) => {
    try {
      return { success: true, hasKey: hasOrgKey(orgId) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Epic H2: current key-custody mode for a team (legacy-e2e | server-managed).
  // Drives the Security & encryption section + migration banner.
  safeHandle('team:get-key-custody-status', async (_event, orgId: string) => {
    if (!isAuthenticated()) return { success: false, error: 'Not authenticated' };
    try {
      const orgJwt = await getOrgScopedJwt(orgId);
      const status = await fetchTeamKeyStatus(orgId, orgJwt);
      return { success: true, mode: status.mode, dekFingerprint: status.dekFingerprint };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:list-key-envelopes', async (_event, orgId: string) => {
    if (!isAuthenticated()) return { success: false, error: 'Not authenticated' };

    try {
      const orgJwt = await getOrgScopedJwt(orgId);
      const envelopes = await fetchAllEnvelopes(orgId, orgJwt);
      return { success: true, envelopes };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ---- Trust Verification Handlers ----

  safeHandle('team:get-member-fingerprint', async (_event, orgId: string, memberId: string) => {
    if (!isAuthenticated()) return { success: false, error: 'Not authenticated' };

    try {
      const orgJwt = await getOrgScopedJwt(orgId);
      const publicKeyJwk = await fetchMemberPublicKey(memberId, orgJwt);
      const fingerprint = computeKeyFingerprint(publicKeyJwk);
      const trustStatus = getMemberTrustStatus(orgId, memberId, fingerprint);
      return { success: true, fingerprint, trustStatus };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:get-my-fingerprint', async (_event, orgId: string) => {
    if (!isAuthenticated()) return { success: false, error: 'Not authenticated' };

    try {
      const publicKeyJwk = await exportPublicKeyJwk();
      const fingerprint = computeKeyFingerprint(publicKeyJwk);
      return { success: true, fingerprint };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:verify-member', async (_event, orgId: string, memberId: string, fingerprint: string) => {
    try {
      markMemberVerified(orgId, memberId, fingerprint);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:revoke-member-trust', async (_event, orgId: string, memberId: string) => {
    try {
      revokeMemberTrust(orgId, memberId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Refresh own identity key for a team: upload current public key
   * and try to fetch/unwrap the org key envelope. Used when identity
   * key pair was regenerated (new device, corrupted safeStorage).
   */
  safeHandle('team:refresh-my-key', async (_event, orgId: string) => {
    if (!isAuthenticated()) return { success: false, error: 'Not authenticated' };

    try {
      const orgJwt = await getOrgScopedJwt(orgId);

      // Ensure identity key pair exists and upload current public key
      await getOrCreateIdentityKeyPair();
      await uploadIdentityKeyToOrg(orgJwt);

      // Try to fetch and unwrap existing envelope (admin may have already re-shared)
      const key = await fetchAndUnwrapOrgKey(orgId, orgJwt);
      return { success: true, hasKey: key !== null };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

// ============================================================================
// Base64 Utilities
// ============================================================================

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.length < 1024) {
    return btoa(String.fromCharCode(...bytes));
  }
  let result = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
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
