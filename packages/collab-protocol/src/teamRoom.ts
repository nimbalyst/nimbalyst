/**
 * TeamRoom wire protocol.
 *
 * Consolidated team state: members, roles, and the shared document index.
 * Team content is encrypted at rest under the server-managed team DEK; there
 * is no client-held org key, so no envelope or identity-key traffic.
 */

import type {
  BoundedPreview,
  ConversationDescriptor,
} from './conversation.js';
import type { FeedbackRequestIndexEntry } from './feedbackRequest.js';

export interface OrgSettings {
  version: 1;
  messaging: {
    roomsEnabled: boolean;
    dmsEnabled: boolean;
    roomCreation: 'members' | 'admins';
  };
}

// ============================================================================
// Client -> Server Messages
// ============================================================================

export type TeamClientMessage =
  | TeamSyncRequestMessage
  | FeedbackIndexSyncRequestMessage
  | TeamDocumentCommentNotifyMessage
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
  | TeamFolderRemoveMessage;

/** Request full team state snapshot */
export interface TeamSyncRequestMessage {
  type: 'teamSync';
}

/** Request the participant-filtered feedback-request index. */
export interface FeedbackIndexSyncRequestMessage {
  type: 'feedbackIndexSync';
}

/** Request the full document list */
export interface TeamDocIndexSyncRequestMessage {
  type: 'docIndexSync';
}

/** Register a new shared document in the index. */
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
}

/** Update a document's encrypted title. */
export interface TeamDocIndexUpdateMessage {
  type: 'docIndexUpdate';
  documentId: string;
  encryptedTitle: string;
  titleIv: string;
}

/** Remove a document from the index. */
export interface TeamDocIndexRemoveMessage {
  type: 'docIndexRemove';
  documentId: string;
}

/** Move a document into recoverable Trash without changing its folder. */
export interface TeamDocTrashMessage {
  type: 'docTrash';
  documentId: string;
  /** Millisecond epoch used to calculate the retention deadline. */
  trashedAt: number;
}

/** Restore a trashed document to its unchanged parent folder. */
export interface TeamDocRestoreMessage {
  type: 'docRestore';
  documentId: string;
}

/**
 * Reparent a document into a different folder (first-class folders). Null
 * `newParentFolderId` = move to root. Touches only the doc's `parent_folder_id`,
 * never its content, so local-to-shared links stay intact.
 */
export interface TeamDocMoveMessage {
  type: 'docMove';
  documentId: string;
  newParentFolderId: string | null;
}

/** Request the full folder list (first-class folders). */
export interface TeamFolderIndexSyncRequestMessage {
  type: 'folderIndexSync';
}

/**
 * Register a new folder node. `parentFolderId` null = root level. The folder
 * name is encrypted at rest the same way document titles are.
 */
export interface TeamFolderRegisterMessage {
  type: 'folderRegister';
  folderId: string;
  parentFolderId?: string | null;
  encryptedName: string;
  nameIv: string;
  sortOrder: number;
  projectId?: string | null;
}

/** Rename a folder in place (single-row update of `encryptedName`). */
export interface TeamFolderRenameMessage {
  type: 'folderRename';
  folderId: string;
  encryptedName: string;
  nameIv: string;
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
}

/**
 * Delete a folder recursively — the folder, all descendant folders, and every
 * document in that subtree. The server cascades a delete to each affected
 * DocumentRoom and broadcasts the removed id sets.
 */
export interface TeamFolderRemoveMessage {
  type: 'folderRemove';
  folderId: string;
}

/**
 * Announce that a document comment mentioned members or replied to one, so the
 * server can route org-scoped inbox deliveries for it.
 *
 * Document comments live in the document's Y.Doc rather than a ConversationRoom,
 * so this is the only producer for that lane. Nothing here is trusted as
 * identity: the server derives the actor from the connection's team JWT,
 * re-resolves every recipient's capability, and re-truncates `preview`. The
 * client only names the source, the reason, and who it believes was addressed.
 *
 * Delivery is idempotent per `(recipient, commentId)`, so a client that
 * re-sends after a reconnect does not duplicate anyone's inbox row.
 */
export interface TeamDocumentCommentNotifyMessage {
  type: 'documentCommentNotify';
  documentId: string;
  /** Id of the comment that caused the notification. */
  commentId: string;
  /** Thread the comment belongs to, when it is a threaded reply. */
  threadId?: string;
  reason: 'mention' | 'reply';
  /** Recipients the client believes were addressed; never includes the author. */
  recipientUserIds: string[];
  /** Display-only copy. Never authoritative and always re-bounded server-side. */
  preview?: BoundedPreview;
}

// ============================================================================
// Server -> Client Messages
// ============================================================================

export type TeamServerMessage =
  | TeamSyncResponseMessage
  | FeedbackIndexSyncResponseMessage
  | FeedbackIndexBroadcastMessage
  | TeamOrgSettingsUpdatedMessage
  | TeamConversationDescriptorUpdatedMessage
  | TeamMemberAddedMessage
  | TeamMemberRemovedMessage
  | TeamMemberRoleChangedMessage
  | TeamDocIndexSyncResponseMessage
  | TeamDocIndexRegisteredMessage
  | TeamDocIndexBroadcastMessage
  | TeamDocIndexRemoveBroadcastMessage
  | TeamFolderIndexSyncResponseMessage
  | TeamFolderBroadcastMessage
  | TeamFolderRemoveBroadcastMessage
  | TeamProjectAccessChangedMessage
  | TeamDocumentCommentNotifyAckMessage
  | TeamErrorMessage;

/** Full team state snapshot */
export interface TeamSyncResponseMessage {
  type: 'teamSyncResponse';
  team: TeamState;
}

/** Full feedback index visible to this team-scoped viewer. */
export interface FeedbackIndexSyncResponseMessage {
  type: 'feedbackIndexSyncResponse';
  entries: FeedbackRequestIndexEntry[];
}

/** One participant-filtered feedback index upsert. */
export interface FeedbackIndexBroadcastMessage {
  type: 'feedbackIndexBroadcast';
  entry: FeedbackRequestIndexEntry;
}

/** Broadcast: organization settings changed. */
export interface TeamOrgSettingsUpdatedMessage {
  type: 'orgSettingsUpdated';
  settings: OrgSettings;
}

/** Broadcast: a conversation registry descriptor changed. */
export interface TeamConversationDescriptorUpdatedMessage {
  type: 'conversationDescriptorUpdated';
  descriptor: ConversationDescriptor;
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

/**
 * Ack: this socket's `docIndexRegister` is committed to `document_index`.
 *
 * Sent only to the registering socket (the index broadcast deliberately
 * excludes it, so registration was otherwise unobservable to its author).
 * A client that is about to write into the new document's room must wait for
 * this: `DocumentRoom` binds the id through `document_index` and 404s an id
 * that isn't there yet, so seeding before the ack is a race (NIM-2472).
 */
export interface TeamDocIndexRegisteredMessage {
  type: 'docIndexRegistered';
  documentId: string;
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

/**
 * Answers `documentCommentNotify`. Sent only to the requesting connection.
 *
 * `suppressedUserIds` covers every recipient the server declined — not an org
 * member, no `receiveNotification` capability, or muted — without saying which,
 * so a sender cannot probe another member's notification settings.
 */
export interface TeamDocumentCommentNotifyAckMessage {
  type: 'documentCommentNotifyAck';
  documentId: string;
  commentId: string;
  deliveredUserIds: string[];
  suppressedUserIds: string[];
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
  } | null;
  members: MemberInfo[];
  documents: EncryptedDocIndexEntry[];
  /** First-class folder nodes (omitted by pre-folders servers). */
  folders?: EncryptedFolderNode[];
  /** Organization configuration (omitted by pre-settings servers). */
  settings?: OrgSettings;
}

/** Information about a team member */
export interface MemberInfo {
  userId: string;
  role: string;
  email: string | null;
  name?: string | null;
  /**
   * The member's personal org id, recorded at team create / invite acceptance.
   * Informational roster data; nothing routes on it any more.
   */
  personalOrgId?: string | null;
}
