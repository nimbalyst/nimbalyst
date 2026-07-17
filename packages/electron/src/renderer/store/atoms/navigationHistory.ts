/**
 * Unified Navigation History
 *
 * Provides browser-style back/forward navigation across all modes (files, agent, settings).
 * When the user presses Cmd+[ or Cmd+], this module handles navigating through
 * their history regardless of which mode they were in.
 *
 * Architecture:
 * - Single history array stores NavigationEntry objects
 * - Each entry captures mode + mode-specific state (tab, session, settings category)
 * - Current position index tracks where we are in history
 * - goBack/goForward move through history and restore state
 * - Navigation flag prevents recording restoration as new navigation
 *
 * @example
 * // Push a navigation entry when user navigates to something
 * const push = useSetAtom(pushNavigationEntryAtom);
 * push({ mode: 'files', files: { tabId: 'tab-1', filePath: '/path/to/file.ts' } });
 *
 * // Go back/forward
 * const goBack = useSetAtom(goBackAtom);
 * goBack();
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from './openProjects';
import type { ContentMode } from '../../types/WindowModeTypes';

// ============================================================
// Types
// ============================================================

/**
 * Files mode navigation state.
 */
export interface FilesNavigationState {
  tabId: string;
  filePath: string;
}

/**
 * Agent mode navigation state.
 */
export interface AgentNavigationState {
  workstreamId: string;
  childSessionId: string | null;
}

/**
 * Tracker mode navigation state.
 */
export interface TrackerNavigationState {
  selectedType: string;
  viewMode: 'list' | 'table' | 'kanban';
}

/**
 * Settings mode navigation state for unified history.
 */
export interface SettingsHistoryState {
  category: string;
  scope: 'application' | 'personal' | 'organization' | 'project' | 'user';
}

/**
 * A single entry in the navigation history.
 * Uses a discriminated union pattern - mode determines which state field is populated.
 */
export interface NavigationEntry {
  timestamp: number;
  mode: ContentMode;

  // Mode-specific state (only one will be populated based on mode)
  files?: FilesNavigationState;
  agent?: AgentNavigationState;
  tracker?: TrackerNavigationState;
  settings?: SettingsHistoryState;
}

/**
 * The complete navigation history state.
 */
interface NavigationHistoryState {
  entries: NavigationEntry[];
  currentIndex: number;
}

// ============================================================
// Constants
// ============================================================

const MAX_HISTORY_SIZE = 50;

// ============================================================
// State Atoms
// ============================================================

const DEFAULT_NAVIGATION_HISTORY: NavigationHistoryState = {
  entries: [],
  currentIndex: -1,
};

/**
 * Per-workspace navigation history. Each open project keeps its own
 * back/forward stack so switching between projects in the rail does not
 * blow away history.
 */
const navigationHistoryAtomFamily = atomFamily((_workspacePath: string) =>
  atom<NavigationHistoryState>(DEFAULT_NAVIGATION_HISTORY)
);

/** Drop the cached navigation history slot for a workspace. */
export function pruneNavigationHistoryWorkspaceState(workspacePath: string): void {
  navigationHistoryAtomFamily.remove(workspacePath);
}

/**
 * Read+write proxy that resolves to the active workspace's history slot.
 * Existing call sites (push, goBack, goForward) keep working unchanged.
 */
const navigationHistoryAtom = atom<NavigationHistoryState, [NavigationHistoryState], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return DEFAULT_NAVIGATION_HISTORY;
    return get(navigationHistoryAtomFamily(path));
  },
  (get, set, value: NavigationHistoryState) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    set(navigationHistoryAtomFamily(path), value);
  }
);

/**
 * Counter for tracking in-flight navigation restorations.
 * When > 0, navigation events should NOT be recorded to history.
 * Uses a counter instead of boolean to handle rapid back/forward clicks correctly.
 */
const restoringNavigationCountAtom = atom<number>(0);

/**
 * Derived boolean for consumers - true when any restoration is in progress.
 */
export const isRestoringNavigationAtom = atom((get) => get(restoringNavigationCountAtom) > 0);

/**
 * Increment the restoring counter (call when starting a restore).
 */
const incrementRestoringAtom = atom(null, (get, set) => {
  set(restoringNavigationCountAtom, get(restoringNavigationCountAtom) + 1);
});

/**
 * Decrement the restoring counter (call when restore completes).
 */
const decrementRestoringAtom = atom(null, (get, set) => {
  const current = get(restoringNavigationCountAtom);
  set(restoringNavigationCountAtom, Math.max(0, current - 1));
});

// ============================================================
// Read-Only Derived Atoms
// ============================================================

/**
 * Whether we can go back in history.
 */
export const canGoBackAtom = atom((get) => {
  const state = get(navigationHistoryAtom);
  return state.currentIndex > 0;
});

/**
 * Whether we can go forward in history.
 */
export const canGoForwardAtom = atom((get) => {
  const state = get(navigationHistoryAtom);
  return state.currentIndex < state.entries.length - 1;
});

/**
 * The current navigation entry (for debugging/display).
 */
export const currentNavigationEntryAtom = atom((get) => {
  const state = get(navigationHistoryAtom);
  if (state.currentIndex < 0 || state.currentIndex >= state.entries.length) {
    return null;
  }
  return state.entries[state.currentIndex];
});

// ============================================================
// Helper Functions
// ============================================================

/**
 * Check if two navigation entries represent the same location.
 */
function entriesEqual(a: NavigationEntry, b: NavigationEntry): boolean {
  if (a.mode !== b.mode) return false;

  switch (a.mode) {
    case 'files':
      return a.files?.tabId === b.files?.tabId;
    case 'agent':
      return (
        a.agent?.workstreamId === b.agent?.workstreamId &&
        a.agent?.childSessionId === b.agent?.childSessionId
      );
    case 'tracker':
      return (
        a.tracker?.selectedType === b.tracker?.selectedType &&
        a.tracker?.viewMode === b.tracker?.viewMode
      );
    case 'settings':
      return (
        a.settings?.category === b.settings?.category &&
        a.settings?.scope === b.settings?.scope
      );
    default:
      return false;
  }
}

// ============================================================
// Action Atoms
// ============================================================

/**
 * Push a new navigation entry onto the history.
 *
 * Called when the user navigates to a new location (opens a file, selects a session, etc.).
 * Does NOT push if:
 * - We're currently restoring from history (isRestoringNavigation)
 * - The entry is the same as the current entry (deduplication)
 *
 * If we're in the middle of history (went back then navigated elsewhere),
 * truncates forward history (like browsers do).
 */
export const pushNavigationEntryAtom = atom(
  null,
  (
    get,
    set,
    entry: Omit<NavigationEntry, 'timestamp'>
  ) => {
    // Don't record if we're restoring from history
    if (get(isRestoringNavigationAtom)) {
      return;
    }

    const state = get(navigationHistoryAtom);
    const fullEntry: NavigationEntry = {
      ...entry,
      timestamp: Date.now(),
    };

    // Don't add duplicate consecutive entries
    if (state.currentIndex >= 0 && state.currentIndex < state.entries.length) {
      const currentEntry = state.entries[state.currentIndex];
      if (entriesEqual(currentEntry, fullEntry)) {
        return;
      }
    }

    // Truncate forward history if we're not at the end
    let newEntries = state.entries;
    if (state.currentIndex < state.entries.length - 1) {
      newEntries = state.entries.slice(0, state.currentIndex + 1);
    }

    // Add the new entry
    newEntries = [...newEntries, fullEntry];

    // Enforce max history size
    if (newEntries.length > MAX_HISTORY_SIZE) {
      newEntries = newEntries.slice(-MAX_HISTORY_SIZE);
    }

    const workspacePath = get(activeWorkspacePathAtom);

    set(navigationHistoryAtom, {
      entries: newEntries,
      currentIndex: newEntries.length - 1,
    });

    // Schedule persistence for the workspace that received the push.
    if (workspacePath) {
      schedulePersist(workspacePath);
    }
  }
);

/**
 * Callbacks for restoring navigation state in each mode.
 * Set by the components that own that state.
 */
interface NavigationRestoreCallbacks {
  restoreFiles?: (state: FilesNavigationState) => void;
  restoreAgent?: (state: AgentNavigationState) => void;
  restoreTracker?: (state: TrackerNavigationState) => void;
  restoreSettings?: (state: SettingsHistoryState) => void;
  setMode?: (mode: ContentMode) => void;
}

let restoreCallbacks: NavigationRestoreCallbacks = {};

/**
 * Register callbacks for restoring navigation state.
 * Called by App.tsx or other top-level component.
 */
export function registerNavigationRestoreCallbacks(callbacks: NavigationRestoreCallbacks): void {
  restoreCallbacks = { ...restoreCallbacks, ...callbacks };
}

/**
 * Restore a navigation entry (set mode and mode-specific state).
 */
function restoreEntry(entry: NavigationEntry): boolean {
  // Set mode first
  if (restoreCallbacks.setMode) {
    restoreCallbacks.setMode(entry.mode);
  }

  // Then restore mode-specific state
  switch (entry.mode) {
    case 'files':
      if (entry.files && restoreCallbacks.restoreFiles) {
        restoreCallbacks.restoreFiles(entry.files);
        return true;
      }
      break;
    case 'agent':
      if (entry.agent && restoreCallbacks.restoreAgent) {
        restoreCallbacks.restoreAgent(entry.agent);
        return true;
      }
      break;
    case 'tracker':
      if (entry.tracker && restoreCallbacks.restoreTracker) {
        restoreCallbacks.restoreTracker(entry.tracker);
        return true;
      }
      break;
    case 'settings':
      if (entry.settings && restoreCallbacks.restoreSettings) {
        restoreCallbacks.restoreSettings(entry.settings);
        return true;
      }
      break;
  }
  return false;
}

/**
 * Go back in navigation history.
 */
export const goBackAtom = atom(null, (get, set) => {
  const state = get(navigationHistoryAtom);

  if (state.currentIndex <= 0) {
    return;
  }

  // Increment restoring counter to prevent recording this navigation
  set(incrementRestoringAtom);

  // Move back
  const newIndex = state.currentIndex - 1;
  const entry = state.entries[newIndex];

  set(navigationHistoryAtom, {
    ...state,
    currentIndex: newIndex,
  });

  // Restore the entry
  restoreEntry(entry);

  // Decrement restoring counter after React has had time to process state updates
  // Using requestAnimationFrame + setTimeout ensures we wait for:
  // 1. React's batched state updates to flush
  // 2. Any useEffect hooks triggered by the restore to complete
  requestAnimationFrame(() => {
    setTimeout(() => {
      store.set(decrementRestoringAtom);
    }, 0);
  });
});

/**
 * Go forward in navigation history.
 */
export const goForwardAtom = atom(null, (get, set) => {
  const state = get(navigationHistoryAtom);

  if (state.currentIndex >= state.entries.length - 1) {
    return;
  }

  // Increment restoring counter to prevent recording this navigation
  set(incrementRestoringAtom);

  // Move forward
  const newIndex = state.currentIndex + 1;
  const entry = state.entries[newIndex];

  set(navigationHistoryAtom, {
    ...state,
    currentIndex: newIndex,
  });

  // Restore the entry
  restoreEntry(entry);

  // Decrement restoring counter after React has had time to process state updates
  // Using requestAnimationFrame + setTimeout ensures we wait for:
  // 1. React's batched state updates to flush
  // 2. Any useEffect hooks triggered by the restore to complete
  requestAnimationFrame(() => {
    setTimeout(() => {
      store.set(decrementRestoringAtom);
    }, 0);
  });
});

// ============================================================
// Persistence
// ============================================================

// Per-workspace debounce timers. A push for project A should not be
// cancelled when the user switches to project B before the timer fires.
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule debounced persistence of navigation history for `workspacePath`.
 */
function schedulePersist(workspacePath: string): void {
  const existing = persistTimers.get(workspacePath);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(async () => {
    persistTimers.delete(workspacePath);

    try {
      if (!window.electronAPI?.invoke) return;
      const state = store.get(navigationHistoryAtomFamily(workspacePath));
      await window.electronAPI.invoke('workspace:update-state', workspacePath, {
        navigationHistory: {
          entries: state.entries,
          currentIndex: state.currentIndex,
        },
      });
    } catch (err) {
      console.error('[navigationHistory] Failed to persist:', err);
    }
  }, 500);

  persistTimers.set(workspacePath, timer);
}

// ============================================================
// Initialization
// ============================================================

// Guard against double-initialization per workspace (React StrictMode calls
// effects twice; in multi-project mode each open project has its own init).
const initPromises = new Map<string, Promise<void>>();

/**
 * Initialize navigation history from workspace state.
 * Call this when workspace path is known.
 *
 * Guarded against double-initialization per workspace.
 *
 * @param workspacePath The workspace whose history should be loaded.
 * @param options.setActive When true (default), this workspace becomes the
 *   active path for the window. Pass `false` to warm-load history for the
 *   project rail without stealing focus.
 */
export async function initNavigationHistory(
  workspacePath: string,
  options: { setActive?: boolean } = {}
): Promise<void> {
  const { setActive = true } = options;
  if (setActive) {
    store.set(activeWorkspacePathAtom, workspacePath);
  }

  const existing = initPromises.get(workspacePath);
  if (existing) return existing;

  const promise = (async () => {
    try {
      if (!window.electronAPI?.invoke) return;
      const workspaceState = await window.electronAPI.invoke('workspace:get-state', workspacePath) as { navigationHistory?: NavigationHistoryState } | undefined;
      const saved = workspaceState?.navigationHistory;

      if (saved && Array.isArray(saved.entries)) {
        store.set(navigationHistoryAtomFamily(workspacePath), {
          entries: saved.entries,
          currentIndex: saved.currentIndex ?? saved.entries.length - 1,
        });
        console.log('[navigationHistory] Loaded', saved.entries.length, 'entries for', workspacePath);
      }
    } catch (err) {
      console.error('[navigationHistory] Failed to load:', err);
    }
  })();

  initPromises.set(workspacePath, promise);
  return promise;
}

/**
 * Clear navigation history for the active workspace (for testing or reset).
 */
export function clearNavigationHistory(): void {
  const workspacePath = store.get(activeWorkspacePathAtom);
  if (!workspacePath) return;
  store.set(navigationHistoryAtomFamily(workspacePath), DEFAULT_NAVIGATION_HISTORY);
  initPromises.delete(workspacePath);
}
