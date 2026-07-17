/**
 * Session Editor State Atoms
 *
 * Per-session state management for the embedded editor area in agent mode.
 * Each AI session can have its own set of open tabs and layout preferences,
 * independent of the main workspace tabs.
 *
 * Pattern: atomFamily for per-session state, derived atoms for UI subscriptions.
 *
 * @example
 * // Read session editor state
 * const state = useAtomValue(sessionEditorStateAtom(sessionId));
 *
 * // Open a file in the session editor
 * const openFile = useSetAtom(openFileInSessionEditorAtom);
 * openFile({ sessionId, filePath: '/path/to/file.ts' });
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { store } from '@nimbalyst/runtime/store';
import {
  type EditorKey,
  type EditorContext,
  makeEditorKey,
  makeEditorContext,
} from '@nimbalyst/runtime/store';
import { addTabAtom, tabIdsAtom, activeTabIdAtom } from '@nimbalyst/runtime/store';

// ============================================================
// Types
// ============================================================

/**
 * Layout mode for the session editor split view.
 * - 'editor': Editor area maximized, transcript hidden
 * - 'split': Both editor and transcript visible with adjustable ratio
 * - 'transcript': Transcript maximized, editor hidden (default)
 */
export type SessionLayoutMode = 'editor' | 'split' | 'transcript';

/**
 * Per-session editor state.
 * Tracks layout mode, split ratio, and which tab is active.
 */
export interface SessionEditorState {
  /** Which panel is maximized or in split mode */
  layoutMode: SessionLayoutMode;
  /** Split ratio (0-1), remembered when toggling back to split mode */
  splitRatio: number;
  /** Active tab key within this session's editor area */
  activeTabKey: EditorKey | null;
  /** Whether the files edited sidebar is visible */
  filesSidebarVisible: boolean;
  /** Whether the "Other Uncommitted Files" section is expanded */
  otherFilesExpanded: boolean;
}

const DEFAULT_SESSION_EDITOR_STATE: SessionEditorState = {
  layoutMode: 'transcript', // Start with transcript maximized (editor hidden)
  splitRatio: 0.5, // Default 50/50 when split mode activated
  activeTabKey: null,
  filesSidebarVisible: true, // Show sidebar by default
  otherFilesExpanded: false, // Collapsed by default
};

// ============================================================
// Per-Session State Atoms
// ============================================================

/**
 * Per-session editor state atom family.
 * Each session gets its own independent layout state.
 */
export const sessionEditorStateAtom = atomFamily((sessionId: string) =>
  atom<SessionEditorState>({ ...DEFAULT_SESSION_EDITOR_STATE })
);

// ============================================================
// Derived Atoms (Read-Only)
// ============================================================

/**
 * Tab keys for a specific session.
 * Derived from the tabIdsAtom using the session's EditorContext.
 */
export const sessionTabKeysAtom = atomFamily((sessionId: string) =>
  atom((get) => get(tabIdsAtom(makeEditorContext(sessionId))))
);

/**
 * Active tab key for a specific session.
 * Derived from activeTabIdAtom using the session's EditorContext.
 */
export const sessionActiveTabKeyAtom = atomFamily((sessionId: string) =>
  atom((get) => get(activeTabIdAtom(makeEditorContext(sessionId))))
);

/**
 * Layout mode for a specific session.
 */
export const sessionLayoutModeAtom = atomFamily((sessionId: string) =>
  atom((get) => get(sessionEditorStateAtom(sessionId)).layoutMode)
);

/**
 * Split ratio for a specific session.
 */
export const sessionSplitRatioAtom = atomFamily((sessionId: string) =>
  atom((get) => get(sessionEditorStateAtom(sessionId)).splitRatio)
);

/**
 * Files sidebar visibility for a specific session.
 */
export const sessionFilesSidebarVisibleAtom = atomFamily((sessionId: string) =>
  atom((get) => get(sessionEditorStateAtom(sessionId)).filesSidebarVisible)
);

/**
 * Other uncommitted files section expanded state for a specific session.
 */
export const sessionOtherFilesExpandedAtom = atomFamily((sessionId: string) =>
  atom((get) => get(sessionEditorStateAtom(sessionId)).otherFilesExpanded)
);

/**
 * Whether the session editor area should be visible.
 * True if in 'editor' or 'split' mode AND has open tabs.
 */
export const sessionEditorVisibleAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    const state = get(sessionEditorStateAtom(sessionId));
    const tabKeys = get(sessionTabKeysAtom(sessionId));
    return state.layoutMode !== 'transcript' && tabKeys.length > 0;
  })
);

/**
 * Tab count for a session - manually updated by SessionEditorArea.
 * This is needed because TabsProvider uses React context (not Jotai atoms),
 * so we need to sync the tab count manually.
 */
export const sessionTabCountAtom = atomFamily((_sessionId: string) =>
  atom<number>(0)
);

/**
 * Whether the session has any open tabs.
 * Reads from the manually-synced tab count atom.
 */
export const sessionHasTabsAtom = atomFamily((sessionId: string) =>
  atom((get) => get(sessionTabCountAtom(sessionId)) > 0)
);

/**
 * Set the tab count for a session.
 * Called by SessionEditorArea when tabs change.
 */
export const setSessionTabCountAtom = atom(
  null,
  (_get, set, { sessionId, count }: { sessionId: string; count: number }) => {
    set(sessionTabCountAtom(sessionId), count);
  }
);

// ============================================================
// Action Atoms
// ============================================================

/**
 * Open a file in the session's embedded editor.
 * - Adds a tab to the session's tab context
 * - Switches to split mode if currently in transcript-only mode
 * - Makes the file the active tab
 */
export const openFileInSessionEditorAtom = atom(
  null,
  (
    get,
    set,
    { sessionId, filePath, isVirtual = false }: { sessionId: string; filePath: string; isVirtual?: boolean }
  ) => {
    const context: EditorContext = makeEditorContext(sessionId);
    const key = makeEditorKey(filePath, sessionId);

    // Open tab using existing addTabAtom
    set(addTabAtom, { context, key, isVirtual });

    // If in transcript-only mode, switch to split mode to show the editor
    const state = get(sessionEditorStateAtom(sessionId));
    if (state.layoutMode === 'transcript') {
      set(sessionEditorStateAtom(sessionId), { ...state, layoutMode: 'split' });
    }
  }
);

/**
 * Set the layout mode for a session.
 * Used by layout control buttons (maximize editor, split, maximize transcript).
 */
export const setSessionLayoutModeAtom = atom(
  null,
  (get, set, { sessionId, mode }: { sessionId: string; mode: SessionLayoutMode }) => {
    const state = get(sessionEditorStateAtom(sessionId));
    set(sessionEditorStateAtom(sessionId), { ...state, layoutMode: mode });

    // Schedule persistence
    schedulePersist(sessionId, { ...state, layoutMode: mode });
  }
);

/**
 * Set the split ratio for a session.
 * Called during drag resize of the split handle.
 */
export const setSessionSplitRatioAtom = atom(
  null,
  (get, set, { sessionId, ratio }: { sessionId: string; ratio: number }) => {
    // Clamp ratio between 0.1 and 0.9 to prevent either panel from being too small
    const clampedRatio = Math.max(0.1, Math.min(0.9, ratio));
    const state = get(sessionEditorStateAtom(sessionId));
    set(sessionEditorStateAtom(sessionId), { ...state, splitRatio: clampedRatio });

    // Schedule persistence
    schedulePersist(sessionId, { ...state, splitRatio: clampedRatio });
  }
);

/**
 * Toggle between split and transcript-only mode.
 * If has no tabs, does nothing.
 */
export const toggleSessionEditorAtom = atom(null, (get, set, sessionId: string) => {
  const state = get(sessionEditorStateAtom(sessionId));
  const tabKeys = get(sessionTabKeysAtom(sessionId));

  // Can't show editor if no tabs
  if (tabKeys.length === 0) return;

  const newMode: SessionLayoutMode = state.layoutMode === 'transcript' ? 'split' : 'transcript';
  set(sessionEditorStateAtom(sessionId), { ...state, layoutMode: newMode });
  schedulePersist(sessionId, { ...state, layoutMode: newMode });
});

/**
 * Toggle the files sidebar visibility for a session.
 * Persists the state to workspace storage.
 */
export const toggleSessionFilesSidebarAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const state = get(sessionEditorStateAtom(sessionId));
    const newState = { ...state, filesSidebarVisible: !state.filesSidebarVisible };
    set(sessionEditorStateAtom(sessionId), newState);
    schedulePersist(sessionId, newState);
  }
);

/**
 * Toggle the "Other Uncommitted Files" section expanded state for a session.
 * Persists the state to workspace storage.
 */
export const toggleSessionOtherFilesExpandedAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const state = get(sessionEditorStateAtom(sessionId));
    const newState = { ...state, otherFilesExpanded: !state.otherFilesExpanded };
    set(sessionEditorStateAtom(sessionId), newState);
    schedulePersist(sessionId, newState);
  }
);

// ============================================================
// Persistence
// ============================================================

// Track workspace path for persistence
let currentWorkspacePath: string | null = null;

// Debounce timers per session
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule persistence of session editor state.
 * Debounced to avoid excessive IPC calls during drag operations.
 */
function schedulePersist(sessionId: string, state: SessionEditorState): void {
  if (!currentWorkspacePath) {
    throw new Error('[sessionEditors] Cannot persist - initSessionEditors not called');
  }
  const workspacePath = currentWorkspacePath;

  // Clear any existing timer for this session
  const existingTimer = persistTimers.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Schedule persistence
  const timer = setTimeout(async () => {
    persistTimers.delete(sessionId);

    try {
      const workspaceState = await window.electronAPI.invoke(
        'workspace:get-state',
        workspacePath
      );

      const existingStates = workspaceState?.sessionEditorStates ?? {};
      const tabKeys = store.get(sessionTabKeysAtom(sessionId));

      await window.electronAPI.invoke('workspace:update-state', workspacePath, {
        sessionEditorStates: {
          ...existingStates,
          [sessionId]: {
            layoutMode: state.layoutMode,
            splitRatio: state.splitRatio,
            filesSidebarVisible: state.filesSidebarVisible,
            otherFilesExpanded: state.otherFilesExpanded,
            openTabs: tabKeys.map((key) => ({
              key,
              isActive: key === store.get(sessionActiveTabKeyAtom(sessionId)),
            })),
          },
        },
      });
    } catch (err) {
      console.error('[sessionEditors] Failed to persist state:', err);
    }
  }, 500);

  persistTimers.set(sessionId, timer);
}

/**
 * Persist tabs for a session (called when tabs change).
 */
export function persistSessionTabs(sessionId: string): void {
  const state = store.get(sessionEditorStateAtom(sessionId));
  schedulePersist(sessionId, state);
}

// ============================================================
// Initialization
// ============================================================

/**
 * Initialize session editors module with workspace path.
 * Call this when workspace path is known.
 */
export function initSessionEditors(workspacePath: string): void {
  currentWorkspacePath = workspacePath;
}

/**
 * Load saved session editor state from workspace state.
 * Call this when switching to or loading a session.
 */
export async function loadSessionEditorState(sessionId: string): Promise<void> {
  if (!currentWorkspacePath) return;

  try {
    const workspaceState = await window.electronAPI.invoke(
      'workspace:get-state',
      currentWorkspacePath
    );

    const saved = workspaceState?.sessionEditorStates?.[sessionId];
    if (saved) {
      // Restore state
      store.set(sessionEditorStateAtom(sessionId), {
        layoutMode: saved.layoutMode ?? 'transcript',
        splitRatio: saved.splitRatio ?? 0.5,
        activeTabKey: null, // Will be set when tabs are restored
        filesSidebarVisible: saved.filesSidebarVisible ?? true,
        otherFilesExpanded: saved.otherFilesExpanded ?? false,
      });

      // Restore tabs
      const context = makeEditorContext(sessionId);
      for (const tab of saved.openTabs ?? []) {
        store.set(addTabAtom, { context, key: tab.key, isVirtual: false });
      }

      // Set active tab
      const activeTab = (saved.openTabs ?? []).find((t: { key: EditorKey; isActive: boolean }) => t.isActive);
      if (activeTab) {
        store.set(activeTabIdAtom(context), activeTab.key);
      }
    }
  } catch (err) {
    console.error('[sessionEditors] Failed to load state:', err);
  }
}

/**
 * Clean up session editor state when a session is deleted.
 * Removes persisted state to prevent unbounded growth.
 */
export async function cleanupSessionEditorState(sessionId: string): Promise<void> {
  if (!currentWorkspacePath) return;

  // Remove any pending persist timer
  const timer = persistTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    persistTimers.delete(sessionId);
  }

  // Remove the session's atom state
  sessionEditorStateAtom.remove(sessionId);
  sessionTabKeysAtom.remove(sessionId);
  sessionActiveTabKeyAtom.remove(sessionId);
  sessionLayoutModeAtom.remove(sessionId);
  sessionSplitRatioAtom.remove(sessionId);
  sessionFilesSidebarVisibleAtom.remove(sessionId);
  sessionEditorVisibleAtom.remove(sessionId);
  sessionHasTabsAtom.remove(sessionId);

  // Remove from persisted workspace state
  try {
    const workspaceState = await window.electronAPI.invoke(
      'workspace:get-state',
      currentWorkspacePath
    );

    const existingStates = workspaceState?.sessionEditorStates ?? {};
    if (sessionId in existingStates) {
      const { [sessionId]: _, ...remainingStates } = existingStates;
      await window.electronAPI.invoke('workspace:update-state', currentWorkspacePath, {
        sessionEditorStates: remainingStates,
      });
    }
  } catch (err) {
    console.error('[sessionEditors] Failed to cleanup state:', err);
  }
}
