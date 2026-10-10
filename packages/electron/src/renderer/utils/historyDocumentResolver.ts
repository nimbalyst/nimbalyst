import type { ContentMode } from '../types/WindowModeTypes';
import { parsePersonalPageUri, personalPageHistoryKey } from '../../shared/personalPageUri';

interface HistoryDocumentPaths {
  activeMode: ContentMode;
  localDocumentPath?: string | null;
  collabDocumentPath?: string | null;
}

/** Resolve the document whose history should open for the currently focused mode. */
export function resolveHistoryDocumentPath({
  activeMode,
  localDocumentPath,
  collabDocumentPath,
}: HistoryDocumentPaths): string | null {
  if (activeMode === 'collab') {
    // A Personal page tab (`personal://<id>`) keeps its history under its document.
    const personal = collabDocumentPath ? parsePersonalPageUri(collabDocumentPath) : null;
    if (personal?.kind === 'page') return personalPageHistoryKey(personal.documentId);
    return collabDocumentPath ?? null;
  }

  return localDocumentPath ?? null;
}
