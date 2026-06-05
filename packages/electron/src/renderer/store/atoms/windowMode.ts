/**
 * Window Mode Atoms
 *
 * Manages which view is active in the project window (files, agent, settings).
 * Controlled by the navigation gutter on the left.
 *
 * @example
 * const mode = useAtomValue(windowModeAtom);
 * const setMode = useSetAtom(setWindowModeAtom);
 * setMode('agent');
 */

import { atom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import type { ContentMode } from '../../types/WindowModeTypes';
import { DocumentModelRegistry } from '../../services/document-model/DocumentModelRegistry';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';

// Re-export ContentMode for convenience (TODO: rename type to WindowMode)
export type { ContentMode };

// ============================================================
// Main Atoms
// ============================================================

/**
 * The active window mode.
 * Controls which main panel is displayed (files, agent, settings).
 */
export const windowModeAtom = atom<ContentMode>('files');

// Track workspace path for persistence
const windowModeWorkspaceAtom = atom<string | null>(null);

// ============================================================
// Debounced Persistence
// ============================================================

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(workspacePath: string, mode: ContentMode): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(async () => {
    try {
      await window.electronAPI.invoke('workspace:update-state', workspacePath, {
        activeMode: mode,
      });
    } catch (err) {
      console.error('[windowMode] Failed to persist:', err);
    }
  }, 500);
}

// ============================================================
// Setter Atoms
// ============================================================

/**
 * Set the window mode.
 * Automatically persists to workspace state (debounced).
 * Flushes any dirty editors via DocumentModelRegistry on mode switch
 * to prevent data loss when navigating away from files.
 */
export const setWindowModeAtom = atom(
  null,
  (get, set, mode: ContentMode) => {
    const previousMode = get(windowModeAtom);
    set(windowModeAtom, mode);

    // Flush dirty editors on any mode switch.
    // Files->Agent: persists unsaved editor content before editors are hidden.
    // Agent->Files: persists any changes made by AI tools before editors reload.
    if (previousMode !== mode) {
      DocumentModelRegistry.flushAll().catch((err) => {
        console.error('[windowMode] Failed to flush dirty editors on mode switch:', err);
      });

      if (mode === 'tracker') {
        window.electronAPI?.featureUsage?.record(FEATURE_USAGE_KEYS.TRACKER_USED).catch((err) => {
          console.error('[windowMode] Failed to record tracker usage:', err);
        });
      }
    }

    const workspacePath = get(windowModeWorkspaceAtom);
    if (workspacePath) {
      schedulePersist(workspacePath, mode);
    }
  }
);

// ============================================================
// Initialization
// ============================================================

// Guard against double-initialization (React StrictMode calls effects twice)
let initPromise: Promise<void> | null = null;
let initializedWorkspace: string | null = null;

/**
 * Initialize window mode from workspace state.
 * Call this when workspace path is known.
 *
 * Guarded against double-initialization - if called multiple times for the
 * same workspace, returns the existing promise.
 */
export async function initWindowMode(workspacePath: string): Promise<void> {
  // If already initialized for this workspace, return existing promise
  if (initializedWorkspace === workspacePath && initPromise) {
    return initPromise;
  }

  // If initializing a different workspace, reset
  if (initializedWorkspace !== workspacePath) {
    initializedWorkspace = workspacePath;
    initPromise = null;
  }

  // Create the initialization promise
  initPromise = (async () => {
    store.set(windowModeWorkspaceAtom, workspacePath);

    try {
      const workspaceState = await window.electronAPI.invoke(
        'workspace:get-state',
        workspacePath
      );

      if (workspaceState?.activeMode) {
        const validModes: ContentMode[] = ['files', 'agent', 'tracker', 'collab', 'pr-review', 'settings'];
        if (validModes.includes(workspaceState.activeMode)) {
          store.set(windowModeAtom, workspaceState.activeMode);
        }
      }
    } catch (err) {
      console.error('[windowMode] Failed to load:', err);
    }
  })();

  return initPromise;
}

/**
 * Reset window mode to defaults.
 */
export function resetWindowMode(): void {
  store.set(windowModeAtom, 'files');
  store.set(windowModeWorkspaceAtom, null);
  initPromise = null;
  initializedWorkspace = null;
}
