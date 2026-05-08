/**
 * Types for TrackerSync -- client-side tracker item encryption and sync layer.
 *
 * These are the client-side equivalents of the TrackerClientMessage/TrackerServerMessage
 * types defined in collabv3/src/types.ts. Duplicated here to avoid a dependency
 * on the collabv3 package (which is a Cloudflare Worker, not a library).
 */

// ============================================================================
// Configuration
// ============================================================================

export interface TrackerSyncConfig {
  /** WebSocket server URL (e.g., wss://sync.nimbalyst.com) */
  serverUrl: string;

  /** Function to get fresh JWT for WebSocket auth */
  getJwt: () => Promise<string>;

  /** B2B organization ID */
  orgId: string;

  /** AES-256-GCM key for encrypting/decrypting tracker items */
  encryptionKey: CryptoKey;

  /** Fingerprint of the org key (included in writes, checked on reads) */
  orgKeyFingerprint?: string;

  /** Current user's ID */
  userId: string;

  /** Project ID (used to construct room ID: org:{orgId}:tracker:{projectId}) */
  projectId: string;

  /** Called when remote tracker items are upserted */
  onItemUpserted?: (item: TrackerItemPayload) => void;

  /** Called when a remote tracker item is deleted */
  onItemDeleted?: (itemId: string) => void;

  /** Called when connection status changes */
  onStatusChange?: (status: TrackerSyncStatus) => void;

  /** Called once after initial sync fully completes. */
  onInitialSyncComplete?: (summary: TrackerInitialSyncSummary) => void | Promise<void>;

  /** Called when tracker room config changes (e.g., issue key prefix) */
  onConfigChanged?: (config: TrackerRoomConfig) => void;

  /**
   * Called when a remote item fails to decrypt. The caller can use this to
   * re-encrypt and re-upload the item from local PGLite data, repairing
   * corrupt server payloads. Return a valid payload to auto-repair, or null
   * to skip. Repaired items are re-uploaded via upsertItem.
   */
  onDecryptFailed?: (itemId: string, error: unknown) => Promise<TrackerItemPayload | null>;

  /**
   * Override the WebSocket URL construction.
   * Useful for integration tests with auth bypass.
   */
  buildUrl?: (roomId: string) => string;
}

export interface TrackerInitialSyncSummary {
  remoteItemCount: number;
  remoteDeletedCount: number;
  sequence: number;
}

// ============================================================================
// Status
// ============================================================================

export type TrackerSyncStatus =
  | 'disconnected'
  | 'connecting'
  | 'syncing'
  | 'connected'
  | 'error';

// ============================================================================
// Tracker Item Payload (decrypted)
// ============================================================================

/**
 * System metadata carried in the sync payload.
 * These are infrastructure fields, not user-defined business data.
 */
export interface TrackerPayloadSystem {
  authorIdentity?: TrackerIdentity | null;
  lastModifiedBy?: TrackerIdentity | null;
  createdByAgent?: boolean;
  /**
   * Legacy only. Session links are local-only per user and are intentionally
   * omitted from new shared tracker sync payloads.
   */
  linkedSessions?: string[];
  linkedCommitSha?: string;
  linkedCommits?: Array<{ sha: string; message: string; sessionId?: string; timestamp: string }>;
  documentId?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * The decrypted payload of a tracker item (v2 -- generic).
 *
 * JSON-serialized, encrypted with AES-256-GCM, sent as an opaque blob.
 * The server never sees any of these fields.
 *
 * All user-defined business data lives in `fields`.
 * System/infrastructure metadata lives in `system`.
 */
export interface TrackerItemPayload {
  /** Unique item ID (also stored in plaintext on server for routing) */
  itemId: string;

  /** Human-readable sequential number assigned by the tracker room */
  issueNumber?: number;

  /** Human-readable key like NIM-123 assigned by the tracker room */
  issueKey?: string;

  /** Primary tracker type */
  primaryType: string;

  /** Whether the item is archived */
  archived: boolean;

  /** System/infrastructure metadata */
  system: TrackerPayloadSystem;

  /** All user-defined field data (schema-driven) */
  fields: Record<string, unknown>;

  /**
   * Per-field timestamps for Last-Write-Wins conflict resolution.
   * Keys cover both `fields` keys and `system` keys.
   */
  fieldUpdatedAt: Record<string, number>;

  /** Comments thread */
  comments: TrackerComment[];

  /** Activity log (status changes, field edits, etc.) */
  activity: TrackerActivity[];

  /** Rich content (Lexical editor state JSON) */
  content?: unknown;

  /** Server-side created timestamp (epoch ms). Set from EncryptedTrackerItem envelope. */
  serverCreatedAt?: number;

  /** Server-side updated timestamp (epoch ms). Set from EncryptedTrackerItem envelope. */
  serverUpdatedAt?: number;
}

export interface TrackerComment {
  id: string;
  /** Structured author identity for offline rendering */
  authorIdentity: TrackerIdentity;
  body: string;
  createdAt: number;
  updatedAt?: number | null;
  /** Soft delete for sync compatibility */
  deleted?: boolean;
  /** @deprecated Use authorIdentity instead */
  authorId?: string;
}

// ============================================================================
// Sync Events
// ============================================================================

/**
 * Result of a full sync operation.
 * Contains all items and deletions from the server since the last sync.
 */
export interface TrackerSyncResult {
  /** Items upserted since last sync (decrypted) */
  items: TrackerItemPayload[];
  /** Item IDs deleted since last sync */
  deletedItemIds: string[];
  /** Server sequence cursor for next sync */
  sequence: number;
  /** Whether there are more items to sync */
  hasMore: boolean;
}

// ============================================================================
// Wire Protocol (client-side copies of collabv3 types)
// ============================================================================

/** Client -> Server messages */
export type TrackerClientMessage =
  | { type: 'trackerSync'; sinceSequence: number }
  | { type: 'trackerUpsert'; itemId: string; encryptedPayload: string; iv: string; issueNumber?: number; issueKey?: string; orgKeyFingerprint?: string }
  | { type: 'trackerDelete'; itemId: string; orgKeyFingerprint?: string }
  | { type: 'trackerBatchUpsert'; items: { itemId: string; encryptedPayload: string; iv: string; issueNumber?: number; issueKey?: string; orgKeyFingerprint?: string }[] }
  | { type: 'trackerSetConfig'; key: string; value: string };

/** Server -> Client messages */
export type TrackerServerMessage =
  | TrackerSyncResponseMessage
  | TrackerUpsertBroadcastMessage
  | TrackerDeleteBroadcastMessage
  | TrackerConfigBroadcastMessage
  | TrackerErrorMessage;

export interface TrackerSyncResponseMessage {
  type: 'trackerSyncResponse';
  items: EncryptedTrackerItem[];
  deletedItemIds: string[];
  sequence: number;
  hasMore: boolean;
  config?: TrackerRoomConfig;
}

export interface TrackerConfigBroadcastMessage {
  type: 'trackerConfigBroadcast';
  config: TrackerRoomConfig;
}

/** Tracker room configuration */
export interface TrackerRoomConfig {
  issueKeyPrefix: string;
}

export interface TrackerUpsertBroadcastMessage {
  type: 'trackerUpsertBroadcast';
  item: EncryptedTrackerItem;
}

export interface TrackerDeleteBroadcastMessage {
  type: 'trackerDeleteBroadcast';
  itemId: string;
  sequence: number;
}

export interface TrackerErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

/** Encrypted tracker item as received from server */
export interface EncryptedTrackerItem {
  itemId: string;
  issueNumber?: number;
  issueKey?: string;
  version: number;
  encryptedPayload: string;
  iv: string;
  createdAt: number;
  updatedAt: number;
  sequence: number;
  /** Fingerprint of the org key used to encrypt this payload (null for legacy items) */
  orgKeyFingerprint?: string | null;
}

// ============================================================================
// TrackerRecord <-> TrackerItemPayload Mapping
// ============================================================================

import type { TrackerItem, TrackerIdentity, TrackerActivity } from '../core/DocumentService';
import type { TrackerRecord } from '../core/TrackerRecord';
import { trackerItemToRecord, trackerRecordToItem } from '../core/TrackerRecord';

/**
 * Convert a TrackerRecord to a TrackerItemPayload for sync.
 */
export function recordToPayload(record: TrackerRecord): TrackerItemPayload {
  const now = Date.now();

  // Build fieldUpdatedAt from record's fieldUpdatedAt, filling gaps with now
  const { linkedSessions: _linkedSessionsTs, ...fieldUpdatedAt } = record.fieldUpdatedAt;
  const payloadFieldUpdatedAt: Record<string, number> = { ...fieldUpdatedAt };
  for (const key of Object.keys(record.fields)) {
    if (!payloadFieldUpdatedAt[key]) payloadFieldUpdatedAt[key] = now;
  }
  // System field timestamps
  const systemKeys = [
    'authorIdentity', 'lastModifiedBy', 'createdByAgent',
    'linkedCommitSha', 'linkedCommits', 'documentId',
    'createdAt', 'updatedAt',
  ];
  for (const key of systemKeys) {
    if (!payloadFieldUpdatedAt[key]) payloadFieldUpdatedAt[key] = now;
  }
  // Routing field timestamps
  payloadFieldUpdatedAt.issueNumber = payloadFieldUpdatedAt.issueNumber ?? now;
  payloadFieldUpdatedAt.issueKey = payloadFieldUpdatedAt.issueKey ?? now;
  payloadFieldUpdatedAt.archived = payloadFieldUpdatedAt.archived ?? now;
  payloadFieldUpdatedAt.comments = payloadFieldUpdatedAt.comments ?? now;
  payloadFieldUpdatedAt.activity = payloadFieldUpdatedAt.activity ?? now;
  if (record.content !== undefined) {
    payloadFieldUpdatedAt.content = payloadFieldUpdatedAt.content ?? now;
  }

  return {
    itemId: record.id,
    issueNumber: record.issueNumber,
    issueKey: record.issueKey,
    primaryType: record.primaryType,
    archived: record.archived,
    system: {
      authorIdentity: record.system.authorIdentity,
      lastModifiedBy: record.system.lastModifiedBy,
      createdByAgent: record.system.createdByAgent,
      linkedCommitSha: record.system.linkedCommitSha,
      linkedCommits: record.system.linkedCommits,
      documentId: record.system.documentId,
      createdAt: record.system.createdAt,
      updatedAt: record.system.updatedAt,
    },
    fields: { ...record.fields },
    fieldUpdatedAt: payloadFieldUpdatedAt,
    comments: record.system.comments ?? [],
    activity: record.system.activity ?? [],
    content: record.content,
  };
}

/**
 * Convert a TrackerItemPayload back to a TrackerRecord.
 * The caller must supply workspace context.
 * Handles both new-format (fields/system) and old-format (top-level fields) payloads
 * for backward compatibility with encrypted items already on the server.
 */
export function payloadToRecord(payload: TrackerItemPayload, workspace: string): TrackerRecord {
  // Handle old-format payloads that have top-level fields instead of fields/system
  const p = payload as any;
  const sys = payload.system ?? {};
  const fields = payload.fields ?? {};

  // If payload has top-level fields (old format), migrate them into fields bag
  if (!payload.fields && p.title) {
    for (const key of ['title', 'description', 'status', 'priority', 'assigneeEmail', 'reporterEmail', 'labels', 'linkedCommitSha', 'documentId']) {
      if (p[key] !== undefined) fields[key] = p[key];
    }
    if (p.customFields && typeof p.customFields === 'object') {
      Object.assign(fields, p.customFields);
    }
  }

  const { linkedSessions: _linkedSessionsTs, ...fieldUpdatedAt } = payload.fieldUpdatedAt;

  return {
    id: payload.itemId,
    primaryType: payload.primaryType ?? p.type ?? '',
    typeTags: [payload.primaryType ?? p.type ?? ''],
    issueNumber: payload.issueNumber,
    issueKey: payload.issueKey,
    source: 'native',
    archived: payload.archived ?? false,
    syncStatus: 'synced',
    system: {
      workspace,
      createdAt: sys.createdAt ?? new Date().toISOString(),
      updatedAt: sys.updatedAt ?? new Date().toISOString(),
      lastIndexed: new Date().toISOString(),
      authorIdentity: sys.authorIdentity ?? p.authorIdentity,
      lastModifiedBy: sys.lastModifiedBy ?? p.lastModifiedBy,
      createdByAgent: sys.createdByAgent ?? p.createdByAgent,
      linkedCommitSha: sys.linkedCommitSha ?? p.linkedCommitSha,
      linkedCommits: sys.linkedCommits ?? p.linkedCommits,
      documentId: sys.documentId ?? p.documentId,
      comments: payload.comments,
      activity: payload.activity,
    },
    content: payload.content,
    fields,
    fieldUpdatedAt: { ...fieldUpdatedAt },
  };
}

/**
 * Convert a legacy TrackerItem to a TrackerItemPayload for sync.
 * Convenience wrapper: converts to TrackerRecord first, then to payload.
 */
export function trackerItemToPayload(item: TrackerItem, _userId: string): TrackerItemPayload {
  const record = trackerItemToRecord(item);
  return recordToPayload(record);
}

/**
 * Convert a TrackerItemPayload to a legacy TrackerItem.
 * Convenience wrapper: converts to TrackerRecord first, then to TrackerItem.
 */
export function payloadToTrackerItem(
  payload: TrackerItemPayload,
  workspace: string
): Omit<TrackerItem, 'module' | 'lastIndexed'> & { module: string; lastIndexed: Date } {
  const record = payloadToRecord(payload, workspace);
  const item = trackerRecordToItem(record);
  return {
    ...item,
    module: '',
    lastIndexed: new Date(),
  };
}
