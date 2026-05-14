import { useState, useCallback } from 'react';
import { errorNotificationService } from '../services/ErrorNotificationService';

export interface ArchiveWorktreeDialogState {
  worktreeId: string;
  worktreeName: string;
  worktreePath: string;
  hasUncommittedChanges: boolean;
  uncommittedFileCount: number;
  hasUnmergedChanges: boolean;
  unmergedCommitCount: number;
}

export interface UseArchiveWorktreeDialogResult {
  /** Current dialog state, or null if dialog is not shown */
  dialogState: ArchiveWorktreeDialogState | null;
  /**
   * Check worktree status and either auto-archive (if clean + merged) or show the confirmation dialog.
   * Returns true if auto-archived without showing dialog.
   */
  showDialog: (params: {
    worktreeId: string;
    worktreeName: string;
    worktreePath: string;
    workspacePath: string;
  }) => Promise<boolean>;
  /** Close the dialog without archiving */
  closeDialog: () => void;
  /** Confirm archive and perform the operation */
  confirmArchive: (workspacePath: string, onSuccess?: () => void) => Promise<void>;
}

/**
 * Hook to manage the archive worktree confirmation dialog.
 * Handles fetching worktree status, auto-archiving when clean, and showing the dialog when needed.
 */
export function useArchiveWorktreeDialog(): UseArchiveWorktreeDialogResult {
  const [dialogState, setDialogState] = useState<ArchiveWorktreeDialogState | null>(null);

  const showDialog = useCallback(async (params: {
    worktreeId: string;
    worktreeName: string;
    worktreePath: string;
    workspacePath: string;
  }): Promise<boolean> => {
    const { worktreeId, worktreeName, worktreePath, workspacePath } = params;

    // console.log('[useArchiveWorktreeDialog] showDialog called', { worktreeId, worktreeName, worktreePath, workspacePath });

    // Fetch worktree status to check for uncommitted/unmerged changes
    let hasUncommittedChanges = false;
    let uncommittedFileCount = 0;
    let hasUnmergedChanges = false;
    let unmergedCommitCount = 0;
    let statusFetched = false;

    if (worktreePath) {
      try {
        // Fetch base branch from origin first to ensure remote refs are up-to-date
        const result = await window.electronAPI.worktreeGetStatus(worktreePath, { fetchFirst: true });
        // console.log('[useArchiveWorktreeDialog] worktreeGetStatus result', result);
        if (result.success && result.status) {
          statusFetched = true;
          hasUncommittedChanges = result.status.hasUncommittedChanges;
          uncommittedFileCount = result.status.modifiedFileCount;

          // If the branch isn't confirmed merged, treat as having unmerged changes.
          // This is conservative: if the merge comparison fails (defaults to isMerged=false,
          // commitsAhead=0), we show the dialog rather than silently auto-archiving.
          const isMerged = result.status.isMerged ?? false;
          if (!isMerged) {
            hasUnmergedChanges = true;
            unmergedCommitCount = result.status.uniqueCommitsAhead ?? result.status.commitsAhead ?? 0;
          }
        }
      } catch (error) {
        console.error('[useArchiveWorktreeDialog] Failed to get worktree status:', error);
      }
    } else {
      console.warn('[useArchiveWorktreeDialog] No worktreePath provided, skipping status check');
    }

    // console.log('[useArchiveWorktreeDialog] Status check result', {
    //   statusFetched,
    //   hasUncommittedChanges,
    //   uncommittedFileCount,
    //   hasUnmergedChanges,
    //   unmergedCommitCount,
    // });

    // If status was fetched and everything is clean, auto-archive without dialog
    if (statusFetched && !hasUncommittedChanges && !hasUnmergedChanges) {
      // console.log('[useArchiveWorktreeDialog] Auto-archiving (clean + merged)');
      try {
        const result = await window.electronAPI.worktreeArchive(worktreeId, workspacePath);
        if (result.success) {
          // console.log('[useArchiveWorktreeDialog] Auto-archive succeeded');
          return true;
        }
        // Backend rejected the archive (e.g. worktree row missing, filesystem
        // error renaming the worktree dir). Previously logged silently; now
        // surfaced so the user knows why nothing visible happened. See #282.
        const msg = result.error ? String(result.error) : 'The backend rejected the auto-archive.';
        errorNotificationService.showError(`Failed to archive "${worktreeName}"`, msg);
        console.error('[useArchiveWorktreeDialog] Auto-archive failed:', result.error);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errorNotificationService.showError(`Failed to archive "${worktreeName}"`, msg);
        console.error('[useArchiveWorktreeDialog] Auto-archive failed:', error);
      }
      // Fall through to show dialog on archive error
    }

    // console.log('[useArchiveWorktreeDialog] Showing dialog');
    setDialogState({
      worktreeId,
      worktreeName,
      worktreePath,
      hasUncommittedChanges,
      uncommittedFileCount,
      hasUnmergedChanges,
      unmergedCommitCount,
    });

    return false;
  }, []);

  const closeDialog = useCallback(() => {
    setDialogState(null);
  }, []);

  const confirmArchive = useCallback(async (workspacePath: string, onSuccess?: () => void) => {
    if (!dialogState) return;

    const worktreeName = dialogState.worktreeName;
    try {
      const result = await window.electronAPI.worktreeArchive(dialogState.worktreeId, workspacePath);

      if (result.success) {
        onSuccess?.();
      } else {
        // The user clicked Confirm on the dialog. Previously the dialog
        // simply closed with no UI feedback on failure, which reads as
        // "Archive did nothing". Surface the rejection. See #282.
        const msg = result.error ? String(result.error) : 'The backend rejected the archive.';
        errorNotificationService.showError(`Failed to archive "${worktreeName}"`, msg);
        console.error('[useArchiveWorktreeDialog] Failed to archive worktree:', result.error);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errorNotificationService.showError(`Failed to archive "${worktreeName}"`, msg);
      console.error('[useArchiveWorktreeDialog] Failed to archive worktree:', error);
    } finally {
      setDialogState(null);
    }
  }, [dialogState]);

  return {
    dialogState,
    showDialog,
    closeDialog,
    confirmArchive,
  };
}
