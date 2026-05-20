/**
 * TeamDocumentRoom wire protocol.
 *
 * Yjs-based collaborative document editing with E2E encrypted updates,
 * awareness state, and ECDH key envelope exchange.
 */

// ============================================================================
// Client -> Server Messages
// ============================================================================

export type DocClientMessage =
  | DocSyncRequestMessage
  | DocUpdateMessage
  | DocCompactMessage
  | DocAwarenessMessage
  | AddKeyEnvelopeMessage
  | RequestKeyEnvelopeMessage
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
  /** Org key fingerprint for epoch enforcement. Server rejects stale-key writes. */
  orgKeyFingerprint?: string;
}

/** Send an encrypted compacted state snapshot */
export interface DocCompactMessage {
  type: 'docCompact';
  encryptedState: string;
  iv: string;
  replacesUpTo: number;
  /** Org key fingerprint for epoch enforcement. Server rejects stale-key writes. */
  orgKeyFingerprint?: string;
}

/** Send encrypted awareness state (cursor, selection) */
export interface DocAwarenessMessage {
  type: 'docAwareness';
  encryptedState: string;
  iv: string;
}

/** Upload a wrapped document key for a target user (ECDH key exchange) */
export interface AddKeyEnvelopeMessage {
  type: 'addKeyEnvelope';
  targetUserId: string;
  wrappedKey: string;
  iv: string;
  senderPublicKey: string;
}

/** Request the caller's key envelope */
export interface RequestKeyEnvelopeMessage {
  type: 'requestKeyEnvelope';
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
  | DocAwarenessBroadcastMessage
  | KeyEnvelopeMessage
  | DocErrorMessage;

/** Response to docSyncRequest with paginated encrypted updates */
export interface DocSyncResponseMessage {
  type: 'docSyncResponse';
  updates: EncryptedDocUpdate[];
  snapshot?: EncryptedDocSnapshot;
  hasMore: boolean;
  cursor: number;
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

/** Broadcast encrypted awareness state to other connections */
export interface DocAwarenessBroadcastMessage {
  type: 'docAwarenessBroadcast';
  encryptedState: string;
  iv: string;
  fromUserId: string;
}

/** Deliver a key envelope to the requesting user */
export interface KeyEnvelopeMessage {
  type: 'keyEnvelope';
  wrappedKey: string;
  iv: string;
  senderPublicKey: string;
  /** User ID of the user who created this envelope */
  senderUserId: string;
}

/** TeamDocumentRoom error response */
export interface DocErrorMessage {
  type: 'error';
  code: string;
  message: string;
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
