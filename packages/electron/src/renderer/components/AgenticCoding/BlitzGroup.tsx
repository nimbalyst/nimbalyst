import React, { useState, useEffect, useRef, memo, useMemo, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { groupSessionStatusAtom, sessionProcessingAtom, sessionUnreadAtom, sessionPendingPromptAtom } from '../../store';
import { SessionContextMenu } from './SessionContextMenu';
import { SessionRelativeTime } from './SessionRelativeTime';

import type { SessionMeta as SessionItem } from '../../store';

interface WorktreeWithStatus {
  id: string;
  name: string;
  displayName?: string;
  path: string;
  branch: string;
  gitStatus?: {
    ahead?: number;
    behind?: number;
    uncommitted?: boolean;
  };
}

interface BlitzWorktreeEntry {
  worktreeId: string;
  sessions: SessionItem[];
  worktreeData?: WorktreeWithStatus;
}

interface BlitzGroupProps {
  blitzId: string;
  title: string;
  isExpanded: boolean;
  isActive: boolean;
  isPinned?: boolean;
  isArchived?: boolean;
  isSelected?: boolean;
  onToggle: () => void;
  onMultiSelect?: (e: React.MouseEvent) => void;
  worktrees: BlitzWorktreeEntry[];
  activeSessionId: string | null;
  onSessionSelect: (sessionId: string, e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
  worktreeCache: Map<string, WorktreeWithStatus>;
  collapsedGroups: string[];
  onToggleWorktreeGroup: (groupKey: string) => void;
  onBlitzRename?: (blitzId: string, newName: string) => void;
  onBlitzPinToggle?: (blitzId: string, isPinned: boolean) => void;
  onBlitzArchive?: (blitzId: string) => void;
  onArchiveOtherWorktrees?: (blitzId: string, keepWorktreeId: string) => void;
  onWorktreeRename?: (worktreeId: string, newName: string) => void;
  onWorktreeArchive?: (worktreeId: string) => void;
  onWorktreeCleanGitignored?: (worktreeId: string) => void;
  onSessionRename?: (sessionId: string, newName: string) => void;
}

/**
 * Aggregate status indicator for the blitz group header.
 * Matches WorkstreamGroupStatusIndicator pattern.
 */
const BlitzGroupStatus: React.FC<{ sessionIds: string[] }> = memo(({ sessionIds }) => {
  const sessionIdsKey = useMemo(() => JSON.stringify([...sessionIds].sort()), [sessionIds]);
  const { hasProcessing, hasPendingPrompt, hasUnread } = useAtomValue(groupSessionStatusAtom(sessionIdsKey));

  if (hasProcessing) {
    return (
      <div className="flex items-center justify-center text-[var(--nim-primary)]" title="Processing">
        <MaterialSymbol icon="progress_activity" size={12} className="animate-spin" />
      </div>
    );
  }
  if (hasPendingPrompt) {
    return (
      <div className="flex items-center justify-center text-[var(--nim-warning)] animate-pulse" title="Waiting for your response">
        <MaterialSymbol icon="help" size={12} />
      </div>
    );
  }
  if (hasUnread) {
    return (
      <div className="flex items-center justify-center text-[var(--nim-primary)]" title="Unread response">
        <MaterialSymbol icon="circle" size={6} fill />
      </div>
    );
  }
  return null;
});

/**
 * Individual session status indicator within the blitz group.
 * Matches WorkstreamSessionStatusIndicator pattern.
 */
const BlitzSessionStatus: React.FC<{ sessionId: string }> = memo(({ sessionId }) => {
  const isProcessing = useAtomValue(sessionProcessingAtom(sessionId));
  const hasPendingPrompt = useAtomValue(sessionPendingPromptAtom(sessionId));
  const hasUnread = useAtomValue(sessionUnreadAtom(sessionId));

  if (isProcessing) {
    return (
      <div className="flex items-center justify-center text-[var(--nim-primary)] animate-spin" title="Processing...">
        <MaterialSymbol icon="progress_activity" size={12} />
      </div>
    );
  }
  if (hasPendingPrompt) {
    return (
      <div className="flex items-center justify-center text-[var(--nim-warning)]" title="Waiting for your response">
        <MaterialSymbol icon="help" size={12} />
      </div>
    );
  }
  if (hasUnread) {
    return (
      <div className="flex items-center justify-center text-[var(--nim-primary)]" title="Unread response">
        <MaterialSymbol icon="circle" size={6} fill />
      </div>
    );
  }
  return null;
});

/**
 * Reusable session row within a blitz group (used both flat and nested).
 */
const BlitzSessionRow: React.FC<{
  session: SessionItem;
  sessionTitle: string;
  hasSessionTitle: boolean;
  isActive: boolean;
  isRenaming: boolean;
  isAnalysis?: boolean;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameKeyDown: (e: React.KeyboardEvent) => void;
  onRenameBlur: () => void;
  onSelect: (e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}> = memo(({ session, sessionTitle, isActive, isRenaming, isAnalysis, renameInputRef, renameValue, onRenameChange, onRenameKeyDown, onRenameBlur, onSelect, onContextMenu }) => (
  <div
    className={`blitz-session-item flex items-center gap-2 py-1.5 px-3 mr-2 mb-0.5 cursor-pointer rounded transition-colors duration-150 select-none ${
      isActive ? 'bg-[var(--nim-bg-selected)]' : 'hover:bg-[var(--nim-bg-hover)]'
    } focus:outline-2 focus:outline-[var(--nim-border-focus)] focus:outline-offset-[-2px]`}
    onClick={onSelect}
    onContextMenu={onContextMenu}
    role="button"
    tabIndex={0}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(e); } }}
    aria-label={`Session: ${sessionTitle}`}
    aria-current={isActive ? 'page' : undefined}
  >
    <div className={`shrink-0 flex items-center justify-center ${
      isActive ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'
    }`}>
      {isAnalysis ? (
        <MaterialSymbol icon="compare_arrows" size={14} />
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="3" y="2" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
          <rect x="10" y="2" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
          <rect x="3" y="11" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
          <path d="M4.5 5v3.5a1.5 1.5 0 0 0 1.5 1.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <path d="M11.5 5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      )}
    </div>
    {isRenaming ? (
      <input
        ref={renameInputRef}
        type="text"
        className="flex-1 min-w-0 py-0.5 px-1.5 text-xs font-medium border border-[var(--nim-primary)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] outline-none box-border"
        value={renameValue}
        onChange={(e) => onRenameChange(e.target.value)}
        onKeyDown={onRenameKeyDown}
        onBlur={onRenameBlur}
        onClick={(e) => e.stopPropagation()}
      />
    ) : (
      <>
        <span className={`flex-1 text-xs text-[var(--nim-text)] whitespace-nowrap overflow-hidden text-ellipsis ${
          isActive ? 'font-medium' : ''
        }`}>{sessionTitle}</span>
        <span className="shrink-0 text-[0.6875rem] text-[var(--nim-text-faint)] ml-2">
          <SessionRelativeTime sessionId={session.id} fallbackTimestamp={session.updatedAt || session.createdAt} />
        </span>
      </>
    )}
    <div className="shrink-0 flex items-center">
      <BlitzSessionStatus sessionId={session.id} />
    </div>
  </div>
));

/**
 * BlitzGroup renders a collapsible group of worktrees created as part of a blitz.
 * Uses the same layout structure as WorkstreamGroup for visual consistency.
 */
export const BlitzGroup: React.FC<BlitzGroupProps> = memo(({
  blitzId,
  title,
  isExpanded,
  isActive,
  isPinned,
  isArchived,
  isSelected,
  onToggle,
  onMultiSelect,
  worktrees,
  activeSessionId,
  onSessionSelect,
  worktreeCache,
  collapsedGroups,
  onToggleWorktreeGroup,
  onBlitzRename,
  onBlitzPinToggle,
  onBlitzArchive,
  onArchiveOtherWorktrees,
  onWorktreeRename,
  onWorktreeArchive,
  onWorktreeCleanGitignored,
  onSessionRename,
}) => {
  const allSessionIds = useMemo(
    () => worktrees.flatMap(w => w.sessions.map(s => s.id)),
    [worktrees]
  );

  const worktreeCount = worktrees.length;

  // Context menu state (blitz header)
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [adjustedContextMenuPosition, setAdjustedContextMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Rename state (blitz header)
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Session/worktree-level context menu state
  const [showSessionContextMenu, setShowSessionContextMenu] = useState(false);
  const [sessionContextMenuPosition, setSessionContextMenuPosition] = useState({ x: 0, y: 0 });
  const [sessionContextMenuWorktreeId, setSessionContextMenuWorktreeId] = useState<string | null>(null);
  const [sessionContextMenuSessionId, setSessionContextMenuSessionId] = useState<string | null>(null);
  const [sessionContextMenuDisplayTitle, setSessionContextMenuDisplayTitle] = useState<string>('');
  // Whether the displayed title comes from session.title (true) or worktree displayName (false)
  const [sessionContextMenuIsSessionTitle, setSessionContextMenuIsSessionTitle] = useState(false);

  // Rename state (inline in session row)
  const [renamingWorktreeId, setRenamingWorktreeId] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameItemValue, setRenameItemValue] = useState('');
  const worktreeRenameInputRef = useRef<HTMLInputElement>(null);
  const contextMenuSession = useMemo(
    () => worktrees.flatMap((worktree) => worktree.sessions).find((session) => session.id === sessionContextMenuSessionId) ?? null,
    [worktrees, sessionContextMenuSessionId],
  );

  const handleChevronClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle();
  }, [onToggle]);

  const handleHeaderClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && onMultiSelect) {
      onMultiSelect(e);
      return;
    }
    // Select the first session in the blitz
    const firstSession = worktrees[0]?.sessions[0];
    if (firstSession) {
      onSessionSelect(firstSession.id, e);
    }
  }, [worktrees, onSessionSelect, onMultiSelect]);

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

  const handleSessionContextMenu = useCallback((e: React.MouseEvent, worktreeId: string, sessionId: string, displayTitle: string, isSessionTitle: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setSessionContextMenuPosition({ x: e.clientX, y: e.clientY });
    setSessionContextMenuWorktreeId(worktreeId);
    setSessionContextMenuSessionId(sessionId);
    setSessionContextMenuDisplayTitle(displayTitle);
    setSessionContextMenuIsSessionTitle(isSessionTitle);
    setShowSessionContextMenu(true);
  }, []);

  const handleCloseSessionContextMenu = useCallback(() => {
    setShowSessionContextMenu(false);
    setSessionContextMenuWorktreeId(null);
    setSessionContextMenuSessionId(null);
  }, []);

  const handleArchiveOtherWorktrees = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowSessionContextMenu(false);
    if (onArchiveOtherWorktrees && sessionContextMenuWorktreeId) {
      onArchiveOtherWorktrees(blitzId, sessionContextMenuWorktreeId);
    }
    setSessionContextMenuWorktreeId(null);
  }, [blitzId, sessionContextMenuWorktreeId, onArchiveOtherWorktrees]);

  const handleSessionWorktreeRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowSessionContextMenu(false);
    setRenameItemValue(sessionContextMenuDisplayTitle);
    if (sessionContextMenuIsSessionTitle && sessionContextMenuSessionId) {
      // The displayed text comes from the session title - rename the session
      setRenamingSessionId(sessionContextMenuSessionId);
      setRenamingWorktreeId(sessionContextMenuWorktreeId);
    } else if (sessionContextMenuWorktreeId) {
      // The displayed text comes from the worktree displayName - rename the worktree
      setRenamingWorktreeId(sessionContextMenuWorktreeId);
      setRenamingSessionId(null);
    }
  }, [sessionContextMenuWorktreeId, sessionContextMenuSessionId, sessionContextMenuDisplayTitle, sessionContextMenuIsSessionTitle]);

  const handleSessionWorktreeArchive = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowSessionContextMenu(false);
    if (onWorktreeArchive && sessionContextMenuWorktreeId) {
      onWorktreeArchive(sessionContextMenuWorktreeId);
    }
    setSessionContextMenuWorktreeId(null);
  }, [sessionContextMenuWorktreeId, onWorktreeArchive]);

  const handleSessionWorktreeCleanGitignored = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowSessionContextMenu(false);
    if (onWorktreeCleanGitignored && sessionContextMenuWorktreeId) {
      onWorktreeCleanGitignored(sessionContextMenuWorktreeId);
    }
    setSessionContextMenuWorktreeId(null);
  }, [sessionContextMenuWorktreeId, onWorktreeCleanGitignored]);

  const handleRenameSubmitItem = useCallback(() => {
    const trimmedValue = renameItemValue.trim();
    if (!trimmedValue) {
      setRenamingWorktreeId(null);
      setRenamingSessionId(null);
      return;
    }
    if (renamingSessionId && onSessionRename) {
      // Rename the session title, and also sync the worktree display name
      onSessionRename(renamingSessionId, trimmedValue);
      if (renamingWorktreeId && onWorktreeRename) {
        onWorktreeRename(renamingWorktreeId, trimmedValue);
      }
    } else if (renamingWorktreeId && onWorktreeRename) {
      const wtData = worktreeCache.get(renamingWorktreeId);
      const currentName = wtData?.displayName || wtData?.name || '';
      if (trimmedValue !== currentName) {
        onWorktreeRename(renamingWorktreeId, trimmedValue);
      }
    }
    setRenamingWorktreeId(null);
    setRenamingSessionId(null);
  }, [renameItemValue, renamingSessionId, renamingWorktreeId, worktreeCache, onSessionRename, onWorktreeRename]);

  const handleRenameItemKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameSubmitItem();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setRenamingWorktreeId(null);
      setRenamingSessionId(null);
    }
  }, [handleRenameSubmitItem]);

  const handlePinToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (onBlitzPinToggle) {
      onBlitzPinToggle(blitzId, !isPinned);
    }
  }, [blitzId, isPinned, onBlitzPinToggle]);

  const handleArchive = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (onBlitzArchive) {
      onBlitzArchive(blitzId);
    }
  }, [blitzId, onBlitzArchive]);

  const handleRenameClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    setRenameValue(title);
    setIsRenaming(true);
  }, [title]);

  const handleRenameSubmit = useCallback(() => {
    const trimmedValue = renameValue.trim();
    if (trimmedValue && trimmedValue !== title && onBlitzRename) {
      onBlitzRename(blitzId, trimmedValue);
    }
    setIsRenaming(false);
  }, [renameValue, title, blitzId, onBlitzRename]);

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsRenaming(false);
    }
  }, [handleRenameSubmit]);

  // Focus and select input when entering rename mode (blitz header)
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  // Focus and select input when entering rename mode (session or worktree)
  useEffect(() => {
    if ((renamingWorktreeId || renamingSessionId) && worktreeRenameInputRef.current) {
      worktreeRenameInputRef.current.focus();
      worktreeRenameInputRef.current.select();
    }
  }, [renamingWorktreeId, renamingSessionId]);

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

  // Close both context menus when mouse leaves the entire blitz group
  const handleGroupMouseLeave = useCallback(() => {
    handleCloseContextMenu();
    handleCloseSessionContextMenu();
  }, [handleCloseContextMenu, handleCloseSessionContextMenu]);

  return (
    <div
      className={`blitz-group mb-1 ${isArchived ? 'archived' : ''} ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
      data-testid={`blitz-group-${blitzId}`}
      onMouseLeave={handleGroupMouseLeave}
    >
      {/* Header - matches WorkstreamGroup header structure */}
      <div
        className={`blitz-group-header flex items-center gap-0 text-[0.8125rem] text-[var(--nim-text)] transition-colors duration-150 rounded-md mx-2 w-[calc(100%-1rem)] ${
          isSelected ? 'bg-[var(--nim-bg-selected)]' : isActive ? 'bg-[var(--nim-bg-selected)]' : 'hover:bg-[var(--nim-bg-hover)]'
        }`}
        onContextMenu={handleContextMenu}
      >
        {/* Chevron - separate click target for expand/collapse */}
        <button
          className="flex items-center justify-center w-6 h-full min-h-[2.5rem] p-0 bg-transparent border-none cursor-pointer text-[var(--nim-text-faint)] shrink-0 rounded-l-md hover:bg-[var(--nim-bg-secondary)] focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--nim-border-focus)] focus-visible:outline-offset-[-2px]"
          onClick={handleChevronClick}
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} blitz`}
        >
          <MaterialSymbol
            icon="chevron_right"
            size={12}
            className={`shrink-0 text-[var(--nim-text-faint)] transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
          />
        </button>

        {/* Main clickable area - icon and content */}
        <div
          className="flex items-start gap-2 flex-1 min-w-0 py-1 pr-2 pl-1 cursor-pointer focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--nim-border-focus)] focus-visible:outline-offset-[-2px] focus-visible:rounded"
          onClick={handleHeaderClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleHeaderClick(e as unknown as React.MouseEvent);
            }
          }}
          aria-label={`Blitz: ${title}, ${worktreeCount} worktree${worktreeCount !== 1 ? 's' : ''}`}
        >
          {/* Lightning bolt icon */}
          <div className={`shrink-0 w-[1.125rem] h-[1.125rem] mt-[0.0625rem] flex items-center justify-center ${
            isActive ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'
          } [&_svg]:w-full [&_svg]:h-full`}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9 2L4 9h4l-1 5 5-7H8l1-5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  type="text"
                  className="flex-1 min-w-0 px-1 py-0 text-[0.8125rem] font-medium border border-[var(--nim-primary)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] outline-none"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={handleRenameKeyDown}
                  onBlur={handleRenameSubmit}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="font-medium text-[var(--nim-text)] whitespace-nowrap overflow-hidden text-ellipsis" title={title}>
                  {title}
                </span>
              )}
              {isPinned && !isRenaming && (
                <MaterialSymbol icon="push_pin" size={12} className="shrink-0 text-[var(--nim-text-faint)] opacity-70" />
              )}
              {isArchived && !isRenaming && (
                <span className="text-[0.5625rem] px-1.5 py-[0.0625rem] rounded-[0.625rem] font-medium bg-[rgba(156,163,175,0.15)] text-[var(--nim-text-faint)]">archived</span>
              )}
              {!isRenaming && <BlitzGroupStatus sessionIds={allSessionIds} />}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="shrink-0 text-[0.6875rem] text-[var(--nim-text-faint)]">
                {worktreeCount} worktree{worktreeCount !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Expanded content - child worktrees */}
      {isExpanded && (
        <div className="blitz-group-children pt-1 pb-1 pl-10 animate-[blitzSlideDown_0.2s_ease-out]">
          {worktrees.map(({ worktreeId, sessions }) => {
            const isAnalysisEntry = worktreeId.startsWith('analysis-');
            const wtData = !isAnalysisEntry ? worktreeCache.get(worktreeId) : undefined;
            // Use the oldest session's title as the worktree group name (e.g. "Session 1")
            // This keeps the original numbered name when additional sessions are added
            const oldestSession = [...sessions].sort((a, b) => a.createdAt - b.createdAt)[0];
            const worktreeGroupName = oldestSession?.title || wtData?.displayName || wtData?.name || 'Loading...';

            if (sessions.length === 1) {
              // Single session - render flat (no worktree subgroup)
              const session = sessions[0];
              const sessionIsActive = session.id === activeSessionId;
              const hasSessionTitle = !!session.title;
              const sessionTitle = session.title || worktreeGroupName;
              const isRenamingThis = (renamingSessionId === session.id) || (!renamingSessionId && renamingWorktreeId === worktreeId);

              return (
                <BlitzSessionRow
                  key={session.id}
                  session={session}
                  sessionTitle={sessionTitle}
                  hasSessionTitle={hasSessionTitle}
                  isActive={sessionIsActive}
                  isAnalysis={isAnalysisEntry}
                  isRenaming={isRenamingThis}
                  renameInputRef={worktreeRenameInputRef}
                  renameValue={renameItemValue}
                  onRenameChange={setRenameItemValue}
                  onRenameKeyDown={handleRenameItemKeyDown}
                  onRenameBlur={handleRenameSubmitItem}
                  onSelect={(e) => onSessionSelect(session.id, e)}
                  onContextMenu={(e) => handleSessionContextMenu(e, worktreeId, session.id, sessionTitle, hasSessionTitle)}
                />
              );
            }

            // Multiple sessions - render as a collapsible worktree subgroup
            const groupKey = `blitz-wt:${worktreeId}`;
            const isWorktreeExpanded = !collapsedGroups.includes(groupKey);
            const worktreeIsActive = sessions.some(s => s.id === activeSessionId);

            return (
              <div key={worktreeId} className="blitz-worktree-subgroup mb-0.5">
                {/* Worktree subgroup header */}
                <div
                  className={`flex items-center gap-0 text-xs text-[var(--nim-text)] rounded mr-2 ${
                    worktreeIsActive ? 'bg-[var(--nim-bg-selected)]' : 'hover:bg-[var(--nim-bg-hover)]'
                  }`}
                  onContextMenu={(e) => {
                    const firstSession = sessions[0];
                    if (firstSession) {
                      handleSessionContextMenu(e, worktreeId, firstSession.id, worktreeGroupName, false);
                    }
                  }}
                >
                  <button
                    className="flex items-center justify-center w-5 h-full min-h-[1.75rem] p-0 bg-transparent border-none cursor-pointer text-[var(--nim-text-faint)] shrink-0 rounded-l hover:bg-[var(--nim-bg-secondary)] focus:outline-none"
                    onClick={(e) => { e.stopPropagation(); onToggleWorktreeGroup(groupKey); }}
                    aria-expanded={isWorktreeExpanded}
                    aria-label={`${isWorktreeExpanded ? 'Collapse' : 'Expand'} worktree`}
                  >
                    <MaterialSymbol
                      icon="chevron_right"
                      size={10}
                      className={`shrink-0 text-[var(--nim-text-faint)] transition-transform duration-200 ${isWorktreeExpanded ? 'rotate-90' : ''}`}
                    />
                  </button>
                  <div
                    className="flex items-center gap-1.5 flex-1 min-w-0 py-1 pr-2 pl-0.5 cursor-pointer"
                    onClick={(e) => { e.stopPropagation(); onSessionSelect(sessions[0].id, e); }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSessionSelect(sessions[0].id, e); } }}
                  >
                    {/* Worktree icon */}
                    <div className={`shrink-0 flex items-center justify-center ${
                      worktreeIsActive ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'
                    }`}>
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect x="3" y="2" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                        <rect x="10" y="2" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                        <rect x="3" y="11" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                        <path d="M4.5 5v3.5a1.5 1.5 0 0 0 1.5 1.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        <path d="M11.5 5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                    </div>
                    <span className={`flex-1 text-xs whitespace-nowrap overflow-hidden text-ellipsis ${
                      worktreeIsActive ? 'font-medium text-[var(--nim-text)]' : 'text-[var(--nim-text)]'
                    }`} title={worktreeGroupName}>{worktreeGroupName}</span>
                    <span className="shrink-0 text-[0.625rem] text-[var(--nim-text-faint)]">
                      {sessions.length}
                    </span>
                    <BlitzGroupStatus sessionIds={sessions.map(s => s.id)} />
                  </div>
                </div>

                {/* Nested sessions */}
                {isWorktreeExpanded && (
                  <div className="pl-6 pt-0.5">
                    {sessions.map(session => {
                      const sessionIsActive = session.id === activeSessionId;
                      const hasSessionTitle = !!session.title;
                      const sessionTitle = session.title || worktreeGroupName;
                      const isRenamingThis = (renamingSessionId === session.id) || (!renamingSessionId && renamingWorktreeId === worktreeId);

                      return (
                        <BlitzSessionRow
                          key={session.id}
                          session={session}
                          sessionTitle={sessionTitle}
                          hasSessionTitle={hasSessionTitle}
                          isActive={sessionIsActive}
                          isRenaming={isRenamingThis}
                          renameInputRef={worktreeRenameInputRef}
                          renameValue={renameItemValue}
                          onRenameChange={setRenameItemValue}
                          onRenameKeyDown={handleRenameItemKeyDown}
                          onRenameBlur={handleRenameSubmitItem}
                          onSelect={(e) => onSessionSelect(session.id, e)}
                          onContextMenu={(e) => handleSessionContextMenu(e, worktreeId, session.id, sessionTitle, hasSessionTitle)}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Blitz Header Context Menu */}
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
          {onBlitzRename && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleRenameClick}
            >
              <MaterialSymbol icon="edit" size={14} />
              Rename
            </button>
          )}
          {onBlitzPinToggle && (
            <button
              className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handlePinToggle}
            >
              <MaterialSymbol icon="push_pin" size={14} />
              {isPinned ? 'Unpin' : 'Pin'}
            </button>
          )}
          {onBlitzArchive && (
            <>
              <div className="workstream-group-context-menu-divider h-px my-1 bg-[var(--nim-border)]" />
              <button
                className="workstream-group-context-menu-item destructive flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-error)] text-left rounded transition-colors duration-150 hover:bg-[rgba(239,68,68,0.1)]"
                onClick={handleArchive}
              >
                <MaterialSymbol icon="archive" size={14} />
                Archive Blitz
              </button>
            </>
          )}
        </div>
      )}

      {/* Session/Worktree-level Context Menu */}
      {showSessionContextMenu && sessionContextMenuIsSessionTitle && contextMenuSession && (
        <SessionContextMenu
          sessionId={contextMenuSession.id}
          title={sessionContextMenuDisplayTitle}
          position={sessionContextMenuPosition}
          onClose={handleCloseSessionContextMenu}
          isArchived={contextMenuSession.isArchived}
          isPinned={contextMenuSession.isPinned}
          isWorkstream={(contextMenuSession.childCount ?? 0) > 0}
          isWorktreeSession={!!contextMenuSession.worktreeId}
          parentSessionId={contextMenuSession.parentSessionId}
          phase={contextMenuSession.phase}
          onRename={onSessionRename ? () => {
            setShowSessionContextMenu(false);
            setRenameItemValue(sessionContextMenuDisplayTitle);
            setRenamingSessionId(contextMenuSession.id);
            setRenamingWorktreeId(sessionContextMenuWorktreeId);
          } : undefined}
        />
      )}

      {showSessionContextMenu && (!sessionContextMenuIsSessionTitle || !contextMenuSession) && (() => {
        const isAnalysisContextMenu = sessionContextMenuWorktreeId?.startsWith('analysis-');
        return (
          <div
            className="workstream-group-context-menu fixed z-[1000] min-w-[140px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.15)] p-1"
            style={{
              left: sessionContextMenuPosition.x,
              top: sessionContextMenuPosition.y
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {(onWorktreeRename || onSessionRename) && (
              <button
                className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
                onClick={handleSessionWorktreeRename}
              >
                <MaterialSymbol icon="edit" size={14} />
                Rename
              </button>
            )}
            {!isAnalysisContextMenu && onArchiveOtherWorktrees && worktrees.length > 1 && (
              <button
                className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
                onClick={handleArchiveOtherWorktrees}
              >
                <MaterialSymbol icon="archive" size={14} />
                Archive Other Worktrees in Blitz
              </button>
            )}
            {!isAnalysisContextMenu && onWorktreeCleanGitignored && (
              <button
                className="workstream-group-context-menu-item flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
                onClick={handleSessionWorktreeCleanGitignored}
              >
                <MaterialSymbol icon="delete_sweep" size={14} />
                Clear Gitignored Files
              </button>
            )}
            {!isAnalysisContextMenu && onWorktreeArchive && (
              <>
                <div className="workstream-group-context-menu-divider h-px my-1 bg-[var(--nim-border)]" />
                <button
                  className="workstream-group-context-menu-item destructive flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-error)] text-left rounded transition-colors duration-150 hover:bg-[rgba(239,68,68,0.1)]"
                  onClick={handleSessionWorktreeArchive}
                >
                  <MaterialSymbol icon="archive" size={14} />
                  Archive Worktree
                </button>
              </>
            )}
          </div>
        );
      })()}

      <style>{`
        @keyframes blitzSlideDown {
          from {
            opacity: 0;
            transform: translateY(-4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .blitz-group.archived .blitz-group-header {
          opacity: 0.5;
        }
      `}</style>
    </div>
  );
});
