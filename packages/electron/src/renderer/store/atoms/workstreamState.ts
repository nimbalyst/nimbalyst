/**
 * Unified Workstream State Management
 *
 * This module provides a single source of truth for all workstream-related state,
 * replacing the fragmented atomFamily approach that was prone to GC issues and
 * lacked persistence.
 *
 * Architecture:
 * - Single backing Map stores all workstream state
 * - atomFamily provides per-workstream read/write access
 * - Derived atoms enable selective subscriptions for performance
 * - Action atoms handle complex mutations
 * - Debounced persistence to workspace state
 *
 * @example
 * // Read workstream state
 * const state = useAtomValue(workstreamStateAtom(workstreamId));
 *
 * // Update specific field
 * const setState = useSetAtom(workstreamStateAtom(workstreamId));
 * setState({ activeChildId: childId });
 *
 * // Use derived atoms for selective subscriptions
 * const activeChild = useAtomValue(workstreamActiveChildAtom(workstreamId));
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { store } from '@nimbalyst/runtime/store';

// ============================================================
// Utilities
// ============================================================

/**
 * Deep merge source into target, returning a new object.
 * Handles nested objects recursively. Arrays are replaced, not merged.
 * Used to merge persisted state with defaults so new fields are always present.
 *
 * STATE PERSISTENCE MIGRATION SAFETY:
 * When adding new fields to WorkstreamState:
 * 1. Add the field to the WorkstreamState interface
 * 2. Add a default value in createDefaultState()
 * That's it - this function automatically handles merging any field present in source.
 */
function deepMergeWorkstreamState(
  target: WorkstreamState,
  source: Partial<WorkstreamState> | undefined
): WorkstreamState {
  if (!source) return target;

  // Start with target defaults
  const result: WorkstreamState = { ...target };

  // Automatically merge any field from source that is defined
  // This avoids the need to manually enumerate fields and prevents
  // the bug where adding a new field requires updating this function
  for (const key of Object.keys(source) as (keyof WorkstreamState)[]) {
    if (source[key] !== undefined) {
      (result as any)[key] = source[key];
    }
  }

  return result;
}

// ============================================================
// Types
// ============================================================

/**
 * Type of workstream.
 * - single: A standalone session
 * - workstream: A parent session with multiple child sessions
 * - worktree: A session tied to a git worktree
 *
 * NOTE: Type is auto-detected based on session state:
 * - Has worktreeId → 'worktree'
 * - Has children → 'workstream'
 * - Neither → 'single'
 */
export type WorkstreamType = 'single' | 'workstream' | 'worktree';

/**
 * Layout mode for the workstream panel.
 * - editor: Editor area maximized, transcript hidden
 * - split: Both editor and transcript visible with adjustable ratio
 * - transcript: Transcript maximized, editor hidden (default)
 */
export type WorkstreamLayoutMode = 'editor' | 'split' | 'transcript';

/**
 * File scope mode for the Files Edited sidebar.
 * - current-changes: Show only files with uncommitted git changes
 * - session-files: Show all files touched in this session/workstream
 * - all-changes: Show all uncommitted files in the repository (default)
 */
export type FileScopeMode = 'current-changes' | 'session-files' | 'all-changes';

/**
 * Complete state for a single workstream.
 * This is the single source of truth for all workstream-related state.
 */
export interface WorkstreamState {
  // ===== Identity =====
  /** Root session ID (workstream ID) */
  id: string;
  /** Type of workstream */
  type: WorkstreamType;

  // ===== Hierarchy (for workstreams) =====
  /** Child session IDs (empty for single sessions) */
  childSessionIds: string[];
  /** Currently active child session ID */
  activeChildId: string | null;

  // ===== Worktree Info (for worktrees) =====
  /** Worktree ID if this is a worktree session */
  worktreeId: string | null;
  /** Resolved worktree path (cached so it's available synchronously on remount) */
  worktreePath: string | null;

  // ===== UI State (persisted per-workstream) =====
  /** Layout mode (split/editor/transcript) */
  layoutMode: WorkstreamLayoutMode;
  /** Split ratio (0-1), remembered when toggling back to split mode */
  splitRatio: number;
  /** Whether the files edited sidebar is visible */
  filesSidebarVisible: boolean;

  // ===== Editor Tabs (within this workstream) =====
  /** Open file paths in editor tabs */
  openFilePaths: string[];
  /** Currently active file path */
  activeFilePath: string | null;

  // ===== Git Commit State (for Manual/Smart mode) =====
  /** Files selected for commit (staged in UI) */
  stagedFiles: string[];
  /** Commit message being composed */
  commitMessage: string;
  /** Active AI proposal ID (when AI proposed a commit) */
  activeProposalId: string | null;

  // ===== Files Edited Sidebar Settings =====
  /** File scope mode for the Files Edited sidebar */
  fileScopeMode: FileScopeMode;
}

/**
 * Create default workstream state for a session ID.
 */
function createDefaultState(id: string): WorkstreamState {
  return {
    id,
    type: 'single',
    childSessionIds: [],
    activeChildId: null,
    worktreeId: null,
    worktreePath: null,
    layoutMode: 'transcript', // Start with transcript maximized
    splitRatio: 0.5,
    filesSidebarVisible: true,
    openFilePaths: [],
    activeFilePath: null,
    stagedFiles: [],
    commitMessage: '',
    activeProposalId: null,
    fileScopeMode: 'all-changes', // Default to showing all changes
  };
}

// ============================================================
// Backing Store
// ============================================================

/**
 * Single Map storing all workstream state.
 * This persists for the app lifecycle and prevents GC issues.
 */
const workstreamStatesAtom = atom<Map<string, WorkstreamState>>(new Map());

/**
 * Flag indicating whether workspace workstream states have been loaded from disk.
 * Used to prevent race conditions where loadSessionChildrenAtom runs before
 * persisted state is restored.
 */
export const workstreamStatesLoadedAtom = atom<boolean>(false);

// ============================================================
// Per-Workstream State Atom
// ============================================================

/**
 * Per-workstream state atom family.
 * Reads from and writes to the backing store.
 *
 * Usage:
 * - Read: get(workstreamStateAtom(id))
 * - Write: set(workstreamStateAtom(id), { field: value })
 *
 * Partial updates are supported - only provide the fields you want to change.
 */
export const workstreamStateAtom = atomFamily((workstreamId: string) =>
  atom(
    // Read
    (get) => {
      const map = get(workstreamStatesAtom);
      const stored = map.get(workstreamId);
      // Deep merge with defaults ensures all fields have values, even nested ones.
      // This handles old persisted state that's missing newly added fields.
      let state = deepMergeWorkstreamState(createDefaultState(workstreamId), stored);

      // Auto-determine type based on state if not explicitly set
      if (state.type === 'single') {
        if (state.worktreeId) {
          state = { ...state, type: 'worktree' };
        } else if (state.childSessionIds.length > 0) {
          state = { ...state, type: 'workstream' };
        }
      }

      return state;
    },
    // Write (supports partial updates)
    (get, set, update: Partial<WorkstreamState>) => {
      const map = new Map(get(workstreamStatesAtom));
      const current = map.get(workstreamId) ?? createDefaultState(workstreamId);
      const updated = { ...current, ...update };
      // console.log(`[workstreamState] Updating workstream ${workstreamId}:`, JSON.stringify(update), '→', JSON.stringify(updated));
      map.set(workstreamId, updated);
      set(workstreamStatesAtom, map);

      // Schedule debounced persistence
      schedulePersist(workstreamId);
    }
  )
);

// ============================================================
// Derived Atoms (Read-Only Slices)
// ============================================================

/**
 * Workstream type (single/workstream/worktree).
 */
export const workstreamTypeAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).type)
);

/**
 * Active child session ID within a workstream.
 */
export const workstreamActiveChildAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).activeChildId)
);

/**
 * Child session IDs for a workstream.
 */
export const workstreamChildrenAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).childSessionIds)
);

/**
 * Layout mode for a workstream.
 */
export const workstreamLayoutModeAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).layoutMode)
);

/**
 * Split ratio for a workstream.
 */
export const workstreamSplitRatioAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).splitRatio)
);

/**
 * Files sidebar visibility for a workstream.
 */
export const workstreamFilesSidebarVisibleAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).filesSidebarVisible)
);

/**
 * Open file paths in a workstream.
 */
export const workstreamOpenFilesAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).openFilePaths)
);

/**
 * Active file path in a workstream.
 */
export const workstreamActiveFileAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).activeFilePath)
);

/**
 * Worktree ID for a workstream (null if not a worktree).
 */
export const workstreamWorktreeIdAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).worktreeId)
);

/**
 * Resolved worktree path for a workstream (null if not a worktree).
 * Cached in state so it's available synchronously on remount.
 */
export const workstreamWorktreePathAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).worktreePath)
);

/**
 * Whether a workstream has children (is a workstream parent).
 */
export const workstreamHasChildrenAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).childSessionIds.length > 0)
);

/**
 * Whether a workstream has any open file tabs.
 */
export const workstreamHasOpenFilesAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).openFilePaths.length > 0)
);

/**
 * Staged files for git commit in a workstream.
 */
export const workstreamStagedFilesAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).stagedFiles)
);

/**
 * Commit message being composed in a workstream.
 */
export const workstreamCommitMessageAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).commitMessage)
);

// activeProposalId atoms removed - git commit proposals handled by widget
// Widget renders directly from tool call data, no atoms needed

/**
 * File scope mode for the Files Edited sidebar in a workstream.
 */
export const workstreamFileScopeModeAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).fileScopeMode)
);

// ============================================================
// Worktree Session Tracking
// ============================================================

/**
 * Map of worktree ID -> last active session ID.
 * Tracks which session was most recently viewed for each worktree.
 * This enables returning to the last active session when clicking a worktree header.
 * This state is persisted to workspace state for continuity across app restarts.
 */
const worktreeActiveSessionMapAtom = atom<Map<string, string>>(new Map());

/**
 * Get the last active session ID for a worktree.
 */
export const worktreeActiveSessionAtom = atomFamily((worktreeId: string) =>
  atom((get) => get(worktreeActiveSessionMapAtom).get(worktreeId) ?? null)
);

// Debounce timer for worktree active session persistence
let worktreeActiveSessionPersistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule persistence of worktree active sessions.
 * Debounced to avoid excessive IPC calls when rapidly switching sessions.
 */
function scheduleWorktreeActiveSessionPersist(): void {
  if (!currentWorkspacePath) return;

  if (worktreeActiveSessionPersistTimer) {
    clearTimeout(worktreeActiveSessionPersistTimer);
  }

  worktreeActiveSessionPersistTimer = setTimeout(async () => {
    worktreeActiveSessionPersistTimer = null;

    try {
      const map = store.get(worktreeActiveSessionMapAtom);
      const worktreeActiveSessions: Record<string, string> = {};
      map.forEach((sessionId, worktreeId) => {
        worktreeActiveSessions[worktreeId] = sessionId;
      });

      await window.electronAPI.invoke('workspace:update-state', currentWorkspacePath!, {
        worktreeActiveSessions,
      });
    } catch (err) {
      console.error('[workstreamState] Failed to persist worktree active sessions:', err);
    }
  }, 500);
}

/**
 * Set the active session for a worktree.
 * Persisted to workspace state for continuity across app restarts.
 */
export const setWorktreeActiveSessionAtom = atom(
  null,
  (get, set, { worktreeId, sessionId }: { worktreeId: string; sessionId: string }) => {
    const map = new Map(get(worktreeActiveSessionMapAtom));
    map.set(worktreeId, sessionId);
    set(worktreeActiveSessionMapAtom, map);

    // Schedule debounced persistence
    scheduleWorktreeActiveSessionPersist();
  }
);

// ============================================================
// Action Atoms (Mutations)
// ============================================================

/**
 * Set the active child session within a workstream.
 */
export const setWorkstreamActiveChildAtom = atom(
  null,
  (get, set, { workstreamId, childId }: { workstreamId: string; childId: string }) => {
    set(workstreamStateAtom(workstreamId), { activeChildId: childId });
  }
);

/**
 * Set the layout mode for a workstream.
 */
export const setWorkstreamLayoutModeAtom = atom(
  null,
  (get, set, { workstreamId, mode }: { workstreamId: string; mode: WorkstreamLayoutMode }) => {
    set(workstreamStateAtom(workstreamId), { layoutMode: mode });
  }
);

/**
 * Set the split ratio for a workstream.
 */
export const setWorkstreamSplitRatioAtom = atom(
  null,
  (get, set, { workstreamId, ratio }: { workstreamId: string; ratio: number }) => {
    // Clamp ratio between 0.1 and 0.9 to prevent either panel from being too small
    const clampedRatio = Math.max(0.1, Math.min(0.9, ratio));
    set(workstreamStateAtom(workstreamId), { splitRatio: clampedRatio });
  }
);

/**
 * Toggle the files sidebar visibility for a workstream.
 */
export const toggleWorkstreamFilesSidebarAtom = atom(
  null,
  (get, set, workstreamId: string) => {
    const current = get(workstreamFilesSidebarVisibleAtom(workstreamId));
    set(workstreamStateAtom(workstreamId), { filesSidebarVisible: !current });
  }
);

/**
 * Add a file to the workstream's open files.
 */
export const addWorkstreamFileAtom = atom(
  null,
  (get, set, { workstreamId, filePath }: { workstreamId: string; filePath: string }) => {
    const state = get(workstreamStateAtom(workstreamId));

    // Don't add if already open
    if (state.openFilePaths.includes(filePath)) {
      set(workstreamStateAtom(workstreamId), { activeFilePath: filePath });
      return;
    }

    // Add to open files and make active
    set(workstreamStateAtom(workstreamId), {
      openFilePaths: [...state.openFilePaths, filePath],
      activeFilePath: filePath,
    });
  }
);

/**
 * Close a file in the workstream's editor tabs.
 */
export const closeWorkstreamFileAtom = atom(
  null,
  (get, set, { workstreamId, filePath }: { workstreamId: string; filePath: string }) => {
    const state = get(workstreamStateAtom(workstreamId));
    const newFiles = state.openFilePaths.filter((f) => f !== filePath);

    // If closing the active file, switch to the first remaining file
    const newActiveFile =
      state.activeFilePath === filePath ? (newFiles[0] || null) : state.activeFilePath;

    set(workstreamStateAtom(workstreamId), {
      openFilePaths: newFiles,
      activeFilePath: newActiveFile,
    });
  }
);

/**
 * Add a child session to a workstream.
 * Updates the parent's child list and the child's type.
 */
export const addWorkstreamChildAtom = atom(
  null,
  (get, set, { workstreamId, childId }: { workstreamId: string; childId: string }) => {
    const state = get(workstreamStateAtom(workstreamId));

    // Update parent
    set(workstreamStateAtom(workstreamId), {
      type: 'workstream',
      childSessionIds: [...state.childSessionIds, childId],
      activeChildId: childId, // Make new child active
    });
  }
);

// ===== Git Commit State Actions =====

/**
 * Set staged files for a workstream.
 */
export const setWorkstreamStagedFilesAtom = atom(
  null,
  (get, set, { workstreamId, files }: { workstreamId: string; files: string[] }) => {
    set(workstreamStateAtom(workstreamId), { stagedFiles: files });
  }
);

/**
 * Toggle a file's staged state in a workstream.
 */
export const toggleWorkstreamStagedFileAtom = atom(
  null,
  (get, set, { workstreamId, filePath }: { workstreamId: string; filePath: string }) => {
    const state = get(workstreamStateAtom(workstreamId));
    const isStaged = state.stagedFiles.includes(filePath);
    const newStaged = isStaged
      ? state.stagedFiles.filter(f => f !== filePath)
      : [...state.stagedFiles, filePath];
    set(workstreamStateAtom(workstreamId), { stagedFiles: newStaged });
  }
);

/**
 * Set commit message for a workstream.
 */
export const setWorkstreamCommitMessageAtom = atom(
  null,
  (get, set, { workstreamId, message }: { workstreamId: string; message: string }) => {
    set(workstreamStateAtom(workstreamId), { commitMessage: message });
  }
);

/**
 * Clear git commit state for a workstream (after successful commit).
 */
export const clearWorkstreamGitStateAtom = atom(
  null,
  (get, set, workstreamId: string) => {
    set(workstreamStateAtom(workstreamId), {
      stagedFiles: [],
      commitMessage: '',
      activeProposalId: null,
    });
  }
);

/**
 * Set file scope mode for a workstream.
 */
export const setWorkstreamFileScopeModeAtom = atom(
  null,
  (get, set, { workstreamId, mode }: { workstreamId: string; mode: FileScopeMode }) => {
    set(workstreamStateAtom(workstreamId), { fileScopeMode: mode });
  }
);

/**
 * Convert a single session into a workstream.
 * Creates the workstream structure and updates state.
 */
export const convertToWorkstreamAtom = atom(
  null,
  (
    get,
    set,
    {
      sessionId,
      parentId,
      siblingId,
    }: { sessionId: string; parentId: string; siblingId?: string }
  ) => {
    // Get the current session's state to preserve UI settings
    const currentState = get(workstreamStateAtom(sessionId));

    // Create parent workstream state, inheriting UI settings from the original session.
    // When siblingId is omitted (drag-drop conversion) the original session is the only
    // child and becomes the active child.
    const childSessionIds = siblingId ? [sessionId, siblingId] : [sessionId];
    const activeChildId = siblingId ?? sessionId;
    set(workstreamStateAtom(parentId), {
      id: parentId,
      type: 'workstream',
      childSessionIds,
      activeChildId,
      worktreeId: null,
      worktreePath: null,
      // Inherit UI state from original session
      layoutMode: currentState.layoutMode,
      splitRatio: currentState.splitRatio,
      filesSidebarVisible: currentState.filesSidebarVisible,
      openFilePaths: currentState.openFilePaths,
      activeFilePath: currentState.activeFilePath,
      // Inherit git state from original session
      stagedFiles: currentState.stagedFiles,
      commitMessage: currentState.commitMessage,
      activeProposalId: currentState.activeProposalId,
      // Inherit sidebar settings from original session
      fileScopeMode: currentState.fileScopeMode,
    });

    // Clear the original session's state (it's now a child, state lives on parent)
    set(workstreamStateAtom(sessionId), {
      id: sessionId,
      type: 'single',
      childSessionIds: [],
      activeChildId: null,
      worktreeId: null,
      worktreePath: null,
      layoutMode: 'transcript',
      splitRatio: 0.5,
      filesSidebarVisible: true,
      openFilePaths: [],
      activeFilePath: null,
      stagedFiles: [],
      commitMessage: '',
      activeProposalId: null,
      fileScopeMode: 'all-changes',
    });

    // Initialize sibling state (only when a sibling was created)
    if (siblingId) {
      set(workstreamStateAtom(siblingId), createDefaultState(siblingId));
    }
  }
);

/**
 * Clean up workstream state when a workstream is closed or deleted.
 */
export const cleanupWorkstreamAtom = atom(null, (get, set, workstreamId: string) => {
  // Remove from backing store
  const map = new Map(get(workstreamStatesAtom));
  map.delete(workstreamId);
  set(workstreamStatesAtom, map);

  // Clear persist timer
  const timer = persistTimers.get(workstreamId);
  if (timer) {
    clearTimeout(timer);
    persistTimers.delete(workstreamId);
  }

  // Remove atom family instance
  workstreamStateAtom.remove(workstreamId);
});

// ============================================================
// Persistence
// ============================================================

// Track workspace path for persistence
let currentWorkspacePath: string | null = null;

// Debounce timers per workstream
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule persistence of workstream state.
 * Debounced to avoid excessive IPC calls during drag operations.
 */
function schedulePersist(workstreamId: string): void {
  if (!currentWorkspacePath) {
    throw new Error('[workstreamState] Cannot persist - initWorkstreamState not called');
  }

  // Clear any existing timer for this workstream
  const existingTimer = persistTimers.get(workstreamId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Schedule persistence
  const timer = setTimeout(async () => {
    persistTimers.delete(workstreamId);

    try {
      const state = store.get(workstreamStateAtom(workstreamId));
      // console.log(`[workstreamState] Persisting workstream ${workstreamId}:`, JSON.stringify(state));
      const workspaceState = await window.electronAPI.invoke(
        'workspace:get-state',
        currentWorkspacePath!
      );

      const existingStates = workspaceState?.workstreamStates ?? {};

      const result = await window.electronAPI.invoke('workspace:update-state', currentWorkspacePath!, {
        workstreamStates: {
          ...existingStates,
          [workstreamId]: state,
        },
      });
      // console.log(`[workstreamState] Persist complete for ${workstreamId}, result:`, result);
    } catch (err) {
      console.error('[workstreamState] Failed to persist state:', err);
    }
  }, 500);

  persistTimers.set(workstreamId, timer);
}

// ============================================================
// Initialization
// ============================================================

/**
 * Initialize workstream state module with workspace path.
 * Call this when workspace path is known.
 */
export function initWorkstreamState(workspacePath: string): void {
  currentWorkspacePath = workspacePath;
}

/**
 * Load all saved workstream states from workspace state.
 * Call this on app startup or workspace open.
 */
export async function loadWorkstreamStates(workspacePath: string): Promise<void> {
  currentWorkspacePath = workspacePath;

  try {
    const workspaceState = await window.electronAPI.invoke('workspace:get-state', workspacePath);
    // console.log('[workstreamState] Full workspace state:', JSON.stringify(workspaceState, null, 2));

    // Load workstream states
    const saved = workspaceState?.workstreamStates ?? {};
    // console.log('[workstreamState] workstreamStates field:', JSON.stringify(saved, null, 2));

    const map = new Map<string, WorkstreamState>();
    for (const [id, state] of Object.entries(saved)) {
      map.set(id, state as WorkstreamState);
      // console.log('[workstreamState] Restored state for', id, ':', state);
    }
    store.set(workstreamStatesAtom, map);
    store.set(workstreamStatesLoadedAtom, true);

    // console.log('[workstreamState] Loaded states for', map.size, 'workstreams');

    // Load worktree active sessions
    const worktreeActiveSessions = workspaceState?.worktreeActiveSessions ?? {};
    const worktreeMap = new Map<string, string>();
    for (const [worktreeId, sessionId] of Object.entries(worktreeActiveSessions)) {
      worktreeMap.set(worktreeId, sessionId as string);
    }
    store.set(worktreeActiveSessionMapAtom, worktreeMap);
    // console.log('[workstreamState] Loaded active sessions for', worktreeMap.size, 'worktrees');
  } catch (err) {
    console.error('[workstreamState] Failed to load states:', err);
    // Still mark as loaded so UI doesn't hang
    store.set(workstreamStatesLoadedAtom, true);
  }
}

/**
 * Load saved state for a specific workstream.
 * Call this when switching to or loading a workstream.
 *
 * IMPORTANT: Only restores UI state fields (layoutMode, splitRatio, etc.), NOT
 * hierarchy state (activeChildId, childSessionIds, type). Hierarchy state is
 * managed by loadSessionChildrenAtom and setWorkstreamActiveChildAtom to avoid
 * race conditions where persisted state overwrites in-flight updates.
 */
export async function loadWorkstreamState(workstreamId: string): Promise<void> {
  if (!currentWorkspacePath) return;

  try {
    const workspaceState = await window.electronAPI.invoke(
      'workspace:get-state',
      currentWorkspacePath
    );

    const saved = workspaceState?.workstreamStates?.[workstreamId];
    if (saved) {
      const map = new Map(store.get(workstreamStatesAtom));
      const current = map.get(workstreamId) ?? createDefaultState(workstreamId);

      // Only restore UI state fields, preserve hierarchy state
      // This prevents race conditions where persisted state overwrites
      // activeChildId that was just set by setWorkstreamActiveChildAtom
      const merged: WorkstreamState = {
        ...current,
        // UI state from persisted
        layoutMode: (saved as WorkstreamState).layoutMode ?? current.layoutMode,
        splitRatio: (saved as WorkstreamState).splitRatio ?? current.splitRatio,
        filesSidebarVisible: (saved as WorkstreamState).filesSidebarVisible ?? current.filesSidebarVisible,
        openFilePaths: (saved as WorkstreamState).openFilePaths ?? current.openFilePaths,
        activeFilePath: (saved as WorkstreamState).activeFilePath ?? current.activeFilePath,
        // Cached worktree path (available synchronously on remount)
        worktreePath: (saved as WorkstreamState).worktreePath ?? current.worktreePath,
        // Hierarchy state preserved from current in-memory state
        // (id, type, childSessionIds, activeChildId, worktreeId)
      };

      map.set(workstreamId, merged);
      store.set(workstreamStatesAtom, map);
    }
  } catch (err) {
    console.error('[workstreamState] Failed to load state for', workstreamId, ':', err);
  }
}

/**
 * Persist a specific workstream state immediately (no debounce).
 * Use for critical state changes that need immediate persistence.
 */
export async function persistWorkstreamState(workstreamId: string): Promise<void> {
  if (!currentWorkspacePath) return;

  try {
    const state = store.get(workstreamStateAtom(workstreamId));
    const workspaceState = await window.electronAPI.invoke(
      'workspace:get-state',
      currentWorkspacePath
    );

    const existingStates = workspaceState?.workstreamStates ?? {};

    await window.electronAPI.invoke('workspace:update-state', currentWorkspacePath, {
      workstreamStates: {
        ...existingStates,
        [workstreamId]: state,
      },
    });
  } catch (err) {
    console.error('[workstreamState] Failed to persist state:', err);
  }
}
