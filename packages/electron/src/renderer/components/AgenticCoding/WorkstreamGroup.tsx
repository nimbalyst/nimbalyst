import React, { useState, useCallback, useEffect, useRef, memo, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol, ProviderIcon, copyToClipboard } from '@nimbalyst/runtime';
import {
  sessionProcessingAtom,
  sessionUnreadAtom,
  sessionPendingPromptAtom,
  sessionHasPendingInteractivePromptAtom,
  groupSessionStatusAtom,
  reparentSessionAtom,
  refreshSessionListAtom,
  sessionShareAtom,
  removeSessionShareAtom,
  shareKeysAtom,
  buildShareUrl,
} from '../../store';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { dialogRef, DIALOG_IDS } from '../../dialogs';
import type { ShareDialogData } from '../../dialogs';
import { SessionContextMenu } from './SessionContextMenu';
import { SessionRelativeTime } from './SessionRelativeTime';

/**
 * Unified component for rendering expandable session groups in the session history.
 * Supports both workstreams (sessions with children) and worktrees (git worktrees with sessions).
 */

/**
 * Status indicator for workstream/worktree group headers.
 * Shows processing/pending/unread status aggregated across all child sessions.
 * Displays when the tree is collapsed so users can see status at a glance.
 */
const WorkstreamGroupStatusIndicator: React.FC<{ sessionIds: string[] }> = memo(({ sessionIds }) => {
  // Create a stable key for the atom family by sorting and serializing session IDs
  const sessionIdsKey = useMemo(() => JSON.stringify([...sessionIds].sort()), [sessionIds]);

  // Subscribe to the aggregated status atom - this properly reacts to state changes
  const { hasPendingInteractivePrompt, hasProcessing, hasPendingPrompt, hasUnread } = useAtomValue(groupSessionStatusAtom(sessionIdsKey));

  // Priority: interactive prompt > processing > pending prompt > unread
  if (hasPendingInteractivePrompt) {
    return (
      <div className="workstream-group-status-indicator waiting-for-input flex items-center justify-center text-[var(--nim-warning)] animate-pulse" title="Waiting for your response">
        <MaterialSymbol icon="contact_support" size={12} />
      </div>
    );
  }

  if (hasProcessing) {
    return (
      <div className="workstream-group-status-indicator processing flex items-center justify-center text-[var(--nim-primary)]" title="Processing">
        <MaterialSymbol icon="progress_activity" size={12} className="animate-spin" />
      </div>
    );
  }

  if (hasPendingPrompt) {
    return (
      <div className="workstream-group-status-indicator pending flex items-center justify-center text-[var(--nim-warning)] animate-pulse" title="Waiting for your response">
        <MaterialSymbol icon="help" size={12} />
      </div>
    );
  }

  if (hasUnread) {
    return (
      <div className="workstream-group-status-indicator unread flex items-center justify-center text-[var(--nim-primary)]" title="Unread response">
        <MaterialSymbol icon="circle" size={6} fill />
      </div>
    );
  }

  return null;
});

import type { SessionMeta as SessionItem } from '../../store';

interface GitStatus {
  ahead?: number;
  behind?: number;
  uncommitted?: boolean;
}

interface WorktreeData {
  id: string;
  name: string;
  displayName?: string;
  path: string;
  branch: string;
  isPinned?: boolean;
  isArchived?: boolean;
}

interface WorkstreamGroupProps {
  type: 'workstream' | 'worktree';
  id: string;
  title: string;
  isExpanded: boolean;
  isActive: boolean;
  isSelected?: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onMultiSelect?: (e: React.MouseEvent) => void;

  // Common props
  sessions: SessionItem[];
  sortBy?: 'updated' | 'created'; // Which field to sort child sessions by
  activeSessionId: string | null;
  onSessionSelect: (sessionId: string, e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
  onChildSessionSelect?: (childSessionId: string, parentId: string, parentType: 'workstream' | 'worktree') => void;
  onSessionDelete?: (sessionId: string) => void;
  onSessionArchive?: (sessionId: string) => void;
  onSessionUnarchive?: (sessionId: string) => void;
  onSessionPinToggle?: (sessionId: string, isPinned: boolean) => void;
  onSessionRename?: (sessionId: string, newName: string) => void;
  onSessionBranch?: (sessionId: string) => void;

  // Session/workstream-specific
  provider?: string;
  isPinned?: boolean;
  isArchived?: boolean;
  childCount?: number;

  // Drag-drop support
  projectPath?: string; // Workspace path for drag-drop validation

  // Workstream-specific
  onWorkstreamArchive?: (sessionId: string) => void;
  onWorkstreamPinToggle?: (sessionId: string, isPinned: boolean) => void;

  // Worktree-specific
  worktree?: WorktreeData;
  gitStatus?: GitStatus;
  onWorktreePinToggle?: (worktreeId: string, isPinned: boolean) => void;
  onWorktreeArchive?: (worktreeId: string) => void;
  onWorktreeRename?: (worktreeId: string, newName: string) => void;
  onFilesMode?: (worktreeId: string) => void;
  onChangesMode?: (worktreeId: string) => void;
  onAddSession?: (worktreeId: string) => void;
  onAddTerminal?: (worktreeId: string) => void;
  onAddSuperLoop?: (worktreeId: string) => void;
  onWorktreeCleanGitignored?: (worktreeId: string) => void;
}

export const WorkstreamGroup: React.FC<WorkstreamGroupProps> = ({
  type,
  id,
  title,
  isExpanded,
  isActive,
  isSelected,
  onToggle,
  onSelect,
  onMultiSelect,
  sessions,
  sortBy = 'updated',
  activeSessionId,
  onSessionSelect,
  onChildSessionSelect,
  onSessionDelete,
  onSessionArchive,
  onSessionUnarchive,
  onSessionPinToggle,
  onSessionRename,
  onSessionBranch,
  provider,
  isPinned,
  isArchived,
  childCount,
  projectPath,
  worktree,
  gitStatus,
  onWorkstreamArchive,
  onWorkstreamPinToggle,
  onWorktreePinToggle,
  onWorktreeArchive,
  onWorktreeRename,
  onFilesMode,
  onChangesMode,
  onAddSession,
  onAddTerminal,
  onAddSuperLoop,
  onWorktreeCleanGitignored,
}) => {
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [adjustedContextMenuPosition, setAdjustedContextMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Drag-drop state and handlers for workstream groups
  const [isValidDropTarget, setIsValidDropTarget] = useState(false);
  const reparentSession = useSetAtom(reparentSessionAtom);
  const refreshSessionList = useSetAtom(refreshSessionListAtom);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (type !== 'workstream' || !projectPath) return;
    const hasSessionData = e.dataTransfer.types.includes('application/x-nimbalyst-session');
    if (!hasSessionData) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsValidDropTarget(true);
  }, [type, projectPath]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (!e.currentTarget.contains(relatedTarget)) {
      setIsValidDropTarget(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsValidDropTarget(false);

    // Only workstream groups accept drops, not worktree groups
    if (type !== 'workstream') return;

    const dataStr = e.dataTransfer.getData('application/x-nimbalyst-session');
    if (!dataStr || !projectPath) return;

    try {
      const { sessionId, parentId, workspacePath, isWorktreeSession: draggedIsWorktree } = JSON.parse(dataStr);

      // Worktree sessions cannot be moved
      if (draggedIsWorktree) return;

      if (workspacePath !== projectPath) return;
      if (sessionId === id) return;
      if (parentId === id) return;

      const success = await reparentSession({
        sessionId,
        oldParentId: parentId,
        newParentId: id,
        workspacePath: projectPath,
      });

      if (success) {
        await refreshSessionList();
        if (window.electronAPI) {
          await window.electronAPI.invoke('analytics:track', {
            event: 'session_reparented',
            properties: {
              had_previous_parent: parentId !== null,
              workspace_path: projectPath,
            },
          });
        }
      }
    } catch (error) {
      console.error('[WorkstreamGroup] Failed to handle drop:', error);
    }
  }, [type, projectPath, id, reparentSession, refreshSessionList]);

  // Worktree rename state
  const [isRenamingWorktree, setIsRenamingWorktree] = useState(false);
  const [worktreeRenameValue, setWorktreeRenameValue] = useState('');
  const worktreeRenameInputRef = useRef<HTMLInputElement>(null);

  // Workstream parent rename state
  const [isRenamingWorkstream, setIsRenamingWorkstream] = useState(false);
  const [workstreamRenameValue, setWorkstreamRenameValue] = useState('');
  const workstreamRenameInputRef = useRef<HTMLInputElement>(null);

  // Sort sessions: pinned first, then by sortBy field (respecting parent sort preference)
  const sortedSessions = React.useMemo(() => {
    return [...sessions].sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      if (sortBy === 'created') {
        return b.createdAt - a.createdAt;
      }
      return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
    });
  }, [sessions, sortBy]);

  // Calculate total uncommitted count across all sessions in the workstream
  const totalUncommittedCount = React.useMemo(() => {
    return sessions.reduce((sum, session) => sum + (session.uncommittedCount || 0), 0);
  }, [sessions]);

  // Workstream session-share state (used only when type === 'workstream')
  const workstreamShareInfo = useAtomValue(sessionShareAtom(id));
  const shareKeys = useAtomValue(shareKeysAtom);

  const removeShare = useSetAtom(removeSessionShareAtom);
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setShowContextMenu(false);
    setAdjustedContextMenuPosition(null);
  }, []);

  const handlePinToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type === 'worktree' && worktree && onWorktreePinToggle) {
      onWorktreePinToggle(worktree.id, !worktree.isPinned);
    } else if (type === 'workstream' && onWorkstreamPinToggle) {
      onWorkstreamPinToggle(id, !isPinned);
    }
  }, [type, id, isPinned, worktree, onWorktreePinToggle, onWorkstreamPinToggle]);

  const handleArchive = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type === 'worktree' && worktree && onWorktreeArchive) {
      onWorktreeArchive(worktree.id);
    } else if (type === 'workstream' && isArchived && onSessionUnarchive) {
      onSessionUnarchive(id);
    } else if (type === 'workstream' && onWorkstreamArchive) {
      onWorkstreamArchive(id);
    }
  }, [type, id, worktree, isArchived, onWorktreeArchive, onWorkstreamArchive, onSessionUnarchive]);

  const handleAddSession = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type === 'worktree' && worktree && onAddSession) {
      onAddSession(worktree.id);
    }
  }, [type, worktree, onAddSession]);

  const handleAddTerminal = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type === 'worktree' && worktree && onAddTerminal) {
      onAddTerminal(worktree.id);
    }
  }, [type, worktree, onAddTerminal]);

  const handleCleanGitignored = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type === 'worktree' && worktree && onWorktreeCleanGitignored) {
      onWorktreeCleanGitignored(worktree.id);
    }
  }, [type, worktree, onWorktreeCleanGitignored]);

  const handleRenameClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type === 'worktree' && worktree) {
      setWorktreeRenameValue(worktree.displayName || worktree.name || '');
      setIsRenamingWorktree(true);
    } else if (type === 'workstream') {
      setWorkstreamRenameValue(title);
      setIsRenamingWorkstream(true);
    }
  }, [type, worktree, title]);

  const handleWorktreeRenameSubmit = useCallback(() => {
    const trimmedValue = worktreeRenameValue.trim();
    const currentName = worktree?.displayName || worktree?.name || '';
    if (trimmedValue && trimmedValue !== currentName && onWorktreeRename && worktree) {
      onWorktreeRename(worktree.id, trimmedValue);
    }
    setIsRenamingWorktree(false);
  }, [worktreeRenameValue, worktree, onWorktreeRename]);

  const handleWorktreeRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleWorktreeRenameSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsRenamingWorktree(false);
    }
  }, [handleWorktreeRenameSubmit]);

  // Focus and select input when entering worktree rename mode
  useEffect(() => {
    if (isRenamingWorktree && worktreeRenameInputRef.current) {
      worktreeRenameInputRef.current.focus();
      worktreeRenameInputRef.current.select();
    }
  }, [isRenamingWorktree]);

  const handleWorkstreamRenameSubmit = useCallback(() => {
    const trimmedValue = workstreamRenameValue.trim();
    if (trimmedValue && trimmedValue !== title && onSessionRename) {
      onSessionRename(id, trimmedValue);
    }
    setIsRenamingWorkstream(false);
  }, [workstreamRenameValue, title, id, onSessionRename]);

  const handleWorkstreamRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleWorkstreamRenameSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsRenamingWorkstream(false);
    }
  }, [handleWorkstreamRenameSubmit]);

  // Focus and select input when entering workstream rename mode
  useEffect(() => {
    if (isRenamingWorkstream && workstreamRenameInputRef.current) {
      workstreamRenameInputRef.current.focus();
      workstreamRenameInputRef.current.select();
    }
  }, [isRenamingWorkstream]);

  const handleAddSuperLoop = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type === 'worktree' && worktree && onAddSuperLoop) {
      onAddSuperLoop(worktree.id);
    }
  }, [type, worktree, onAddSuperLoop]);
  const handleFilesMode = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (type === 'worktree' && worktree && onFilesMode) {
      onFilesMode(worktree.id);
    }
  }, [type, worktree, onFilesMode]);

  const handleChangesMode = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (type === 'worktree' && worktree && onChangesMode) {
      onChangesMode(worktree.id);
    }
  }, [type, worktree, onChangesMode]);

  const handleWorkstreamBranch = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type === 'workstream' && onSessionBranch) {
      onSessionBranch(id);
    }
  }, [type, id, onSessionBranch]);

  const handleWorkstreamDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type === 'workstream' && onSessionDelete) {
      onSessionDelete(id);
    }
  }, [type, id, onSessionDelete]);

  const handleWorkstreamCopySessionId = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type !== 'workstream') return;
    copyToClipboard(id);
  }, [type, id]);

  const handleWorkstreamExportHtml = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type !== 'workstream') return;
    (window as any).electronAPI?.exportSessionToHtml({ sessionId: id });
  }, [type, id]);

  const handleWorkstreamCopyTranscript = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type !== 'workstream') return;
    (window as any).electronAPI?.exportSessionToClipboard({ sessionId: id });
  }, [type, id]);

  const handleWorkstreamShareLink = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type !== 'workstream') return;
    dialogRef.current?.open<ShareDialogData>(DIALOG_IDS.SHARE, {
      contentType: 'session',
      sessionId: id,
      title,
    });
  }, [type, id, title]);

  const handleWorkstreamCopyShareLink = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type !== 'workstream' || !workstreamShareInfo) return;
    const url = buildShareUrl(workstreamShareInfo.shareId, shareKeys.get(id));
    copyToClipboard(url);
    errorNotificationService.showInfo('Share link copied', 'The share link has been copied to your clipboard.', { duration: 3000 });
  }, [type, id, workstreamShareInfo, shareKeys]);

  const handleWorkstreamUnshare = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (type !== 'workstream' || !workstreamShareInfo) return;
    try {
      const result = await (window as any).electronAPI?.deleteShare({ shareId: workstreamShareInfo.shareId, sessionId: id });
      if (result?.success) {
        removeShare(id);
        errorNotificationService.showInfo('Session unshared', 'The share link has been removed.', { duration: 3000 });
      } else if (result?.error) {
        errorNotificationService.showError('Unshare failed', result.error);
      }
    } catch (error) {
      errorNotificationService.showError('Unshare failed', error instanceof Error ? error.message : 'An unexpected error occurred');
    }
  }, [type, id, workstreamShareInfo, removeShare]);

  const handleHeaderClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && onMultiSelect) {
      onMultiSelect(e);
      return;
    }
    onSelect();
  }, [onSelect, onMultiSelect]);

  const handleChevronClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle();
  }, [onToggle]);

  // Adjust context menu position to keep it within viewport
  useEffect(() => {
    if (showContextMenu && contextMenuRef.current) {
      const rect = contextMenuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let newX = contextMenuPosition.x;
      let newY = contextMenuPosition.y;

      if (contextMenuPosition.x + rect.width > viewportWidth) {
        newX = contextMenuPosition.x - rect.width;
      }
      if (contextMenuPosition.y + rect.height > viewportHeight) {
        newY = contextMenuPosition.y - rect.height;
      }

      newX = Math.max(0, newX);
      newY = Math.max(0, newY);

      if (newX !== contextMenuPosition.x || newY !== contextMenuPosition.y) {
        setAdjustedContextMenuPosition({ x: newX, y: newY });
      }
    }
  }, [showContextMenu, contextMenuPosition]);

  // Determine display values based on type
  const displayTitle = type === 'worktree'
    ? (worktree?.displayName || worktree?.name || title)
    : title;

  const displayIsPinned = type === 'worktree' ? worktree?.isPinned : isPinned;
  const displayIsArchived = type === 'worktree' ? worktree?.isArchived : isArchived;
  const sessionCount = sessions.length || childCount || 0;

  return (
    <div
      className={`workstream-group mb-1 ${displayIsArchived ? 'archived' : ''} ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
      data-testid={type === 'worktree' ? 'worktree-group' : 'workstream-group'}
      onMouseLeave={handleCloseContextMenu}
    >
      {/* Header */}
      <div
        className={`workstream-group-header flex items-center gap-0 text-[0.8125rem] text-[var(--nim-text)] transition-colors duration-150 rounded-md mx-2 w-[calc(100%-1rem)] ${
          isSelected ? 'bg-[var(--nim-bg-selected)]' : isActive ? 'bg-[var(--nim-bg-selected)]' : 'hover:bg-[var(--nim-bg-hover)]'
        } ${isValidDropTarget ? 'bg-[rgba(83,89,93,0.4)] border-2 border-dashed border-[var(--nim-primary)]' : ''}`}
        onContextMenu={handleContextMenu}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Chevron - separate click target for expand/collapse */}
        <button
          className="workstream-group-chevron-button flex items-center justify-center w-6 h-full min-h-[2.5rem] p-0 bg-transparent border-none cursor-pointer text-[var(--nim-text-faint)] shrink-0 rounded-l-md hover:bg-[var(--nim-bg-secondary)] focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--nim-border-focus)] focus-visible:outline-offset-[-2px]"
          onClick={handleChevronClick}
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${type}`}
        >
          <MaterialSymbol
            icon="chevron_right"
            size={12}
            className={`workstream-group-chevron shrink-0 text-[var(--nim-text-faint)] transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
          />
        </button>

        {/* Main clickable area - icon and content */}
        <div
          className="workstream-group-main flex items-start gap-2 flex-1 min-w-0 py-1 pr-2 pl-1 cursor-pointer focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--nim-border-focus)] focus-visible:outline-offset-[-2px] focus-visible:rounded"
          onClick={handleHeaderClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect();
            }
          }}
          aria-label={`${type === 'worktree' ? 'Worktree' : 'Workstream'}: ${displayTitle}, ${sessionCount} session${sessionCount !== 1 ? 's' : ''}`}
        >
          {/* Icon */}
          <div className={`workstream-group-icon shrink-0 w-[1.125rem] h-[1.125rem] mt-[0.0625rem] flex items-center justify-center ${
            isActive ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'
          } [&_svg]:w-full [&_svg]:h-full`}>
            {type === 'worktree' ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="3" y="2" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                <rect x="10" y="2" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                <rect x="3" y="11" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                <path d="M4.5 5v3.5a1.5 1.5 0 0 0 1.5 1.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <path d="M11.5 5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="8" cy="4" r="1.5" fill="currentColor"/>
                <circle cx="4" cy="12" r="1.5" fill="currentColor"/>
                <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
                <line x1="7.5" y1="5.2" x2="4.5" y2="10.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                <line x1="8.5" y1="5.2" x2="11.5" y2="10.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
              </svg>
            )}
          </div>

          {/* Content */}
          <div className="workstream-group-content flex-1 min-w-0 flex flex-col gap-0.5">
            <div className="workstream-group-row-primary flex items-center gap-1">
              {isRenamingWorktree && type === 'worktree' ? (
                <input
                  ref={worktreeRenameInputRef}
                  type="text"
                  className="workstream-group-rename-input flex-1 min-w-0 px-1 py-0 text-[0.8125rem] font-medium border border-[var(--nim-primary)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] outline-none"
                  value={worktreeRenameValue}
                  onChange={(e) => setWorktreeRenameValue(e.target.value)}
                  onKeyDown={handleWorktreeRenameKeyDown}
                  onBlur={handleWorktreeRenameSubmit}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : isRenamingWorkstream && type === 'workstream' ? (
                <input
                  ref={workstreamRenameInputRef}
                  type="text"
                  className="workstream-group-rename-input flex-1 min-w-0 px-1 py-0 text-[0.8125rem] font-medium border border-[var(--nim-primary)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] outline-none"
                  value={workstreamRenameValue}
                  onChange={(e) => setWorkstreamRenameValue(e.target.value)}
                  onKeyDown={handleWorkstreamRenameKeyDown}
                  onBlur={handleWorkstreamRenameSubmit}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="workstream-group-name font-medium text-[var(--nim-text)] whitespace-nowrap overflow-hidden text-ellipsis">{displayTitle}</span>
              )}
              {displayIsPinned && !isRenamingWorktree && (
                <MaterialSymbol icon="push_pin" size={12} className="workstream-group-pin-icon shrink-0 text-[var(--nim-text-faint)] opacity-70" />
              )}
              {displayIsArchived && !isRenamingWorktree && (
                <span className="workstream-group-badge archived text-[0.5625rem] px-1.5 py-[0.0625rem] rounded-[0.625rem] font-medium bg-[rgba(156,163,175,0.15)] text-[var(--nim-text-faint)]">archived</span>
              )}
              {/* Status indicator for child sessions (processing/pending/unread) */}
              {!isRenamingWorktree && (
                <WorkstreamGroupStatusIndicator sessionIds={sessions.map(s => s.id)} />
              )}
            </div>
            <div className="workstream-group-row-secondary flex items-center gap-1.5 flex-wrap">
              {/* Git status badges for worktrees */}
              {type === 'worktree' && gitStatus && (
                <>
                  {gitStatus.ahead && gitStatus.ahead > 0 && (
                    <span className="workstream-group-badge ahead text-[0.5625rem] px-1.5 py-[0.0625rem] rounded-[0.625rem] font-medium bg-[rgba(74,158,255,0.15)] text-[var(--nim-primary)]">
                      {gitStatus.ahead} ahead
                    </span>
                  )}
                  {gitStatus.behind && gitStatus.behind > 0 && (
                    <span className="workstream-group-badge behind text-[0.5625rem] px-1.5 py-[0.0625rem] rounded-[0.625rem] font-medium bg-[rgba(245,158,11,0.15)] text-[var(--nim-warning)]">
                      {gitStatus.behind} behind
                    </span>
                  )}
                  {gitStatus.uncommitted && (
                    <span className="workstream-group-badge uncommitted text-[0.5625rem] px-1.5 py-[0.0625rem] rounded-[0.625rem] font-medium bg-[rgba(245,158,11,0.15)] text-[var(--nim-warning)]">
                      uncommitted
                    </span>
                  )}
                </>
              )}
              {/* Show total uncommitted count for workstreams */}
              {type === 'workstream' && totalUncommittedCount > 0 && (
                <span
                  className="workstream-group-badge uncommitted text-[0.5625rem] px-1.5 py-[0.0625rem] rounded-[0.625rem] font-medium bg-[rgba(245,158,11,0.15)] text-[var(--nim-warning)]"
                  title={`${totalUncommittedCount} uncommitted change${totalUncommittedCount !== 1 ? 's' : ''} across all sessions`}
                >
                  {totalUncommittedCount} uncommitted
                </span>
              )}
              <span className="workstream-group-count shrink-0 text-[0.6875rem] text-[var(--nim-text-faint)]">
                {sessionCount} session{sessionCount !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
        </div>

        {/* Action buttons for worktrees */}
        {type === 'worktree' && (onFilesMode || onChangesMode) && (
          <div className="workstream-group-actions flex items-center gap-0.5 pr-2 shrink-0">
            {onFilesMode && (
              <button
                className="workstream-group-action-button flex items-center justify-center w-6 h-6 p-0 bg-transparent border-none rounded cursor-pointer text-[var(--nim-text-faint)] transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--nim-border-focus)] focus-visible:outline-offset-[-2px]"
                onClick={handleFilesMode}
                title="Browse Files"
                aria-label="Browse files in worktree"
              >
                <MaterialSymbol icon="description" size={14} />
              </button>
            )}
            {onChangesMode && (
              <button
                className="workstream-group-action-button flex items-center justify-center w-6 h-6 p-0 bg-transparent border-none rounded cursor-pointer text-[var(--nim-text-faint)] transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--nim-border-focus)] focus-visible:outline-offset-[-2px]"
                onClick={handleChangesMode}
                title="View Changes"
                aria-label="View changes in worktree"
              >
                <MaterialSymbol icon="difference" size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Sessions List */}
      {isExpanded && (
        <div className="workstream-group-sessions pt-1 pb-1 pl-10 animate-[workstreamSlideDown_0.2s_ease-out]">
          {sortedSessions.map(session => (
            <WorkstreamSessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onClick={(e) => {
                // Always go through onSessionSelect so shift/cmd-click selection works.
                // onSessionSelect (handleSessionClick) handles the regular click path
                // by calling its own onSessionSelect which navigates to the session.
                onSessionSelect(session.id, e);
              }}
              onDelete={onSessionDelete ? () => onSessionDelete(session.id) : undefined}
              onArchive={onSessionArchive ? () => onSessionArchive(session.id) : undefined}
              onUnarchive={onSessionUnarchive ? () => onSessionUnarchive(session.id) : undefined}
              onPinToggle={onSessionPinToggle ? (pinned) => onSessionPinToggle(session.id, pinned) : undefined}
              onRename={onSessionRename ? (newName) => onSessionRename(session.id, newName) : undefined}
              onBranch={onSessionBranch ? () => onSessionBranch(session.id) : undefined}
              onRemoveFromWorkstream={type === 'workstream' && projectPath ? async () => {
                const success = await reparentSession({
                  sessionId: session.id,
                  oldParentId: id,
                  newParentId: null,
                  workspacePath: projectPath,
                });
                if (success) {
                  await refreshSessionList();
                }
              } : undefined}
            />
          ))}
        </div>
      )}

      {/* Context Menu */}
      {showContextMenu && (
        <div
          ref={contextMenuRef}
          className="workstream-group-context-menu fixed z-[1000] min-w-[140px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.15)] p-1"
          style={{
            left: (adjustedContextMenuPosition || contextMenuPosition).x,
            top: (adjustedContextMenuPosition || contextMenuPosition).y
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Worktree menu items */}
          {type === 'worktree' && onWorktreeRename && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleRenameClick}
            >
              <MaterialSymbol icon="edit" size={14} />
              Rename
            </button>
          )}
          {type === 'worktree' && onWorktreePinToggle && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handlePinToggle}
            >
              <MaterialSymbol icon="push_pin" size={14} />
              {worktree?.isPinned ? 'Unpin' : 'Pin'}
            </button>
          )}
          {type === 'worktree' && onAddSession && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleAddSession}
            >
              <MaterialSymbol icon="add" size={14} />
              Add Session
            </button>
          )}
          {type === 'worktree' && onAddTerminal && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleAddTerminal}
            >
              <MaterialSymbol icon="terminal" size={14} />
              Add Terminal
            </button>
          )}
          {type === 'worktree' && onAddSuperLoop && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleAddSuperLoop}
            >
              <MaterialSymbol icon="sync" size={14} />
              New Super Loop
            </button>
          )}
          {type === 'worktree' && onWorktreeCleanGitignored && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleCleanGitignored}
            >
              <MaterialSymbol icon="delete_sweep" size={14} />
              Clear Gitignored Files
            </button>
          )}
          {type === 'worktree' && onWorktreeArchive && (
            <>
              <div className="workstream-group-context-menu-divider h-px my-1 bg-[var(--nim-border)]" />
              <button
                className="workstream-group-context-menu-item destructive flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-error)] text-left rounded transition-colors duration-150 hover:bg-[rgba(239,68,68,0.1)]"
                onClick={handleArchive}
              >
                <MaterialSymbol icon="archive" size={14} />
                Archive Worktree
              </button>
            </>
          )}

          {/* Workstream menu items */}
          {type === 'workstream' && onSessionRename && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleRenameClick}
            >
              <MaterialSymbol icon="edit" size={14} />
              Rename
            </button>
          )}
          {type === 'workstream' && onWorkstreamPinToggle && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handlePinToggle}
            >
              <MaterialSymbol icon="push_pin" size={14} />
              {isPinned ? 'Unpin' : 'Pin'}
            </button>
          )}
          {type === 'workstream' && onSessionBranch && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleWorkstreamBranch}
            >
              <MaterialSymbol icon="fork_right" size={14} />
              Branch conversation
            </button>
          )}
          {type === 'workstream' && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleWorkstreamCopySessionId}
            >
              <MaterialSymbol icon="content_copy" size={14} />
              Copy Session ID
            </button>
          )}
          {type === 'workstream' && workstreamShareInfo ? (
            <>
              <button
                className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
                onClick={handleWorkstreamCopyShareLink}
              >
                <MaterialSymbol icon="content_copy" size={14} />
                Copy share link
              </button>
              <button
                className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
                onClick={handleWorkstreamUnshare}
              >
                <MaterialSymbol icon="link_off" size={14} />
                Unshare
              </button>
            </>
          ) : type === 'workstream' ? (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleWorkstreamShareLink}
            >
              <MaterialSymbol icon="link" size={14} />
              Share link
            </button>
          ) : null}
          {type === 'workstream' && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleWorkstreamExportHtml}
            >
              <MaterialSymbol icon="download" size={14} />
              Export as HTML
            </button>
          )}
          {type === 'workstream' && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleWorkstreamCopyTranscript}
            >
              <MaterialSymbol icon="assignment" size={14} />
              Copy transcript
            </button>
          )}
          {type === 'workstream' && onWorkstreamArchive && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleArchive}
            >
              <MaterialSymbol icon={isArchived ? 'unarchive' : 'archive'} size={14} />
              {isArchived ? 'Unarchive Workstream' : 'Archive Workstream'}
            </button>
          )}
          {type === 'workstream' && onSessionDelete && (
            <button
              className="workstream-group-context-menu-item destructive flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-error)] text-left rounded transition-colors duration-150 hover:bg-[rgba(239,68,68,0.1)]"
              onClick={handleWorkstreamDelete}
            >
              <MaterialSymbol icon="delete" size={14} />
              Delete
            </button>
          )}
        </div>
      )}

      {/* Keyframe animation styles */}
      <style>{`
        @keyframes workstreamSlideDown {
          from {
            opacity: 0;
            transform: translateY(-4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .workstream-group.archived .workstream-group-header {
          opacity: 0.5;
        }
        .workstream-group.archived .workstream-session-item {
          opacity: 0.5;
        }
      `}</style>
    </div>
  );
};

/**
 * Status indicator for workstream child sessions.
 * Subscribes to Jotai atoms for real-time processing/unread/pending state.
 */
const WorkstreamSessionStatusIndicator = memo<{ sessionId: string; uncommittedCount?: number }>(({ sessionId, uncommittedCount }) => {
  const hasPendingInteractivePrompt = useAtomValue(sessionHasPendingInteractivePromptAtom(sessionId));
  const isProcessing = useAtomValue(sessionProcessingAtom(sessionId));
  const hasPendingPrompt = useAtomValue(sessionPendingPromptAtom(sessionId));
  const hasUnread = useAtomValue(sessionUnreadAtom(sessionId));

  // Priority: interactive prompt > processing > pending prompt > unread > uncommitted count
  if (hasPendingInteractivePrompt) {
    return (
      <div className="workstream-session-item-status waiting-for-input flex items-center justify-center text-[var(--nim-warning)] animate-pulse" title="Waiting for your response">
        <MaterialSymbol icon="contact_support" size={12} />
      </div>
    );
  }

  if (isProcessing) {
    return (
      <div className="workstream-session-item-status processing flex items-center justify-center text-[var(--nim-primary)] animate-spin" title="Processing...">
        <MaterialSymbol icon="progress_activity" size={12} />
      </div>
    );
  }

  if (hasPendingPrompt) {
    return (
      <div className="workstream-session-item-status pending-prompt flex items-center justify-center text-[var(--nim-warning)]" title="Waiting for your response">
        <MaterialSymbol icon="help" size={12} />
      </div>
    );
  }

  if (hasUnread) {
    return (
      <div className="workstream-session-item-status unread flex items-center justify-center text-[var(--nim-primary)]" title="Unread response">
        <MaterialSymbol icon="circle" size={6} fill />
      </div>
    );
  }

  if (uncommittedCount && uncommittedCount > 0) {
    return (
      <span
        className="workstream-session-item-badge uncommitted text-[0.625rem] py-[0.0625rem] px-1 rounded-lg font-medium text-[var(--nim-warning)] bg-[color-mix(in_srgb,var(--nim-warning)_15%,transparent)]"
        title={`${uncommittedCount} uncommitted change${uncommittedCount !== 1 ? 's' : ''}`}
      >
        {uncommittedCount}
      </span>
    );
  }

  return null;
});

// Child session item within a workstream group
interface WorkstreamSessionItemProps {
  session: SessionItem;
  isActive: boolean;
  onClick: (e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onPinToggle?: (isPinned: boolean) => void;
  onRename?: (newName: string) => void;
  onBranch?: () => void;
  onRemoveFromWorkstream?: () => void;
}

const WorkstreamSessionItem: React.FC<WorkstreamSessionItemProps> = ({
  session,
  isActive,
  onClick,
  onDelete,
  onArchive,
  onUnarchive,
  onPinToggle,
  onRename,
  onBranch,
  onRemoveFromWorkstream,
}) => {
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const shareInfo = useAtomValue(sessionShareAtom(session.id));

  const displayTitle = session.title || 'Untitled Session';

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  }, []);

  const handleDelete = () => {
    setShowContextMenu(false);
    onDelete?.();
  };

  const handleArchive = () => {
    setShowContextMenu(false);
    onArchive?.();
  };

  const handleUnarchive = () => {
    setShowContextMenu(false);
    onUnarchive?.();
  };

  const handlePinToggle = (isPinned: boolean) => {
    setShowContextMenu(false);
    onPinToggle?.(isPinned);
  };

  const handleBranch = () => {
    setShowContextMenu(false);
    onBranch?.();
  };

  const handleRemoveFromWorkstream = () => {
    setShowContextMenu(false);
    onRemoveFromWorkstream?.();
  };

  const handleRenameSubmit = () => {
    const trimmedValue = renameValue.trim();
    if (trimmedValue && trimmedValue !== displayTitle && onRename) {
      onRename(trimmedValue);
    }
    setIsRenaming(false);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsRenaming(false);
    }
  };


  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  return (
    <div
      data-testid="workstream-child-item"
      className={`workstream-session-item flex items-center gap-2 py-1.5 px-3 mr-2 mb-0.5 cursor-pointer rounded transition-colors duration-150 select-none ${
        isActive ? 'active bg-[var(--nim-bg-selected)]' : 'hover:bg-[var(--nim-bg-hover)]'
      } ${session.isArchived ? 'opacity-60 hover:opacity-80' : ''} focus:outline-2 focus:outline-[var(--nim-border-focus)] focus:outline-offset-[-2px]`}
      onClick={onClick}
      onContextMenu={handleContextMenu}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(e);
        }
      }}
      aria-label={`Session: ${displayTitle}`}
      aria-current={isActive ? 'page' : undefined}
    >
      <div className={`workstream-session-item-icon shrink-0 flex items-center justify-center ${
        isActive ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'
      }`}>
        <ProviderIcon provider={session.provider || 'claude'} size={14} />
      </div>
      {session.isPinned && (
        <MaterialSymbol icon="push_pin" size={10} className={`workstream-session-item-pin-icon shrink-0 -ml-1 opacity-70 ${
          isActive ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-faint)]'
        }`} />
      )}
      {shareInfo && (
        <MaterialSymbol icon="link" size={10} className={`workstream-session-item-share-icon shrink-0 -ml-1 opacity-70 ${
          isActive ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-faint)]'
        }`} title="Shared" />
      )}
      {isRenaming ? (
        <input
          ref={renameInputRef}
          type="text"
          className="workstream-session-item-rename-input flex-1 min-w-0 py-0.5 px-1.5 text-xs font-medium border border-[var(--nim-primary)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] outline-none box-border"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={handleRenameSubmit}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <span className={`workstream-session-item-title flex-1 text-xs text-[var(--nim-text)] whitespace-nowrap overflow-hidden text-ellipsis ${
            isActive ? 'font-medium' : ''
          }`}>{displayTitle}</span>
          <span className="workstream-session-item-timestamp shrink-0 text-[0.6875rem] text-[var(--nim-text-faint)] ml-2">
            <SessionRelativeTime sessionId={session.id} fallbackTimestamp={session.updatedAt || session.createdAt} />
          </span>
        </>
      )}
      <div className="workstream-session-item-right flex items-center gap-1 shrink-0">
        <WorkstreamSessionStatusIndicator sessionId={session.id} uncommittedCount={session.uncommittedCount} />
      </div>

      {/* Context Menu */}
      {showContextMenu && (
        <SessionContextMenu
          sessionId={session.id}
          title={displayTitle}
          position={contextMenuPosition}
          onClose={() => setShowContextMenu(false)}
          isArchived={session.isArchived}
          isPinned={session.isPinned}
          isWorkstream={(session.childCount ?? 0) > 0}
          isWorktreeSession={!!session.worktreeId}
          parentSessionId={session.parentSessionId}
          phase={session.phase}
          onRename={onRename ? () => { setRenameValue(displayTitle); setIsRenaming(true); } : undefined}
          onPinToggle={onPinToggle ? handlePinToggle : undefined}
          onBranch={onBranch ? handleBranch : undefined}
          onRemoveFromWorkstream={onRemoveFromWorkstream ? handleRemoveFromWorkstream : undefined}
          onArchive={onArchive ? handleArchive : undefined}
          onUnarchive={onUnarchive ? handleUnarchive : undefined}
          onDelete={onDelete ? handleDelete : undefined}
        />
      )}
    </div>
  );
};
