/**
 * Set type on a Local wiki page is a frontmatter change: the page keeps its
 * file, id, place, body and children, and gains `type:`. Main refuses a type
 * that is not a wiki type (Decision 9: its items stay in the app database).
 * A database Personal page not exported yet keeps the old copy-into-an-item
 * path.
 */
import { getPersonalCollabHost } from '../store/atoms/collabDocuments';

/** True when the page is in the Local wiki folder, so Set type happens in place. */
export function isLocalWikiPage(workspacePath: string, documentId: string): boolean {
  return !getPersonalCollabHost(workspacePath).source().isLegacyDocument(documentId);
}

/** Gives a Local wiki page a type in place; returns the page id, which is also the item id. */
export async function setLocalWikiPageType(workspacePath: string, documentId: string, typeId: string): Promise<string> {
  await window.electronAPI.invoke('local-wiki:command', workspacePath, { type: 'set-document-type', documentId, pageType: typeId });
  return documentId;
}
