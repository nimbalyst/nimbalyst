/**
 * Document Model Atoms
 *
 * Per-file state derived from DocumentModel instances.
 * These atoms bridge the DocumentModel coordination layer into the
 * reactive Jotai world so that UI components (tab indicators, mode
 * switch handlers, etc.) can subscribe to document-level state.
 *
 * Unlike editor atoms (keyed by EditorKey = file + context), these are
 * keyed by file path alone because DocumentModel is shared across all
 * editor instances for the same file.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

// -- Types (duplicated from document-model/types to avoid cross-package import) --

export interface DocumentDiffState {
  tagId: string;
  sessionId: string;
  oldContent: string;
  newContent: string;
  createdAt: number;
}

// -- Atoms ------------------------------------------------------------------

/**
 * Per-file dirty state (OR of all editors for that file).
 * Written by DocumentModel event listeners.
 * Read by UI components that need file-level dirty info
 * (as opposed to editor-instance-level).
 */
export const documentDirtyAtom = atomFamily((_filePath: string) => atom(false));

/**
 * Per-file diff state.
 * Written by DocumentModel when it enters/exits diff mode.
 * Read by UI components that need to show diff indicators.
 */
export const documentDiffStateAtom = atomFamily((_filePath: string) =>
  atom<DocumentDiffState | null>(null),
);

/**
 * Per-file attach count (number of editors viewing this file).
 * Useful for debugging and for features like "file is open in N editors."
 */
export const documentAttachCountAtom = atomFamily((_filePath: string) => atom(0));

/**
 * Derived: Is any file in the workspace dirty?
 * Tracks all file paths that have been registered.
 */
export const registeredDocumentPathsAtom = atom<string[]>([]);

/**
 * Derived: Count of dirty documents across the workspace.
 */
export const dirtyDocumentCountAtom = atom((get) => {
  const paths = get(registeredDocumentPathsAtom);
  return paths.filter((path) => get(documentDirtyAtom(path))).length;
});

/**
 * Derived: Any file has a pending diff?
 */
export const hasAnyPendingDiffAtom = atom((get) => {
  const paths = get(registeredDocumentPathsAtom);
  return paths.some((path) => get(documentDiffStateAtom(path)) !== null);
});
