/**
 * How an agent addresses a Personal page (Decision 20). Personal pages live in
 * the local database, never in a collab room, so they have their own scheme
 * beside `collab://`:
 *
 *   personal://<documentId>                a Personal page (same as its tab path)
 *   personal://tracker-content/<itemId>    the body of a Personal typed page,
 *                                          the local twin of collab://tracker-content/<itemId>
 */

export const PERSONAL_PAGE_URI_PREFIX = 'personal://';
const PERSONAL_TYPED_PAGE_PREFIX = `${PERSONAL_PAGE_URI_PREFIX}tracker-content/`;

export type PersonalPageTarget =
  | { kind: 'page'; documentId: string }
  | { kind: 'typed-page'; itemId: string };

export function isPersonalPageUri(uri: string | null | undefined): boolean {
  return typeof uri === 'string' && uri.startsWith(PERSONAL_PAGE_URI_PREFIX);
}

export function parsePersonalPageUri(uri: string): PersonalPageTarget | null {
  if (uri.startsWith(PERSONAL_TYPED_PAGE_PREFIX)) {
    const itemId = uri.slice(PERSONAL_TYPED_PAGE_PREFIX.length);
    return itemId && !itemId.includes('/') ? { kind: 'typed-page', itemId } : null;
  }
  if (!uri.startsWith(PERSONAL_PAGE_URI_PREFIX)) return null;
  const documentId = uri.slice(PERSONAL_PAGE_URI_PREFIX.length);
  return documentId && !documentId.includes('/') ? { kind: 'page', documentId } : null;
}

export function personalTypedPageUri(itemId: string): string {
  return `${PERSONAL_TYPED_PAGE_PREFIX}${itemId}`;
}

/** Prefix of a Personal page body's history key, which is also its editor's document path. */
export const PERSONAL_PAGE_HISTORY_PREFIX = 'personal-doc://';

/** The local-history key a Personal page's body is snapshotted under. */
export function personalPageHistoryKey(documentId: string): string {
  return `${PERSONAL_PAGE_HISTORY_PREFIX}${documentId}`;
}

/** The local-history key a Personal typed page's body is snapshotted under. */
export const PERSONAL_TYPED_PAGE_HISTORY_PREFIX = 'personal-doc://tracker-content/';

export function personalTypedPageHistoryKey(itemId: string): string {
  return `${PERSONAL_TYPED_PAGE_HISTORY_PREFIX}${itemId}`;
}
