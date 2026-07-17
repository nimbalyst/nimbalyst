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

const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function schedulePersist(workspacePath: string, mode: ContentMode): void {
  const existing = persistTimers.get(workspacePath);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(async () => {
    persistTimers.delete(workspacePath);
    try {
      await window.electronAPI.invoke('workspace:update-state', workspacePath, {
        activeMode: mode,
      });
    } catch (err) {
      console.error('[windowMode] Failed to persist:', err);
    }
  }, 500);
  persistTimers.set(workspacePath, timer);
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
      initializedModes.set(workspacePath, mode);
      schedulePersist(workspacePath, mode);
    }
  }
);

// ============================================================
// Initialization
// ============================================================

// Cache initialization per workspace. A single global promise lets a stale
// response from project A overwrite the active mode after switching to B.
const initPromises = new Map<string, Promise<void>>();
const initializedModes = new Map<string, ContentMode>();

/**
 * Initialize window mode from workspace state.
 * Call this when workspace path is known.
 *
 * Guarded against double-initialization - if called multiple times for the
 * same workspace, returns the existing promise.
 */
export async function initWindowMode(workspacePath: string): Promise<void> {
  store.set(windowModeWorkspaceAtom, workspacePath);

  const cachedMode = initializedModes.get(workspacePath);
  if (cachedMode) {
    store.set(windowModeAtom, cachedMode);
    return;
  }

  const existing = initPromises.get(workspacePath);
  if (existing) return existing;

  const initPromise = (async () => {

    try {
      const workspaceState = await window.electronAPI.invoke(
        'workspace:get-state',
        workspacePath
      );

      const validModes: ContentMode[] = ['files', 'agent', 'tracker', 'collab', 'pr-review', 'settings'];
      const restoredMode = validModes.includes(workspaceState?.activeMode)
        ? workspaceState.activeMode as ContentMode
        : 'files';
      initializedModes.set(workspacePath, restoredMode);

      // Only the workspace that is still active may publish into the global
      // compatibility atom. Late responses remain cached for their own path.
      if (store.get(windowModeWorkspaceAtom) === workspacePath) {
        store.set(windowModeAtom, restoredMode);
      }
    } catch (err) {
      console.error('[windowMode] Failed to load:', err);
    }
  })();

  initPromises.set(workspacePath, initPromise);
  try {
    await initPromise;
  } finally {
    initPromises.delete(workspacePath);
  }
}

/**
 * Reset window mode to defaults.
 */
export function resetWindowMode(): void {
  store.set(windowModeAtom, 'files');
  store.set(windowModeWorkspaceAtom, null);
  for (const timer of persistTimers.values()) clearTimeout(timer);
  persistTimers.clear();
  initPromises.clear();
  initializedModes.clear();
}
