import { useCallback, useSyncExternalStore } from 'react';

export type GitTab = 'log' | 'changes' | 'output';

export interface PanelState {
  activeTab: GitTab;
  selectedHash: string | null;
}

const DEFAULT_STATE: PanelState = { activeTab: 'log', selectedHash: null };

// Module-level store keyed by workspace path, so panel state survives
// component unmount/remount within the same renderer process.
const stateByWorkspace = new Map<string, PanelState>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function ensureState(workspacePath: string): PanelState {
  let s = stateByWorkspace.get(workspacePath);
  if (!s) {
    s = { ...DEFAULT_STATE };
    stateByWorkspace.set(workspacePath, s);
  }
  return s;
}

function patch(workspacePath: string, update: Partial<PanelState>) {
  const prev = ensureState(workspacePath);
  stateByWorkspace.set(workspacePath, { ...prev, ...update });
  emit();
}

/**
 * Read the live selectedHash from the module store.
 * Used by callers that need to compute updates from the current value
 * without triggering stale-closure issues in event handlers.
 */
export function readSelectedHash(workspacePath: string): string | null {
  return ensureState(workspacePath).selectedHash;
}

/**
 * Hook for the git panel's per-workspace UI state (active tab, selected commit).
 * Backed by a module-level store so the state persists across panel
 * unmount/remount within the same renderer.
 */
export function usePanelState(workspacePath: string) {
  const state = useSyncExternalStore(
    subscribe,
    () => ensureState(workspacePath),
  );

  const setActiveTab = useCallback((tab: GitTab) => {
    patch(workspacePath, { activeTab: tab });
  }, [workspacePath]);

  const setSelectedHash = useCallback((hash: string | null) => {
    patch(workspacePath, { selectedHash: hash });
  }, [workspacePath]);

  return {
    activeTab: state.activeTab,
    selectedHash: state.selectedHash,
    setActiveTab,
    setSelectedHash,
  };
}
