/**
 * Types for DocumentSync -- client-side Yjs + encryption layer.
 *
 * Wire-protocol message shapes come from `@nimbalyst/collab-protocol` and
 * are shared with the sync server. This file adds the client-side config
 * surface, review-gate state, and awareness types the renderer consumes.
 */

import type { KeyEnvelopeMessage as ProtocolKeyEnvelopeMessage } from '@nimbalyst/collab-protocol';

export type {
  DocClientMessage,
  DocServerMessage,
  DocSyncRequestMessage,
  DocUpdateMessage,
  DocCompactMessage,
  DocAwarenessMessage,
  AddKeyEnvelopeMessage,
  RequestKeyEnvelopeMessage,
  DocSetMetadataMessage,
  DocSyncResponseMessage,
  DocUpdateBroadcastMessage,
  DocUpdateAckMessage,
  DocAwarenessBroadcastMessage,
  DocErrorMessage,
  EncryptedDocUpdate,
  EncryptedDocSnapshot,
} from '@nimbalyst/collab-protocol';

/** Wire key-envelope delivery message (`type: 'keyEnvelope'`). */
export type DocKeyEnvelopeMessage = ProtocolKeyEnvelopeMessage;

// ============================================================================
// Configuration
// ============================================================================

export interface DocumentSyncConfig {
  /** WebSocket server URL (e.g., wss://sync.nimbalyst.com) */
  serverUrl: string;

  /** Function to get fresh JWT for WebSocket auth */
  getJwt: () => Promise<string>;

  /** B2B organization ID */
  orgId: string;

  /** AES-256-GCM key for encrypting/decrypting Yjs updates */
  documentKey: CryptoKey;

  /** Current user's ID */
  userId: string;

  /** Document ID (used to construct room ID) */
  documentId: string;

  /** Org key fingerprint for key epoch enforcement. If provided, the server
   *  rejects writes with a stale fingerprint after key rotation. */
  orgKeyFingerprint?: string;

  /** Called when a remote Yjs update is applied to the Y.Doc */
  onRemoteUpdate?: (origin: string) => void;

  /** Called when awareness state changes from remote users */
  onAwarenessUpdate?: (states: Map<string, AwarenessState>) => void;

  /** Called when connection status changes */
  onStatusChange?: (status: DocumentSyncStatus) => void;

  /**
   * Previously persisted local updates that have not been acknowledged by the
   * server yet. Applied locally on startup so the editor can recover them.
   */
  initialPendingUpdateBase64?: string;

  /**
   * Called whenever the merged pending local update changes. The host can
   * persist this blob so offline edits survive renderer/app restarts.
   */
  onPendingUpdateChange?: (
    pendingUpdateBase64: string | null
  ) => void | Promise<void>;

  /**
   * Called when the review gate state changes (remote changes arrive or are accepted/rejected).
   * Allows UI to show pending review indicators.
   */
  onReviewStateChange?: (state: ReviewGateState) => void;

  /**
   * Called once after the initial sync response from the server completes.
   * `isEmpty` is true if the server had no existing content for this room.
   *
   * Hosts that may want to seed the Y.Doc from local persistence should gate
   * their bootstrap on this callback: bootstrap only when `isEmpty` is true so
   * stale local content does not CRDT-merge into a room that already has
   * authoritative content from other collaborators.
   */
  onFirstSyncComplete?: (isEmpty: boolean) => void;

  /**
   * Called when a key envelope is received from the server.
   * The consumer should verify `senderPublicKey` against the sender's
   * registered identity key (from TeamRoom) before using the envelope
   * to unwrap the document key. Use ECDHKeyManager.unwrapDocumentKeyVerified().
   */
  onKeyEnvelope?: (envelope: {
    wrappedKey: string;
    iv: string;
    senderPublicKey: string;
    senderUserId: string;
  }) => void;

  /**
   * Enable the review gate for remote changes.
   * When true, remote updates are applied to the Y.Doc (for CRDT correctness and live preview)
   * but marked as "unreviewed" -- the host application should not autosave until
   * acceptRemoteChanges() is called.
   *
   * When false (default), all remote updates are treated as accepted immediately.
   * Use false for single-user multi-device sync (no review needed for your own edits).
   */
  reviewGateEnabled?: boolean;

  /**
   * Override the WebSocket URL construction.
   * If provided, called instead of the default JWT-based URL builder.
   * Useful for integration tests with auth bypass.
   */
  buildUrl?: (roomId: string) => string;

  /**
   * Factory for creating WebSocket connections.
   * If provided, used instead of `new WebSocket(url)`.
   * This allows the Electron renderer to proxy WebSocket connections
   * through the main process (Node.js), working around Cloudflare proxy
   * restrictions that block browser WebSocket upgrades.
   */
  createWebSocket?: (url: string) => WebSocket;
}

// ============================================================================
// Review Gate
// ============================================================================

/**
 * State of the review gate for remote changes.
 * Mirrors the AI "pending review" pattern: remote edits are visible in the editor
 * but not saved to disk until the user explicitly accepts them.
 */
export interface ReviewGateState {
  /** Whether there are any unreviewed remote changes */
  hasUnreviewed: boolean;
  /** Number of buffered remote update operations */
  unreviewedCount: number;
  /** User IDs that contributed unreviewed changes */
  unreviewedAuthors: string[];
}

// ============================================================================
// Status
// ============================================================================

export type DocumentSyncStatus =
  | 'disconnected'
  | 'connecting'
  | 'syncing'
  | 'replaying'
  | 'offline-unsynced'
  | 'connected'
  | 'error';

// ============================================================================
// Awareness
// ============================================================================

/**
 * Serialized Yjs relative position.
 * Created via Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, index)).
 * Survives concurrent edits -- if someone inserts text before your cursor,
 * the relative position still resolves correctly after the remote update is merged.
 */
export type SerializedRelativePosition = string; // base64 encoded

/**
 * Awareness state carried over the encrypted broadcast.
 *
 * Two shapes coexist on this wire:
 * - Markdown (Lexical) sends `{ cursor?: { anchor, head }, user: { name, color } }`.
 * - Extension editors send the y-protocols Awareness state, which always
 *   includes a `user: { id, name, color }` standard block plus arbitrary
 *   editor-specific keys (e.g. `selectedElementIds`, `tool`, `editingNodeId`).
 *
 * Server-side validation: none. The DocumentRoom relays the encrypted blob
 * verbatim. This is a private protocol consumed only by Nimbalyst clients,
 * so widening the type here is safe.
 */
export type AwarenessState = Record<string, unknown> & {
  /** Required user block. `id` is optional in the markdown path; required in
   *  the extension path so the SDK hook can dedupe remote collaborators by
   *  stable user id rather than y-protocols clientID. */
  user: { name: string; color: string; id?: string; [k: string]: unknown };
  /** Lexical-style cursor block (markdown path only). */
  cursor?: {
    anchor: SerializedRelativePosition;
    head: SerializedRelativePosition;
  };
};
