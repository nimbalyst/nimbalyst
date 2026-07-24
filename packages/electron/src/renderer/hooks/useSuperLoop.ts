/**
 * useSuperLoop - Hooks for managing Super Loop state
 *
 * IPC event listeners are centralized in store/listeners/superLoopListeners.ts.
 * This file provides hooks for initial data loading and UI utilities.
 */

import { useEffect, useCallback } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import {
  setSuperLoopsAtom,
  superLoopListAtom,
  activeSuperLoopsAtom,
  newSuperLoopDialogOpenAtom,
} from '../store/atoms/superLoop';

/**
 * Load Super Loop data for a workspace on mount.
 * IPC event listeners are handled by centralized listeners (initSuperLoopListeners).
 */
export function useSuperLoopInit(workspacePath: string | null, enabled = true) {
  const setSuperLoops = useSetAtom(setSuperLoopsAtom);

  useEffect(() => {
    if (!enabled || !workspacePath) return;

    const loadLoops = async () => {
      try {
        const result = await window.electronAPI.invoke('super-loop:list', workspacePath);
        if (result.success && result.loops) {
          setSuperLoops(result.loops);
        }
      } catch (err) {
        console.error('[useSuperLoopInit] Failed to load super loops:', err);
      }
    };

    loadLoops();
  }, [enabled, workspacePath, setSuperLoops]);
}

/**
 * Hook for Super Loop dialog management
 *
 * Super Loops automatically create their own dedicated worktree,
 * so no worktree selection is needed.
 */
export function useSuperLoopDialog() {
  const setDialogOpen = useSetAtom(newSuperLoopDialogOpenAtom);

  const openDialog = useCallback(() => {
    setDialogOpen(true);
  }, [setDialogOpen]);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
  }, [setDialogOpen]);

  return { openDialog, closeDialog };
}

/**
 * Hook to get Super Loop for a specific worktree
 */
export function useSuperLoopForWorktree(worktreeId: string | null) {
  const loops = useAtomValue(superLoopListAtom);

  return loops.find(loop => loop.worktreeId === worktreeId) ?? null;
}

/**
 * Hook to control a Super Loop
 */
export function useSuperLoopControls(superLoopId: string) {
  const start = useCallback(async () => {
    const result = await window.electronAPI.invoke('super-loop:start', superLoopId);
    return result.success;
  }, [superLoopId]);

  const pause = useCallback(async () => {
    const result = await window.electronAPI.invoke('super-loop:pause', superLoopId);
    return result.success;
  }, [superLoopId]);

  const stop = useCallback(async (reason?: string) => {
    const result = await window.electronAPI.invoke('super-loop:stop', superLoopId, reason);
    return result.success;
  }, [superLoopId]);

  const deleteLoop = useCallback(async () => {
    const result = await window.electronAPI.invoke('super-loop:delete', superLoopId);
    return result.success;
  }, [superLoopId]);

  const forceResume = useCallback(async (options?: { bumpMaxIterations?: number; resetCompletionSignal?: boolean }) => {
    const result = await window.electronAPI.invoke('super-loop:force-resume', superLoopId, options);
    return result.success;
  }, [superLoopId]);

  return { start, pause, stop, delete: deleteLoop, forceResume };
}

/**
 * Get active Super Loops count (for badges etc)
 */
export function useActiveSuperLoopsCount(): number {
  const activeLoops = useAtomValue(activeSuperLoopsAtom);
  return activeLoops.length;
}
