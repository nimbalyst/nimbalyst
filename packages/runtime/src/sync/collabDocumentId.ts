/**
 * Collaborative document id <-> room id helpers.
 *
 * A collab `documentId` is interpolated into a DocumentRoom id and a WebSocket
 * URL path: `/sync/org:<orgId>:doc:<documentId>`. Most ids are UUIDs
 * (`crypto.randomUUID()`) or sha256 hex digests (`getSyncId()`), which are
 * already URL-safe. But some legacy/foreign docs were registered with a raw
 * filename ("Integration 80% of Everything.md") as the id. The space and '%'
 * make a malformed URL that the server rejected with HTTP 400, and the client
 * reconnected forever.
 *
 * Rather than block those docs, we URL-ENCODE the documentId segment when
 * building any room URL. The collab server decodes it back to the canonical
 * raw id before addressing the Durable Object, so the encoding is transparent
 * end to end and the docs open normally. Encoding a UUID / hex digest is a
 * no-op, so existing docs are unaffected.
 *
 * IMPORTANT: keep `documentId` RAW everywhere in app state and crypto (the
 * AES-GCM AAD binds to the raw id on both client and server). Only encode at
 * the exact point a room id is placed into a URL.
 */
const COLLAB_DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * True when `documentId` is already a plain URL-safe token (UUID or sha256
 * hex). Used only to emit a one-time diagnostic for legacy filename-shaped ids
 * -- it never blocks; the id is encoded either way.
 */
export function isValidCollabDocumentId(documentId: unknown): documentId is string {
  return (
    typeof documentId === 'string' &&
    documentId.length > 0 &&
    COLLAB_DOCUMENT_ID_PATTERN.test(documentId)
  );
}

/**
 * Build the room id for a document room with the documentId segment URL-encoded
 * so the result is always a valid URL path component. The collab server decodes
 * it back before addressing the DocumentRoom DO.
 */
export function encodeDocumentRoomId(orgId: string, documentId: string): string {
  return `org:${orgId}:doc:${encodeURIComponent(documentId)}`;
}
