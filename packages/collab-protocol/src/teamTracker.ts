/**
 * TeamTrackerRoom wire protocol.
 *
 * Phase 2 of tracker-sync-redesign. Server-assigned monotonic syncIds,
 * plaintext item payloads, and server-allocated issue numbering.
 *
 * The `encryptedPayload` field name is VESTIGIAL. Payloads travel as
 * plaintext JSON over TLS; the server holds the team DEK, encrypts at rest,
 * and CAN read them. The field keeps its name because renaming it breaks
 * every deployed client -- there is no protocol version handshake in this
 * lane. `iv` and `orgKeyFingerprint` are live with changed meanings; the
 * `Encrypted*` type names were dropped.
 *
 * Do not draw a security conclusion from these field names. Read the lane
 * table in docs/IDENTITY_AUTH_AND_ROOMS.md section 6 first.
 */

/**
 * Per-room monotonic version counter, server-assigned. Wider than 32 bits
 * intentionally: stored as INTEGER in DO SQLite (53-bit safe via JS number).
 */
export type SyncId = number;

/** Sentinel meaning "send me everything." */
export const SYNC_ID_INITIAL: SyncId = 0;

/** Maximum UTF-8 size of one non-tombstone tracker item payload. */
export const MAX_TRACKER_ITEM_PAYLOAD_BYTES = 256 * 1024;

export type TrackerItemPayloadValidationResult =
  | { success: true; value: Record<string, unknown> }
  | { success: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) bytes += 1;
    else if (codeUnit < 0x800) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Shared runtime schema for the plaintext item payload inside a tracker
 * envelope. Unknown business fields remain allowed, while the fixed fields
 * every client dereferences are validated before the value crosses a storage
 * or projection boundary.
 */
export function validateTrackerItemPayload(
  value: unknown,
  expectedItemId?: string,
): TrackerItemPayloadValidationResult {
  if (!isRecord(value)) return { success: false, error: 'payload must be a JSON object' };
  if (typeof value.itemId !== 'string' || value.itemId.length === 0) {
    return { success: false, error: 'payload.itemId must be a non-empty string' };
  }
  if (expectedItemId !== undefined && value.itemId !== expectedItemId) {
    return { success: false, error: 'payload.itemId must match envelope itemId' };
  }
  if (typeof value.primaryType !== 'string' || value.primaryType.length === 0) {
    return { success: false, error: 'payload.primaryType must be a non-empty string' };
  }
  if (typeof value.archived !== 'boolean') {
    return { success: false, error: 'payload.archived must be a boolean' };
  }
  if (!Number.isSafeInteger(value.bodyVersion) || (value.bodyVersion as number) < 0) {
    return { success: false, error: 'payload.bodyVersion must be a non-negative safe integer' };
  }
  if (!isRecord(value.fields)) {
    return { success: false, error: 'payload.fields must be an object' };
  }
  if (!isRecord(value.labels)) {
    return { success: false, error: 'payload.labels must be an object' };
  }
  for (const [entryId, entry] of Object.entries(value.labels)) {
    if (!isRecord(entry)
      || entry.id !== entryId
      || typeof entry.value !== 'string'
      || (entry.tombstone !== undefined && entry.tombstone !== true)) {
      return { success: false, error: `payload.labels.${entryId} is not a valid label entry` };
    }
  }
  if (!Array.isArray(value.comments)) {
    return { success: false, error: 'payload.comments must be an array' };
  }
  for (const comment of value.comments) {
    if (!isRecord(comment)
      || typeof comment.id !== 'string'
      || comment.id.length === 0
      || !isRecord(comment.authorIdentity)
      || typeof comment.body !== 'string'
      || typeof comment.createdAt !== 'number'
      || !Number.isFinite(comment.createdAt)) {
      return { success: false, error: 'payload.comments contains an invalid comment' };
    }
  }
  if (value.activity !== undefined && !Array.isArray(value.activity)) {
    return { success: false, error: 'payload.activity must be an array when present' };
  }
  if (!isRecord(value.system)) {
    return { success: false, error: 'payload.system must be an object' };
  }
  if (value.issueNumber !== undefined
    && (!Number.isSafeInteger(value.issueNumber) || (value.issueNumber as number) <= 0)) {
    return { success: false, error: 'payload.issueNumber must be a positive safe integer when present' };
  }
  if (value.issueKey !== undefined
    && (typeof value.issueKey !== 'string' || value.issueKey.length === 0)) {
    return { success: false, error: 'payload.issueKey must be a non-empty string when present' };
  }
  return { success: true, value };
}

/** Size-check, parse, and validate a plaintext tracker item payload. */
export function parseTrackerItemPayload(
  payload: string,
  expectedItemId?: string,
): TrackerItemPayloadValidationResult {
  if (utf8ByteLength(payload) > MAX_TRACKER_ITEM_PAYLOAD_BYTES) {
    return {
      success: false,
      error: `payload exceeds ${MAX_TRACKER_ITEM_PAYLOAD_BYTES} UTF-8 bytes`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { success: false, error: 'payload must be valid JSON' };
  }
  return validateTrackerItemPayload(value, expectedItemId);
}

/**
 * One item as it travels on the wire. The DO stores rows in this shape
 * (modulo snake_case columns). Tombstones: `encryptedPayload: null`,
 * `iv` omitted, `deletedAt` populated.
 */
export interface TrackerItemEnvelope {
  itemId: string;
  syncId: SyncId;
  /** Plaintext JSON despite the name. See the file header. */
  encryptedPayload: string | null;
  /**
   * Empty/absent = server-managed row. Non-empty = pre-cutover ciphertext no
   * supported client can read. Load-bearing: do not drop it as vestigial.
   */
  iv?: string;
  updatedAt: number;
  deletedAt: number | null;
  /** Fingerprint of the team DEK the row was encrypted at rest under. */
  orgKeyFingerprint: string | null;
  /** Server-allocated; never changes after first assignment. */
  issueNumber?: number;
  /** Server-allocated; never changes after first assignment. */
  issueKey?: string;
}

/** Tracker-room-scoped config. */
export interface TrackerRoomConfig {
  issueKeyPrefix: string;
  /** Additive W3-E diagnostic; older peers safely ignore it. */
  issueKeyPrefixAssignment?: {
    status: 'disambiguated' | 'conflict';
    message: string;
    requestedPrefix?: string;
    conflictingProjectName?: string;
    suggestedPrefix?: string;
  };
}

/** Live identity shown in the tracker-room viewer roster. */
export interface TrackerPresenceMember {
  /** Authenticated Stytch member id in this team organization. */
  teamMemberId: string;
  displayName: string;
  /** Null until the authoritative team roster exposes a profile image. */
  avatarUrl: string | null;
}

/**
 * One tracker SCHEMA row on the wire (Epic B Phase 3). Mirrors
 * {@link TrackerItemEnvelope} but keyed by the schema TYPE name
 * instead of an itemId, and with no issue-number allocation. The payload is
 * the plaintext JSON-serialized TrackerDataModel; the server stores it
 * without reading it, which is a choice rather than a guarantee.
 * Tombstones (type deleted / reset to built-in): `encryptedPayload: null`,
 * `iv` omitted, `deletedAt` populated. Schemas carry their OWN monotonic
 * syncId cursor, independent of the item cursor.
 */
export interface TrackerSchemaEnvelope {
  schemaType: string;
  syncId: SyncId;
  encryptedPayload: string | null;
  iv?: string;
  updatedAt: number;
  deletedAt: number | null;
  /** Fingerprint of the team DEK the row was encrypted at rest under. */
  orgKeyFingerprint: string | null;
}

/**
 * One team-shared saved view. Mirrors {@link TrackerSchemaEnvelope}
 * but keyed by a client-generated `viewId`. The payload is the plaintext
 * JSON-serialized SavedView (name + definition); the server stores it without
 * reading it, which is a choice rather than a guarantee.
 * Tombstones (view unshared or deleted): `encryptedPayload: null`, `iv`
 * omitted, `deletedAt` populated. Saved views carry their OWN monotonic syncId
 * cursor, independent of the item, schema, and navigation cursors.
 */
export interface TrackerSavedViewEnvelope {
  viewId: string;
  syncId: SyncId;
  encryptedPayload: string | null;
  iv?: string;
  updatedAt: number;
  deletedAt: number | null;
  /** Fingerprint of the team DEK the row was encrypted at rest under. */
  orgKeyFingerprint: string | null;
}

/** One shared tracker-sidebar navigation entry (folder or type placement). */
export interface TrackerNavigationEnvelope {
  entryId: string;
  syncId: SyncId;
  encryptedPayload: string | null;
  iv?: string;
  updatedAt: number;
  deletedAt: number | null;
  /** Fingerprint of the team DEK the row was encrypted at rest under. */
  orgKeyFingerprint: string | null;
}

// ============================================================================
// Client -> Server Messages
// ============================================================================

export type TrackerClientMessage =
  | TrackerSyncRequestMessage
  | TrackerMutationRequestMessage
  | TrackerMutationBatchRequestMessage
  | TrackerSetConfigMessage
  | TrackerSchemaSyncRequestMessage
  | TrackerSchemaMutationRequestMessage
  | TrackerNavigationSyncRequestMessage
  | TrackerNavigationMutationRequestMessage
  | TrackerSavedViewSyncRequestMessage
  | TrackerSavedViewMutationRequestMessage
  | TrackerPresenceMessage
  | TrackerPingMessage;

/** Announce or refresh this connection's ephemeral tracker-room presence. */
export interface TrackerPresenceMessage {
  type: 'trackerPresence';
  /** @deprecated Ignored by the server; presence identity is roster-derived. */
  displayName?: string;
  /** @deprecated Ignored by the server; the roster currently has no avatar. */
  avatarUrl?: string | null;
}

/** Request the saved-view delta since a cursor. `sinceSyncId: 0` bootstraps. */
export interface TrackerSavedViewSyncRequestMessage {
  type: 'trackerSavedViewSync';
  sinceSyncId: SyncId;
}

/** Upsert (encryptedPayload set) or unshare/delete (null = tombstone) one view. */
export interface TrackerSavedViewMutationRequestMessage {
  type: 'trackerSavedViewMutation';
  clientMutationId: string;
  viewId: string;
  /** Null for delete (tombstone). */
  encryptedPayload: string | null;
}

export interface TrackerNavigationSyncRequestMessage {
  type: 'trackerNavigationSync';
  sinceSyncId: SyncId;
}

export interface TrackerNavigationMutationRequestMessage {
  type: 'trackerNavigationMutation';
  clientMutationId: string;
  entryId: string;
  encryptedPayload: string | null;
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
  /**
   * Create the type only if the room has no live definition of it; refused
   * with `schemaExists` otherwise. A re-send of the exact payload the room
   * already holds is accepted. Send only to a room whose schema bootstrap
   * advertised `schemaCreateOnly`: an older room ignores the field and upserts.
   */
  createOnly?: boolean;
}

export interface TrackerSyncRequestMessage {
  type: 'trackerSync';
  sinceSyncId: SyncId;
  /** Reserved for a future server-aware variant; ignored today. */
  onlyPrimaryTypes?: string[];
  /** Additive hint used only when a fresh room auto-claims its first prefix. */
  initializeIssueKeyPrefix?: string;
}

export interface TrackerMutationRequestMessage {
  type: 'trackerMutation';
  clientMutationId: string;
  itemId: string;
  /** Null for delete (tombstone). */
  encryptedPayload: string | null;
  issueNumber?: number;
  issueKey?: string;
}

/** One atomic update-many command. Batch entries must target existing items. */
export interface TrackerMutationBatchRequestMessage {
  type: 'trackerMutationBatch';
  mutations: Array<Omit<TrackerMutationRequestMessage, 'type'>>;
}

export interface TrackerSetConfigMessage {
  type: 'trackerSetConfig';
  key: 'issueKeyPrefix';
  value: string;
  /** Optional correlation for a config request; absent on older clients. */
  clientMutationId?: string;
  /** Bootstrap requests may be disambiguated; explicit requests must reject. */
  assignmentMode?: 'auto' | 'explicit';
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
  | TrackerMutationBatchAckMessage
  | TrackerConfigBroadcastMessage
  | TrackerSchemaSyncResponseMessage
  | TrackerSchemaDeltaMessage
  | TrackerSchemaMutationAckMessage
  | TrackerNavigationSyncResponseMessage
  | TrackerNavigationDeltaMessage
  | TrackerNavigationMutationAckMessage
  | TrackerSavedViewSyncResponseMessage
  | TrackerSavedViewDeltaMessage
  | TrackerSavedViewMutationAckMessage
  | TrackerPresenceRosterMessage
  | TrackerPresenceDeltaMessage
  | TrackerPongMessage
  | TrackerRoomMovedMessage
  | TrackerErrorMessage;

/** Full current viewer roster, sent to a connection after its announcement. */
export interface TrackerPresenceRosterMessage {
  type: 'trackerPresenceRoster';
  members: TrackerPresenceMember[];
}

/**
 * One viewer joined/updated or left the room. Presence is retained only in the
 * WebSocket hibernation attachment, never in D1 or room SQLite.
 */
export interface TrackerPresenceDeltaMessage {
  type: 'trackerPresenceDelta';
  connected: boolean;
  member: TrackerPresenceMember;
}

export interface TrackerSavedViewSyncResponseMessage {
  type: 'trackerSavedViewSyncResponse';
  views: TrackerSavedViewEnvelope[];
  cursorSyncId: SyncId;
  hasMore: boolean;
}

export interface TrackerSavedViewDeltaMessage {
  type: 'trackerSavedViewDelta';
  view: TrackerSavedViewEnvelope;
}

export interface TrackerSavedViewMutationAckMessage {
  type: 'trackerSavedViewMutationAck';
  clientMutationId: string;
  accepted: boolean;
  syncId?: SyncId;
  view?: TrackerSavedViewEnvelope;
  error?: {
    code: TrackerMutationRejectCode;
    message: string;
  };
}

export interface TrackerNavigationSyncResponseMessage {
  type: 'trackerNavigationSyncResponse';
  entries: TrackerNavigationEnvelope[];
  cursorSyncId: SyncId;
  hasMore: boolean;
}

export interface TrackerNavigationDeltaMessage {
  type: 'trackerNavigationDelta';
  entry: TrackerNavigationEnvelope;
}

export interface TrackerNavigationMutationAckMessage {
  type: 'trackerNavigationMutationAck';
  clientMutationId: string;
  accepted: boolean;
  syncId?: SyncId;
  entry?: TrackerNavigationEnvelope;
  error?: {
    code: TrackerMutationRejectCode;
    message: string;
  };
}

export interface TrackerSchemaSyncResponseMessage {
  type: 'trackerSchemaSyncResponse';
  schemas: TrackerSchemaEnvelope[];
  cursorSyncId: SyncId;
  hasMore: boolean;
  /** The room honors `createOnly` on schema mutations. Absent from older rooms. */
  schemaCreateOnly?: boolean;
}

export interface TrackerSchemaDeltaMessage {
  type: 'trackerSchemaDelta';
  schema: TrackerSchemaEnvelope;
}

export interface TrackerSchemaMutationAckMessage {
  type: 'trackerSchemaMutationAck';
  clientMutationId: string;
  accepted: boolean;
  syncId?: SyncId;
  schema?: TrackerSchemaEnvelope;
  error?: {
    code: TrackerMutationRejectCode;
    message: string;
  };
}

export interface TrackerSyncResponseMessage {
  type: 'trackerSyncResponse';
  items: TrackerItemEnvelope[];
  cursorSyncId: SyncId;
  hasMore: boolean;
  /** Sent on the first batch only. */
  config?: TrackerRoomConfig;
}

export interface TrackerDeltaMessage {
  type: 'trackerDelta';
  item: TrackerItemEnvelope;
}

export type TrackerMutationRejectCode =
  | 'staleKeyEpoch'
  | 'rotationLocked'
  | 'forbidden'
  /** The server could not load the team DEK, so the write is refused. */
  | 'custodyUnavailable'
  /** The payload carried a client iv — the retired client-encrypted lane. */
  | 'legacy_encryption_retired'
  /** A new key cannot be minted until the project's org-wide prefix conflict is resolved. */
  | 'issueKeyPrefixConflict'
  /**
   * D3: the actor may add to this team tracker's schema but not remove from it.
   * A permanent refusal, not a transient one — retrying the same payload will be
   * refused again until an admin makes the change.
   *
   * Wire skew: a client built before this code existed sees an unrecognized
   * string in `error.code` and falls back to `error.message`, which carries the
   * full explanation. No client has ever been able to assume the union is
   * closed, so adding a member cannot break one.
   */
  | 'adminRequired'
  /** A create-only schema mutation named a type the room already defines. */
  | 'schemaExists'
  | 'malformed';

export interface TrackerMutationAckMessage {
  type: 'trackerMutationAck';
  clientMutationId: string;
  accepted: boolean;
  syncId?: SyncId;
  issueNumber?: number;
  issueKey?: string;
  item?: TrackerItemEnvelope;
  error?: {
    code: TrackerMutationRejectCode;
    message: string;
  };
}

/** One coherent result for `trackerMutationBatch`: every entry commits or none do. */
export interface TrackerMutationBatchAckMessage {
  type: 'trackerMutationBatchAck';
  accepted: boolean;
  entries: Array<Omit<TrackerMutationAckMessage, 'type' | 'accepted' | 'error'>>;
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
  /** Present when the error rejects a correlated config request. */
  clientMutationId?: string;
  conflictingProjectName?: string;
  suggestedPrefix?: string;
}
