/**
 * FilesEditedSidebar - Shows files edited by AI in the current workstream.
 *
 * Uses the FileEditsSidebar component from runtime with all its features:
 * - Smart folder collapse
 * - Git status indicators
 * - Pending review indicators
 * - Group by directory toggle
 * - Expand/collapse all controls
 *
 * Fetches file edits from the database for ALL sessions in the workstream.
 * Optionally allows filtering by a specific child session.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getWorktreeNameFromPath } from '../../utils/pathUtils';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { FileEditsSidebar as FileEditsSidebarComponent, MaterialSymbol } from '@nimbalyst/runtime';
import type { FileEditSummary } from '@nimbalyst/runtime';
import {
  diffTreeGroupByDirectoryAtom,
  setDiffTreeGroupByDirectoryAtom,
  agentFileScopeModeAtom,
  setAgentFileScopeModeAtom,
  type AgentFileScopeMode,
} from '../../store/atoms/projectState';
import { workstreamSessionsAtom } from '../../store/atoms/sessions';
import {
  hasExternalEditorAtom,
  externalEditorNameAtom,
  openInExternalEditorAtom,
  revealInFinderAtom,
  copyFilePathAtom,
} from '../../store/atoms/appSettings';
import { diffPeekSizeAtom, setDiffPeekSizeAtom } from '../../store/atoms/diffPeekSizeAtoms';
import {
  workstreamStagedFilesAtom,
  setWorkstreamStagedFilesAtom,
} from '../../store/atoms/workstreamState';
import {
  sessionFileEditsAtom,
  workstreamFileEditsAtom,
  sessionGitStatusAtom,
  workstreamGitStatusAtom,
  sessionPendingReviewFilesAtom,
  workstreamPendingReviewFilesAtom,
  workspaceUncommittedFilesAtom,
  worktreeChangedFilesAtom,
  type FileEditWithSession,
} from '../../store/atoms/sessionFiles';
import { registerSessionWorkspace, registerWorktreePath, loadInitialSessionFileState } from '../../store/listeners/fileStateListeners';
import { isPathInWorkspace } from '../../../shared/pathUtils';
import { FilesScopeDropdown } from './FilesScopeDropdown';
import { GitOperationsPanel } from './GitOperationsPanel';
import { TodoPanel } from './TodoPanel';
import { TaskListPanel } from './TaskListPanel';
import { TeammatePanel } from './TeammatePanel';
import { TrackerPanel } from './TrackerPanel';

interface FilesEditedSidebarProps {
  /** The workstream ID (parent session ID) - files from all child sessions will be shown */
  workstreamId: string;
  /** The currently active session ID within the workstream - used for AI commit requests */
  activeSessionId: string | null;
  workspacePath: string;
  onFileClick: (filePath: string) => void;
  /** Callback to open file in Files mode (switches to Files mode and opens the file) */
  onOpenInFilesMode?: (filePath: string) => void;
  width?: number;
  /** The worktree ID if this is a worktree session */
  worktreeId?: string | null;
  /** The worktree path if this is a worktree session */
  worktreePath?: string | null;
  /** Callback when worktree is archived */
  onWorktreeArchived?: () => void;
  /** Whether the workspace is a git repository */
  isGitRepo?: boolean;
}


export const FilesEditedSidebar: React.FC<FilesEditedSidebarProps> = React.memo(({
  workstreamId,
  activeSessionId,
  workspacePath,
  onFileClick,
  onOpenInFilesMode,
  width = 256,
  worktreeId,
  worktreePath,
  onWorktreeArchived,
  isGitRepo = false,
}) => {
  const effectiveWorkspacePath = worktreePath || workspacePath;
  // Get all session IDs in this workstream (must be declared before useEffects that use it)
  const workstreamSessions = useAtomValue(workstreamSessionsAtom(workstreamId));
  const hasMultipleSessions = workstreamSessions.length > 1;

  // Read all file/git data from atoms (NO local state, NO IPC subscriptions)
  // Use workstream atoms which combine ALL data from all child sessions
  // The filtering logic will filter down to specific sessions based on user selection
  const allFileEdits = useAtomValue(workstreamFileEditsAtom(workstreamId));
  const sessionFilesGitStatus = useAtomValue(workstreamGitStatusAtom(workstreamId));
  const pendingReviewFiles = useAtomValue(workstreamPendingReviewFilesAtom(workstreamId));
  // For worktrees, use worktreePath; otherwise use main workspacePath
  const uncommittedFilesPath = worktreePath || workspacePath;
  const allUncommittedFiles = useAtomValue(workspaceUncommittedFilesAtom(uncommittedFilesPath));
  // Always call the hook unconditionally with a stable key, use empty array if no worktreeId
  const worktreeChangedFilesKey = worktreeId || '__no_worktree__';
  const worktreeChangedFilesRaw = useAtomValue(worktreeChangedFilesAtom(worktreeChangedFilesKey));
  const worktreeChangedFiles = worktreeId ? worktreeChangedFilesRaw : [];

  // UI state (keep in local state - this is fine)
  const [filterToCurrentSession, setFilterToCurrentSession] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const isWorkspaceCommittableFile = useCallback(
    (filePath: string) => isPathInWorkspace(filePath, effectiveWorkspacePath),
    [effectiveWorkspacePath]
  );

  const workspaceScopedFileEdits = useMemo(
    () => allFileEdits.filter((edit) => isWorkspaceCommittableFile(edit.filePath)),
    [allFileEdits, isWorkspaceCommittableFile]
  );

  // Register this session/worktree with central listener for state updates
  useEffect(() => {
    registerSessionWorkspace(workstreamId, effectiveWorkspacePath);
    if (worktreeId && worktreePath) {
      registerWorktreePath(worktreeId, worktreePath);
    }
  }, [workstreamId, effectiveWorkspacePath, worktreeId, worktreePath]);

  // Lazy load file state for all child sessions in the workstream
  useEffect(() => {
    // Debug logging - uncomment if needed
    // console.log('[FilesEditedSidebar] Loading file state for workstream', workstreamId, 'with', workstreamSessions.length, 'child sessions');

    // Load file state for the workstream itself (parent)
    loadInitialSessionFileState(workstreamId, effectiveWorkspacePath);

    // Also load file state for all child sessions
    workstreamSessions.forEach(sessionId => {
      if (sessionId !== workstreamId) {
        loadInitialSessionFileState(sessionId, effectiveWorkspacePath);
      }
    });
  }, [workstreamId, effectiveWorkspacePath, workstreamSessions]);

  // Group by directory state from Jotai
  const [groupByDirectory] = useAtom(diffTreeGroupByDirectoryAtom);
  const setDiffTreeGroupByDirectory = useSetAtom(setDiffTreeGroupByDirectoryAtom);

  // Staged files - used for checkbox state (per-workstream)
  // Checkboxes are always shown in the new unified design
  const stagedFilesArr = useAtomValue(workstreamStagedFilesAtom(workstreamId));
  const stagedFiles = useMemo(
    () => new Set(stagedFilesArr.filter((filePath) => isPathInWorkspace(filePath, effectiveWorkspacePath))),
    [stagedFilesArr, effectiveWorkspacePath]
  );
  const setStagedFilesAction = useSetAtom(setWorkstreamStagedFilesAtom);

  useEffect(() => {
    if (worktreeId) {
      return;
    }

    const sanitized = stagedFilesArr.filter((filePath) => isPathInWorkspace(filePath, effectiveWorkspacePath));
    if (sanitized.length !== stagedFilesArr.length) {
      setStagedFilesAction({ workstreamId, files: sanitized });
    }
  }, [effectiveWorkspacePath, stagedFilesArr, setStagedFilesAction, workstreamId, worktreeId]);

  // File scope mode for filtering what files to show (workspace-level setting)
  const fileScopeMode = useAtomValue(agentFileScopeModeAtom);
  const setFileScopeModeAction = useSetAtom(setAgentFileScopeModeAtom);

  // File action atoms
  const hasExternalEditor = useAtomValue(hasExternalEditorAtom);
  const externalEditorName = useAtomValue(externalEditorNameAtom);
  const openInExternalEditor = useSetAtom(openInExternalEditorAtom);
  const revealInFinder = useSetAtom(revealInFinderAtom);
  const copyFilePath = useSetAtom(copyFilePathAtom);

  // Diff peek popover (shared persisted size with the git extension and commit widget)
  const diffPeekSize = useAtomValue(diffPeekSizeAtom);
  const setDiffPeekSize = useSetAtom(setDiffPeekSizeAtom);
  const handleGetDiff = useCallback(async (filePath: string) => {
    const gitWorkspacePath = worktreePath || workspacePath;
    if (!gitWorkspacePath) return null;
    // Prefer session-aware diff (pre-edit baseline vs ai-edit snapshot) when an
    // active session has touched this file. Falls back to git's working-tree
    // diff when no session baseline exists. Without this, gitignored or
    // untracked files always render as fully-added (all green) because
    // git:file-diff synthesizes against /dev/null. See NIM-586.
    if (activeSessionId) {
      try {
        const sessionDiff = await window.electronAPI.invoke(
          'session:file-diff',
          gitWorkspacePath,
          activeSessionId,
          filePath,
        ) as { unifiedDiff: string; isBinary: boolean; source: string };
        if (sessionDiff?.unifiedDiff && sessionDiff.unifiedDiff.trim().length > 0) {
          return { unifiedDiff: sessionDiff.unifiedDiff, isBinary: sessionDiff.isBinary };
        }
      } catch {
        // Fall through to git diff on any session-diff failure.
      }
    }
    return await window.electronAPI.invoke(
      'git:file-diff',
      gitWorkspacePath,
      { path: filePath, group: 'working' as const }
    ) as { unifiedDiff: string; isBinary: boolean };
  }, [activeSessionId, worktreePath, workspacePath]);

  const setGroupByDirectory = useCallback((value: boolean) => {
    if (effectiveWorkspacePath) {
      setDiffTreeGroupByDirectory({ groupByDirectory: value, workspacePath: effectiveWorkspacePath });
    }
  }, [effectiveWorkspacePath, setDiffTreeGroupByDirectory]);

  const setFileScopeMode = useCallback((mode: AgentFileScopeMode) => {
    setFileScopeModeAction({ fileScopeMode: mode, workspacePath: effectiveWorkspacePath });
  }, [effectiveWorkspacePath, setFileScopeModeAction]);

  // Helper to check if a file has uncommitted git changes
  const isFileUncommitted = useCallback((filePath: string): boolean => {
    const effectiveWorkspacePath = worktreePath || workspacePath;
    let relativePath = filePath;
    if (filePath.startsWith(effectiveWorkspacePath)) {
      relativePath = filePath.slice(effectiveWorkspacePath.length + 1);
    }
    const status = sessionFilesGitStatus[relativePath];
    // File has uncommitted changes if it has a status and status is not 'unchanged'
    return status !== undefined && status.status !== 'unchanged';
  }, [sessionFilesGitStatus, workspacePath, worktreePath]);

  // Calculate total session files count (deduplicated by filepath)
  const totalSessionFilesCount = useMemo(() => {
    if (!allFileEdits.length) return 0;

    // Deduplicate by filePath (most recent edit wins)
    const fileMap = new Map<string, FileEditWithSession>();
    for (const edit of allFileEdits) {
      const existing = fileMap.get(edit.filePath);
      if (!existing || new Date(edit.timestamp) > new Date(existing.timestamp)) {
        fileMap.set(edit.filePath, edit);
      }
    }
    return fileMap.size;
  }, [allFileEdits]);

  // Filter file edits based on session scope and file scope mode
  const fileEdits = useMemo(() => {
    // First, filter by session scope
    let filtered: FileEditWithSession[];
    if (filterToCurrentSession && activeSessionId) {
      // Filter to current session only
      filtered = allFileEdits.filter(edit => edit.sessionId === activeSessionId);
    } else {
      // Show all files from workstream, deduplicated by filePath (most recent edit wins)
      const fileMap = new Map<string, FileEditWithSession>();
      for (const edit of allFileEdits) {
        const existing = fileMap.get(edit.filePath);
        if (!existing || new Date(edit.timestamp) > new Date(existing.timestamp)) {
          fileMap.set(edit.filePath, edit);
        }
      }
      filtered = Array.from(fileMap.values());
    }

    // Then, filter by file scope mode
    switch (fileScopeMode) {
      case 'current-changes':
        // Only show files that have uncommitted changes
        return filtered.filter(edit => isWorkspaceCommittableFile(edit.filePath) && isFileUncommitted(edit.filePath));

      case 'session-files':
        // Show all files from session(s)
        return filtered;

      case 'all-changes': {
        // Merge uncommitted session files with all other uncommitted files
        // For worktrees, use worktree changed files; for regular sessions, use workspace uncommitted files
        const uncommittedFiltered = filtered.filter(
          edit => isWorkspaceCommittableFile(edit.filePath) && isFileUncommitted(edit.filePath)
        );
        const sessionFilePaths = new Set(uncommittedFiltered.map(f => f.filePath));
        let additionalFiles: FileEditWithSession[];

        if (worktreeId && worktreePath) {
          // For worktrees: add worktree changed files that aren't already in session files
          // Note: worktreeChangedFiles may be empty, that's OK - we just show session files
          additionalFiles = worktreeChangedFiles
            .map(f => `${worktreePath}/${f.path}`) // Convert relative to absolute
            .filter(filePath => !sessionFilePaths.has(filePath))
            .map(filePath => ({
              filePath,
              linkType: 'edited' as const,
              timestamp: new Date().toISOString(),
              sessionId: '', // Not from a session
            }));
        } else {
          // For regular sessions: add uncommitted files from workspace that aren't in session files
          additionalFiles = allUncommittedFiles
            .filter(filePath => !sessionFilePaths.has(filePath))
            .map(filePath => ({
              filePath,
              linkType: 'edited' as const,
              timestamp: new Date().toISOString(),
              sessionId: '', // Not from a session
            }));
        }
        return [...uncommittedFiltered, ...additionalFiles];
      }

      default:
        return filtered;
    }
  }, [allFileEdits, filterToCurrentSession, activeSessionId, fileScopeMode, isWorkspaceCommittableFile, isFileUncommitted, allUncommittedFiles, worktreeId, worktreePath, worktreeChangedFiles]);

  // Memoize editedFiles array for GitOperationsPanel to prevent unnecessary re-renders
  const editedFilePaths = useMemo(() => {
    if (worktreeId) {
      // For worktrees, include worktree changed files
      return [...fileEdits.map((f) => f.filePath), ...worktreeChangedFiles.map(f => f.path)];
    }
    return fileEdits
      .map((f) => f.filePath)
      .filter((filePath) => isWorkspaceCommittableFile(filePath));
  }, [fileEdits, isWorkspaceCommittableFile, worktreeId, worktreeChangedFiles]);

  // Helper to convert absolute path to relative path for worktree comparisons
  const toRelativePath = useCallback((absolutePath: string) => {
    if (worktreePath && absolutePath.startsWith(worktreePath)) {
      return absolutePath.slice(worktreePath.length + 1);
    }
    return absolutePath;
  }, [worktreePath]);

  // For worktrees: compute the set of staged files from worktreeChangedFiles
  // Convert relative paths to absolute for matching with fileEdits
  const worktreeStagedFiles = useMemo(() => {
    if (!worktreeId || !worktreePath) return new Set<string>();
    // Return absolute paths so they match the selectedFiles expected by FileEditsSidebarComponent
    return new Set(worktreeChangedFiles.filter(f => f.staged).map(f => `${worktreePath}/${f.path}`));
  }, [worktreeId, worktreePath, worktreeChangedFiles]);


  // Handle worktree file staging toggle
  const handleWorktreeToggleStaged = useCallback(async (filePath: string) => {
    if (!worktreePath || !worktreeId) {
      return;
    }

    try {
      // Convert to relative path if absolute
      const relativePath = toRelativePath(filePath);
      const file = worktreeChangedFiles.find(f => f.path === relativePath);
      if (!file) {
        // File not in worktreeChangedFiles (e.g., from "All Uncommitted Files"), stage it directly
        await window.electronAPI.invoke('worktree:stage-file', worktreePath, relativePath, true);
        return;
      }

      const newStaged = !file.staged;
      await window.electronAPI.invoke('worktree:stage-file', worktreePath, relativePath, newStaged);

      // Refresh worktree state from backend - the atom will be updated by the IPC call
      // which triggers a git:status-changed event, handled by central listener
    } catch (error) {
      console.error('[FilesEditedSidebar] Failed to toggle worktree file staging:', error);
    }
  }, [worktreePath, worktreeId, worktreeChangedFiles, toRelativePath]);

  // Handle worktree stage all / unstage all
  const handleWorktreeToggleAllStaged = useCallback(async (stage: boolean) => {
    if (!worktreePath || !worktreeId) return;

    try {
      await window.electronAPI.invoke('worktree:stage-all', worktreePath, stage);

      // Worktree state will be updated by the git:status-changed event from central listener
    } catch (error) {
      console.error('[FilesEditedSidebar] Failed to toggle all worktree file staging:', error);
    }
  }, [worktreePath, worktreeId]);

  // Handle file selection change (checkbox toggle)
  // For worktrees, this stages/unstages the file in git
  // For regular sessions, this updates the workstream staged files state
  const handleSelectionChange = useCallback((filePath: string, selected: boolean) => {
    if (worktreeId && worktreePath) {
      // For worktrees, use git staging
      handleWorktreeToggleStaged(filePath);
    } else {
      // For regular sessions, use workstream state
      const newFiles = selected
        ? [...stagedFilesArr, filePath]
        : stagedFilesArr.filter(f => f !== filePath);
      setStagedFilesAction({ workstreamId, files: newFiles });
    }
  }, [worktreeId, worktreePath, stagedFilesArr, setStagedFilesAction, workstreamId, handleWorktreeToggleStaged]);

  // Handle select all files
  const handleSelectAll = useCallback((selected: boolean) => {
    if (worktreeId && worktreePath) {
      // For worktrees, stage/unstage all files
      handleWorktreeToggleAllStaged(selected);
    } else {
      // For regular sessions, use workstream state
      if (selected) {
        setStagedFilesAction({ workstreamId, files: editedFilePaths });
      } else {
        setStagedFilesAction({ workstreamId, files: [] });
      }
    }
  }, [worktreeId, worktreePath, editedFilePaths, setStagedFilesAction, workstreamId, handleWorktreeToggleAllStaged]);

  // Handle bulk selection change (for folder checkboxes)
  const handleBulkSelectionChange = useCallback(async (filePaths: string[], selected: boolean) => {
    if (worktreeId && worktreePath) {
      // For worktrees, stage/unstage each file individually
      for (const filePath of filePaths) {
        const relativePath = toRelativePath(filePath);
        const file = worktreeChangedFiles.find(f => f.path === relativePath);
        if (file && file.staged !== selected) {
          await window.electronAPI.invoke('worktree:stage-file', worktreePath, relativePath, selected);
        }
      }
      // Worktree state will be updated by the git:status-changed event from central listener
    } else {
      // For regular sessions, use workstream state
      const currentSet = new Set(stagedFilesArr);
      if (selected) {
        filePaths.forEach(fp => currentSet.add(fp));
      } else {
        filePaths.forEach(fp => currentSet.delete(fp));
      }
      setStagedFilesAction({ workstreamId, files: Array.from(currentSet) });
    }
  }, [worktreeId, worktreePath, worktreeChangedFiles, stagedFilesArr, setStagedFilesAction, workstreamId, toRelativePath]);

  // NOTE: Git status pruning of committed files is now handled by central listener in fileStateListeners.ts

  // NOTE: File edits are now loaded and updated by central listener in fileStateListeners.ts

  // NOTE: Git status is now loaded and updated by central listener in fileStateListeners.ts

  // NOTE: Uncommitted files are now loaded and updated by central listener in fileStateListeners.ts

  // NOTE: Worktree changed files are now loaded and updated by central listener in fileStateListeners.ts

  // NOTE: Session file updates are now handled by central listener in fileStateListeners.ts

  // NOTE: Pending review files are now loaded and updated by central listener in fileStateListeners.ts

  // NOTE: Pending review file updates are now handled by central listener in fileStateListeners.ts

  // Handle "Keep All" button click - clear pending for all sessions in workstream
  const handleKeepAll = useCallback(async () => {
    if (!workspacePath || isClearing || workstreamSessions.length === 0) return;

    setIsClearing(true);
    try {
      if (typeof window !== 'undefined' && (window as any).electronAPI) {
        // Clear pending for all sessions in the workstream
        await Promise.all(
          workstreamSessions.map(async (sessionId) => {
            await (window as any).electronAPI.history.clearPendingForSession(workspacePath, sessionId);
          })
        );
        // Pending files state will be updated via the event listener
      }
    } catch (error) {
      console.error('[FilesEditedSidebar] Failed to clear pending for workstream:', error);
    } finally {
      setIsClearing(false);
    }
  }, [workspacePath, workstreamSessions, isClearing]);

  // Context menu handlers
  const handleOpenInFiles = useCallback((filePath: string) => {
    // Navigate to the file in Files mode (main editor)
    if (onOpenInFilesMode) {
      onOpenInFilesMode(filePath);
    } else {
      // Fallback to opening in agent mode if no Files mode handler provided
      onFileClick(filePath);
    }
  }, [onOpenInFilesMode, onFileClick]);

  const handleViewDiff = useCallback(async (filePath: string) => {
    // Open diff view for the file
    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        await window.electronAPI.invoke('file:open-diff', filePath, workspacePath);
      } catch (error) {
        console.error('[FilesEditedSidebar] Failed to open diff:', error);
      }
    }
  }, [workspacePath]);

  const handleCopyPath = useCallback((filePath: string) => {
    copyFilePath(filePath);
  }, [copyFilePath]);

  const handleRevealInFinder = useCallback((filePath: string) => {
    revealInFinder(filePath);
  }, [revealInFinder]);

  const handleOpenInExternalEditor = useCallback((filePath: string) => {
    openInExternalEditor(filePath);
  }, [openInExternalEditor]);

  const handleShowSessionFiles = useCallback(() => {
    // Switch to session-files mode
    setFileScopeMode('session-files');
  }, [setFileScopeMode]);

  const handleShowAllUncommitted = useCallback(() => {
    // Switch to all-changes mode
    setFileScopeMode('all-changes');
  }, [setFileScopeMode]);

  return (
    <div className="files-edited-sidebar shrink-0 flex flex-col h-full bg-[var(--nim-bg-secondary)]" style={{ width }}>
      {/* Header with scope dropdown and controls */}
      <div className="files-edited-sidebar__header flex items-center gap-2 px-3 py-2 border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shrink-0">
        <FilesScopeDropdown
          fileScopeMode={fileScopeMode}
          onFileScopeModeChange={setFileScopeMode}
          hasMultipleSessions={hasMultipleSessions}
          activeSessionId={activeSessionId}
          filterToCurrentSession={filterToCurrentSession}
          onFilterToCurrentSessionChange={setFilterToCurrentSession}
          groupByDirectory={groupByDirectory}
          onGroupByDirectoryChange={setGroupByDirectory}
          isWorktree={!!worktreeId}
          workstreamSessionCount={workstreamSessions.length}
          worktreeName={worktreePath ? getWorktreeNameFromPath(worktreePath) : undefined}
        />
        {/* Spacer to push controls to the right */}
        <div className="flex-1" />
        {/* Expand/Collapse controls */}
        <div className="files-edited-sidebar__controls flex gap-1 shrink-0">
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('file-edits-sidebar:expand-all'));
            }}
            disabled={!groupByDirectory}
            className="files-edited-sidebar__control-btn flex items-center justify-center w-6 h-6 border-none rounded bg-transparent text-[var(--nim-text-muted)] cursor-pointer hover:enabled:bg-[var(--nim-bg-tertiary)] disabled:text-[var(--nim-text-disabled)] disabled:cursor-default disabled:opacity-50"
            title="Expand all"
          >
            <MaterialSymbol icon="unfold_more" size={16} />
          </button>
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('file-edits-sidebar:collapse-all'));
            }}
            disabled={!groupByDirectory}
            className="files-edited-sidebar__control-btn flex items-center justify-center w-6 h-6 border-none rounded bg-transparent text-[var(--nim-text-muted)] cursor-pointer hover:enabled:bg-[var(--nim-bg-tertiary)] disabled:text-[var(--nim-text-disabled)] disabled:cursor-default disabled:opacity-50"
            title="Collapse all"
          >
            <MaterialSymbol icon="unfold_less" size={16} />
          </button>
        </div>
      </div>

      {/* Keep All button - show when there are pending files (only in non-git repos) */}
      {!isGitRepo && pendingReviewFiles.size > 0 && (
        <div className="files-edited-sidebar__keep-all-banner flex items-center justify-between px-3 py-2 bg-[color-mix(in_srgb,var(--nim-warning)_10%,var(--nim-bg))] border-b border-[color-mix(in_srgb,var(--nim-warning)_30%,transparent)] shrink-0">
          <div className="files-edited-sidebar__keep-all-info flex items-center gap-2">
            <MaterialSymbol icon="rate_review" size={16} className="files-edited-sidebar__keep-all-icon text-[var(--nim-warning)]" />
            <span className="files-edited-sidebar__keep-all-text text-xs text-[var(--nim-warning)] font-medium">
              <span className="files-edited-sidebar__keep-all-count font-semibold">{pendingReviewFiles.size}</span>
              {' '}file{pendingReviewFiles.size !== 1 ? 's' : ''} pending review
            </span>
          </div>
          <button
            className="files-edited-sidebar__keep-all-btn flex items-center gap-1 px-2.5 py-1 bg-transparent border border-[var(--nim-warning)] rounded text-[var(--nim-warning)] text-[11px] font-medium cursor-pointer transition-all duration-200 font-inherit hover:enabled:bg-[color-mix(in_srgb,var(--nim-warning)_15%,transparent)] disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleKeepAll}
            disabled={isClearing}
            title="Accept all pending AI changes"
          >
            <MaterialSymbol icon="check_circle" size={14} />
            {isClearing ? 'Keeping...' : 'Keep All'}
          </button>
        </div>
      )}

      {/* Files Content */}
      <div className="files-edited-sidebar__content flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-auto">
          <FileEditsSidebarComponent
            fileEdits={fileEdits}
            onFileClick={onFileClick}
            workspacePath={worktreePath || workspacePath}
            pendingReviewFiles={pendingReviewFiles}
            groupByDirectory={groupByDirectory}
            onGroupByDirectoryChange={setGroupByDirectory}
            hideControls
            onOpenInFiles={handleOpenInFiles}
            onCopyPath={handleCopyPath}
            onRevealInFinder={handleRevealInFinder}
            onOpenInExternalEditor={hasExternalEditor ? handleOpenInExternalEditor : undefined}
            externalEditorName={externalEditorName}
            showCheckboxes={true}
            selectedFiles={worktreeId ? worktreeStagedFiles : stagedFiles}
            onSelectionChange={handleSelectionChange}
            isFileSelectable={isWorkspaceCommittableFile}
            onSelectAll={handleSelectAll}
            onBulkSelectionChange={handleBulkSelectionChange}
            totalSessionFilesCount={totalSessionFilesCount}
            onShowSessionFiles={handleShowSessionFiles}
            totalUncommittedCount={worktreeId ? worktreeChangedFiles.length : allUncommittedFiles.length}
            onShowAllUncommitted={handleShowAllUncommitted}
            scopeMode={fileScopeMode}
            onGetDiff={isGitRepo ? handleGetDiff : undefined}
            diffPeekWidth={diffPeekSize?.width}
            diffPeekHeight={diffPeekSize?.height}
            onDiffPeekResize={setDiffPeekSize}
          />
        </div>
      </div>

      {/* Git Operations Panel */}
      <GitOperationsPanel
        workspacePath={workspacePath}
        workstreamId={workstreamId}
        sessionId={activeSessionId || workstreamId}
        editedFiles={editedFilePaths}
        worktreeId={worktreeId}
        worktreePath={worktreePath}
        onWorktreeArchived={onWorktreeArchived}
        onFileClick={onFileClick}
      />

      {/* Todo Panel - shows agent's current tasks */}
      {activeSessionId && (
        <TodoPanel sessionId={activeSessionId} />
      )}

      {/* Task List Panel - shows the SDK-native task queue (TaskCreate/TaskUpdate) */}
      {activeSessionId && (
        <TaskListPanel sessionId={activeSessionId} />
      )}

      {/* Teammate Panel - shows agent's current teammates */}
      {activeSessionId && (
        <TeammatePanel sessionId={activeSessionId} />
      )}

      {/* Tracker Panel - shows tracker items linked by the agent */}
      <TrackerPanel workstreamId={workstreamId} />
    </div>
  );
});

FilesEditedSidebar.displayName = 'FilesEditedSidebar';
