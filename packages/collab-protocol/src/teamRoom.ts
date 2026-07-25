/**
 * TeamRoom wire protocol.
 *
 * Consolidated team state: members, roles, identity keys, key envelopes,
 * shared document index, and org key rotation broadcasts.
 */

import type {
  AnnouncePersonalOrgMessage,
  InboxEventFanoutMessage,
  InboxEventFanoutAckMessage,
} from './inbox.js';

// ============================================================================
// Client -> Server Messages
// ============================================================================

export type TeamClientMessage =
  | TeamSyncRequestMessage
  | TeamUploadIdentityKeyMessage
  | TeamRequestIdentityKeyMessage
  | TeamRequestKeyEnvelopeMessage
  | TeamDocIndexSyncRequestMessage
  | TeamDocIndexRegisterMessage
  | TeamDocIndexUpdateMessage
  | TeamDocIndexRemoveMessage
  | TeamDocTrashMessage
  | TeamDocRestoreMessage
  | TeamDocMoveMessage
  | TeamFolderIndexSyncRequestMessage
  | TeamFolderRegisterMessage
  | TeamFolderRenameMessage
  | TeamFolderMoveMessage
  | TeamFolderRemoveMessage
  | AnnouncePersonalOrgMessage
  | InboxEventFanoutMessage;

/** Request full team state snapshot */
export interface TeamSyncRequestMessage {
  type: 'teamSync';
}

/** Upload own ECDH public key */
export interface TeamUploadIdentityKeyMessage {
  type: 'uploadIdentityKey';
  publicKeyJwk: string;
}

/** Fetch a member's public key */
export interface TeamRequestIdentityKeyMessage {
  type: 'requestIdentityKey';
  targetUserId: string;
}

/** Request own key envelope */
export interface TeamRequestKeyEnvelopeMessage {
  type: 'requestKeyEnvelope';
}

/** Request the full document list */
export interface TeamDocIndexSyncRequestMessage {
  type: 'docIndexSync';
}

/**
 * Register a new shared document in the index.
 *
 * `orgKeyFingerprint` echoes the client's current org key fingerprint so the
 * server can enforce epoch alignment during rotation (see
 * `TeamRoom.validateDocIndexWriteAllowed`). Optional in the type to keep the
 * Yjs-only document path lightweight, but the server rejects writes with
 * `staleKeyEpoch` once `current_org_key_fingerprint` is set.
 */
export interface TeamDocIndexRegisterMessage {
  type: 'docIndexRegister';
  documentId: string;
  encryptedTitle: string;
  titleIv: string;
  documentType: string;
  /** Marks entries carrying explicit shared-document type metadata. */
  metadataVersion?: 2;
  /** Exact normalized suffix, including its leading dot. */
  fileExtension?: string;
  /** Stable id of the editor that owns this document type. */
  editorId?: string;
  /**
   * Epic H3 P0: the project this document belongs to (the tracker-room routing
   * `teamProjectId`). Optional for backward compatibility — when omitted the
   * server tags the doc with the org's primary project. Lets a project move
   * answer "which docs travel with this project."
   */
  projectId?: string | null;
  /**
   * First-class folders: the folder this document lives in. Null/omitted = root
   * level. During the dual-write transition new clients also encode the folder
   * path into `encryptedTitle` so un-upgraded clients still render the tree.
   */
  parentFolderId?: string | null;
  orgKeyFingerprint?: string | null;
}

/** Update a document's encrypted title. See `TeamDocIndexRegisterMessage` for `orgKeyFingerprint`. */
export interface TeamDocIndexUpdateMessage {
  type: 'docIndexUpdate';
  documentId: string;
  encryptedTitle: string;
  titleIv: string;
  orgKeyFingerprint?: string | null;
}

/** Remove a document from the index. See `TeamDocIndexRegisterMessage` for `orgKeyFingerprint`. */
export interface TeamDocIndexRemoveMessage {
  type: 'docIndexRemove';
  documentId: string;
  orgKeyFingerprint?: string | null;
}

/** Move a document into recoverable Trash without changing its folder. */
export interface TeamDocTrashMessage {
  type: 'docTrash';
  documentId: string;
  /** Millisecond epoch used to calculate the retention deadline. */
  trashedAt: number;
  orgKeyFingerprint?: string | null;
}

/** Restore a trashed document to its unchanged parent folder. */
export interface TeamDocRestoreMessage {
  type: 'docRestore';
  documentId: string;
  orgKeyFingerprint?: string | null;
}

/**
 * Reparent a document into a different folder (first-class folders). Null
 * `newParentFolderId` = move to root. Touches only the doc's `parent_folder_id`,
 * never its content, so local-to-shared links stay intact. See
 * `TeamDocIndexRegisterMessage` for `orgKeyFingerprint`.
 */
export interface TeamDocMoveMessage {
  type: 'docMove';
  documentId: string;
  newParentFolderId: string | null;
  orgKeyFingerprint?: string | null;
}

/** Request the full folder list (first-class folders). */
export interface TeamFolderIndexSyncRequestMessage {
  type: 'folderIndexSync';
}

/**
 * Register a new folder node. `parentFolderId` null = root level. The folder
 * name is encrypted the same way document titles are (`orgKeyFingerprint`
 * echoes the epoch for rotation gating). See `TeamDocIndexRegisterMessage`.
 */
export interface TeamFolderRegisterMessage {
  type: 'folderRegister';
  folderId: string;
  parentFolderId?: string | null;
  encryptedName: string;
  nameIv: string;
  sortOrder: number;
  projectId?: string | null;
  orgKeyFingerprint?: string | null;
}

/** Rename a folder in place (single-row update of `encryptedName`). */
export interface TeamFolderRenameMessage {
  type: 'folderRename';
  folderId: string;
  encryptedName: string;
  nameIv: string;
  orgKeyFingerprint?: string | null;
}

/**
 * Move a folder to a new parent (single-row update of `parentFolderId`). The
 * server rejects cycles (a folder cannot move under its own descendant). Null
 * `newParentFolderId` = move to root.
 */
export interface TeamFolderMoveMessage {
  type: 'folderMove';
  folderId: string;
  newParentFolderId: string | null;
  sortOrder?: number;
  orgKeyFingerprint?: string | null;
}

/**
 * Delete a folder recursively — the folder, all descendant folders, and every
 * document in that subtree. The server cascades a delete to each affected
 * DocumentRoom and broadcasts the removed id sets.
 */
export interface TeamFolderRemoveMessage {
  type: 'folderRemove';
  folderId: string;
  orgKeyFingerprint?: string | null;
}

// ============================================================================
// Server -> Client Messages
// ============================================================================

export type TeamServerMessage =
  | TeamSyncResponseMessage
  | TeamMemberAddedMessage
  | TeamMemberRemovedMessage
  | TeamMemberRoleChangedMessage
  | TeamKeyEnvelopeAvailableMessage
  | TeamKeyEnvelopeMessage
  | TeamIdentityKeyResponseMessage
  | TeamIdentityKeyUploadedMessage
  | TeamDocIndexSyncResponseMessage
  | TeamDocIndexBroadcastMessage
  | TeamDocIndexRemoveBroadcastMessage
  | TeamFolderIndexSyncResponseMessage
  | TeamFolderBroadcastMessage
  | TeamFolderRemoveBroadcastMessage
  | TeamOrgKeyRotatedMessage
  | TeamProjectAccessChangedMessage
  | InboxEventFanoutAckMessage
  | TeamErrorMessage;

/** Full team state snapshot */
export interface TeamSyncResponseMessage {
  type: 'teamSyncResponse';
  team: TeamState;
}

/** Broadcast: member added */
export interface TeamMemberAddedMessage {
  type: 'memberAdded';
  member: MemberInfo;
}

/** Broadcast: member removed */
export interface TeamMemberRemovedMessage {
  type: 'memberRemoved';
  userId: string;
}

/** Broadcast: member role changed */
export interface TeamMemberRoleChangedMessage {
  type: 'memberRoleChanged';
  userId: string;
  role: string;
}

/** Push notification: a key envelope is now available for target user */
export interface TeamKeyEnvelopeAvailableMessage {
  type: 'keyEnvelopeAvailable';
  targetUserId: string;
}

/** Delivery of a key envelope to the requesting user */
export interface TeamKeyEnvelopeMessage {
  type: 'keyEnvelope';
  wrappedKey: string;
  iv: string;
  senderPublicKey: string;
  /** User ID of the user who created this envelope */
  senderUserId: string;
}

/** Response with a peer's public key */
export interface TeamIdentityKeyResponseMessage {
  type: 'identityKeyResponse';
  userId: string;
  publicKeyJwk: string;
}

/** Broadcast: a member uploaded their identity key (so others can wrap for them) */
export interface TeamIdentityKeyUploadedMessage {
  type: 'identityKeyUploaded';
  userId: string;
}

/** Broadcast: the org encryption key was rotated (fingerprint changed) */
export interface TeamOrgKeyRotatedMessage {
  type: 'orgKeyRotated';
  fingerprint: string;
}

/**
 * Broadcast: a member's project-scoped access changed (Epic H1).
 *
 * Emitted by the TeamRoom when a project_access grant is created, updated, or
 * revoked (via the admin REST mutations or the one-time backfill). Lets every
 * connected member keep its local org/project projection live without polling.
 * `projectRole` is the new role, or `null` when access was revoked.
 */
export interface TeamProjectAccessChangedMessage {
  type: 'projectAccessChanged';
  projectId: string;
  userId: string;
  projectRole: string | null;
}

/** Full document list response */
export interface TeamDocIndexSyncResponseMessage {
  type: 'docIndexSyncResponse';
  documents: EncryptedDocIndexEntry[];
}

/** Broadcast: document registered or updated */
export interface TeamDocIndexBroadcastMessage {
  type: 'docIndexBroadcast';
  document: EncryptedDocIndexEntry;
}

/** Broadcast: document removed */
export interface TeamDocIndexRemoveBroadcastMessage {
  type: 'docIndexRemoveBroadcast';
  documentId: string;
}

/** Full folder list response (first-class folders). */
export interface TeamFolderIndexSyncResponseMessage {
  type: 'folderIndexSyncResponse';
  folders: EncryptedFolderNode[];
}

/** Broadcast: folder registered, renamed, or moved (single upserted node). */
export interface TeamFolderBroadcastMessage {
  type: 'folderBroadcast';
  folder: EncryptedFolderNode;
}

/**
 * Broadcast: a folder subtree was removed. Carries the full set of folder ids
 * and document ids that were deleted so every client can prune its local tree
 * and links in one pass.
 */
export interface TeamFolderRemoveBroadcastMessage {
  type: 'folderRemoveBroadcast';
  folderIds: string[];
  documentIds: string[];
}

/** TeamRoom error response */
export interface TeamErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

// ============================================================================
// Data Types
// ============================================================================

/** Encrypted document index entry as stored/transmitted */
export interface EncryptedDocIndexEntry {
  documentId: string;
  encryptedTitle: string;
  titleIv: string;
  documentType: string;
  /** Marks entries carrying explicit shared-document type metadata. */
  metadataVersion?: 2;
  /** Exact normalized suffix, including its leading dot. */
  fileExtension?: string;
  /** Stable id of the editor that owns this document type. */
  editorId?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Epic H3 P0: the project this document belongs to (tracker-room routing
   * `teamProjectId`). Null for legacy/pre-H3 rows (treated as the org's
   * primary project at read time).
   */
  projectId?: string | null;
  /**
   * User id of whoever most recently changed this document (title OR content).
   * Drives the doc-list "unread" indicator's self-edit suppression without
   * opening the doc. Null for legacy rows / never-written index entries.
   */
  lastWriterUserId?: string | null;
  /**
   * First-class folders: the folder this document lives in. Null = root level
   * (also the value for legacy rows, whose structure still lives in the title
   * during the dual-write transition).
   */
  parentFolderId?: string | null;
  /** Millisecond epoch when moved to Trash; null/undefined means active. */
  trashedAt?: number | null;
}

/**
 * Encrypted folder node as stored/transmitted (first-class folders).
 *
 * A folder is a real synced entity with a stable `folderId`, so move/rename are
 * single-row updates and every local-to-shared link stays intact when content
 * is reorganized. The name is encrypted with the org key (or team DEK in
 * server-managed mode) — same visibility model as document titles.
 */
export interface EncryptedFolderNode {
  folderId: string;
  /** Null = root level. */
  parentFolderId?: string | null;
  encryptedName: string;
  nameIv: string;
  sortOrder: number;
  /** Mirrors `document_index.project_id` partitioning. */
  projectId?: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** Full team state snapshot sent on teamSync */
export interface TeamState {
  metadata: {
    orgId: string;
    name: string;
    gitRemoteHash: string | null;
    /**
     * Server-minted UUID that names this team's tracker room
     * (`org:{orgId}:tracker:{teamProjectId}`). Stable across team
     * lifetime; never derived from mutable inputs. Backfilled to null
     * for pre-D8 teams until they reconnect to a TeamRoom that has the
     * migration applied. Tracker-sync-redesign D8 / NIM-404.
     */
    teamProjectId: string | null;
    createdBy: string;
    createdAt: number;
    /** Server-authoritative fingerprint of the current org encryption key */
    currentOrgKeyFingerprint?: string | null;
  } | null;
  members: MemberInfo[];
  documents: EncryptedDocIndexEntry[];
  /** First-class folder nodes (omitted by pre-folders servers). */
  folders?: EncryptedFolderNode[];
  /** Caller's own key envelope (if exists) */
  keyEnvelope?: {
    wrappedKey: string;
    iv: string;
    senderPublicKey: string;
    senderUserId?: string;
  } | null;
}

/** Information about a team member */
export interface MemberInfo {
  userId: string;
  role: string;
  email: string | null;
  hasKeyEnvelope: boolean;
  hasIdentityKey: boolean;
  /**
   * The member's personal org id, used to address their PersonalIndexRoom
   * (`org:{personalOrgId}:user:{userId}:index`) for inbox-event fanout.
   * Recorded authoritatively at team create/invite acceptance. Older members
   * may be repaired once by `announcePersonalOrg` when this value is null.
   */
  personalOrgId?: string | null;
}
