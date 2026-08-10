/**
 * Types for DocumentSync -- client-side Yjs sync layer.
 *
 * Wire-protocol message shapes come from `@nimbalyst/collab-protocol` and
 * are shared with the sync server. This file adds the client-side config
 * surface, review-gate state, and awareness types the renderer consumes.
 */

import type { Doc } from 'yjs';
import type { LocalDocumentReplica } from './LocalDocumentReplica';

export type {
  DocClientMessage,
  DocServerMessage,
  DocSyncRequestMessage,
  DocUpdateMessage,
  DocCompactMessage,
  DocAwarenessMessage,
  DocSetMetadataMessage,
  DocSyncResponseMessage,
  DocUpdateBroadcastMessage,
  DocUpdateAckMessage,
  DocAwarenessBroadcastMessage,
  DocErrorMessage,
  EncryptedDocUpdate,
  EncryptedDocSnapshot,
} from '@nimbalyst/collab-protocol';

// ============================================================================
// Configuration
// ============================================================================

export interface DocumentSyncConfig {
  /** Existing durable replica to attach to. The provider never destroys it. */
  replica?: LocalDocumentReplica;

  /** Existing Y.Doc for transitional callers that do not yet use a replica. */
  ydoc?: Doc;
  /** WebSocket server URL (e.g., wss://sync.nimbalyst.com) */
  serverUrl: string;

  /**
   * Function to get a fresh JWT for WebSocket auth.
   * `forceRefresh` (NIM-949) bypasses any cached org-scoped token so a reconnect
   * after an auth-style rejection (HTTP 400 wrong-org/expired) re-exchanges.
   */
  getJwt: (opts?: { forceRefresh?: boolean }) => Promise<string>;

  /** B2B organization ID */
  orgId: string;

  /** Current user's ID */
  userId: string;

  /** Document ID (used to construct room ID) */
  documentId: string;

  /** Called when a remote Yjs update is applied to the Y.Doc */
  onRemoteUpdate?: (origin: string) => void;

  /**
   * Called after the Y.Doc changes locally, remotely, or during initial sync.
   * The host owns serialization and persistence; runtime only signals that the
   * current decrypted document state is ready to inspect.
   */
  onContentChanged?: (yDoc: Doc) => void;

  /**
   * Called once for each locally-originated Yjs update after runtime has
   * excluded remote, snapshot, persisted-pending, and replica-internal origins.
   * Hosts can use this boundary for lifecycle-level product telemetry without
   * importing analytics into the runtime package.
   */
  onLocalUpdate?: () => void;

  /** Called when awareness state changes from remote users */
  onAwarenessUpdate?: (states: Map<string, AwarenessState>) => void;

  /** Called when connection status changes */
  onStatusChange?: (status: DocumentSyncStatus) => void;

  /**
   * Called when an update reached the Y.Doc but a listener threw while handling
   * it -- in practice, the Lexical binding aborting.
   *
   * This is NOT a payload problem and deliberately does not stop sync, but the
   * host has to know: the document is in the Y.Doc and did not paint, so an
   * editor left on screen shows an empty document that looks blank rather than
   * broken. That is exactly how an unregistered `tracker-reference` node
   * reached production as "some docs still don't load" with nothing but a
   * console error to show for it.
   */
  onEditorBindingError?: (error: unknown) => void;

  /** Structured, content-free desktop observability sink. */
  onOfflineMetric?: (event: {
    metric: string;
    [property: string]: string | number | boolean | null;
  }) => void;

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
   * Epic H3 P1: called when the server reports this document room was relocated
   * to another org by the move engine. The doc id is unchanged; the host should
   * re-resolve which org owns the document and reconnect.
   */
  onRoomMoved?: (dest: { destOrgId: string }) => void;

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
  /**
   * Additive, ephemeral departure marker. Updated clients delete the sender's
   * remote state immediately; older clients ignore it and fall back to their
   * existing stale-state cleanup while retaining the required user block.
   */
  nimbalystDeparture?: { version: 1 };
  /** Lexical-style cursor block (markdown path only). */
  cursor?: {
    anchor: SerializedRelativePosition;
    head: SerializedRelativePosition;
  };
};
