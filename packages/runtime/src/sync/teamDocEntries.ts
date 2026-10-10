/**
 * Wire document-index entries to the client's `DocIndexEntry`, for TeamSync.
 *
 * The server decrypts titles it owns and sends them with the empty-iv sentinel.
 * A non-empty iv is a pre-cutover row from the retired client-managed lane: no
 * supported client holds that key, so the entry is surfaced as locked rather
 * than rendering base64 as a title. Parent kind and sort order are absent from
 * older servers and read as a page parent with no order.
 *
 * Page fields follow the wire's three states: an object is the page's fields,
 * null is none, and absent means the entry does not say (an older server, or a
 * row the server could not read), so the fields already known are kept.
 */

import { normalizePageFields, type TeamClientMessage } from '@nimbalyst/collab-protocol';
import type { DocIndexEntry, EncryptedDocIndexEntry } from './teamSyncTypes';

/** The readable entry, or throws when the title is pre-cutover ciphertext. */
export function decodeDocEntry(encrypted: EncryptedDocIndexEntry, known?: DocIndexEntry): DocIndexEntry {
  if (encrypted.titleIv) {
    throw new Error('doc-index title is pre-cutover client-encrypted content and can no longer be read');
  }
  return { ...entryFields(encrypted, known), title: encrypted.encryptedTitle };
}

/**
 * The entry for a title that could not be read. When the client already knows
 * this document by a readable title, a broadcast that only moved metadata keeps
 * it instead of turning a visible page into a locked one.
 */
export function lockedDocEntry(encrypted: EncryptedDocIndexEntry, known?: DocIndexEntry): DocIndexEntry {
  if (known && !known.decryptFailed && known.title) return { ...entryFields(encrypted, known), title: known.title };
  return { ...entryFields(encrypted, known), title: '', decryptFailed: true };
}

/**
 * The offline queue keeps one message per page and kind. Two field patches to
 * one page merge, the later value winning per key, so the second edit made
 * offline does not drop the first.
 */
export function mergeQueuedMessage(previous: TeamClientMessage | undefined, next: TeamClientMessage): TeamClientMessage {
  if (previous?.type !== 'docIndexSetFields' || next.type !== 'docIndexSetFields') return next;
  return { ...next, fields: { ...previous.fields, ...next.fields } };
}

function entryFields(e: EncryptedDocIndexEntry, known: DocIndexEntry | undefined): Omit<DocIndexEntry, 'title'> {
  const fields = e.fields === undefined ? known?.fields : normalizePageFields(e.fields);
  return {
    documentId: e.documentId,
    projectId: e.projectId ?? null,
    documentType: e.documentType,
    metadataVersion: e.metadataVersion,
    fileExtension: e.fileExtension,
    editorId: e.editorId,
    createdBy: e.createdBy,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    lastWriterUserId: e.lastWriterUserId ?? null,
    parentFolderId: e.parentFolderId ?? null,
    parentKind: e.parentKind ?? 'page',
    sortOrder: e.sortOrder ?? null,
    trashedAt: e.trashedAt ?? null,
    ...(e.hasContent === false ? { hasContent: false } : {}),
    ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
  };
}
