/**
 * PersonalProjectSyncRoom wire protocol.
 *
 * Per-user project file sync: markdown content push, Yjs upgrade,
 * incremental Yjs updates, compaction, and deletes.
 */

// ============================================================================
// Client -> Server Messages
// ============================================================================

export type ProjectSyncClientMessage =
  | ProjectSyncRequestMessage
  | FileContentPushMessage
  | FileContentBatchPushMessage
  | FileDeleteMessage
  | FileYjsInitMessage
  | FileYjsUpdateMessage
  | FileYjsCompactMessage;

/** Initial sync: client sends manifest of what it has */
export interface ProjectSyncRequestMessage {
  type: 'projectSyncRequest';
  files: ProjectSyncManifestEntry[];
}

/** Entry in the client's sync manifest */
export interface ProjectSyncManifestEntry {
  syncId: string;
  contentHash: string;
  lastModifiedAt: number;
  hasYjs: boolean;
  yjsSeq: number;
}

/** Push file content (markdown phase) */
export interface FileContentPushMessage {
  type: 'fileContentPush';
  syncId: string;
  encryptedContent: string;
  contentIv: string;
  contentHash: string;
  encryptedPath: string;
  pathIv: string;
  encryptedTitle: string;
  titleIv: string;
  lastModifiedAt: number;
}

/** Batch push (for startup sync sweep) */
export interface FileContentBatchPushMessage {
  type: 'fileContentBatchPush';
  files: Omit<FileContentPushMessage, 'type'>[];
}

/** Delete a file */
export interface FileDeleteMessage {
  type: 'fileDelete';
  syncId: string;
}

/** Upgrade file from markdown to Yjs phase */
export interface FileYjsInitMessage {
  type: 'fileYjsInit';
  syncId: string;
  encryptedSnapshot: string;
  iv: string;
}

/** Send a Yjs update for a file in Yjs phase */
export interface FileYjsUpdateMessage {
  type: 'fileYjsUpdate';
  syncId: string;
  encryptedUpdate: string;
  iv: string;
}

/** Compact Yjs state for a file */
export interface FileYjsCompactMessage {
  type: 'fileYjsCompact';
  syncId: string;
  encryptedSnapshot: string;
  iv: string;
  replacesUpTo: number;
}

// ============================================================================
// Server -> Client Messages
// ============================================================================

export type ProjectSyncServerMessage =
  | ProjectSyncResponseMessage
  | FileContentBroadcastMessage
  | FileDeleteBroadcastMessage
  | FileYjsUpdateBroadcastMessage
  | FileYjsInitBroadcastMessage
  | ProjectSyncErrorMessage;

/** Response to projectSyncRequest */
export interface ProjectSyncResponseMessage {
  type: 'projectSyncResponse';
  updatedFiles: ProjectSyncFileEntry[];
  yjsUpdates: ProjectSyncYjsUpdate[];
  newFiles: ProjectSyncFileEntry[];
  needFromClient: string[];
  deletedSyncIds: string[];
}

/** File entry in sync response */
export interface ProjectSyncFileEntry {
  syncId: string;
  encryptedContent: string;
  contentIv: string;
  contentHash: string;
  encryptedPath: string;
  pathIv: string;
  encryptedTitle: string;
  titleIv: string;
  lastModifiedAt: number;
  hasYjs: boolean;
}

/** Yjs update entry in sync response */
export interface ProjectSyncYjsUpdate {
  syncId: string;
  encryptedUpdate: string;
  iv: string;
  sequence: number;
}

/** Broadcast when another device pushes content */
export interface FileContentBroadcastMessage {
  type: 'fileContentBroadcast';
  syncId: string;
  encryptedContent: string;
  contentIv: string;
  contentHash: string;
  encryptedPath: string;
  pathIv: string;
  encryptedTitle: string;
  titleIv: string;
  lastModifiedAt: number;
  fromConnectionId: string;
}

/** Broadcast Yjs update from another device */
export interface FileYjsUpdateBroadcastMessage {
  type: 'fileYjsUpdateBroadcast';
  syncId: string;
  encryptedUpdate: string;
  iv: string;
  sequence: number;
  fromConnectionId: string;
}

/** Broadcast file deletion */
export interface FileDeleteBroadcastMessage {
  type: 'fileDeleteBroadcast';
  syncId: string;
  fromConnectionId: string;
}

/** Broadcast Yjs init (file upgraded to Yjs phase) */
export interface FileYjsInitBroadcastMessage {
  type: 'fileYjsInitBroadcast';
  syncId: string;
  fromConnectionId: string;
}

/** PersonalProjectSyncRoom error response */
export interface ProjectSyncErrorMessage {
  type: 'error';
  code: string;
  message: string;
}
