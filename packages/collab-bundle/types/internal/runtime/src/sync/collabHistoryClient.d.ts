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
import type { DocRevisionCreateResponse, DocRevisionKind, DocRevisionListResponse, DocRevisionMetadata } from '@nimbalyst/collab-protocol';
import type { TeamJwt } from '../auth/jwtScopes';
export interface CollabHistoryClientConfig {
    /** Sync server URL, e.g. `wss://sync.nimbalyst.com`. Converted to https://. */
    serverUrl: string;
    /** Async accessor for the room JWT (same as DocumentSyncConfig.getJwt). */
    getJwt: () => Promise<TeamJwt>;
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
export declare class CollabHistoryError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
export declare class CollabHistoryClient {
    private readonly config;
    private readonly httpBase;
    private readonly roomId;
    constructor(config: CollabHistoryClientConfig);
    listRevisions(opts?: {
        cursor?: string | null;
        limit?: number;
    }): Promise<DocRevisionListResponse>;
    /**
     * Load a single revision and decrypt its snapshot payload.
     */
    loadRevision(revisionId: string): Promise<LoadedRevision>;
    /**
     * Encrypt and submit a new revision. Server may dedupe against an
     * identical recent revision and return its id instead.
     */
    createRevision(input: CreateRevisionInput): Promise<DocRevisionCreateResponse>;
    private fetchAuthed;
    private encodePayload;
    private buildRequestUrl;
}
