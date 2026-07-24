/**
 * SuperLoopGroup - Displays a Super Loop in the session history
 *
 * Follows the same visual and interaction patterns as BlitzGroup:
 * - Flat list item (no card/border)
 * - Parent-controlled expand/collapse
 * - Active session highlighting
 * - Child iteration rows matching BlitzSessionRow style
 */

import React, { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol, ProviderIcon } from '@nimbalyst/runtime';
import {
  superRunnerStateAtom,
  superIterationsAtom,
  setSuperIterationsAtom,
  superProgressAtom,
  setSuperProgressAtom,
  getSuperStatusInfo,
} from '../../store/atoms/superLoop';
import {
  groupSessionStatusAtom,
  sessionProcessingAtom,
  sessionUnreadAtom,
  sessionPendingPromptAtom,
} from '../../store';
import type { SuperLoop, SuperLoopStatus, SuperIteration, SuperLearning } from '../../../shared/types/superLoop';
import { getRelativeTimeString } from '../../utils/dateFormatting';

interface SuperLoopGroupProps {
  loopId: string;
  loop: SuperLoop;
  isExpanded: boolean;
  isActive: boolean;
  isSelected?: boolean;
  onToggle: () => void;
  onMultiSelect?: (e: React.MouseEvent) => void;
  activeSessionId: string | null;
  onSessionSelect: (sessionId: string, e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onRename?: (newName: string) => void;
  onPinToggle?: (isPinned: boolean) => void;
}

/**
 * Compact status badge matching BlitzGroup's archive badge style.
 * Hidden when running (the spinning sync icon indicates running state).
 */
const SuperStatusBadge: React.FC<{ status: SuperLoopStatus }> = memo(({ status }) => {
  if (status === 'running') return null;
  const { label } = getSuperStatusInfo(status);
  const colorMap: Record<string, string> = {
    paused: 'bg-[rgba(234,179,8,0.15)] text-[var(--nim-warning)]',
    completed: 'bg-[rgba(59,130,246,0.15)] text-[var(--nim-primary)]',
    failed: 'bg-[rgba(239,68,68,0.15)] text-[var(--nim-error)]',
    blocked: 'bg-[rgba(249,115,22,0.15)] text-orange-500',
    pending: 'bg-[rgba(156,163,175,0.15)] text-[var(--nim-text-faint)]',
  };
  return (
    <span className={`text-[0.5625rem] px-1.5 py-[0.0625rem] rounded-[0.625rem] font-medium ${colorMap[status] || ''}`}>
      {label}
    </span>
  );
});

/**
 * Aggregate status indicator for the Super Loop group header.
 * When iterations are loaded, uses groupSessionStatusAtom (same as BlitzGroupStatus).
 * When not loaded, derives a simple indicator from the loop status.
 */
const SuperGroupStatus: React.FC<{ sessionIds: string[]; loopStatus: SuperLoopStatus }> = memo(({ sessionIds, loopStatus }) => {
  // When iteration session IDs are available, use the standard group status atom
  const sessionIdsKey = useMemo(() => JSON.stringify([...sessionIds].sort()), [sessionIds]);
  const groupStatus = useAtomValue(groupSessionStatusAtom(sessionIdsKey));

  if (sessionIds.length > 0) {
    if (groupStatus.hasProcessing) {
      return (
        <div className="flex items-center justify-center text-[var(--nim-primary)]" title="Processing">
          <MaterialSymbol icon="progress_activity" size={12} className="animate-spin" />
        </div>
      );
    }
    if (groupStatus.hasPendingPrompt) {
      return (
        <div className="flex items-center justify-center text-[var(--nim-warning)] animate-pulse" title="Waiting for your response">
          <MaterialSymbol icon="help" size={12} />
        </div>
      );
    }
    if (groupStatus.hasUnread) {
      return (
        <div className="flex items-center justify-center text-[var(--nim-primary)]" title="Unread response">
          <MaterialSymbol icon="circle" size={6} fill />
        </div>
      );
    }
    return null;
  }

  // Fallback: derive from loop status when iterations not loaded
  if (loopStatus === 'running') {
    return (
      <div className="flex items-center justify-center text-[var(--nim-primary)]" title="Running">
        <MaterialSymbol icon="progress_activity" size={12} className="animate-spin" />
      </div>
    );
  }
  if (loopStatus === 'blocked') {
    return (
      <div className="flex items-center justify-center text-[var(--nim-warning)] animate-pulse" title="Blocked">
        <MaterialSymbol icon="help" size={12} />
      </div>
    );
  }
  return null;
});

/**
 * Per-session status indicator for iteration rows.
 * Same pattern as BlitzSessionStatus.
 */
const SuperIterationStatus: React.FC<{ sessionId: string }> = memo(({ sessionId }) => {
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
 * Iteration row matching BlitzSessionRow style.
 */
const SuperIterationRow: React.FC<{
  iteration: SuperIteration;
  learning?: SuperLearning;
  isActive: boolean;
  onSelect: (e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
}> = memo(({ iteration, learning, isActive, onSelect }) => (
  <div
    className={`super-loop-iteration-item flex items-center gap-2 py-1.5 px-3 mr-2 mb-0.5 cursor-pointer rounded transition-colors duration-150 select-none ${
      isActive ? 'bg-[var(--nim-bg-selected)]' : 'hover:bg-[var(--nim-bg-hover)]'
    } focus:outline-2 focus:outline-[var(--nim-border-focus)] focus:outline-offset-[-2px]`}
    onClick={onSelect}
    role="button"
    tabIndex={0}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(e); } }}
    aria-label={`Iteration ${iteration.iterationNumber}`}
    aria-current={isActive ? 'page' : undefined}
  >
    <div className={`shrink-0 flex items-center justify-center ${
      isActive ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'
    }`}>
      <ProviderIcon provider="claude-code" size={14} />
    </div>
    <span className={`flex-1 text-xs text-[var(--nim-text)] whitespace-nowrap overflow-hidden text-ellipsis ${
      isActive ? 'font-medium' : ''
    }`}>
      {learning?.summary || iteration.exitReason || `Iteration ${iteration.iterationNumber}`}
    </span>
    <span className="shrink-0 text-[0.6875rem] text-[var(--nim-text-faint)] ml-2">
      {getRelativeTimeString(iteration.createdAt)}
    </span>
    <div className="shrink-0 flex items-center">
      <SuperIterationStatus sessionId={iteration.sessionId} />
    </div>
  </div>
));

/**
 * Blocked continue UI - textarea and button for providing feedback to overcome a blocker.
 */
const SuperBlockedContinueUI: React.FC<{ loopId: string }> = memo(({ loopId }) => {
  const [input, setInput] = useState('');
  const [isContinuing, setIsContinuing] = useState(false);

  const handleContinue = useCallback(async () => {
    if (!input.trim()) return;
    setIsContinuing(true);
    try {
      const result = await window.electronAPI.invoke('super-loop:continue-blocked', loopId, input);
      if (!result.success) {
        console.error('[SuperLoopGroup] Failed to continue loop:', result.error);
      }
      setInput('');
    } catch (err) {
      console.error('[SuperLoopGroup] Failed to continue loop:', err);
    } finally {
      setIsContinuing(false);
    }
  }, [loopId, input]);

  return (
    <div className="px-3 py-2 mx-2 mr-4 mb-1 rounded bg-[var(--nim-bg-secondary)]">
      <textarea
        className="w-full px-2 py-1 text-xs bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded resize-none text-[var(--nim-text)] placeholder:text-[var(--nim-text-muted)]"
        rows={3}
        placeholder="Provide additional context or guidance to help overcome the blocker..."
        value={input}
        onChange={(e) => setInput(e.target.value)}
        disabled={isContinuing}
      />
      <button
        className="mt-1 px-3 py-1 text-xs bg-[var(--nim-primary)] text-white rounded hover:opacity-90 disabled:opacity-50"
        onClick={handleContinue}
        disabled={isContinuing || !input.trim()}
      >
        {isContinuing ? 'Continuing...' : 'Continue Loop'}
      </button>
    </div>
  );
});

export const SuperLoopGroup: React.FC<SuperLoopGroupProps> = memo(({
  loopId,
  loop,
  isExpanded,
  isActive,
  isSelected,
  onToggle,
  onMultiSelect,
  activeSessionId,
  onSessionSelect,
  onArchive,
  onUnarchive,
  onRename,
  onPinToggle,
}) => {
  const runnerState = useAtomValue(superRunnerStateAtom(loopId));
  const iterations = useAtomValue(superIterationsAtom(loopId));
  const setIterations = useSetAtom(setSuperIterationsAtom);
  const progress = useAtomValue(superProgressAtom(loopId));
  const setProgress = useSetAtom(setSuperProgressAtom);

  const [isLoadingIterations, setIsLoadingIterations] = useState(false);

  // Context menu state
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [adjustedContextMenuPosition, setAdjustedContextMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Rename state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Force-resume dropdown state
  const [showForceResumeMenu, setShowForceResumeMenu] = useState(false);
  const forceResumeMenuRef = useRef<HTMLDivElement>(null);

  // Extract iteration session IDs for aggregate status
  const iterationSessionIds = useMemo(
    () => iterations.map(iter => iter.sessionId),
    [iterations]
  );

  // Load iterations and progress when expanded
  useEffect(() => {
    if (!isExpanded) return;

    let cancelled = false;

    const loadData = async () => {
      if (iterations.length === 0) {
        setIsLoadingIterations(true);
        try {
          const result = await window.electronAPI.invoke('super-loop:get-with-iterations', loopId);
          if (!cancelled && result.success && result.loop?.iterations) {
            setIterations({ loopId, iterations: result.loop.iterations });
          }
        } catch (err) {
          console.error('[SuperLoopGroup] Failed to load iterations:', err);
        } finally {
          if (!cancelled) setIsLoadingIterations(false);
        }
      }

      if (!progress) {
        try {
          const result = await window.electronAPI.invoke('super-loop:get-progress', loopId);
          if (!cancelled && result.success && result.progress) {
            setProgress({ loopId, progress: result.progress });
          }
        } catch (err) {
          console.error('[SuperLoopGroup] Failed to load progress:', err);
        }
      }
    };

    loadData();
    return () => { cancelled = true; };
  }, [isExpanded, loopId, iterations.length, progress, setIterations, setProgress]);

  // Control handlers
  const handleStart = useCallback(async () => {
    try {
      await window.electronAPI.invoke('super-loop:start', loopId);
    } catch (err) {
      console.error('[SuperLoopGroup] Failed to start loop:', err);
    }
  }, [loopId]);

  const handlePause = useCallback(async () => {
    try {
      await window.electronAPI.invoke('super-loop:pause', loopId);
    } catch (err) {
      console.error('[SuperLoopGroup] Failed to pause loop:', err);
    }
  }, [loopId]);

  const handleStop = useCallback(async () => {
    try {
      await window.electronAPI.invoke('super-loop:stop', loopId, 'User stopped');
    } catch (err) {
      console.error('[SuperLoopGroup] Failed to stop loop:', err);
    }
  }, [loopId]);

  const handleForceResume = useCallback(async (bumpIterations: number) => {
    setShowForceResumeMenu(false);
    try {
      await window.electronAPI.invoke('super-loop:force-resume', loopId, {
        bumpMaxIterations: bumpIterations > 0 ? bumpIterations : undefined,
        resetCompletionSignal: true,
      });
    } catch (err) {
      console.error('[SuperLoopGroup] Failed to force-resume loop:', err);
    }
  }, [loopId]);

  // Display title: user-set title, or first line of task description
  const displayTitle = useMemo(() => {
    if (loop.title) return loop.title;
    const firstLine = loop.taskDescription.split('\n')[0].trim();
    return firstLine.length > 50 ? firstLine.slice(0, 50) + '...' : firstLine;
  }, [loop.title, loop.taskDescription]);

  const currentIteration = runnerState?.currentIteration ?? loop.currentIteration;
  const isRunning = loop.status === 'running';
  const isPaused = loop.status === 'paused';
  const isActiveLoop = isRunning || isPaused;

  const handleChevronClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle();
  }, [onToggle]);

  // Select the most recent iteration's session when clicking the header
  const handleHeaderClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && onMultiSelect) {
      onMultiSelect(e);
      return;
    }
    if (iterations.length > 0) {
      const latestIteration = iterations[iterations.length - 1];
      onSessionSelect(latestIteration.sessionId, e);
    }
  }, [iterations, onSessionSelect, onMultiSelect]);

  // Context menu handlers
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

  const handleRenameClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    setRenameValue(displayTitle);
    setIsRenaming(true);
  }, [displayTitle]);

  const handleRenameSubmit = useCallback(() => {
    const trimmedValue = renameValue.trim();
    if (trimmedValue && trimmedValue !== displayTitle && onRename) {
      onRename(trimmedValue);
    }
    setIsRenaming(false);
  }, [renameValue, displayTitle, onRename]);

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

  const handlePinToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (onPinToggle) {
      onPinToggle(!loop.isPinned);
    }
  }, [loop.isPinned, onPinToggle]);

  const handleArchiveToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowContextMenu(false);
    if (loop.isArchived && onUnarchive) {
      onUnarchive();
    } else if (!loop.isArchived && onArchive) {
      onArchive();
    }
  }, [loop.isArchived, onArchive, onUnarchive]);

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

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

  return (
    <div
      className={`super-loop-group mb-1 ${loop.isArchived ? 'archived' : ''} ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
      data-testid={`super-loop-group-${loopId}`}
      onMouseLeave={handleCloseContextMenu}
    >
      {/* Header - matches BlitzGroup/WorkstreamGroup header structure */}
      <div
        className={`super-loop-group-header flex items-center gap-0 text-[0.8125rem] text-[var(--nim-text)] transition-colors duration-150 rounded-md mx-2 w-[calc(100%-1rem)] ${
          isSelected ? 'bg-[var(--nim-bg-selected)]' : isActive ? 'bg-[var(--nim-bg-selected)]' : 'hover:bg-[var(--nim-bg-hover)]'
        }`}
        onContextMenu={handleContextMenu}
      >
        {/* Chevron - separate click target for expand/collapse */}
        <button
          className="flex items-center justify-center w-6 h-full min-h-[2.5rem] p-0 bg-transparent border-none cursor-pointer text-[var(--nim-text-faint)] shrink-0 rounded-l-md hover:bg-[var(--nim-bg-secondary)] focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--nim-border-focus)] focus-visible:outline-offset-[-2px]"
          onClick={handleChevronClick}
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} Super Loop`}
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
          aria-label={`Super Loop: ${displayTitle}`}
        >
          {/* Sync icon */}
          <div className={`shrink-0 w-[1.125rem] h-[1.125rem] mt-[0.0625rem] flex items-center justify-center ${
            isActive ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'
          }`}>
            <MaterialSymbol
              icon="sync"
              size={16}
              className={isRunning ? 'animate-spin' : ''}
            />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            {/* Title line */}
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
                <>
                  <span className="font-medium text-[var(--nim-text)] whitespace-nowrap overflow-hidden text-ellipsis" title={displayTitle}>
                    {displayTitle}
                  </span>
                  {loop.isPinned && (
                    <MaterialSymbol icon="push_pin" size={12} className="shrink-0 text-[var(--nim-text-faint)] opacity-70" />
                  )}
                  {loop.isArchived && (
                    <span className="text-[0.5625rem] px-1.5 py-[0.0625rem] rounded-[0.625rem] font-medium bg-[rgba(156,163,175,0.15)] text-[var(--nim-text-faint)]">archived</span>
                  )}
                </>
              )}
              {!isRenaming && <SuperStatusBadge status={loop.status} />}
              {!isRenaming && <SuperGroupStatus sessionIds={iterationSessionIds} loopStatus={loop.status} />}
            </div>
            {/* Subtitle line */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="shrink-0 text-[0.6875rem] text-[var(--nim-text-faint)]">
                {currentIteration}/{loop.maxIterations} iterations
              </span>
              <span className="shrink-0 text-[0.6875rem] text-[var(--nim-text-faint)]">
                {getRelativeTimeString(loop.updatedAt)}
              </span>
            </div>
          </div>

          {/* Control buttons */}
          <div className="flex items-center gap-0.5 shrink-0 self-center" onClick={(e) => e.stopPropagation()}>
            {isActiveLoop && (
              <>
                {isRunning ? (
                  <button
                    onClick={handlePause}
                    className="p-1 rounded hover:bg-[var(--nim-bg-secondary)] text-[var(--nim-text-faint)] hover:text-[var(--nim-warning)] transition-colors"
                    title="Pause"
                  >
                    <MaterialSymbol icon="pause" size={14} />
                  </button>
                ) : (
                  <button
                    onClick={handleStart}
                    className="p-1 rounded hover:bg-[var(--nim-bg-secondary)] text-[var(--nim-text-faint)] hover:text-green-500 transition-colors"
                    title="Resume"
                  >
                    <MaterialSymbol icon="play_arrow" size={14} />
                  </button>
                )}
                <button
                  onClick={handleStop}
                  className="p-1 rounded hover:bg-[var(--nim-bg-secondary)] text-[var(--nim-text-faint)] hover:text-[var(--nim-error)] transition-colors"
                  title="Stop"
                >
                  <MaterialSymbol icon="stop" size={14} />
                </button>
              </>
            )}
            {loop.status === 'pending' && (
              <button
                onClick={handleStart}
                className="p-1 rounded hover:bg-[var(--nim-bg-secondary)] text-[var(--nim-text-faint)] hover:text-green-500 transition-colors"
                title="Start"
              >
                <MaterialSymbol icon="play_arrow" size={14} />
              </button>
            )}
            {(loop.status === 'completed' || loop.status === 'failed' || loop.status === 'blocked') && (
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setShowForceResumeMenu(prev => !prev); }}
                  className="p-1 rounded hover:bg-[var(--nim-bg-secondary)] text-[var(--nim-text-faint)] hover:text-green-500 transition-colors"
                  title="Resume loop"
                >
                  <MaterialSymbol icon="replay" size={14} />
                </button>
                {showForceResumeMenu && (
                  <div
                    ref={forceResumeMenuRef}
                    className="absolute right-0 top-full mt-1 z-50 min-w-[160px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md shadow-lg py-1"
                    onMouseLeave={() => setShowForceResumeMenu(false)}
                  >
                    <div className="px-3 py-1.5 text-[10px] text-[var(--nim-text-muted)] font-semibold uppercase tracking-wide">Resume with</div>
                    {[
                      { label: 'No extra iterations', bump: 0 },
                      { label: '+5 iterations', bump: 5 },
                      { label: '+10 iterations', bump: 10 },
                      { label: '+20 iterations', bump: 20 },
                    ].map(opt => (
                      <button
                        key={opt.bump}
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-[var(--nim-text)] bg-transparent border-none cursor-pointer hover:bg-[var(--nim-bg-hover)] text-left"
                        onClick={(e) => { e.stopPropagation(); handleForceResume(opt.bump); }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Expanded content - iteration sessions */}
      {isExpanded && (
        <div className="super-loop-children pt-1 pb-1 pl-10 animate-[superLoopSlideDown_0.2s_ease-out]">
          {isLoadingIterations ? (
            <div className="flex items-center justify-center py-3">
              <MaterialSymbol icon="progress_activity" size={16} className="animate-spin text-[var(--nim-text-muted)]" />
            </div>
          ) : iterations.length === 0 ? (
            <div className="text-center py-3 text-xs text-[var(--nim-text-muted)]">
              No iterations yet
            </div>
          ) : (
            iterations.map((iteration) => {
              const learning = progress?.learnings?.find(l => l.iteration === iteration.iterationNumber);
              return (
                <SuperIterationRow
                  key={iteration.id}
                  iteration={iteration}
                  learning={learning}
                  isActive={iteration.sessionId === activeSessionId}
                  onSelect={(e) => onSessionSelect(iteration.sessionId, e)}
                />
              );
            })
          )}

          {/* Blocked continue UI */}
          {loop.status === 'blocked' && (
            <SuperBlockedContinueUI loopId={loopId} />
          )}
        </div>
      )}

      {/* Context Menu */}
      {showContextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[1000] min-w-[140px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.15)] p-1"
          style={{
            left: (adjustedContextMenuPosition || contextMenuPosition).x,
            top: (adjustedContextMenuPosition || contextMenuPosition).y
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {onRename && (
            <button
              className="flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleRenameClick}
            >
              <MaterialSymbol icon="edit" size={14} />
              Rename
            </button>
          )}
          {onPinToggle && (
            <button
              className="flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-text)] text-left rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handlePinToggle}
            >
              <MaterialSymbol icon="push_pin" size={14} />
              {loop.isPinned ? 'Unpin' : 'Pin'}
            </button>
          )}
          {(onArchive || onUnarchive) && (
            <>
              <div className="h-px my-1 bg-[var(--nim-border)]" />
              <button
                className="flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-[0.8125rem] text-[var(--nim-error)] text-left rounded transition-colors duration-150 hover:bg-[rgba(239,68,68,0.1)]"
                onClick={handleArchiveToggle}
              >
                <MaterialSymbol icon={loop.isArchived ? "unarchive" : "archive"} size={14} />
                {loop.isArchived ? 'Unarchive' : 'Archive'}
              </button>
            </>
          )}
        </div>
      )}

      <style>{`
        @keyframes superLoopSlideDown {
          from {
            opacity: 0;
            transform: translateY(-4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .super-loop-group.archived .super-loop-group-header {
          opacity: 0.5;
        }
      `}</style>
    </div>
  );
});

export default SuperLoopGroup;
