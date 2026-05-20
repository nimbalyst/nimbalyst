/**
 * TeamTrackerRoom wire protocol.
 *
 * Phase 2 of tracker-sync-redesign. Server-assigned monotonic syncIds,
 * E2E encrypted item payloads, and server-allocated issue numbering.
 */

/**
 * Per-room monotonic version counter, server-assigned. Wider than 32 bits
 * intentionally: stored as INTEGER in DO SQLite (53-bit safe via JS number).
 */
export type SyncId = number;

/** Sentinel meaning "send me everything." */
export const SYNC_ID_INITIAL: SyncId = 0;

/**
 * One item as it travels on the wire. The DO stores rows in this shape
 * (modulo snake_case columns). Tombstones: `encryptedPayload: null`,
 * `iv` omitted, `deletedAt` populated.
 */
export interface EncryptedTrackerItemEnvelope {
  itemId: string;
  syncId: SyncId;
  encryptedPayload: string | null;
  iv?: string;
  updatedAt: number;
  deletedAt: number | null;
  orgKeyFingerprint: string | null;
  /** Server-allocated; never changes after first assignment. */
  issueNumber?: number;
  /** Server-allocated; never changes after first assignment. */
  issueKey?: string;
}

/** Tracker-room-scoped config. */
export interface TrackerRoomConfig {
  issueKeyPrefix: string;
}

// ============================================================================
// Client -> Server Messages
// ============================================================================

export type TrackerClientMessage =
  | TrackerSyncRequestMessage
  | TrackerMutationRequestMessage
  | TrackerSetConfigMessage
  | TrackerPingMessage;

export interface TrackerSyncRequestMessage {
  type: 'trackerSync';
  sinceSyncId: SyncId;
  /** Reserved for a future server-aware variant; ignored today. */
  onlyPrimaryTypes?: string[];
}

export interface TrackerMutationRequestMessage {
  type: 'trackerMutation';
  clientMutationId: string;
  itemId: string;
  /** Null for delete (tombstone). */
  encryptedPayload: string | null;
  /** Omitted for delete. */
  iv?: string;
  orgKeyFingerprint: string | null;
  issueNumber?: number;
  issueKey?: string;
}

export interface TrackerSetConfigMessage {
  type: 'trackerSetConfig';
  key: 'issueKeyPrefix';
  value: string;
}

export interface TrackerPingMessage {
  type: 'trackerPing';
}

// ============================================================================
// Server -> Client Messages
// ============================================================================

export type TrackerServerMessage =
  | TrackerSyncResponseMessage
  | TrackerDeltaMessage
  | TrackerMutationAckMessage
  | TrackerConfigBroadcastMessage
  | TrackerPongMessage
  | TrackerErrorMessage;

export interface TrackerSyncResponseMessage {
  type: 'trackerSyncResponse';
  items: EncryptedTrackerItemEnvelope[];
  cursorSyncId: SyncId;
  hasMore: boolean;
  /** Sent on the first batch only. */
  config?: TrackerRoomConfig;
}

export interface TrackerDeltaMessage {
  type: 'trackerDelta';
  item: EncryptedTrackerItemEnvelope;
}

export type TrackerMutationRejectCode =
  | 'staleKeyEpoch'
  | 'rotationLocked'
  | 'forbidden'
  | 'malformed';

export interface TrackerMutationAckMessage {
  type: 'trackerMutationAck';
  clientMutationId: string;
  accepted: boolean;
  syncId?: SyncId;
  issueNumber?: number;
  issueKey?: string;
  item?: EncryptedTrackerItemEnvelope;
  error?: {
    code: TrackerMutationRejectCode;
    message: string;
  };
}

export interface TrackerConfigBroadcastMessage {
  type: 'trackerConfigBroadcast';
  config: TrackerRoomConfig;
}

export interface TrackerPongMessage {
  type: 'trackerPong';
}

export interface TrackerErrorMessage {
  type: 'trackerError';
  code: string;
  message: string;
}
