/**
 * Editor Atoms
 *
 * Per-editor-instance state using atom families keyed by EditorKey.
 * This allows the same file to be open in multiple contexts (main vs worktrees)
 * with independent state per instance.
 *
 * Key principle: Editor components WRITE to these atoms, UI components (Tab, TabBar) READ.
 * The parent (TabEditor) neither reads nor writes - it just passes EditorHost to the editor.
 */
import type { EditorKey, EditorContext } from '../utils/editorKey';
/**
 * Per-editor dirty state.
 * Set by editor when content changes, cleared on save.
 * Tab component subscribes to show dirty indicator.
 */
export declare const editorDirtyAtom: import("jotai-family").AtomFamily<EditorKey, import("jotai").PrimitiveAtom<boolean> & {
    init: boolean;
}>;
/**
 * Per-editor processing state.
 * Set when AI is making changes to the editor content.
 * Tab component subscribes to show processing indicator.
 */
export declare const editorProcessingAtom: import("jotai-family").AtomFamily<EditorKey, import("jotai").PrimitiveAtom<boolean> & {
    init: boolean;
}>;
/**
 * Per-editor pending review state.
 * Set when AI has made changes that need user approval.
 * Tab component subscribes to show pending changes indicator.
 */
export declare const editorHasUnacceptedChangesAtom: import("jotai-family").AtomFamily<EditorKey, import("jotai").PrimitiveAtom<boolean> & {
    init: boolean;
}>;
/**
 * Tab IDs per context.
 * TabBar subscribes to this to know which tabs to render.
 * When this changes, TabBar re-renders to add/remove/reorder tabs.
 * Individual tab metadata changes do NOT trigger TabBar re-render.
 */
export declare const tabIdsAtom: import("jotai-family").AtomFamily<EditorContext, import("jotai").PrimitiveAtom<EditorKey[]> & {
    init: EditorKey[];
}>;
/**
 * Active tab per context.
 * TabContent subscribes to this to show/hide editors.
 */
export declare const activeTabIdAtom: import("jotai-family").AtomFamily<EditorContext, import("jotai").PrimitiveAtom<EditorKey | null> & {
    init: EditorKey | null;
}>;
/**
 * Tab metadata that doesn't affect dirty/processing state.
 * Used for pinned status, custom icons, etc.
 */
export interface TabMetadata {
    isPinned: boolean;
    isVirtual: boolean;
    customTitle?: string;
    customIcon?: string;
}
export declare const tabMetadataAtom: import("jotai-family").AtomFamily<EditorKey, import("jotai").PrimitiveAtom<TabMetadata> & {
    init: TabMetadata;
}>;
/**
 * Derived: Count of dirty editors in a context.
 * Window title can subscribe to show unsaved count.
 */
export declare const dirtyEditorCountAtom: import("jotai-family").AtomFamily<EditorContext, import("jotai").Atom<number>>;
/**
 * Derived: Check if any editor has pending review.
 * Useful for showing a global indicator.
 */
export declare const hasAnyPendingReviewAtom: import("jotai-family").AtomFamily<EditorContext, import("jotai").Atom<boolean>>;
/**
 * Actions for managing tabs.
 * These are write-only atoms that modify the tab state.
 */
/**
 * Add a new tab to a context.
 * If virtual, replaces any existing virtual tab.
 */
export declare const addTabAtom: import("jotai").WritableAtom<null, [{
    context: EditorContext;
    key: EditorKey;
    isVirtual?: boolean;
}], void> & {
    init: null;
};
/**
 * Close a tab.
 */
export declare const closeTabAtom: import("jotai").WritableAtom<null, [{
    context: EditorContext;
    key: EditorKey;
}], void> & {
    init: null;
};
/**
 * Reorder tabs within a context.
 */
export declare const reorderTabsAtom: import("jotai").WritableAtom<null, [{
    context: EditorContext;
    newOrder: EditorKey[];
}], void> & {
    init: null;
};
