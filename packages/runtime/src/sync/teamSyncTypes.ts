/**
 * Types for TeamSync -- client-side team state sync layer.
 *
 * Wire-protocol message shapes come from `@nimbalyst/collab-protocol` and
 * are shared with the sync server. This file adds the client-side config
 * surface (callbacks, status) and the decrypted projections (`TeamState`,
 * `DocIndexEntry`) that the renderer consumes.
 */

import type {
  MemberInfo as ProtocolMemberInfo,
  TeamState as ProtocolTeamState,
  EncryptedDocIndexEntry as ProtocolEncryptedDocIndexEntry,
} from '@nimbalyst/collab-protocol';

export type {
  TeamClientMessage,
  TeamServerMessage,
  TeamSyncResponseMessage,
  TeamMemberAddedMessage,
  TeamMemberRemovedMessage,
  TeamMemberRoleChangedMessage,
  TeamKeyEnvelopeAvailableMessage,
  TeamKeyEnvelopeMessage,
  TeamIdentityKeyResponseMessage,
  TeamIdentityKeyUploadedMessage,
  TeamDocIndexSyncResponseMessage,
  TeamDocIndexBroadcastMessage,
  TeamDocIndexRemoveBroadcastMessage,
  TeamOrgKeyRotatedMessage,
  TeamErrorMessage,
} from '@nimbalyst/collab-protocol';

/** Re-export wire types under client-side names. */
export type MemberInfo = ProtocolMemberInfo;
export type EncryptedDocIndexEntry = ProtocolEncryptedDocIndexEntry;
/** Wire-format team state (encrypted document titles, sent by server). */
export type ServerTeamState = ProtocolTeamState;

// ============================================================================
// Configuration
// ============================================================================

export interface TeamSyncConfig {
  /** WebSocket server URL (e.g., wss://sync.nimbalyst.com) */
  serverUrl: string;

  /** Function to get fresh JWT for WebSocket auth */
  getJwt: () => Promise<string>;

  /** B2B organization ID */
  orgId: string;

  /** Current user's ID */
  userId: string;

  /** AES-256-GCM key for encrypting/decrypting document titles (org key) */
  encryptionKey: CryptoKey;

  /**
   * Fingerprint of the current org key (`SHA-256(rawKey).slice(0,32)`),
   * attached to every doc-index write so the server can enforce key-epoch
   * alignment during rotation. May be `null` while the host adapter is
   * still bootstrapping; once set, writes that don't match the server's
   * current fingerprint are rejected with `staleKeyEpoch`.
   */
  orgKeyFingerprint: string | null;

  /** Called when full team state snapshot is received (initial sync) */
  onTeamStateLoaded?: (state: TeamState) => void;

  /** Called when a member is added */
  onMemberAdded?: (member: MemberInfo) => void;

  /** Called when a member is removed */
  onMemberRemoved?: (userId: string) => void;

  /** Called when a member's role changes */
  onMemberRoleChanged?: (userId: string, role: string) => void;

  /** Called when a key envelope becomes available for the current user */
  onKeyEnvelopeAvailable?: (targetUserId: string) => void;

  /** Called when a key envelope is delivered */
  onKeyEnvelope?: (envelope: KeyEnvelopeData) => void;

  /** Called when a member uploads their identity key (so admin can wrap for them) */
  onIdentityKeyUploaded?: (userId: string) => void;

  /** Called when the full document list is loaded (from teamSync or docIndexSync) */
  onDocumentsLoaded?: (documents: DocIndexEntry[]) => void;

  /** Called when a document is added or updated */
  onDocumentChanged?: (document: DocIndexEntry) => void;

  /** Called when a document is removed */
  onDocumentRemoved?: (documentId: string) => void;

  /** Called when the org encryption key is rotated (fingerprint changed) */
  onOrgKeyRotated?: (fingerprint: string) => void;

  /** Called when connection status changes */
  onStatusChange?: (status: TeamSyncStatus) => void;

  /**
   * Override the WebSocket URL construction.
   * Useful for integration tests with auth bypass.
   */
  buildUrl?: (roomId: string) => string;
}

// ============================================================================
// Status
// ============================================================================

export type TeamSyncStatus =
  | 'disconnected'
  | 'connecting'
  | 'syncing'
  | 'connected'
  | 'error';

// ============================================================================
// Decrypted team state (client-side projection)
// ============================================================================

export interface TeamState {
  metadata: {
    orgId: string;
    name: string;
    gitRemoteHash: string | null;
    /**
     * Server-minted UUID that names this team's tracker room
     * (tracker-sync-redesign D8 / NIM-404). May be null when reading
     * snapshots persisted before the migration ran on the server.
     */
    teamProjectId: string | null;
    createdBy: string;
    createdAt: number;
  } | null;
  members: MemberInfo[];
  documents: DocIndexEntry[];
  keyEnvelope?: KeyEnvelopeData | null;
}

export interface KeyEnvelopeData {
  wrappedKey: string;
  iv: string;
  senderPublicKey: string;
}

/** Decrypted document index entry for UI consumption */
export interface DocIndexEntry {
  documentId: string;
  title: string;
  documentType: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}
