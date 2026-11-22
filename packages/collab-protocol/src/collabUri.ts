/**
 * Collaborative document URI utilities
 *
 * URI format: collab://org:{orgId}:doc:{documentId}
 *
 * These URIs identify collaborative documents backed by DocumentRoom
 * Durable Objects. They are used as tab identifiers in the tab system,
 * similar to how virtual:// URIs are used for non-filesystem tabs.
 */

import type { TeamDocumentRoomId } from './roomIds.js';

const COLLAB_PREFIX = 'collab://';

/**
 * Check if a path is a collaborative document URI.
 */
export function isCollabUri(path: string): boolean {
  return path.startsWith(COLLAB_PREFIX);
}

const COLLAB_FILE_TYPE_PREFIX = 'collab-';

/**
 * The AI-facing `fileType` tag for a shared document of `documentType`.
 *
 * Agent prompts branch on this to say "reach this through readCollabDoc /
 * applyCollabDocEdit, not Read/Edit". The document's own type is carried in the
 * suffix so the prompt can also say WHAT it is -- a shared mockup and a shared
 * markdown note take the same tools but are not the same document.
 */
export function collabFileTypeFor(documentType: string | undefined): string {
  return `${COLLAB_FILE_TYPE_PREFIX}${documentType || 'document'}`;
}

/**
 * Whether a `fileType` denotes a shared collaborative document of any type.
 *
 * Prefer this over comparing against `'collab-markdown'`: that literal silently
 * excluded every custom-editor document type, which is how shared mockups ended
 * up described to agents as markdown.
 */
export function isCollabDocumentFileType(fileType: string | null | undefined): boolean {
  return typeof fileType === 'string' && fileType.startsWith(COLLAB_FILE_TYPE_PREFIX);
}

/** The document type carried in a `collab-*` fileType tag, if any. */
export function collabDocumentTypeFromFileType(
  fileType: string | null | undefined,
): string | undefined {
  if (!isCollabDocumentFileType(fileType)) return undefined;
  const documentType = fileType!.slice(COLLAB_FILE_TYPE_PREFIX.length);
  return documentType === 'document' ? undefined : documentType;
}

/**
 * Parse a collab:// URI into its component parts.
 * Throws if the URI doesn't match the expected format.
 *
 * @example
 * parseCollabUri('collab://org:abc123:doc:xyz789')
 * // => { orgId: 'abc123', documentId: 'xyz789' }
 */
export function parseCollabUri(uri: string): { orgId: string; documentId: string } {
  if (!isCollabUri(uri)) {
    throw new Error(`Not a collab URI: ${uri}`);
  }

  const path = uri.slice(COLLAB_PREFIX.length);
  // Expected format: org:{orgId}:doc:{documentId}
  const match = /^org:([^:]+):doc:(.+)$/.exec(path);
  const orgId = match?.[1];
  const documentId = match?.[2];
  if (orgId === undefined || documentId === undefined) {
    throw new Error(`Invalid collab URI format: ${uri}`);
  }

  return {
    orgId,
    documentId,
  };
}

/** The document id prefix of a typed page's body room: `tracker-content/<itemId>`. */
export const TRACKER_BODY_DOCUMENT_PREFIX = 'tracker-content/';

/**
 * The tracker item behind a typed-page body URI, or null for any other URI.
 *
 * Agents are handed the short form, `collab://tracker-content/<itemId>`, whose
 * org is the project's team; the long form names the org itself. A body room is
 * not in the shared-docs index, so callers resolve it from the item id.
 */
export function parseTrackerBodyUri(uri: string): { itemId: string; orgId: string | null } | null {
  if (!isCollabUri(uri)) return null;
  const short = uri.slice(COLLAB_PREFIX.length);
  if (short.startsWith(TRACKER_BODY_DOCUMENT_PREFIX)) {
    const itemId = short.slice(TRACKER_BODY_DOCUMENT_PREFIX.length);
    return itemId ? { itemId, orgId: null } : null;
  }
  const match = /^org:([^:]+):doc:tracker-content\/(.+)$/.exec(short);
  return match ? { itemId: match[2]!, orgId: match[1]! } : null;
}

/**
 * Build a collab:// URI from org and document IDs.
 *
 * @example
 * buildCollabUri('abc123', 'xyz789')
 * // => 'collab://org:abc123:doc:xyz789'
 */
export function buildCollabUri(orgId: string, documentId: string): string {
  return `${COLLAB_PREFIX}org:${orgId}:doc:${documentId}`;
}

/**
 * Build the DocumentRoom ID from a collab URI.
 * This matches the room ID format used by the collabv3 server routing.
 */
export function collabUriToRoomId(uri: string): TeamDocumentRoomId {
  const { orgId, documentId } = parseCollabUri(uri);
  return `org:${orgId}:doc:${documentId}`;
}
