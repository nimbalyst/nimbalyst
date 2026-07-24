/**
 * Tab State Hooks
 *
 * Hooks for subscribing to per-tab state (dirty, processing, pending changes).
 * Uses Jotai atom families so each tab subscribes to only its own state.
 *
 * These hooks replace the manual subscription system in TabsContext.
 */

import { useAtomValue, useSetAtom } from 'jotai';
import {
  editorDirtyAtom,
  editorProcessingAtom,
  editorHasUnacceptedChangesAtom,
  makeEditorKey,
  type EditorKey,
} from '@nimbalyst/runtime/store';
import {
  collabConnectionStatusAtom,
  hasCollabUnsyncedChanges,
} from '../store/atoms/collabEditor';

/**
 * Subscribe to a tab's dirty state.
 * Only this component will re-render when this tab's dirty state changes.
 *
 * @param filePath - The file path of the editor
 * @param sessionId - Optional session ID for worktree editors
 */
export function useTabDirty(filePath: string, sessionId?: string): boolean {
  const key = makeEditorKey(filePath, sessionId);
  return useAtomValue(editorDirtyAtom(key));
}

/**
 * Subscribe to a tab's processing state (AI is making changes).
 * Only this component will re-render when this tab's processing state changes.
 */
export function useTabProcessing(filePath: string, sessionId?: string): boolean {
  const key = makeEditorKey(filePath, sessionId);
  return useAtomValue(editorProcessingAtom(key));
}

/**
 * Subscribe to a tab's pending changes state (has AI diffs awaiting review).
 * Only this component will re-render when this tab's pending state changes.
 */
export function useTabHasUnacceptedChanges(filePath: string, sessionId?: string): boolean {
  const key = makeEditorKey(filePath, sessionId);
  return useAtomValue(editorHasUnacceptedChangesAtom(key));
}

/**
 * Subscribe to whether a collaborative tab still has local unacknowledged changes.
 */
export function useTabHasCollabUnsyncedChanges(filePath: string): boolean {
  const status = useAtomValue(collabConnectionStatusAtom(filePath));
  return hasCollabUnsyncedChanges(status);
}

/**
 * Get setter for dirty state (for TabEditor to call).
 */
export function useSetTabDirty(filePath: string, sessionId?: string) {
  const key = makeEditorKey(filePath, sessionId);
  return useSetAtom(editorDirtyAtom(key));
}

/**
 * Get setter for processing state.
 */
export function useSetTabProcessing(filePath: string, sessionId?: string) {
  const key = makeEditorKey(filePath, sessionId);
  return useSetAtom(editorProcessingAtom(key));
}

/**
 * Get setter for pending changes state.
 */
export function useSetTabHasUnacceptedChanges(filePath: string, sessionId?: string) {
  const key = makeEditorKey(filePath, sessionId);
  return useSetAtom(editorHasUnacceptedChangesAtom(key));
}

/**
 * Re-export for imperative use outside React (e.g., in EditorHost callbacks).
 */
export { editorDirtyAtom, editorProcessingAtom, editorHasUnacceptedChangesAtom, makeEditorKey };
