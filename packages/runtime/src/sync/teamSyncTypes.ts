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
  EncryptedFolderNode as ProtocolEncryptedFolderNode,
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
  TeamFolderIndexSyncResponseMessage,
  TeamFolderBroadcastMessage,
  TeamFolderRemoveBroadcastMessage,
  TeamOrgKeyRotatedMessage,
  TeamProjectAccessChangedMessage,
  TeamErrorMessage,
} from '@nimbalyst/collab-protocol';

/** Re-export wire types under client-side names. */
export type MemberInfo = ProtocolMemberInfo;
export type EncryptedDocIndexEntry = ProtocolEncryptedDocIndexEntry;
export type EncryptedFolderNode = ProtocolEncryptedFolderNode;
/** Wire-format team state (encrypted document titles, sent by server). */
export type ServerTeamState = ProtocolTeamState;

// ============================================================================
// Configuration
// ============================================================================

export interface TeamSyncConfig {
  /** WebSocket server URL (e.g., wss://sync.nimbalyst.com) */
  serverUrl: string;

  /** Optional host WebSocket factory (Electron main and other non-DOM hosts). */
  createWebSocket?: (url: string) => WebSocket;

  /** Function to get fresh JWT for WebSocket auth */
  getJwt: () => Promise<string>;

  /** B2B organization ID */
  orgId: string;

  /**
   * Epic H3 P0/A: the active project's tracker-room routing key. Document rooms
   * are org-scoped (`org:{orgId}:doc:{docId}`), but the doc INDEX is now
   * project-partitioned on the server, so each `docIndexRegister` carries this
   * `projectId` to attribute the doc to its project. `null` (or absent) tags the
   * doc to the org's primary project (legacy behavior).
   */
  teamProjectId?: string | null;

  /** Current user's ID */
  userId: string;

  /**
   * Current user's PERSONAL org id. When set, it is announced to the TeamRoom
   * on every (re)connect via `announcePersonalOrg`, so the server can address
   * this member's PersonalIndexRoom for inbox-event fanout. Omitted when the
   * personal org id is not yet resolvable locally (e.g. mobile sync disabled).
   */
  personalOrgId?: string;

  /**
   * Epic H2 key custody. `legacy-e2e` (default): the client encrypts/decrypts
   * doc-index titles with the org key (zero-knowledge). `server-managed`: the
   * server holds the per-team DEK and encrypts titles at rest, so the client
   * sends/receives PLAINTEXT titles and `encryptionKey` is unused.
   */
  keyCustody?: 'legacy-e2e' | 'server-managed';

  /**
   * AES-256-GCM key for encrypting/decrypting document titles (org key).
   * Required in `legacy-e2e` mode; unused (and optional) in `server-managed`.
   */
  encryptionKey?: CryptoKey;

  /**
   * NIM-906/910: retained legacy org keys, used ONLY in `server-managed` mode to
   * read PRE-MIGRATION doc-index titles. Titles registered before the team
   * flipped to server-managed are still AES ciphertext — the TeamRoom passes
   * them through unchanged with their original (non-empty) iv, since the server
   * never held the zero-knowledge org key and so cannot re-key them.
   *
   * This is an ARRAY because the org key may have been ROTATED while the team
   * was still legacy-e2e, so different titles can be encrypted under different
   * org-key EPOCHS (current + archived). We try each candidate key until one
   * decrypts; only when ALL fail do we surface the row as `decryptFailed`
   * (locked) instead of raw base64. A client holding the right epoch can also
   * re-register the recovered title as plaintext via `backfillLegacyTitles()`.
   */
  legacyOrgKeys?: CryptoKey[];

  /**
   * Disable the provider's fire-and-forget title repair when a host needs to
   * await and verify the backfill explicitly (for migration finalization).
   */
  autoBackfillLegacyTitles?: boolean;

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

  /** Called when the full folder list is loaded (from teamSync or folderIndexSync) */
  onFoldersLoaded?: (folders: FolderNode[]) => void;

  /** Called when a folder is registered, renamed, or moved */
  onFolderChanged?: (folder: FolderNode) => void;

  /**
   * Called when a folder subtree is removed. Carries every folder id and
   * document id that was deleted so the host can prune its tree and links.
   */
  onFoldersRemoved?: (folderIds: string[], documentIds: string[]) => void;

  /** Called when the org encryption key is rotated (fingerprint changed) */
  onOrgKeyRotated?: (fingerprint: string) => void;

  /**
   * Called when a member's project-scoped access changed (Epic H1). `projectRole`
   * is the new role, or `null` when access was revoked. The host writes this
   * through to the local org/project projection so `canAccess` stays live.
   */
  onProjectAccessChanged?: (projectId: string, userId: string, projectRole: string | null) => void;

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
  folders: FolderNode[];
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
  /** Optional V2 type metadata; absent on legacy rows. */
  metadataVersion?: 2;
  /** Exact normalized suffix, including the leading dot. */
  fileExtension?: string;
  /** Stable owning editor id (built-in or extension id). */
  editorId?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /**
   * User id of whoever most recently changed this document (title OR content).
   * Lets the sidebar's unread indicator suppress the user's own edits without
   * opening the doc. Null/undefined for legacy rows.
   */
  lastWriterUserId?: string | null;
  /**
   * First-class folders: the folder this document lives in. Null/undefined =
   * root level (also legacy rows, whose path still lives in the title).
   */
  parentFolderId?: string | null;
  /** Millisecond epoch when moved to Trash; null/undefined means active. */
  trashedAt?: number | null;
  /**
   * True when the server returned a doc index entry whose encrypted title
   * could not be decrypted with the current org key. Preserved in the list
   * so the user can see something exists rather than the entry vanishing
   * silently; the UI should render it as locked / non-interactive.
   */
  decryptFailed?: boolean;
}

/** Explicit type metadata written by V2 shared-document creators. */
export interface SharedDocumentTypeMetadataV2 {
  metadataVersion: 2;
  /** Exact normalized suffix, including the leading dot. */
  fileExtension: string;
  /** Stable owning editor id (built-in or extension id). */
  editorId: string;
}

/** Decrypted folder node for UI consumption (first-class folders). */
export interface FolderNode {
  folderId: string;
  /** Null = root level. */
  parentFolderId?: string | null;
  name: string;
  sortOrder: number;
  projectId?: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** True when the folder name could not be decrypted (render as locked). */
  decryptFailed?: boolean;
}
