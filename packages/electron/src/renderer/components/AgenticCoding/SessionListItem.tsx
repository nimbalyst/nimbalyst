import { SessionSpawnerLink } from './SessionSpawnerLink';
import { SessionProviderIcon } from './SessionProviderIcon';
import React, { useState, useCallback, useEffect, useRef, useMemo, memo } from 'react';
import { atom, useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useSessionTreeMove } from './useSessionTreeMove';
import { SessionMovePicker } from './SessionMovePicker';
import { WorktreeIcon } from '../common/WorktreeIcon';
import { ProviderIcon } from '@nimbalyst/runtime/ui/icons/ProviderIcons';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import { sessionOrChildProcessingAtom, sessionUnreadAtom, sessionPendingPromptAtom, sessionHasPendingInteractivePromptAtom, sessionShareAtom, sessionWakeupAtom, sessionLastActivityAtom } from '../../store';
import { sessionRegistryAtom } from '../../store/atoms/sessions';
import { SessionContextMenu } from './SessionContextMenu';
import { FullTitleTooltip } from './FullTitleTooltip';
import { settingAtom } from '../../store/atoms/settingAtomFamily';
import { sessionAgentWakePendingAtom } from '../../store/atoms/teamInbox';
import { sessionBackgroundTasksAtom, describeBackgroundWait } from '../../store/atoms/sessionBackgroundTasks';

/**
 * Combined status indicator that subscribes to this session's state atoms.
 * Shows waiting for input, processing, pending prompt, or unread status (in priority order).
 * Only this component re-renders when the session's state changes.
 */
export const SessionStatusIndicator = memo<{ sessionId: string; messageCount?: number }>(({ sessionId, messageCount }) => {
  // Use aggregated atom that checks this session AND any children (for workstreams)
  const hasPendingInteractivePrompt = useAtomValue(sessionHasPendingInteractivePromptAtom(sessionId));
  const isProcessing = useAtomValue(sessionOrChildProcessingAtom(sessionId));
  const hasPendingPrompt = useAtomValue(sessionPendingPromptAtom(sessionId));
  const hasAgentWakePending = useAtomValue(sessionAgentWakePendingAtom(sessionId));
  const hasUnread = useAtomValue(sessionUnreadAtom(sessionId));
  const wakeup = useAtomValue(sessionWakeupAtom(sessionId));
  // Lead turn is over; the session is only draining background shells/sub-agents.
  const backgroundTasks = useAtomValue(sessionBackgroundTasksAtom(sessionId));

  // Priority: waiting for input > processing > pending prompt > scheduled wakeup > unread > message count
  // All interactive prompts (AskUserQuestion, ExitPlanMode, ToolPermission, etc.) show same indicator
  if (hasPendingInteractivePrompt) {
    return (
      <div className="session-list-item-status waiting-for-input flex items-center justify-center w-5 h-5 text-[var(--nim-warning)] animate-pulse" title="Waiting for your response">
        <MaterialSymbol icon="contact_support" size={14} />
      </div>
    );
  }

  if (isProcessing && backgroundTasks?.length) {
    return (
      <div className="session-list-item-status background-wait flex items-center justify-center w-5 h-5 text-[var(--nim-text-muted)] animate-pulse" title={describeBackgroundWait(backgroundTasks, Date.now())}>
        <MaterialSymbol icon="timelapse" size={14} />
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

  if (hasAgentWakePending) {
    return (
      <div className="session-list-item-status agent-wake-pending flex items-center justify-center w-5 h-5 text-[var(--nim-warning)] animate-pulse" title="Room message pending agent dispatch">
        <MaterialSymbol icon="hourglass_top" size={14} />
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

// This leaf owns its expiry timer: following never ticks the parent or sibling rows.
const EXTERNAL_ACTIVITY_RECENT_MS = 30_000;
const SessionExternalMarker = memo(function SessionExternalMarker({ sessionId }: { sessionId: string }) {
  const source = useAtomValue(useMemo(() => atom(get => get(sessionRegistryAtom).get(sessionId)?.externalSource), [sessionId]));
  const lastActivity = useAtomValue(useMemo(() => atom(get => get(sessionRegistryAtom).get(sessionId)?.externalLastActivityAt), [sessionId]));
  const enabled = useAtomValue(settingAtom('app.externalSessionFollowEnabled')) === true;
  const [, expire] = useState(0);
  const age = Date.now() - (lastActivity ?? 0);
  const following = !!source && enabled && lastActivity !== undefined && age >= 0 && age < EXTERNAL_ACTIVITY_RECENT_MS;

  useEffect(() => {
    if (!following || lastActivity === undefined) return;
    const timer = setTimeout(() => expire(value => value + 1), Math.max(0, lastActivity + EXTERNAL_ACTIVITY_RECENT_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [source, enabled, lastActivity, following]);

  if (!source) return null;
  return (
    <span className="session-list-item-external inline-flex gap-1 whitespace-nowrap text-[var(--nim-text-muted)]" title={`Imported from ${source === 'claude-code' ? 'Claude Code' : 'Codex'}`}>
      <span>External</span>
      {following && <span className="session-list-item-following text-[var(--nim-primary)]" title="Recent external session activity">Following</span>}
    </span>
  );
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
  treeContext?: boolean;
  treeLeading?: React.ReactNode;
  /** Inline summary shown on the metadata line (or the title line when compact). */
  treeDetails?: React.ReactNode;
  /** Single-line row: title, inline summary and time. */
  compact?: boolean;
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

// Named rather than an inline arrow so the render profiler can report it by
// name instead of "Memo <- SessionHistory". See docs/RENDER_PERFORMANCE.md.
export const SessionListItem = memo<SessionListItemProps>(function SessionListItem({
  id,
  treeContext,
  treeLeading,
  treeDetails,
  compact,
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
}) {
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const { move, isDragging, isDraggable, hint, onDragStart: handleDragStart, onDragEnd: handleDragEnd, onDragOver: handleDragOver, onDragLeave: handleDragLeave, onDrop: handleDrop } = useSessionTreeMove(id, projectPath);

  // Share state (for the share icon indicator in the list item)
  const shareInfo = useAtomValue(sessionShareAtom(id));

  // Awaiting input state (interactive prompt or pending prompt)
  const hasInteractivePrompt = useAtomValue(sessionHasPendingInteractivePromptAtom(id));
  const hasPendingPromptAtom = useAtomValue(sessionPendingPromptAtom(id));
  const isAwaitingInput = hasInteractivePrompt || hasPendingPromptAtom;

  const handleRemoveFromWorkstream = useCallback(() => { void move(id, null); }, [move, id]);

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

  // Auto-focus and select text when rename input appears
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const displayTitle = title || 'Untitled Session';

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

  // A quiet session still ages: relativeTime is derived from a fixed timestamp,
  // so without a periodic re-render the "X ago" label sits frozen until the
  // session next has activity (#1200). One coarse tick a minute matches the
  // finest granularity getRelativeTimeString renders — same approach as the
  // Inbox section's relative labels.
  const [relativeTimeTick, setRelativeTimeTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setRelativeTimeTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

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
  }), [timestamp, relativeTimeTick]);

  // Extract model ID from provider:model format
  const displayModel = model?.includes(':') ? model.split(':')[1] : model;

  return (
    <div
        id={"session-list-item-" + id}
      data-testid={isWorktreeSession ? 'worktree-session-item' : isWorkstream ? 'workstream-session-item' : 'session-list-item'}
      data-session-type={isWorktreeSession ? 'worktree' : isWorkstream ? 'workstream' : 'session'}
      className={`session-list-item relative flex ${compact ? 'compact items-center py-0.5' : 'items-start py-1'} gap-2.5 pr-3 pl-7 cursor-pointer rounded mr-2 transition-[background-color,opacity] duration-150 select-none
        hover:bg-[var(--nim-bg-hover)]
        focus:outline-2 focus:outline-[var(--nim-border-focus)] focus:-outline-offset-2
        ${isActive ? 'active bg-[var(--nim-bg-selected)]' : ''}
        ${isLoaded ? 'loaded' : ''}
        ${isArchived ? 'archived opacity-60 hover:opacity-80' : ''}
        ${isSelected ? 'selected bg-[var(--nim-bg-selected)]' : ''}
        ${isPinned ? 'pinned' : ''}
        ${isDragging ? 'dragging opacity-50 cursor-grabbing' : ''}
        ${hint?.valid ? 'drop-target-valid bg-[rgba(83,89,93,0.4)] border-2 border-dashed border-[var(--nim-primary)]' : ''}
        ${hint?.between && hint.valid ? 'border-t-2 border-[var(--nim-primary)]' : ''}
        ${isDraggable ? 'cursor-grab' : ''}
        ${isAwaitingInput && !isActive ? 'bg-[rgba(251,191,36,0.08)]' : ''}
      `}
      style={{ ...(isAwaitingInput ? { borderLeft: '2px solid var(--nim-warning)' } : {}), ...(treeContext ? { paddingLeft: 4, marginLeft: 0 } : {}), ...(hint && !hint.valid ? { cursor: 'not-allowed' } : {}) }}
      onClick={onClick}
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
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(e as unknown as React.MouseEvent);
        }
      }}
      aria-label={`Session: ${displayTitle}, ${timestampLabel} ${relativeTime}${isLoaded ? ' (loaded in tab)' : ''}${isArchived ? ' (archived)' : ''}`}
      aria-current={isActive ? 'page' : undefined}
    >
      {treeLeading}
      <div className={`session-list-item-icon shrink-0 ${compact ? "" : "mt-0.5"} text-[var(--nim-text-muted)] flex items-center relative ${isActive ? '[&]:text-[var(--nim-primary)] [&_svg]:text-[var(--nim-primary)]' : '[&_svg]:text-[var(--nim-text-muted)]'} ${isWorkstream ? 'workstream-icon' : ''} ${isWorktreeSession ? 'worktree-icon' : ''}`}>
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
        ) : isWorktreeSession && !treeContext ? (
          <WorktreeIcon size={16} />
        ) : isWorkstream && !treeContext ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="8" cy="4" r="1.5" fill="currentColor"/>
            <circle cx="4" cy="12" r="1.5" fill="currentColor"/>
            <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
            <line x1="7.5" y1="5.2" x2="4.5" y2="10.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
            <line x1="8.5" y1="5.2" x2="11.5" y2="10.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
          </svg>
        ) : (
          <SessionProviderIcon sessionId={id} provider={provider} size={16} isActive={isActive} hideLaunchCount={treeContext} />
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
        ) : compact ? (
          <div className="session-list-item-compact-line flex items-center gap-1.5 min-w-0">
            <FullTitleTooltip
              label={displayTitle}
              className={`session-list-item-title block flex-1 min-w-0 text-[0.8125rem] text-[var(--nim-text)] font-medium overflow-hidden text-ellipsis whitespace-nowrap transition-colors duration-150 ${isActive ? 'font-semibold' : ''} ${isArchived ? 'text-[var(--nim-text-faint)]' : ''}`}
            >
              {displayTitle}
            </FullTitleTooltip>
            {treeDetails}
            <span className="session-list-item-datetime shrink-0 text-[0.6875rem] text-[var(--nim-text-faint)] whitespace-nowrap" title={fullDateTime}>{relativeTime}</span>
            {hint && <span className="session-tree-drop-hint text-xs text-[var(--nim-primary)]" role="status">{hint.label}</span>}
          </div>
        ) : (
          <>
            <FullTitleTooltip
              label={displayTitle}
              className={`session-list-item-title block text-[0.8125rem] text-[var(--nim-text)] font-medium overflow-hidden text-ellipsis whitespace-nowrap mb-0.5 transition-colors duration-150 ${isActive ? 'font-semibold' : ''} ${isArchived ? 'text-[var(--nim-text-faint)]' : ''}`}
            >
              {displayTitle}
            </FullTitleTooltip>
            <div className="session-list-item-meta flex gap-1.5 text-[0.6875rem] text-[var(--nim-text-faint)] items-center mt-0.5">
              <span className="session-list-item-datetime text-[0.6875rem] text-[var(--nim-text-faint)] whitespace-nowrap transition-colors duration-150" title={fullDateTime}>{relativeTime}</span>
              {displayModel && <span className="session-list-item-model overflow-hidden text-ellipsis whitespace-nowrap">{displayModel}</span>}
              {phase && <SessionPhaseBadge phase={phase} />}
              <SessionExternalMarker sessionId={id} />
              {treeDetails}
            </div>
            <SessionSpawnerLink sessionId={id} />
            {hint && <div className="session-tree-drop-hint text-xs text-[var(--nim-primary)]" role="status">{hint.label}</div>}
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

      </div>

      {showMovePicker && <SessionMovePicker sessionId={id} onMove={(parentId) => move(id, parentId)} onClose={() => setShowMovePicker(false)} />}

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
          onRemoveFromWorkstream={parentSessionId ? handleRemoveFromWorkstream : undefined}
          onMoveUnder={isDraggable ? () => setShowMovePicker(true) : undefined}
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
    prev.treeContext === next.treeContext &&
    prev.treeLeading === next.treeLeading &&
    prev.treeDetails === next.treeDetails &&
    prev.compact === next.compact &&
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
