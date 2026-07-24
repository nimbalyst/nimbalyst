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

/**
 * One tracker SCHEMA row on the wire (Epic B Phase 3). Mirrors
 * {@link EncryptedTrackerItemEnvelope} but keyed by the schema TYPE name
 * instead of an itemId, and with no issue-number allocation. The encrypted
 * payload is the JSON-serialized TrackerDataModel; the server never reads it.
 * Tombstones (type deleted / reset to built-in): `encryptedPayload: null`,
 * `iv` omitted, `deletedAt` populated. Schemas carry their OWN monotonic
 * syncId cursor, independent of the item cursor.
 */
export interface EncryptedTrackerSchemaEnvelope {
  schemaType: string;
  syncId: SyncId;
  encryptedPayload: string | null;
  iv?: string;
  updatedAt: number;
  deletedAt: number | null;
  orgKeyFingerprint: string | null;
}

/** One shared tracker-sidebar navigation entry (folder or type placement). */
export interface EncryptedTrackerNavigationEnvelope {
  entryId: string;
  syncId: SyncId;
  encryptedPayload: string | null;
  iv?: string;
  updatedAt: number;
  deletedAt: number | null;
  orgKeyFingerprint: string | null;
}

// ============================================================================
// Client -> Server Messages
// ============================================================================

export type TrackerClientMessage =
  | TrackerSyncRequestMessage
  | TrackerMutationRequestMessage
  | TrackerSetConfigMessage
  | TrackerSchemaSyncRequestMessage
  | TrackerSchemaMutationRequestMessage
  | TrackerNavigationSyncRequestMessage
  | TrackerNavigationMutationRequestMessage
  | TrackerPingMessage;

export interface TrackerNavigationSyncRequestMessage {
  type: 'trackerNavigationSync';
  sinceSyncId: SyncId;
}

export interface TrackerNavigationMutationRequestMessage {
  type: 'trackerNavigationMutation';
  clientMutationId: string;
  entryId: string;
  encryptedPayload: string | null;
  iv?: string;
  orgKeyFingerprint: string | null;
}

/** Request the schema delta since a cursor. `sinceSyncId: 0` bootstraps. */
export interface TrackerSchemaSyncRequestMessage {
  type: 'trackerSchemaSync';
  sinceSyncId: SyncId;
}

/** Upsert (encryptedPayload set) or delete (null = tombstone) one schema. */
export interface TrackerSchemaMutationRequestMessage {
  type: 'trackerSchemaMutation';
  clientMutationId: string;
  schemaType: string;
  /** Null for delete (tombstone). */
  encryptedPayload: string | null;
  /** Omitted for delete. */
  iv?: string;
  orgKeyFingerprint: string | null;
}

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
  | TrackerSchemaSyncResponseMessage
  | TrackerSchemaDeltaMessage
  | TrackerSchemaMutationAckMessage
  | TrackerNavigationSyncResponseMessage
  | TrackerNavigationDeltaMessage
  | TrackerNavigationMutationAckMessage
  | TrackerPongMessage
  | TrackerRoomMovedMessage
  | TrackerErrorMessage;

export interface TrackerNavigationSyncResponseMessage {
  type: 'trackerNavigationSyncResponse';
  entries: EncryptedTrackerNavigationEnvelope[];
  cursorSyncId: SyncId;
  hasMore: boolean;
}

export interface TrackerNavigationDeltaMessage {
  type: 'trackerNavigationDelta';
  entry: EncryptedTrackerNavigationEnvelope;
}

export interface TrackerNavigationMutationAckMessage {
  type: 'trackerNavigationMutationAck';
  clientMutationId: string;
  accepted: boolean;
  syncId?: SyncId;
  entry?: EncryptedTrackerNavigationEnvelope;
  error?: {
    code: TrackerMutationRejectCode;
    message: string;
  };
}

export interface TrackerSchemaSyncResponseMessage {
  type: 'trackerSchemaSyncResponse';
  schemas: EncryptedTrackerSchemaEnvelope[];
  cursorSyncId: SyncId;
  hasMore: boolean;
}

export interface TrackerSchemaDeltaMessage {
  type: 'trackerSchemaDelta';
  schema: EncryptedTrackerSchemaEnvelope;
}

export interface TrackerSchemaMutationAckMessage {
  type: 'trackerSchemaMutationAck';
  clientMutationId: string;
  accepted: boolean;
  syncId?: SyncId;
  schema?: EncryptedTrackerSchemaEnvelope;
  error?: {
    code: TrackerMutationRejectCode;
    message: string;
  };
}

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

/**
 * Sent when this tracker room has been relocated to another org by the move
 * engine (Epic H3 P1). The client must tear down its engine for the old room
 * and re-resolve routing (the project now lives at the new org + routing key).
 * The old room is frozen read-only; never write to it after receiving this.
 */
export interface TrackerRoomMovedMessage {
  type: 'trackerRoomMoved';
  /** The destination org the project now lives in. */
  destOrgId: string;
  /** The project's new tracker-room routing key under the destination org. */
  destTeamProjectId: string;
}

export interface TrackerErrorMessage {
  type: 'trackerError';
  code: string;
  message: string;
}
