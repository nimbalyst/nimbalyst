/**
 * Trash in a Pages section. Removing a page sends it and every page below it
 * to Trash with one trash time (`CollabDocsSession.removePage`), so Trash shows
 * that as one entry and restore brings the whole subtree back. Types and typed
 * pages placed under the page never go to Trash: their placements stay, so they
 * show in their usual place meanwhile and are back under the page once it is.
 *
 * Team Trash is emptied by the server 30 days after a page went in; Personal
 * Trash keeps a page until it is restored. Nothing here deletes anything.
 */
import { isTypePageDocumentId } from './collabTree';
import type { SharedDocument } from './types';

/** A page and the pages that went to Trash with it (below it, same trash time), the page first. */
export function pagesTrashedWith(documents: SharedDocument[], documentId: string): string[] {
  const trashedAt = documents.find((document) => document.documentId === documentId)?.trashedAt;
  const ids = [documentId];
  for (let index = 0; trashedAt != null && index < ids.length; index++) {
    for (const document of documents) {
      if (document.parentFolderId === ids[index] && (document.parentKind ?? 'page') === 'page'
        && document.trashedAt === trashedAt && !ids.includes(document.documentId)) ids.push(document.documentId);
    }
  }
  return ids;
}

/**
 * Whether restoring `documentId` (with `restoring`, the pages coming back with
 * it) would leave it under a page that is not in the tree: one deleted for
 * good, or one still in Trash. Such a page goes to the section root. A typed
 * page parent is not checked; the page tree holds no list of typed pages.
 */
export function restoredParentGone(documents: SharedDocument[], documentId: string, restoring: ReadonlySet<string>): boolean {
  const document = documents.find((candidate) => candidate.documentId === documentId);
  if (!document?.parentFolderId || document.parentKind === 'item') return false;
  const parent = documents.find((candidate) => candidate.documentId === document.parentFolderId);
  return !parent || (parent.trashedAt != null && !restoring.has(parent.documentId));
}

export interface CollabTrashEntry {
  document: SharedDocument;
  /** Pages that went to Trash with it and come back with it. */
  insideCount: number;
}

/**
 * One entry per page a person (or agent) sent to Trash, newest first; the
 * pages that went with it are counted on it, not listed. A type's prose page
 * is not counted as a page.
 */
export function listTrashEntries(trashed: SharedDocument[]): CollabTrashEntry[] {
  const byId = new Map(trashed.map((document) => [document.documentId, document]));
  return trashed
    .filter((document) => {
      if (document.trashedAt == null) return false;
      const parent = document.parentFolderId && (document.parentKind ?? 'page') === 'page'
        ? byId.get(document.parentFolderId)
        : undefined;
      return !parent || parent.trashedAt !== document.trashedAt;
    })
    .sort((left, right) => (right.trashedAt ?? 0) - (left.trashedAt ?? 0))
    .map((document) => ({
      document,
      insideCount: pagesTrashedWith(trashed, document.documentId)
        .filter((id) => id !== document.documentId && !isTypePageDocumentId(id)).length,
    }));
}
