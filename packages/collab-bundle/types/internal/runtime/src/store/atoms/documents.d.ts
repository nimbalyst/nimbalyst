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
export interface DocumentDiffState {
    tagId: string;
    sessionId: string;
    oldContent: string;
    newContent: string;
    createdAt: number;
}
/**
 * Per-file dirty state (OR of all editors for that file).
 * Written by DocumentModel event listeners.
 * Read by UI components that need file-level dirty info
 * (as opposed to editor-instance-level).
 */
export declare const documentDirtyAtom: import("jotai-family").AtomFamily<string, import("jotai").PrimitiveAtom<boolean> & {
    init: boolean;
}>;
/**
 * Per-file diff state.
 * Written by DocumentModel when it enters/exits diff mode.
 * Read by UI components that need to show diff indicators.
 */
export declare const documentDiffStateAtom: import("jotai-family").AtomFamily<string, import("jotai").PrimitiveAtom<DocumentDiffState | null> & {
    init: DocumentDiffState | null;
}>;
/**
 * Per-file attach count (number of editors viewing this file).
 * Useful for debugging and for features like "file is open in N editors."
 */
export declare const documentAttachCountAtom: import("jotai-family").AtomFamily<string, import("jotai").PrimitiveAtom<number> & {
    init: number;
}>;
/**
 * Derived: Is any file in the workspace dirty?
 * Tracks all file paths that have been registered.
 */
export declare const registeredDocumentPathsAtom: import("jotai").PrimitiveAtom<string[]> & {
    init: string[];
};
/**
 * Derived: Count of dirty documents across the workspace.
 */
export declare const dirtyDocumentCountAtom: import("jotai").Atom<number>;
/**
 * Derived: Any file has a pending diff?
 */
export declare const hasAnyPendingDiffAtom: import("jotai").Atom<boolean>;
