/**
 * Tracker sync wire protocol (metadata layer) + client-side projections.
 *
 * Wire-protocol message shapes (`TrackerClientMessage`, `TrackerServerMessage`,
 * `EncryptedTrackerItemEnvelope`, `SyncId`, `TrackerRoomConfig`,
 * `TrackerMutationRejectCode`) come from `@nimbalyst/collab-protocol` and are
 * shared with the sync server. This file adds the decrypted payload shape
 * (`TrackerItemPayload`), the PGLite cache schema, and the four-state
 * transaction queue that the renderer engine uses.
 *
 * See `design/Collaboration/tracker-sync-redesign.md` for the decisions
 * captured in this protocol (D2-D9).
 */

import type {
  TeamTrackerRoomId,
  SyncId,
  TrackerMutationRejectCode,
} from '@nimbalyst/collab-protocol';

export type {
  SyncId,
  EncryptedTrackerItemEnvelope,
  TrackerRoomConfig,
  TrackerMutationRejectCode,
  TrackerClientMessage,
  TrackerServerMessage,
  TrackerSyncRequestMessage,
  TrackerMutationRequestMessage,
  TrackerSetConfigMessage,
  TrackerPingMessage,
  TrackerSyncResponseMessage,
  TrackerDeltaMessage,
  TrackerMutationAckMessage,
  TrackerConfigBroadcastMessage,
  TrackerPongMessage,
  TrackerErrorMessage,
} from '@nimbalyst/collab-protocol';

export { SYNC_ID_INITIAL } from '@nimbalyst/collab-protocol';

// ============================================================================
// D8: Routing identity
// ============================================================================

/**
 * The stable, server-minted UUID that names a tracker room. Minted in
 * TeamRoom at team creation, never rotated, never derived from mutable
 * inputs (NIM-404).
 */
export type TeamProjectId = string;

/**
 * Tracker room ID. The TrackerRoom DO instance is keyed off this string.
 * The {teamProjectId} component is the only thing routing depends on; the
 * {orgId} prefix is namespace isolation, not routing.
 */
export type TrackerRoomId = TeamTrackerRoomId;

/**
 * Construct a TrackerRoomId from its components.
 */
export function buildTrackerRoomId(orgId: string, teamProjectId: TeamProjectId): TrackerRoomId {
  return `org:${orgId}:tracker:${teamProjectId}`;
}

// ============================================================================
// D7: Decrypted payload (client-side)
// ============================================================================

/**
 * Decrypted payload. JSON-serialized inside `encryptedPayload`.
 *
 * The shape is intentionally typeless at the field level: `fields` is the
 * user-defined business data bag (title, status, priority, etc.) keyed by
 * field name as declared in the tracker type's schema. The fixed-shape
 * fields (`primaryType`, `archived`, `system`, `comments`, `labels`,
 * `bodyVersion`) carry sync-relevant semantics that the conflict
 * resolution rules in `TrackerConflictPolicy` need to know about by name.
 *
 * Notably absent compared to the v1 payload:
 *   - `fieldUpdatedAt`: the per-field LWW timestamp map is gone. Ordering
 *     is now expressed by the server-assigned `syncId` on the envelope.
 *   - `activity`: the activity feed becomes a derivation of the
 *     append-only comment/event log rather than a snapshot per item.
 *   - `content`: the body text is no longer carried in the metadata
 *     payload. Bodies live in DocumentRoom Y.Docs (per D5) and the
 *     payload only carries `bodyVersion` for cache invalidation.
 *   - `linkedSessions`: device-local, stripped at the upload boundary
 *     (see `stripLocalOnlyFields`).
 */
export interface TrackerItemPayload {
  /** Echo of the envelope itemId; useful for sanity checks after decrypt. */
  itemId: string;

  /** Primary tracker type (e.g. "bug", "task", "decision"). */
  primaryType: string;

  /** Whether the item is archived. LWW per `syncId`. */
  archived: boolean;

  /** Human-readable sequential number assigned by the tracker room. */
  issueNumber?: number;

  /** Human-readable key like "NIM-123" assigned by the tracker room. */
  issueKey?: string;

  /**
   * The current body version pointer. References a snapshot in the
   * DocumentRoom Y.Doc for this item. Bumped on every body write; clients
   * use it to invalidate `tracker_body_cache` projections.
   */
  bodyVersion: number;

  /** User-defined business data, keyed by schema field name. LWW per `syncId`. */
  fields: Record<string, unknown>;

  /**
   * Add-wins set, per-element ID. Concurrent additions all survive;
   * concurrent removal-of-an-addition wins as remove. The shape is a
   * map of label-id -> a tombstone marker; clients render the keyset
   * of non-tombstoned entries.
   */
  labels: Record<string, LabelEntry>;

  /** Append-only comment log. Comments are never lost. */
  comments: TrackerCommentEntry[];

  /** System/infrastructure metadata. LWW per `syncId`. */
  system: TrackerPayloadSystem;
}

/**
 * Entry in the add-wins labels set.
 */
export interface LabelEntry {
  /** The label value (what the user sees). */
  value: string;
  /** Stable per-element ID; same value can appear with different IDs. */
  id: string;
  /** Set when this entry has been removed. Clients hide tombstoned entries. */
  tombstone?: true;
}

/**
 * Entry in the append-only comment log.
 */
export interface TrackerCommentEntry {
  /** Stable client-minted UUID. */
  id: string;
  /** Author identity at the time of write. */
  authorIdentity: TrackerIdentity;
  /** Comment body (markdown). */
  body: string;
  /** Client-asserted creation timestamp (ms). Server clock is `syncId`. */
  createdAt: number;
  /** Server-assigned ordinal for stable display ordering. */
  serverOrdinal?: number;
  /** Soft-delete flag. Body content stays for audit; UI hides it. */
  deleted?: boolean;
  /** Last edit timestamp (ms). Edits are LWW within the comment row. */
  updatedAt?: number;
}

/**
 * System metadata. LWW per `syncId`.
 */
export interface TrackerPayloadSystem {
  authorIdentity?: TrackerIdentity | null;
  lastModifiedBy?: TrackerIdentity | null;
  createdByAgent?: boolean;
  linkedCommitSha?: string;
  linkedCommits?: Array<{ sha: string; message: string; sessionId?: string; timestamp: string }>;
  /** Body document ID, if the body is hosted in a DocumentRoom. */
  documentId?: string;
  /**
   * Structured origin (how the item entered Nimbalyst; for imports, a pointer
   * back to the upstream source). LWW per `syncId`. Optional — older clients
   * omit it and newer clients tolerate its absence. Imported items sync like
   * any other item; only the importer owner can re-snapshot (auth is local).
   */
  origin?: TrackerOrigin;
  /** Client-asserted creation timestamp (ms). */
  createdAt?: string;
  /** Client-asserted last-update timestamp (ms). Server clock is `syncId`. */
  updatedAt?: string;
}

/**
 * Author identity. Re-exported from `DocumentService` so the wire and
 * the in-memory `TrackerItem`/`TrackerRecord` shapes share one source
 * of truth (snapshotted email + display name + git fallbacks).
 */
import type { TrackerIdentity, TrackerOrigin } from '../core/DocumentService';
export type { TrackerIdentity };

/**
 * Field names that are device-local and MUST be stripped from the payload
 * before encrypting and uploading. These never cross the wire.
 *
 * `linkedSessions` is the canonical example: it lives in
 * `tracker_items.data.linkedSessions` in PGLite for renderer convenience,
 * but session IDs are device-local entities and have no meaning to other
 * team members.
 *
 * Phase 3 (TrackerSyncEngine) calls `stripLocalOnlyFields(payload)` at
 * the upload boundary before encryption.
 */
export const LOCAL_ONLY_PAYLOAD_FIELDS = ['linkedSessions'] as const;

// ============================================================================
// D6: Transaction queue (four-state model)
// ============================================================================

/**
 * Lifecycle of a client-side mutation, persisted to PGLite
 * `tracker_transactions`.
 *
 * - `pendingApply`: the queue row exists but the projection in
 *   `tracker_items` has NOT yet received the optimistic apply. This is
 *   the load-bearing state that makes `applyAndEnqueueAtomically`
 *   crash-safe: we write the queue row FIRST so a process crash before
 *   the projection write still leaves a record bootstrap can replay.
 *   On bootstrap, `pendingApply` rows trigger `applyOptimistic` and get
 *   promoted to `persistedEnqueue`.
 * - `created`: the optimistic local apply has happened but the row has
 *   not yet been moved into `queued`. Exists as its own state to handle
 *   tab-crash mid-enqueue when the legacy (non-atomic) entry point is
 *   used: on relaunch, `created` rows get promoted to `queued` and
 *   submitted.
 * - `queued`: the row is ready to send; waiting for an open WebSocket.
 * - `executing`: the row has been sent; waiting for `trackerMutationAck`.
 * - `persistedEnqueue`: the row was enqueued AND the projection was
 *   applied. Reached via `applyAndEnqueueAtomically` (or replay of a
 *   `pendingApply` row on bootstrap). The durability guarantee
 *   originally claimed by this state now actually holds.
 *
 * After ack:
 *   accepted = true  -> row is deleted (the projection in `tracker_items`
 *                       now holds the confirmed state)
 *   accepted = false -> row is kept with `lastRejection` populated for UI
 *                       surfacing; the optimistic local apply is rolled
 *                       back by the engine.
 */
export type TrackerTransactionState =
  | 'pendingApply'
  | 'created'
  | 'queued'
  | 'executing'
  | 'persistedEnqueue';

/**
 * One row in `tracker_transactions`. Phase 3 client engine reads/writes
 * these; the renderer never touches them directly.
 */
export interface TrackerTransactionRow {
  /** Stable client-minted UUID. Echoed back in `TrackerMutationAckMessage`. */
  clientMutationId: string;

  /** Item this transaction operates on. */
  itemId: string;

  /** Workspace path; transactions are partitioned per workspace. */
  workspacePath: string;

  /** Current lifecycle state. */
  state: TrackerTransactionState;

  /** What this transaction does. Server doesn't distinguish create vs update; `delete` is `null` payload. */
  kind: 'create' | 'update' | 'delete';

  /**
   * The mutation payload to send. For `create` and `update`, this is the
   * full decrypted `TrackerItemPayload`. For `delete`, this is omitted.
   * Encryption happens at send-time, not persist-time, so we don't lose
   * the ability to re-encrypt under a rotated org key if rotation
   * happens between enqueue and send.
   */
  payload?: TrackerItemPayload;

  /** When this row was created in the queue (ms). */
  enqueuedAt: number;

  /** When this row entered `executing` state (ms). Used for stuck-mutation detection. */
  startedAt?: number;

  /** Server-assigned `syncId` from the ack. Set on accepted=true. */
  confirmedSyncId?: SyncId;

  /** Populated when the ack was accepted=false; surfaces in the UI. */
  lastRejection?: {
    code: TrackerMutationRejectCode;
    message: string;
    occurredAt: number;
  };
}

// ============================================================================
// D9: PGLite cache schema (TypeScript shape of the SQL rows)
// ============================================================================

/**
 * One row in `tracker_items` (local PGLite). The decrypted projection of
 * what the metadata sync layer holds. The renderer queries this table for
 * kanban / list / detail views.
 *
 * Notably absent compared to the v1 row shape:
 *   - `_fieldUpdatedAt` JSONB key inside `data`: the per-field LWW
 *     timestamp map is gone; ordering is `sync_id`.
 *
 * Notably added:
 *   - `sync_id`: server-assigned monotonic version of the most recent
 *     accepted mutation for this row. Used for `WHERE sync_id > N`
 *     delta queries inside PGLite (e.g., "what changed since the last
 *     UI repaint").
 *   - `body_version`: pointer to the most recent body snapshot in
 *     DocumentRoom; bumped on every body write; used to invalidate
 *     `tracker_body_cache`.
 *   - `deleted_at`: tombstone marker. Rows with `deleted_at IS NOT NULL`
 *     are hidden from queries but kept around so we can roll back an
 *     accidental delete.
 *
 * The renderer-facing columns (`type`, `status`, `title`, etc.) remain
 * for index efficiency; they are generated columns or denormalized from
 * `data`.
 */
export interface TrackerItemRow {
  id: string;
  workspacePath: string;
  type: string;
  status: string | null;
  priority: string | null;
  assigneeId: string | null;
  title: string | null;
  issueNumber: number | null;
  issueKey: string | null;
  /** Decrypted `TrackerItemPayload`. */
  data: TrackerItemPayload;
  syncId: SyncId | null;
  bodyVersion: number;
  deletedAt: Date | null;
  updatedAt: Date;
  archived: boolean;
}

/**
 * One row in `tracker_body_cache` (local PGLite). Cold-read projection of
 * the body Y.Doc for full-text search and "no roundtrip" reads when the
 * detail panel is not open.
 *
 * Phase 4 (Body Y.Doc cache) reads/writes these. Phase 1 just provisions
 * the schema.
 */
export interface TrackerBodyCacheRow {
  itemId: string;
  bodyVersion: number;
  /** Decrypted body content (markdown, or Lexical-JSON serialized). */
  content: string;
  cachedAt: Date;
}

// ============================================================================
// Helpers exported for use by the phase-3 client engine
// ============================================================================

/**
 * Returns a shallow copy of `payload` with all device-local fields
 * stripped. Phase 3 calls this at the upload boundary, before encryption.
 *
 * Today the only stripped field is `linkedSessions` (per D3). New
 * local-only fields should be added to `LOCAL_ONLY_PAYLOAD_FIELDS` and
 * picked up here automatically.
 */
export function stripLocalOnlyFields(payload: TrackerItemPayload): TrackerItemPayload {
  const stripped: TrackerItemPayload = {
    ...payload,
    fields: { ...payload.fields },
    system: { ...payload.system },
  };
  for (const key of LOCAL_ONLY_PAYLOAD_FIELDS) {
    delete (stripped.fields as Record<string, unknown>)[key];
    delete (stripped.system as Record<string, unknown>)[key];
  }
  return stripped;
}
