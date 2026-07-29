/**
 * TeamDocumentRoom wire protocol.
 *
 * Yjs-based collaborative document editing. Update and snapshot payloads are
 * plaintext on the wire and encrypted at rest by the server under the
 * server-managed team DEK. Awareness state is plaintext over TLS as well --
 * it is never persisted, and the `iv` field on `docAwareness` is the retired
 * client-managed lane's empty sentinel, kept only for wire compatibility.
 */

// ============================================================================
// Client -> Server Messages
// ============================================================================

export type DocClientMessage =
  | DocSyncRequestMessage
  | DocUpdateMessage
  | DocCompactMessage
  | DocAwarenessMessage
  | DocSetMetadataMessage;

/** Request document updates since a sequence number */
export interface DocSyncRequestMessage {
  type: 'docSyncRequest';
  sinceSeq: number;
}

/** Send an encrypted Yjs update */
export interface DocUpdateMessage {
  type: 'docUpdate';
  encryptedUpdate: string;
  iv: string;
  clientUpdateId?: string;
}

/** Send an encrypted compacted state snapshot */
export interface DocCompactMessage {
  type: 'docCompact';
  encryptedState: string;
  iv: string;
  replacesUpTo: number;
  /** Correlates the server acknowledgement with this compaction attempt. */
  clientCompactId?: string;
}

/** Send encrypted awareness state (cursor, selection) */
export interface DocAwarenessMessage {
  type: 'docAwareness';
  encryptedState: string;
  iv: string;
}

/** Set room-level metadata (e.g., custom TTL). Only allowlisted keys are accepted. */
export interface DocSetMetadataMessage {
  type: 'docSetMetadata';
  entries: Record<string, string>;
}

// ============================================================================
// Server -> Client Messages
// ============================================================================

export type DocServerMessage =
  | DocSyncResponseMessage
  | DocUpdateBroadcastMessage
  | DocUpdateAckMessage
  | DocCompactAckMessage
  | DocAwarenessBroadcastMessage
  | DocRoomMovedMessage
  | DocErrorMessage;

/**
 * Sent when this document room has been relocated to another org by the move
 * engine (Epic H3 P1). The doc id is unchanged; only the org changes. The
 * client must re-resolve which org the document now belongs to and reconnect.
 */
export interface DocRoomMovedMessage {
  type: 'docRoomMoved';
  destOrgId: string;
}

/** Response to docSyncRequest with paginated encrypted updates */
export interface DocSyncResponseMessage {
  type: 'docSyncResponse';
  updates: EncryptedDocUpdate[];
  snapshot?: EncryptedDocSnapshot;
  hasMore: boolean;
  cursor: number;
  /**
   * Persisted sequence high-watermark for the room. Optional only for
   * compatibility with servers that predate the explicit head contract.
   */
  serverHead?: number;
  /**
   * Whether the room has ever accepted document state. This remains true when
   * compaction has pruned the transport update rows. Optional only for
   * compatibility with older servers.
   */
  serverHasState?: boolean;
  /**
   * The room-authed userId of whoever applied the most recent content update,
   * and when (server clock, ms). Plaintext metadata (the writer identity is not
   * secret to team members; the content stays encrypted). Used to tell a user
   * who/when last edited a shared doc before their push overwrites it. Null when
   * the document has no updates yet. Derived from the latest `encrypted_updates`
   * row, so it reflects the last *content* edit (not title/index changes).
   */
  lastWriterUserId?: string | null;
  lastUpdatedAt?: number | null;
}

/** Broadcast an encrypted Yjs update to other connections */
export interface DocUpdateBroadcastMessage {
  type: 'docUpdateBroadcast';
  encryptedUpdate: string;
  iv: string;
  senderId: string;
  sequence: number;
}

/** Acknowledge receipt of a client-originated update after it is persisted. */
export interface DocUpdateAckMessage {
  type: 'docUpdateAck';
  clientUpdateId: string;
  sequence: number;
}

/** Acknowledge a compaction only after its snapshot and pruning commit. */
export interface DocCompactAckMessage {
  type: 'docCompactAck';
  clientCompactId?: string;
  accepted: boolean;
  replacesUpTo: number;
  deduplicated?: boolean;
  error?: {
    code: string;
    message: string;
  };
}

/** Broadcast encrypted awareness state to other connections */
export interface DocAwarenessBroadcastMessage {
  type: 'docAwarenessBroadcast';
  encryptedState: string;
  iv: string;
  fromUserId: string;
}

/** TeamDocumentRoom error response */
export interface DocErrorMessage {
  type: 'error';
  code: string;
  message: string;
  /** Present when the error rejects a specific client-originated update. */
  clientUpdateId?: string;
}

// ============================================================================
// Data Types
// ============================================================================

/** Encrypted Yjs update as stored/transmitted */
export interface EncryptedDocUpdate {
  sequence: number;
  encryptedUpdate: string;
  iv: string;
  senderId: string;
  createdAt: number;
}

/** Encrypted compacted Y.Doc state snapshot */
export interface EncryptedDocSnapshot {
  encryptedState: string;
  iv: string;
  replacesUpTo: number;
  createdAt: number;
}
