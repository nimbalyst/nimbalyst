/**
 * PersonalProjectSyncRoom wire protocol.
 *
 * Per-user project file sync: markdown content push, Yjs upgrade,
 * incremental Yjs updates, compaction, and deletes.
 */

// ============================================================================
// Storage limits
// ============================================================================

/**
 * Cloudflare Durable Object SQLite rejects any single string, BLOB or row over
 * 2 MB (SQLITE_TOOBIG). A file row carries the encrypted content plus its
 * encrypted path/title, IVs, hash and id, so the budget below leaves headroom
 * for the columns the server adds. Client and server both check against it.
 */
export const PROJECT_SYNC_MAX_FILE_STORED_BYTES = 2 * 1024 * 1024 - 64 * 1024;

/** Base64 length of an AES-GCM ciphertext (plaintext + 16-byte tag). */
export function aesGcmBase64Length(plaintextBytes: number): number {
  return 4 * Math.ceil((plaintextBytes + 16) / 3);
}

/** Stored size of an encrypted file entry. Every field is base64/hex, so length is bytes. */
export function projectSyncFileStoredBytes(file: Omit<FileContentPushMessage, 'type' | 'lastModifiedAt'>): number {
  return file.syncId.length + file.encryptedContent.length + file.contentIv.length + file.contentHash.length
    + file.encryptedPath.length + file.pathIv.length + file.encryptedTitle.length + file.titleIv.length;
}

/**
 * Predicts {@link projectSyncFileStoredBytes} from plaintext sizes, so a client
 * can skip a file without encrypting it. IVs are 12 bytes (16 base64 chars),
 * the hash is SHA-256 hex and the syncId is a SHA-256 hex digest.
 */
export function projectSyncEstimatedStoredBytes(sizes: { contentBytes: number; pathBytes: number; titleBytes: number; syncIdLength: number }): number {
  return sizes.syncIdLength + 64 + 3 * 16
    + aesGcmBase64Length(sizes.contentBytes) + aesGcmBase64Length(sizes.pathBytes) + aesGcmBase64Length(sizes.titleBytes);
}

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
  /**
   * syncIds whose last push got no ack (the socket dropped or the ack timed
   * out). A server that acks pushes answers with `pushConfirmations`.
   */
  confirm?: string[];
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
  /** Echoed in the {@link FileContentPushAckMessage}. Absent from older clients. */
  requestId?: string;
}

/** Batch push (for startup sync sweep) */
export interface FileContentBatchPushMessage {
  type: 'fileContentBatchPush';
  files: Omit<FileContentPushMessage, 'type' | 'requestId'>[];
  /** Echoed in the {@link FileContentPushAckMessage}. Absent from older clients. */
  requestId?: string;
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
  | FileContentPushAckMessage
  | ProjectSyncErrorMessage;

/** Response to projectSyncRequest */
export interface ProjectSyncResponseMessage {
  type: 'projectSyncResponse';
  /** Absent together on legacy single-response servers. */
  transferId?: string;
  batchIndex?: number;
  isLastBatch?: boolean;
  /**
   * Set by servers that answer every content push with a
   * {@link FileContentPushAckMessage}. Servers that predate the ack omit it and
   * store what they receive without answering.
   */
  pushAck?: boolean;
  /**
   * The content hash the server holds for each syncId in the request's
   * `confirm`, or null when it holds no row. Present only when `confirm` was.
   */
  pushConfirmations?: ProjectSyncPushConfirmation[];
  updatedFiles: ProjectSyncFileEntry[];
  yjsUpdates: ProjectSyncYjsUpdate[];
  newFiles: ProjectSyncFileEntry[];
  needFromClient: string[];
  deletedSyncIds: string[];
}

/** What the server holds for a file whose push went unanswered. */
export interface ProjectSyncPushConfirmation {
  syncId: string;
  contentHash: string | null;
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

/** Why the server did not store one file of a push. */
export interface ProjectSyncFileRejection {
  syncId: string;
  code: 'file_too_large' | 'store_failed';
  message: string;
}

/**
 * Sent to the pushing connection only, after every fileContentPush and
 * fileContentBatchPush, once the server has persisted what it could. A file is
 * stored only if its syncId is in `stored`.
 */
export interface FileContentPushAckMessage {
  type: 'fileContentPushAck';
  requestId?: string;
  stored: string[];
  rejected: ProjectSyncFileRejection[];
}

/** PersonalProjectSyncRoom error response */
export interface ProjectSyncErrorMessage {
  type: 'error';
  code: string;
  message: string;
  /** Set when the error concerns one file (e.g. `file_too_large` on a Yjs snapshot). */
  syncId?: string;
}
