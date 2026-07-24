import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Adapter describing how a given mode maximizes the editor section.
 *
 * `S` is a mode-specific snapshot of the restorable layout state (e.g. the
 * collapse booleans of the surrounding panels). The hook is agnostic to its
 * shape — it only captures it on maximize and hands it back on restore.
 */
export interface EditorMaximizeAdapter<S> {
  /**
   * Identity for the layout scope being maximized, such as a workspace path or
   * workstream id. Changing it clears any pending restore snapshot so state
   * captured in one scope cannot be applied to another.
   */
  scopeKey?: string;
  /** Capture the current restorable layout state. */
  snapshot: () => S;
  /** Collapse every sibling panel so the editor fills the window. */
  maximize: () => void;
  /** Restore a previously captured layout state. */
  restore: (snapshot: S) => void;
}

export interface EditorMaximizeControls {
  /** Whether the editor is currently maximized by this hook. */
  isMaximized: boolean;
  /** Toggle between maximized and the captured prior layout. */
  toggle: () => void;
  /**
   * Drop the pending restore snapshot without changing any panel state.
   * Call this when the user manually toggles a panel while maximized so the
   * next {@link toggle} re-maximizes from the current layout instead of
   * applying a now-stale restore.
   */
  clearMaximize: () => void;
}

/**
 * Double-click-to-maximize state machine shared by Files, Agent, and Shared
 * Docs modes. The editor subtree is never unmounted — modes collapse their
 * sibling panels via the adapter, keeping stateful editors alive (see
 * docs/EDITOR_STATE.md §4).
 *
 * The snapshot lives only in memory (transient across restarts by design).
 */
export function useEditorMaximize<S>(adapter: EditorMaximizeAdapter<S>): EditorMaximizeControls {
  // Keep the latest adapter so toggle/clearMaximize stay stable yet never read
  // a stale closure over the mode's current panel state.
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;

  // Presence of a snapshot IS the "maximized" flag; the state mirror only
  // exists to trigger re-renders for `isMaximized` consumers.
  const snapshotRef = useRef<S | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (snapshotRef.current !== null) {
      snapshotRef.current = null;
      setIsMaximized(false);
    }
  }, [adapter.scopeKey]);

  const toggle = useCallback(() => {
    if (snapshotRef.current !== null) {
      adapterRef.current.restore(snapshotRef.current);
      snapshotRef.current = null;
      setIsMaximized(false);
    } else {
      snapshotRef.current = adapterRef.current.snapshot();
      adapterRef.current.maximize();
      setIsMaximized(true);
    }
  }, []);

  const clearMaximize = useCallback(() => {
    if (snapshotRef.current !== null) {
      snapshotRef.current = null;
      setIsMaximized(false);
    }
  }, []);

  return { isMaximized, toggle, clearMaximize };
}
