import type { ContentMode } from '../types/WindowModeTypes';

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
    return collabDocumentPath ?? null;
  }

  return localDocumentPath ?? null;
}
