import type {
  SharedDocument,
  SharedFolder,
} from '../store/atoms/collabDocuments';
import {
  getSharedDocumentDisplayName,
  getSharedDocumentDisplayPath,
} from '../components/CollabMode/collabTree';

export interface SharedDocumentSearchResult {
  document: SharedDocument;
  displayName: string;
  displayPath: string;
}

/**
 * Search the live team document index without coupling consumers to a UI.
 * Command-open and shared-file mentions can both project these results into
 * their own result shapes while keeping locked documents unselectable.
 */
export function searchSharedDocuments(
  documents: SharedDocument[],
  folders: SharedFolder[],
  query: string,
): SharedDocumentSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();

  return documents
    .filter((document) => !document.decryptFailed)
    .map((document) => {
      const displayPath = getSharedDocumentDisplayPath(document, folders);
      return {
        document,
        displayName: getSharedDocumentDisplayName(displayPath, document.documentId),
        displayPath,
      };
    })
    .filter(({ displayName, displayPath }) => {
      if (!normalizedQuery) return true;
      return displayName.toLowerCase().includes(normalizedQuery)
        || displayPath.toLowerCase().includes(normalizedQuery);
    })
    .sort((a, b) => (b.document.updatedAt ?? 0) - (a.document.updatedAt ?? 0));
}
