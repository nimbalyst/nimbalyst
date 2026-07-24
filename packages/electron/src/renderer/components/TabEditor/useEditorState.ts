/**
 * useEditorState - Consolidated state management for TabEditor
 *
 * This hook owns all editor state and provides a clean separation between:
 * - Content tracking (currentContent, lastSavedContent)
 * - Dirty detection (host-controlled, single source of truth)
 * - Diff mode (orthogonal to dirty state)
 * - Programmatic change suppression
 *
 * Key insight: "Saved state" and "Diff baseline" are DIFFERENT concepts:
 * - Saved state: What's on disk (for dirty detection)
 * - Diff baseline: What we're comparing against in diff mode (pre-edit content)
 */

import { useCallback, useRef, useState, useMemo } from 'react';

/**
 * Diff mode state - tracks AI edit visualization
 */
export interface DiffModeState {
  isActive: boolean;
  baseline: string;      // Pre-edit content for diff visualization
  target: string;        // AI's proposed content (what's now on disk)
  tagId: string;         // For history tracking
  sessionId: string;     // AI session that made the edit
  filePath: string;      // File being edited
}

/**
 * Editor state managed by this hook
 */
export interface EditorState {
  // Content tracking
  currentContent: string;
  lastSavedContent: string;

  // Dirty detection (computed, not set directly)
  isDirty: boolean;

  // Diff mode (separate from dirty state)
  diffMode: DiffModeState | null;

  // Flags
  isApplyingProgrammaticChange: boolean;
}

/**
 * Actions returned by the hook for state manipulation
 */
export interface EditorStateActions {
  // Content management
  setCurrentContent: (content: string) => void;
  setLastSavedContent: (content: string) => void;
  syncContentAfterSave: (savedContent: string) => void;

  // Diff mode management
  enterDiffMode: (params: {
    baseline: string;
    target: string;
    tagId: string;
    sessionId: string;
    filePath: string;
  }) => void;
  exitDiffMode: () => void;
  updateDiffTarget: (newTarget: string) => void;

  // Programmatic change control
  beginProgrammaticChange: () => void;
  endProgrammaticChange: () => void;
  withProgrammaticChange: <T>(fn: () => T) => T;

  // Manual dirty override (for edge cases)
  resetDirtyState: () => void;
}

/**
 * Refs for stable access in timers/callbacks
 */
export interface EditorStateRefs {
  currentContentRef: React.MutableRefObject<string>;
  lastSavedContentRef: React.MutableRefObject<string>;
  isDirtyRef: React.MutableRefObject<boolean>;
  diffModeRef: React.MutableRefObject<DiffModeState | null>;
  isApplyingProgrammaticChangeRef: React.MutableRefObject<boolean>;
}

export interface UseEditorStateOptions {
  initialContent: string;
  onDirtyChange?: (isDirty: boolean) => void;
}

export interface UseEditorStateReturn {
  state: EditorState;
  actions: EditorStateActions;
  refs: EditorStateRefs;
}

/**
 * Compute dirty state from current and saved content
 *
 * This is the SINGLE source of truth for dirty detection.
 * Programmatic changes do NOT make the document dirty.
 */
function computeDirtyState(
  currentContent: string,
  lastSavedContent: string,
  isApplyingProgrammaticChange: boolean,
  diffMode: DiffModeState | null
): boolean {
  // Programmatic changes never make dirty
  if (isApplyingProgrammaticChange) {
    return false;
  }

  // In diff mode, compare against the diff target (AI's proposed content)
  // not the baseline (pre-edit content)
  if (diffMode?.isActive) {
    // If content matches the target, user hasn't made additional edits
    if (currentContent === diffMode.target) {
      return false;
    }
    // User has edited on top of the diff - this IS dirty
    return true;
  }

  // Normal mode: compare against last saved content
  return currentContent !== lastSavedContent;
}

/**
 * useEditorState - Consolidated editor state management
 *
 * Usage:
 * ```typescript
 * const { state, actions, refs } = useEditorState({
 *   initialContent,
 *   onDirtyChange
 * });
 *
 * // In content change handler
 * actions.setCurrentContent(newContent);
 *
 * // In diff mode entry
 * actions.enterDiffMode({ baseline, target, tagId, sessionId, filePath });
 *
 * // During programmatic updates
 * actions.beginProgrammaticChange();
 * editor.loadContent(content);
 * actions.endProgrammaticChange();
 * ```
 */
export function useEditorState({
  initialContent,
  onDirtyChange
}: UseEditorStateOptions): UseEditorStateReturn {
  // Core state
  const [currentContent, setCurrentContentState] = useState(initialContent);
  const [lastSavedContent, setLastSavedContentState] = useState(initialContent);
  const [diffMode, setDiffMode] = useState<DiffModeState | null>(null);
  const [isApplyingProgrammaticChange, setIsApplyingProgrammaticChange] = useState(false);

  // Refs for stable access
  const currentContentRef = useRef(currentContent);
  const lastSavedContentRef = useRef(lastSavedContent);
  const diffModeRef = useRef(diffMode);
  const isApplyingProgrammaticChangeRef = useRef(isApplyingProgrammaticChange);

  // Sync refs with state
  currentContentRef.current = currentContent;
  lastSavedContentRef.current = lastSavedContent;
  diffModeRef.current = diffMode;
  isApplyingProgrammaticChangeRef.current = isApplyingProgrammaticChange;

  // Compute dirty state
  const isDirty = useMemo(
    () => computeDirtyState(currentContent, lastSavedContent, isApplyingProgrammaticChange, diffMode),
    [currentContent, lastSavedContent, isApplyingProgrammaticChange, diffMode]
  );

  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  // Track previous dirty state for change notification
  const prevIsDirtyRef = useRef(isDirty);

  // Notify parent when dirty state changes
  if (isDirty !== prevIsDirtyRef.current) {
    prevIsDirtyRef.current = isDirty;
    onDirtyChange?.(isDirty);
  }

  // Actions
  const setCurrentContent = useCallback((content: string) => {
    setCurrentContentState(content);
    currentContentRef.current = content;
  }, []);

  const setLastSavedContent = useCallback((content: string) => {
    setLastSavedContentState(content);
    lastSavedContentRef.current = content;
  }, []);

  const syncContentAfterSave = useCallback((savedContent: string) => {
    setLastSavedContentState(savedContent);
    lastSavedContentRef.current = savedContent;
    // Also update current content ref to match (content hasn't changed, just saved)
    currentContentRef.current = savedContent;
    setCurrentContentState(savedContent);
  }, []);

  const enterDiffMode = useCallback((params: {
    baseline: string;
    target: string;
    tagId: string;
    sessionId: string;
    filePath: string;
  }) => {
    const newDiffMode: DiffModeState = {
      isActive: true,
      ...params
    };
    setDiffMode(newDiffMode);
    diffModeRef.current = newDiffMode;
  }, []);

  const exitDiffMode = useCallback(() => {
    setDiffMode(null);
    diffModeRef.current = null;
  }, []);

  const updateDiffTarget = useCallback((newTarget: string) => {
    setDiffMode(prev => {
      if (!prev) return null;
      const updated = { ...prev, target: newTarget };
      diffModeRef.current = updated;
      return updated;
    });
  }, []);

  const beginProgrammaticChange = useCallback(() => {
    setIsApplyingProgrammaticChange(true);
    isApplyingProgrammaticChangeRef.current = true;
  }, []);

  const endProgrammaticChange = useCallback(() => {
    setIsApplyingProgrammaticChange(false);
    isApplyingProgrammaticChangeRef.current = false;
  }, []);

  const withProgrammaticChange = useCallback(<T,>(fn: () => T): T => {
    setIsApplyingProgrammaticChange(true);
    isApplyingProgrammaticChangeRef.current = true;
    try {
      return fn();
    } finally {
      setIsApplyingProgrammaticChange(false);
      isApplyingProgrammaticChangeRef.current = false;
    }
  }, []);

  const resetDirtyState = useCallback(() => {
    // Force dirty to false by syncing current with last saved
    setLastSavedContentState(currentContentRef.current);
    lastSavedContentRef.current = currentContentRef.current;
    onDirtyChange?.(false);
  }, [onDirtyChange]);

  // Build state object
  const state: EditorState = useMemo(() => ({
    currentContent,
    lastSavedContent,
    isDirty,
    diffMode,
    isApplyingProgrammaticChange
  }), [currentContent, lastSavedContent, isDirty, diffMode, isApplyingProgrammaticChange]);

  // Build actions object (stable references via useCallback)
  const actions: EditorStateActions = useMemo(() => ({
    setCurrentContent,
    setLastSavedContent,
    syncContentAfterSave,
    enterDiffMode,
    exitDiffMode,
    updateDiffTarget,
    beginProgrammaticChange,
    endProgrammaticChange,
    withProgrammaticChange,
    resetDirtyState
  }), [
    setCurrentContent,
    setLastSavedContent,
    syncContentAfterSave,
    enterDiffMode,
    exitDiffMode,
    updateDiffTarget,
    beginProgrammaticChange,
    endProgrammaticChange,
    withProgrammaticChange,
    resetDirtyState
  ]);

  // Build refs object
  const refs: EditorStateRefs = useMemo(() => ({
    currentContentRef,
    lastSavedContentRef,
    isDirtyRef,
    diffModeRef,
    isApplyingProgrammaticChangeRef
  }), []);

  return { state, actions, refs };
}
