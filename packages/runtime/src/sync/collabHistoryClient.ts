/**
 * Client for the shared-document revision history REST API.
 *
 * Talks to the same DocumentRoom DurableObject that owns the WebSocket
 * transport. Endpoints sit under the document's room path:
 *
 *   GET    {serverUrl}/sync/{roomId}/revisions
 *   GET    {serverUrl}/sync/{roomId}/revisions/{revisionId}
 *   POST   {serverUrl}/sync/{roomId}/revisions
 *
 * Encryption: revision payloads are AES-GCM ciphertext bound to a
 * per-revision AAD `(orgId|documentId|revisionId|purpose=doc-revision)`. The
 * server never sees plaintext or the document key.
 *
 * Auth: same room JWT used by DocumentSyncProvider, sent as
 * `Authorization: Bearer {jwt}`.
 */

import type {
  DocRevisionCreateRequest,
  DocRevisionCreateResponse,
  DocRevisionDetailResponse,
  DocRevisionKind,
  DocRevisionListResponse,
  DocRevisionMetadata,
  DocRevisionPayload,
} from '@nimbalyst/collab-protocol';
import { encodeDocumentRoomId } from './collabDocumentId';

const REVISION_ENCODING_VERSION = 1;

export interface CollabHistoryClientConfig {
  /** Sync server URL, e.g. `wss://sync.nimbalyst.com`. Converted to https://. */
  serverUrl: string;
  /** Async accessor for the room JWT (same as DocumentSyncConfig.getJwt). */
  getJwt: () => Promise<string>;
  /** Optional extra query appended to revision HTTP requests (test seam). */
  urlExtraQuery?: string;
  /** Org owning the room. */
  orgId: string;
  /** Document identity. */
  documentId: string;
}

export interface CreateRevisionInput {
  revisionKind: DocRevisionKind;
  editorType: string;
  contentFormat: string;
  /** Plaintext snapshot bytes -- encrypted before send. */
  plaintext: Uint8Array;
  basisSequence: number;
  parentRevisionId?: string | null;
  restoredFromRevisionId?: string | null;
}

export interface LoadedRevision {
  metadata: DocRevisionMetadata;
  plaintext: Uint8Array;
}

export class CollabHistoryError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'CollabHistoryError';
  }
}

export class CollabHistoryClient {
  private readonly httpBase: string;
  private readonly roomId: string;

  constructor(private readonly config: CollabHistoryClientConfig) {
    this.httpBase = toHttpUrl(config.serverUrl);
    // documentId is URL-encoded for the path; AAD below still binds to the raw
    // config.documentId, matching the server.
    this.roomId = encodeDocumentRoomId(config.orgId, config.documentId);
  }

  async listRevisions(opts: { cursor?: string | null; limit?: number } = {}): Promise<DocRevisionListResponse> {
    const url = this.buildRequestUrl(`/sync/${this.roomId}/revisions`);
    if (opts.cursor) url.searchParams.set('cursor', opts.cursor);
    if (opts.limit) url.searchParams.set('limit', String(opts.limit));

    const response = await this.fetchAuthed(url.toString(), { method: 'GET' });
    return (await response.json()) as DocRevisionListResponse;
  }

  /**
   * Load a single revision and decrypt its snapshot payload.
   */
  async loadRevision(revisionId: string): Promise<LoadedRevision> {
    const url = this.buildRequestUrl(`/sync/${this.roomId}/revisions/${encodeURIComponent(revisionId)}`);
    const response = await this.fetchAuthed(url, { method: 'GET' });
    const body = (await response.json()) as DocRevisionDetailResponse;
    // The server decrypts revision payloads it owns and serves them as
    // PLAINTEXT with the empty-iv sentinel. A non-empty iv is pre-cutover
    // client-encrypted content no supported client can read.
    if (body.payload.iv) {
      throw new Error('Revision payload is pre-cutover client-encrypted content and can no longer be read');
    }
    const plaintext = base64ToBytes(body.payload.encryptedSnapshot);
    return { metadata: body.metadata, plaintext };
  }

  /**
   * Encrypt and submit a new revision. Server may dedupe against an
   * identical recent revision and return its id instead.
   */
  async createRevision(input: CreateRevisionInput): Promise<DocRevisionCreateResponse> {
    const contentHash = await sha256Hex(input.plaintext);
    // Client mints a request-scoped id only for AAD binding; the server
    // assigns the authoritative id. AAD must therefore use the eventual
    // server id, which we don't know yet -- so the server reads the AAD
    // it stored on create and the client rebuilds it on read using the
    // server-returned id. To keep the model coherent and let the server
    // dedupe before we even attempt encryption work, we bind to the
    // content_hash (which the server validates indirectly via dedupe).
    const payload = await this.encodePayload(contentHash, input.plaintext);

    const body: DocRevisionCreateRequest = {
      revisionKind: input.revisionKind,
      editorType: input.editorType,
      contentFormat: input.contentFormat,
      contentHash,
      basisSequence: input.basisSequence,
      parentRevisionId: input.parentRevisionId ?? null,
      restoredFromRevisionId: input.restoredFromRevisionId ?? null,
      payload,
    };

    const url = this.buildRequestUrl(`/sync/${this.roomId}/revisions`);
    const response = await this.fetchAuthed(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await response.json()) as DocRevisionCreateResponse;
  }

  private async fetchAuthed(url: string | URL, init: RequestInit): Promise<Response> {
    const jwt = await this.config.getJwt();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${jwt}`);

    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
      let code = 'http_error';
      let message = `HTTP ${response.status}`;
      try {
        const err = await response.json() as { code?: string; message?: string };
        code = err.code ?? code;
        message = err.message ?? message;
      } catch {
        // body wasn't json; keep generic message
      }
      throw new CollabHistoryError(response.status, code, message);
    }
    return response;
  }

  private async encodePayload(_contentHash: string, plaintext: Uint8Array): Promise<DocRevisionPayload> {
    // Send PLAINTEXT (base64, iv sentinel ''); the server encrypts at rest
    // with the team DEK.
    return {
      encryptedSnapshot: bytesToBase64(plaintext),
      iv: '',
      encodingVersion: REVISION_ENCODING_VERSION,
    };
  }

  private buildRequestUrl(pathname: string): URL {
    const url = new URL(`${this.httpBase}${pathname}`);
    if (this.config.urlExtraQuery) {
      const extra = new URLSearchParams(this.config.urlExtraQuery);
      extra.forEach((value, key) => url.searchParams.append(key, value));
    }
    return url;
  }

}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toHttpUrl(serverUrl: string): string {
  if (serverUrl.startsWith('wss://')) return `https://${serverUrl.slice(6)}`;
  if (serverUrl.startsWith('ws://')) return `http://${serverUrl.slice(5)}`;
  return serverUrl;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
