/**
 * TeamDocumentRoom revision-history protocol.
 *
 * User-visible version history for shared documents. Distinct from the
 * `docUpdate` / `docCompact` transport log used by the Yjs sync layer --
 * revisions are sparse, full encrypted snapshots created at meaningful
 * checkpoints (manual save, autosnapshot, pre/post restore).
 *
 * Transport is HTTP request/response against the same DocumentRoom DO
 * that owns the document. Endpoints (all rooted at the document's
 * `/sync/org:{orgId}:doc:{documentId}` path):
 *
 *   GET    .../revisions[?cursor=&limit=]   -> DocRevisionListResponse
 *   GET    .../revisions/{revisionId}        -> DocRevisionDetailResponse
 *   POST   .../revisions                     -> DocRevisionCreateResponse
 *
 * The wire encoding is JSON. Payload ciphertext is base64. The server
 * never decrypts revision payloads; they bind to a per-revision AAD
 * (orgId, documentId, revisionId, purpose=doc-revision) on the client.
 */

/**
 * Kind of revision. Drives retention policy and UI rendering.
 *
 * - `bootstrap`     first revision created when a document is shared.
 * - `manual`        explicit "Save Version" action.
 * - `auto`          autosnapshot taken after a quiet period of edits.
 * - `restore-pre`   mandatory checkpoint taken just before a restore.
 * - `restore-head`  new head revision created by applying a restore.
 */
export type DocRevisionKind =
  | 'bootstrap'
  | 'manual'
  | 'auto'
  | 'restore-pre'
  | 'restore-head';

/**
 * Plaintext metadata stored alongside each revision. Visible to the server
 * for retention/dedupe/listing; never includes user-authored labels in MVP.
 */
export interface DocRevisionMetadata {
  /** Server-assigned opaque identifier. */
  revisionId: string;
  /** Server clock at create time, milliseconds since epoch. */
  createdAt: number;
  /** User who created the revision (room-authed userId). */
  createdBy: string;
  revisionKind: DocRevisionKind;
  /** Logical editor type, e.g. `markdown`, `excalidraw`, `mindmap`. */
  editorType: string;
  /**
   * Snapshot payload format identifier. Editors decide their own value
   * (e.g. `markdown`, `excalidraw-json`, `yjs-state`); the server treats it
   * as opaque.
   */
  contentFormat: string;
  /**
   * Hex-encoded SHA-256 of the plaintext snapshot. Computed on the client
   * before encryption and used by the server for dedupe-on-hash within a
   * short window.
   */
  contentHash: string;
  /** Ciphertext size in bytes. Used for retention size accounting. */
  payloadBytes: number;
  /**
   * Document sequence number that the snapshot reflects -- the largest
   * `encrypted_updates.sequence` applied at the time of capture. Used to
   * distinguish revisions when timestamps tie.
   */
  basisSequence: number;
  /** Previous head revision at create time, if any. */
  parentRevisionId: string | null;
  /** For `restore-head`, the revision that was restored. */
  restoredFromRevisionId: string | null;
}

/**
 * Encrypted snapshot payload. AES-GCM ciphertext; encoding version covers
 * future changes to the canonical plaintext shape.
 */
export interface DocRevisionPayload {
  encryptedSnapshot: string;
  iv: string;
  encodingVersion: number;
}

/** GET .../revisions[?cursor=&limit=] */
export interface DocRevisionListResponse {
  revisions: DocRevisionMetadata[];
  /** Opaque cursor; null when no more pages. */
  cursor: string | null;
}

/** GET .../revisions/{revisionId} */
export interface DocRevisionDetailResponse {
  metadata: DocRevisionMetadata;
  payload: DocRevisionPayload;
}

/** POST .../revisions */
export interface DocRevisionCreateRequest {
  revisionKind: DocRevisionKind;
  editorType: string;
  contentFormat: string;
  contentHash: string;
  basisSequence: number;
  parentRevisionId?: string | null;
  restoredFromRevisionId?: string | null;
  payload: DocRevisionPayload;
}

export interface DocRevisionCreateResponse {
  revisionId: string;
  createdAt: number;
  /**
   * Present when the server short-circuited the create because an existing
   * revision had the same `contentHash` inside the dedupe window. The
   * returned `revisionId` references the existing revision; clients should
   * treat this as a successful no-op.
   */
  dedupedAgainstRevisionId?: string;
}

/** REST error envelope. Mirrors `DocErrorMessage` shape for consistency. */
export interface DocRevisionErrorResponse {
  code: string;
  message: string;
}
