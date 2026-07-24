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

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { EditorKey, EditorContext } from '../utils/editorKey';

/**
 * Per-editor dirty state.
 * Set by editor when content changes, cleared on save.
 * Tab component subscribes to show dirty indicator.
 */
export const editorDirtyAtom = atomFamily((_key: EditorKey) => atom(false));

/**
 * Per-editor processing state.
 * Set when AI is making changes to the editor content.
 * Tab component subscribes to show processing indicator.
 */
export const editorProcessingAtom = atomFamily((_key: EditorKey) =>
  atom(false)
);

/**
 * Per-editor pending review state.
 * Set when AI has made changes that need user approval.
 * Tab component subscribes to show pending changes indicator.
 */
export const editorHasUnacceptedChangesAtom = atomFamily((_key: EditorKey) =>
  atom(false)
);

/**
 * Tab IDs per context.
 * TabBar subscribes to this to know which tabs to render.
 * When this changes, TabBar re-renders to add/remove/reorder tabs.
 * Individual tab metadata changes do NOT trigger TabBar re-render.
 */
export const tabIdsAtom = atomFamily((_context: EditorContext) =>
  atom<EditorKey[]>([])
);

/**
 * Active tab per context.
 * TabContent subscribes to this to show/hide editors.
 */
export const activeTabIdAtom = atomFamily((_context: EditorContext) =>
  atom<EditorKey | null>(null)
);

/**
 * Tab metadata that doesn't affect dirty/processing state.
 * Used for pinned status, custom icons, etc.
 */
export interface TabMetadata {
  isPinned: boolean;
  isVirtual: boolean; // Preview tab
  customTitle?: string;
  customIcon?: string;
}

const defaultTabMetadata: TabMetadata = {
  isPinned: false,
  isVirtual: false,
};

export const tabMetadataAtom = atomFamily((_key: EditorKey) =>
  atom<TabMetadata>(defaultTabMetadata)
);

/**
 * Derived: Count of dirty editors in a context.
 * Window title can subscribe to show unsaved count.
 */
export const dirtyEditorCountAtom = atomFamily((context: EditorContext) =>
  atom((get) => {
    const tabIds = get(tabIdsAtom(context));
    return tabIds.filter((key) => get(editorDirtyAtom(key))).length;
  })
);

/**
 * Derived: Check if any editor has pending review.
 * Useful for showing a global indicator.
 */
export const hasAnyPendingReviewAtom = atomFamily((context: EditorContext) =>
  atom((get) => {
    const tabIds = get(tabIdsAtom(context));
    return tabIds.some((key) => get(editorHasUnacceptedChangesAtom(key)));
  })
);

/**
 * Actions for managing tabs.
 * These are write-only atoms that modify the tab state.
 */

/**
 * Add a new tab to a context.
 * If virtual, replaces any existing virtual tab.
 */
export const addTabAtom = atom(
  null,
  (
    get,
    set,
    {
      context,
      key,
      isVirtual = false,
    }: {
      context: EditorContext;
      key: EditorKey;
      isVirtual?: boolean;
    }
  ) => {
    const currentTabs = get(tabIdsAtom(context));

    // Already open?
    if (currentTabs.includes(key)) {
      set(activeTabIdAtom(context), key);
      // If opening non-virtually, make it permanent
      if (!isVirtual) {
        const metadata = get(tabMetadataAtom(key));
        if (metadata.isVirtual) {
          set(tabMetadataAtom(key), { ...metadata, isVirtual: false });
        }
      }
      return;
    }

    // If virtual, remove any existing virtual tab
    let newTabs = currentTabs;
    if (isVirtual) {
      const virtualKey = currentTabs.find(
        (k) => get(tabMetadataAtom(k)).isVirtual
      );
      if (virtualKey) {
        newTabs = currentTabs.filter((k) => k !== virtualKey);
        // Cleanup the old virtual tab's atoms
        editorDirtyAtom.remove(virtualKey);
        editorProcessingAtom.remove(virtualKey);
        editorHasUnacceptedChangesAtom.remove(virtualKey);
        tabMetadataAtom.remove(virtualKey);
      }
    }

    // Add the new tab
    set(tabIdsAtom(context), [...newTabs, key]);
    set(tabMetadataAtom(key), { ...defaultTabMetadata, isVirtual });
    set(activeTabIdAtom(context), key);
  }
);

/**
 * Close a tab.
 */
export const closeTabAtom = atom(
  null,
  (
    get,
    set,
    { context, key }: { context: EditorContext; key: EditorKey }
  ) => {
    const currentTabs = get(tabIdsAtom(context));
    const idx = currentTabs.indexOf(key);
    if (idx === -1) return;

    // Remove from list
    const newTabs = currentTabs.filter((k) => k !== key);
    set(tabIdsAtom(context), newTabs);

    // If this was active, activate adjacent tab
    if (get(activeTabIdAtom(context)) === key) {
      if (newTabs.length > 0) {
        const newActiveIdx = Math.min(idx, newTabs.length - 1);
        set(activeTabIdAtom(context), newTabs[newActiveIdx]);
      } else {
        set(activeTabIdAtom(context), null);
      }
    }

    // Cleanup atoms for this tab
    editorDirtyAtom.remove(key);
    editorProcessingAtom.remove(key);
    editorHasUnacceptedChangesAtom.remove(key);
    tabMetadataAtom.remove(key);
  }
);

/**
 * Reorder tabs within a context.
 */
export const reorderTabsAtom = atom(
  null,
  (
    _get,
    set,
    { context, newOrder }: { context: EditorContext; newOrder: EditorKey[] }
  ) => {
    set(tabIdsAtom(context), newOrder);
  }
);
