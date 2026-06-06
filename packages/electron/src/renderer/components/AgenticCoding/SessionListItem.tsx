import React, { useState, useCallback, useEffect, useRef, useMemo, memo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol, ProviderIcon } from '@nimbalyst/runtime';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import { sessionOrChildProcessingAtom, sessionUnreadAtom, sessionPendingPromptAtom, sessionHasPendingInteractivePromptAtom, reparentSessionAtom, refreshSessionListAtom, sessionShareAtom, sessionWakeupAtom, sessionLastActivityAtom } from '../../store';
import { convertToWorkstreamAtom } from '../../store/atoms/sessions';
import { SessionContextMenu } from './SessionContextMenu';

/**
 * Combined status indicator that subscribes to this session's state atoms.
 * Shows waiting for input, processing, pending prompt, or unread status (in priority order).
 * Only this component re-renders when the session's state changes.
 */
const SessionStatusIndicator = memo<{ sessionId: string; messageCount?: number }>(({ sessionId, messageCount }) => {
  // Use aggregated atom that checks this session AND any children (for workstreams)
  const hasPendingInteractivePrompt = useAtomValue(sessionHasPendingInteractivePromptAtom(sessionId));
  const isProcessing = useAtomValue(sessionOrChildProcessingAtom(sessionId));
  const hasPendingPrompt = useAtomValue(sessionPendingPromptAtom(sessionId));
  const hasUnread = useAtomValue(sessionUnreadAtom(sessionId));
  const wakeup = useAtomValue(sessionWakeupAtom(sessionId));

  // Priority: waiting for input > processing > pending prompt > scheduled wakeup > unread > message count
  // All interactive prompts (AskUserQuestion, ExitPlanMode, ToolPermission, etc.) show same indicator
  if (hasPendingInteractivePrompt) {
    return (
      <div className="session-list-item-status waiting-for-input flex items-center justify-center w-5 h-5 text-[var(--nim-warning)] animate-pulse" title="Waiting for your response">
        <MaterialSymbol icon="contact_support" size={14} />
      </div>
    );
  }

  if (isProcessing) {
    return (
      <div className="session-list-item-status processing flex items-center justify-center w-5 h-5 text-[var(--nim-primary)] opacity-80" title="Processing...">
        <MaterialSymbol icon="progress_activity" size={14} className="animate-spin" />
      </div>
    );
  }

  if (hasPendingPrompt) {
    return (
      <div className="session-list-item-status pending-prompt flex items-center justify-center w-5 h-5 text-[var(--nim-warning)] animate-pulse" title="Waiting for your response">
        <MaterialSymbol icon="help" size={14} />
      </div>
    );
  }

  if (wakeup) {
    const isOverdue = wakeup.status === 'overdue';
    const colorClass = isOverdue ? 'text-[var(--nim-warning)]' : 'text-[var(--nim-primary)]';
    const tooltip = isOverdue
      ? `Overdue wakeup${wakeup.reason ? ` — ${wakeup.reason}` : ''}`
      : `Scheduled wakeup at ${new Date(wakeup.fireAt).toLocaleString()}${wakeup.reason ? ` — ${wakeup.reason}` : ''}`;
    return (
      <div className={`session-list-item-status wakeup flex items-center justify-center w-5 h-5 ${colorClass} opacity-80`} title={tooltip}>
        <MaterialSymbol icon="schedule" size={14} />
      </div>
    );
  }

  if (hasUnread) {
    return (
      <div className="session-list-item-status unread flex items-center justify-center w-5 h-5 text-[var(--nim-primary)]" title="Unread response">
        <MaterialSymbol icon="circle" size={8} fill />
      </div>
    );
  }

  // if (messageCount !== undefined) {
  //   return <span className="session-list-item-message-count">{messageCount}</span>;
  // }

  return null;
});

const PHASE_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  backlog: { label: 'Backlog', color: 'var(--nim-text-faint)', bg: 'rgba(128,128,128,0.12)' },
  planning: { label: 'Planning', color: 'var(--nim-primary)', bg: 'rgba(96,165,250,0.12)' },
  implementing: { label: 'Implementing', color: 'var(--nim-warning)', bg: 'rgba(251,191,36,0.12)' },
  validating: { label: 'Validating', color: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
  complete: { label: 'Complete', color: 'var(--nim-success)', bg: 'rgba(74,222,128,0.12)' },
};

const SessionPhaseBadge = memo<{ phase: string }>(({ phase }) => {
  const style = PHASE_STYLES[phase];
  if (!style) return null;
  return (
    <span
      className="session-list-item-phase text-[0.5625rem] leading-tight px-1 py-px rounded font-medium whitespace-nowrap"
      style={{ color: style.color, backgroundColor: style.bg }}
    >
      {style.label}
    </span>
  );
});

interface SessionListItemProps {
  id: string;
  title: string;
  createdAt: number;
  updatedAt?: number;
  isActive: boolean;
  isLoaded?: boolean; // Whether session is loaded in a tab
  /** @deprecated Uses Jotai atom subscription - do not pass */
  isProcessing?: boolean;
  /** @deprecated Uses Jotai atom subscription - do not pass */
  hasUnread?: boolean;
  /** @deprecated Uses Jotai atom subscription - do not pass */
  hasPendingPrompt?: boolean;
  isArchived?: boolean; // Whether session is archived
  isPinned?: boolean; // Whether session is pinned to the top
  isSelected?: boolean; // Whether session is selected for bulk actions
  selectedCount?: number; // Number of sessions currently selected (for context menu labels)
  sortBy?: 'updated' | 'created'; // Which timestamp to display based on sort order
  onClick: (e: React.MouseEvent) => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onRename?: (newName: string) => void; // Callback when session is renamed
  onPinToggle?: (isPinned: boolean) => void; // Callback when pin status changes
  onBranch?: () => void; // Callback when user wants to branch this session
  provider?: string;
  model?: string;
  messageCount?: number;
  sessionType?: 'session' | 'workstream' | 'blitz' | 'voice'; // Structural type of session
  isWorkstream?: boolean; // Whether this session is a workstream (has children)
  isWorktreeSession?: boolean; // Whether this session belongs to a worktree (shows worktree icon)
  parentSessionId?: string | null; // Parent session ID for hierarchical workstreams
  projectPath?: string; // Workspace path for drag-drop validation
  uncommittedCount?: number; // Number of uncommitted files in this session
  branchedAt?: number; // Timestamp when this session was branched (branch tracking)
  phase?: string; // Kanban board phase (backlog, planning, implementing, validating, complete)
}

export const SessionListItem = memo<SessionListItemProps>(({
  id,
  title,
  createdAt,
  updatedAt,
  isActive,
  isLoaded = false,
  isProcessing = false,
  hasUnread = false,
  hasPendingPrompt = false,
  isArchived = false,
  isPinned = false,
  isSelected = false,
  selectedCount = 1,
  sortBy = 'updated',
  onClick,
  onDelete,
  onArchive,
  onUnarchive,
  onRename,
  onPinToggle,
  onBranch,
  provider,
  model,
  messageCount,
  sessionType,
  isWorkstream = false,
  isWorktreeSession = false,
  parentSessionId = null,
  projectPath,
  uncommittedCount,
  branchedAt,
  phase,
}) => {
  const [isHovering, setIsHovering] = useState(false);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [isValidDropTarget, setIsValidDropTarget] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Atom setters for drag-drop
  const reparentSession = useSetAtom(reparentSessionAtom);
  const convertToWorkstream = useSetAtom(convertToWorkstreamAtom);
  const refreshSessionList = useSetAtom(refreshSessionListAtom);

  // Share state (for the share icon indicator in the list item)
  const shareInfo = useAtomValue(sessionShareAtom(id));

  // Awaiting input state (interactive prompt or pending prompt)
  const hasInteractivePrompt = useAtomValue(sessionHasPendingInteractivePromptAtom(id));
  const hasPendingPromptAtom = useAtomValue(sessionPendingPromptAtom(id));
  const isAwaitingInput = hasInteractivePrompt || hasPendingPromptAtom;

  // Determine if this session can be dragged
  // Can drag if: (1) Has a parent (is a child session), OR (2) Is an orphan (no parent, no children)
  // Worktree sessions cannot be dragged - they are tied to their git worktree
  const isDraggable = !isWorktreeSession && (parentSessionId !== null || !isWorkstream);

  // Determine if this session can accept drops
  // Workstreams and standalone root sessions can be drop targets (dropping creates a workstream)
  // Worktree sessions/workstreams cannot accept drops - they are tied to their git worktree
  const isDropTarget = !isWorktreeSession && (isWorkstream || parentSessionId === null);

  const handleRemoveFromWorkstream = useCallback(async () => {
    if (!parentSessionId || !projectPath) return;

    const success = await reparentSession({
      sessionId: id,
      oldParentId: parentSessionId,
      newParentId: null,
      workspacePath: projectPath,
    });

    if (success) {
      await refreshSessionList();
    }
  }, [id, parentSessionId, projectPath, reparentSession, refreshSessionList]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setShowContextMenu(false);
  }, []);

  const handleRenameSubmit = () => {
    const trimmedValue = renameValue.trim();
    if (trimmedValue && trimmedValue !== title && onRename) {
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

  // Drag-and-drop handlers
  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (!isDraggable || !projectPath) {
      e.preventDefault();
      return;
    }

    const dragData = {
      sessionId: id,
      parentId: parentSessionId,
      workspacePath: projectPath,
      isWorktreeSession,
    };

    e.dataTransfer.setData('application/x-nimbalyst-session', JSON.stringify(dragData));
    e.dataTransfer.effectAllowed = 'move';
    setIsDragging(true);
  }, [isDraggable, id, parentSessionId, projectPath, isWorktreeSession]);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isDropTarget) return;

    // Check if dragging a session
    const hasSessionData = e.dataTransfer.types.includes('application/x-nimbalyst-session');
    if (!hasSessionData) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsValidDropTarget(true);
  }, [isDropTarget]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear drop target if actually leaving the element
    // (not when entering a child element)
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (!e.currentTarget.contains(relatedTarget)) {
      setIsValidDropTarget(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsValidDropTarget(false);

    const dataStr = e.dataTransfer.getData('application/x-nimbalyst-session');
    if (!dataStr || !projectPath) return;

    try {
      const { sessionId, parentId, workspacePath, isWorktreeSession: draggedIsWorktree } = JSON.parse(dataStr);

      // Validate worktree sessions cannot be moved
      if (draggedIsWorktree) {
        console.error('[SessionListItem] Cannot move worktree sessions');
        return;
      }

      // Validate same workspace
      if (workspacePath !== projectPath) {
        console.error('[SessionListItem] Cannot move session between workspaces');
        return;
      }

      // Validate not dropping on self
      if (sessionId === id) {
        // console.error('[SessionListItem] Cannot drop session on itself');
        return;
      }

      // Validate not dropping on current parent (no-op)
      if (parentId === id) {
        // console.log('[SessionListItem] Session already belongs to this workstream');
        return;
      }

      let targetParentId = id;

      if (!isWorkstream) {
        // Drop target is a standalone session, not a workstream.
        // Convert it to a workstream first (without creating a sibling - the dragged session fills that role),
        // then reparent the dragged session into the new workstream parent.
        // console.log(`[SessionListItem] Converting session ${id} to workstream before reparenting`);
        const result = await convertToWorkstream({
          sessionId: id,
          workspacePath: projectPath,
          skipSiblingCreation: true,
        });

        if (!result) {
          console.error('[SessionListItem] Failed to convert drop target to workstream');
          return;
        }

        // The dragged session should be reparented under the new workstream parent
        targetParentId = result.parentId;
      }

      // Execute reparent into the (possibly new) workstream parent
      // console.log(`[SessionListItem] Reparenting session ${sessionId} from ${parentId} to ${targetParentId}`);
      const success = await reparentSession({
        sessionId,
        oldParentId: parentId,
        newParentId: targetParentId,
        workspacePath: projectPath,
      });

      if (success) {
        // Refresh session list to ensure consistency
        await refreshSessionList();

        // Track analytics
        if (window.electronAPI) {
          await window.electronAPI.invoke('analytics:track', {
            event: 'session_reparented',
            properties: {
              had_previous_parent: parentId !== null,
              created_workstream: !isWorkstream,
              workspace_path: projectPath,
            },
          });
        }
      }
    } catch (error) {
      console.error('[SessionListItem] Failed to handle drop:', error);
    }
  }, [projectPath, id, isWorkstream, reparentSession, convertToWorkstream, refreshSessionList]);

  // Auto-focus and select text when rename input appears
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  // Get the first line of the title (truncate if too long)
  const displayTitle = title || 'Untitled Session';
  const truncatedTitle = displayTitle.length > 40
    ? displayTitle.substring(0, 40) + '...'
    : displayTitle;

  // Per-session live activity. Bumped on every `ai:message-logged`; only
  // this list item re-renders when its own activity ticks, instead of the
  // whole SessionHistory + 705 siblings. Fall back to the registry's
  // `updatedAt` (set at DB refresh / on terminal session events) when no
  // activity has been recorded since mount.
  const liveActivity = useAtomValue(sessionLastActivityAtom(id));
  const effectiveUpdatedAt = liveActivity > 0 ? liveActivity : updatedAt;

  // Show timestamp based on current sort order
  const timestamp = sortBy === 'updated' ? (effectiveUpdatedAt || createdAt) : createdAt;
  const timestampLabel = sortBy === 'updated' ? 'updated' : 'created';

  const { relativeTime, fullDateTime } = useMemo(() => ({
    relativeTime: getRelativeTimeString(timestamp),
    fullDateTime: new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short'
    }),
  }), [timestamp]);

  // Extract model ID from provider:model format
  const displayModel = model?.includes(':') ? model.split(':')[1] : model;

  return (
    <div
        id={"session-list-item-" + id}
      data-testid={isWorktreeSession ? 'worktree-session-item' : isWorkstream ? 'workstream-session-item' : 'session-list-item'}
      data-session-type={isWorktreeSession ? 'worktree' : isWorkstream ? 'workstream' : 'session'}
      className={`session-list-item relative flex items-start gap-2.5 py-1 px-3 pl-8 cursor-pointer rounded mx-2 transition-[background-color,opacity] duration-150 select-none
        hover:bg-[var(--nim-bg-hover)]
        focus:outline-2 focus:outline-[var(--nim-border-focus)] focus:-outline-offset-2
        ${isActive ? 'active bg-[var(--nim-bg-selected)]' : ''}
        ${isLoaded ? 'loaded' : ''}
        ${isArchived ? 'archived opacity-60 hover:opacity-80' : ''}
        ${isSelected ? 'selected bg-[var(--nim-bg-selected)]' : ''}
        ${isPinned ? 'pinned' : ''}
        ${isDragging ? 'dragging opacity-50 cursor-grabbing' : ''}
        ${isValidDropTarget ? 'drop-target-valid bg-[rgba(83,89,93,0.4)] border-2 border-dashed border-[var(--nim-primary)]' : ''}
        ${isDraggable ? 'cursor-grab' : ''}
        ${isAwaitingInput && !isActive ? 'bg-[rgba(251,191,36,0.08)]' : ''}
      `}
      style={isAwaitingInput ? { borderLeft: '2px solid var(--nim-warning)' } : undefined}
      onClick={onClick}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      onContextMenu={handleContextMenu}
      draggable={isDraggable}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(e as unknown as React.MouseEvent);
        }
      }}
      aria-label={`Session: ${displayTitle}, ${timestampLabel} ${relativeTime}${isLoaded ? ' (loaded in tab)' : ''}${isArchived ? ' (archived)' : ''}`}
      aria-current={isActive ? 'page' : undefined}
    >
      <div className={`session-list-item-icon shrink-0 mt-0.5 text-[var(--nim-text-muted)] flex items-center relative ${isActive ? '[&]:text-[var(--nim-primary)] [&_svg]:text-[var(--nim-primary)]' : '[&_svg]:text-[var(--nim-text-muted)]'} ${isWorkstream ? 'workstream-icon' : ''} ${isWorktreeSession ? 'worktree-icon' : ''}`}>
        {sessionType === 'voice' ? (
          // Voice session: OpenAI icon with mic badge
          <div className="relative">
            <ProviderIcon provider="openai" size={16} />
            <MaterialSymbol
              icon="mic"
              size={12}
              className="absolute -bottom-1 -right-1.5 text-[var(--nim-text-muted)]"
              fill
            />
          </div>
        ) : isWorktreeSession ? (
          // Worktree icon (git branching visual)
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="3" y="2" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            <rect x="10" y="2" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            <rect x="3" y="11" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            <path d="M4.5 5v3.5a1.5 1.5 0 0 0 1.5 1.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M11.5 5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        ) : isWorkstream ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="8" cy="4" r="1.5" fill="currentColor"/>
            <circle cx="4" cy="12" r="1.5" fill="currentColor"/>
            <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
            <line x1="7.5" y1="5.2" x2="4.5" y2="10.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
            <line x1="8.5" y1="5.2" x2="11.5" y2="10.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
          </svg>
        ) : (
          <ProviderIcon provider={provider || 'claude'} size={16} />
        )}
      </div>
      {isPinned && (
        <MaterialSymbol icon="push_pin" size={12} className={`session-list-item-pin-icon shrink-0 -ml-1 opacity-70 ${isActive ? 'text-[var(--nim-primary)] opacity-80' : 'text-[var(--nim-text-faint)]'}`} />
      )}
      {branchedAt && (
        <MaterialSymbol icon="fork_right" size={12} className={`session-list-item-branch-icon shrink-0 -ml-1 opacity-60 ${isActive ? 'text-[var(--nim-primary)] opacity-70' : 'text-[var(--nim-text-faint)]'}`} title="Branched conversation" />
      )}
      {shareInfo && (
        <MaterialSymbol icon="link" size={12} className={`session-list-item-share-icon shrink-0 -ml-1 opacity-60 ${isActive ? 'text-[var(--nim-primary)] opacity-70' : 'text-[var(--nim-text-faint)]'}`} title="Shared" />
      )}
      <div className="session-list-item-content flex-1 min-w-0 overflow-hidden">
        {isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            className="session-list-item-rename-input w-full px-2 py-1 text-[0.8125rem] font-medium border border-[var(--nim-primary)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] outline-none box-border"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameSubmit}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <div title={displayTitle} className={`session-list-item-title text-[0.8125rem] text-[var(--nim-text)] font-medium overflow-hidden text-ellipsis whitespace-nowrap mb-0.5 transition-colors duration-150 ${isActive ? 'font-semibold' : ''} ${isArchived ? 'text-[var(--nim-text-faint)]' : ''}`}>{truncatedTitle}</div>
            <div className="session-list-item-meta flex gap-1.5 text-[0.6875rem] text-[var(--nim-text-faint)] items-center mt-0.5">
              <span className="session-list-item-datetime text-[0.6875rem] text-[var(--nim-text-faint)] whitespace-nowrap transition-colors duration-150" title={fullDateTime}>{relativeTime}</span>
              {displayModel && <span className="session-list-item-model overflow-hidden text-ellipsis whitespace-nowrap">{displayModel}</span>}
              {phase && <SessionPhaseBadge phase={phase} />}
            </div>
          </>
        )}
      </div>
      <div className="session-list-item-right shrink-0 flex items-center gap-1.5 ml-auto">
        {uncommittedCount !== undefined && uncommittedCount > 0 && (
          <span className="session-list-item-badge uncommitted text-[0.6875rem] px-1.5 py-0.5 rounded-xl font-semibold whitespace-nowrap bg-[rgba(245,158,11,0.15)] text-[var(--nim-warning)]" title={`${uncommittedCount} uncommitted change${uncommittedCount !== 1 ? 's' : ''}`}>
            {uncommittedCount}
          </span>
        )}
        <SessionStatusIndicator sessionId={id} messageCount={messageCount} />
        {/*{(onArchive || onUnarchive) && (*/}
        {/*  <button*/}
        {/*    className={`session-list-item-archive shrink-0 flex items-center justify-center w-5 h-5 p-0 bg-transparent border-none rounded text-[var(--nim-text-faint)] cursor-pointer transition-all duration-150 focus:outline-2 focus:outline-[var(--nim-border-focus)] focus:outline-offset-1*/}
        {/*      ${isHovering ? 'visible opacity-70 pointer-events-auto hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)] hover:opacity-100' : 'opacity-0 pointer-events-none'}*/}
        {/*      disabled:cursor-default disabled:opacity-0 disabled:pointer-events-none*/}
        {/*    `}*/}
        {/*    onClick={(e) => {*/}
        {/*      e.stopPropagation();*/}
        {/*      if (isArchived && onUnarchive) onUnarchive();*/}
        {/*      else if (!isArchived && onArchive) onArchive();*/}
        {/*    }}*/}
        {/*    aria-label={isArchived ? `Unarchive ${isWorkstream ? 'workstream' : isWorktreeSession ? 'worktree' : 'session'}` : `Archive ${isWorkstream ? 'workstream' : isWorktreeSession ? 'worktree' : 'session'}`}*/}
        {/*    title={isArchived ? `Unarchive ${isWorkstream ? 'workstream' : isWorktreeSession ? 'worktree' : 'session'}` : `Archive ${isWorkstream ? 'workstream' : isWorktreeSession ? 'worktree' : 'session'}`}*/}
        {/*  >*/}
        {/*    {isArchived ? (*/}
        {/*      <MaterialSymbol icon="unarchive" size={14} />*/}
        {/*    ) : (*/}
        {/*      <MaterialSymbol icon="archive" size={14} />*/}
        {/*    )}*/}
        {/*  </button>*/}
        {/*)}*/}
      </div>

      {/* Context Menu */}
      {showContextMenu && (
        <SessionContextMenu
          sessionId={id}
          title={title}
          position={contextMenuPosition}
          onClose={handleCloseContextMenu}
          isArchived={isArchived}
          isPinned={isPinned}
          isWorkstream={isWorkstream}
          isWorktreeSession={isWorktreeSession}
          parentSessionId={parentSessionId}
          phase={phase}
          onRename={onRename ? () => { setRenameValue(title); setIsRenaming(true); } : undefined}
          onPinToggle={onPinToggle}
          onBranch={onBranch}
          onRemoveFromWorkstream={parentSessionId && !isWorktreeSession ? handleRemoveFromWorkstream : undefined}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
          onDelete={onDelete}
          selectedCount={selectedCount}
        />
      )}
    </div>
  );
}, (prev, next) => {
  return (
    prev.id === next.id &&
    prev.title === next.title &&
    prev.createdAt === next.createdAt &&
    prev.updatedAt === next.updatedAt &&
    prev.isActive === next.isActive &&
    prev.isLoaded === next.isLoaded &&
    prev.isArchived === next.isArchived &&
    prev.isPinned === next.isPinned &&
    prev.isSelected === next.isSelected &&
    prev.selectedCount === next.selectedCount &&
    prev.sortBy === next.sortBy &&
    prev.provider === next.provider &&
    prev.model === next.model &&
    prev.messageCount === next.messageCount &&
    prev.sessionType === next.sessionType &&
    prev.isWorkstream === next.isWorkstream &&
    prev.isWorktreeSession === next.isWorktreeSession &&
    prev.parentSessionId === next.parentSessionId &&
    prev.projectPath === next.projectPath &&
    prev.uncommittedCount === next.uncommittedCount &&
    prev.branchedAt === next.branchedAt &&
    prev.phase === next.phase
  );
});
