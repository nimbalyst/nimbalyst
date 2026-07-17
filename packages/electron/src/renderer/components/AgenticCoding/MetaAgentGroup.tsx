/**
 * MetaAgentGroup - Displays a meta-agent session and its child sessions in the session history.
 *
 * Follows the same visual patterns as SuperLoopGroup and BlitzGroup:
 * - Flat list item (no card/border)
 * - Parent-controlled expand/collapse
 * - Active session highlighting
 * - Child session rows
 */

import React, { memo, useCallback, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol, ProviderIcon } from '@nimbalyst/runtime';
import {
  groupIndicatorStateAtom,
  sessionIndicatorStateAtom,
  type SessionMeta,
} from '../../store';
import { SessionRelativeTime } from './SessionRelativeTime';
import { SessionContextMenu } from './SessionContextMenu';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import {
  GroupOperationalIndicator,
  SessionOperationalIndicator,
  getSessionOperationalLabel,
} from './SessionOperationalIndicator';

interface MetaAgentGroupProps {
  metaSession: SessionMeta;
  childSessions: SessionMeta[];
  isExpanded: boolean;
  isActive: boolean;
  isSelected?: boolean;
  onToggle: () => void;
  onMultiSelect?: (e: React.MouseEvent) => void;
  activeSessionId: string | null;
  onSessionSelect: (sessionId: string, e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
  onSessionArchive?: (sessionId: string) => void;
  onSessionUnarchive?: (sessionId: string) => void;
  onSessionDelete?: (sessionId: string) => void;
  onMetaSessionArchive?: (sessionId: string) => void;
  onMetaSessionUnarchive?: (sessionId: string) => void;
  onMetaSessionDelete?: (sessionId: string) => void;
  onSessionPinToggle?: (sessionId: string, isPinned: boolean) => void;
  onSessionBranch?: (sessionId: string) => void;
  onWorktreeArchive?: (worktreeId: string) => void;
}

/**
 * Aggregate status indicator for the meta-agent group header.
 */
const MetaAgentGroupStatus: React.FC<{ groupKey: string }> = memo(({ groupKey }) => {
  return <GroupOperationalIndicator groupKey={groupKey} variant="group" />;
});

/**
 * Child session row matching SuperIterationRow / BlitzSessionRow style.
 */
const MetaAgentChildRow: React.FC<{
  session: SessionMeta;
  isActive: boolean;
  onSelect: (e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}> = memo(({ session, isActive, onSelect, onContextMenu }) => {
  const indicatorState = useAtomValue(sessionIndicatorStateAtom(session.id));
  const operationalLabel = getSessionOperationalLabel(indicatorState);
  const timestamp = session.updatedAt || session.createdAt;
  return (
  <div
    className={`meta-agent-child-item flex items-center gap-2 py-1.5 px-3 mr-2 mb-0.5 cursor-pointer rounded transition-colors duration-150 select-none ${
      isActive ? 'bg-[var(--nim-bg-selected)]' : 'hover:bg-[var(--nim-bg-hover)]'
    } focus:outline-2 focus:outline-[var(--nim-border-focus)] focus:outline-offset-[-2px]`}
    onClick={onSelect}
    onContextMenu={onContextMenu}
    role="button"
    tabIndex={0}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(e); } }}
    aria-label={`Session: ${session.title || 'Untitled Session'}.${operationalLabel ? ` Status: ${operationalLabel}.` : ''} Updated ${getRelativeTimeString(timestamp)}.`}
    aria-current={isActive ? 'page' : undefined}
  >
    <div className={`shrink-0 flex items-center justify-center ${
      isActive ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'
    }`}>
      <ProviderIcon provider={session.provider || 'claude-code'} size={14} />
    </div>
    <span className={`flex-1 text-xs text-[var(--nim-text)] whitespace-nowrap overflow-hidden text-ellipsis ${
      isActive ? 'font-medium' : ''
    }`}>
      {session.title || 'Untitled Session'}
    </span>
    <span className="shrink-0 text-[0.6875rem] text-[var(--nim-text-faint)] ml-2">
      <SessionRelativeTime sessionId={session.id} fallbackTimestamp={session.updatedAt || session.createdAt} />
    </span>
    <div className="shrink-0 flex items-center">
      <SessionOperationalIndicator sessionId={session.id} variant="child" />
    </div>
  </div>
  );
});

export const MetaAgentGroup: React.FC<MetaAgentGroupProps> = memo(({
  metaSession,
  childSessions,
  isExpanded,
  isActive,
  isSelected,
  onToggle,
  onMultiSelect,
  activeSessionId,
  onSessionSelect,
  onSessionArchive,
  onSessionUnarchive,
  onSessionDelete,
  onMetaSessionArchive,
  onMetaSessionUnarchive,
  onMetaSessionDelete,
  onSessionPinToggle,
  onSessionBranch,
  onWorktreeArchive,
}) => {
  const [contextMenuSession, setContextMenuSession] = useState<SessionMeta | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const groupKey = useMemo(
    () => JSON.stringify({
      parentId: metaSession.id,
      childIds: childSessions.map((session) => session.id).sort(),
    }),
    [metaSession.id, childSessions],
  );
  const groupIndicatorState = useAtomValue(groupIndicatorStateAtom(groupKey));
  const groupOperationalLabel = getSessionOperationalLabel(groupIndicatorState);

  const openContextMenu = useCallback((session: SessionMeta, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuSession(session);
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenuSession(null);
  }, []);

  const handleArchive = useCallback((session: SessionMeta) => {
    if (session.agentRole === 'meta-agent') {
      onMetaSessionArchive?.(session.id);
      return;
    }
    if (session.worktreeId && onWorktreeArchive) {
      onWorktreeArchive(session.worktreeId);
      return;
    }
    onSessionArchive?.(session.id);
  }, [onMetaSessionArchive, onSessionArchive, onWorktreeArchive]);

  const handleUnarchive = useCallback((session: SessionMeta) => {
    if (session.agentRole === 'meta-agent') {
      onMetaSessionUnarchive?.(session.id);
      return;
    }
    onSessionUnarchive?.(session.id);
  }, [onMetaSessionUnarchive, onSessionUnarchive]);

  const handleDelete = useCallback((session: SessionMeta) => {
    if (session.agentRole === 'meta-agent') {
      onMetaSessionDelete?.(session.id);
      return;
    }
    onSessionDelete?.(session.id);
  }, [onMetaSessionDelete, onSessionDelete]);

  return (
    <div data-testid="meta-agent-group" data-meta-session-id={metaSession.id}>
      {/* Group header */}
      <div
        className={`meta-agent-group-header flex items-center gap-1.5 py-1.5 px-2 mr-2 cursor-pointer rounded transition-colors duration-150 select-none ${
          isActive ? 'bg-[var(--nim-bg-selected)]' : isSelected ? 'bg-[var(--nim-bg-selected)]' : 'hover:bg-[var(--nim-bg-hover)]'
        }`}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) {
            onMultiSelect?.(e);
          } else {
            onSessionSelect(metaSession.id, e);
          }
        }}
        onContextMenu={(e) => openContextMenu(metaSession, e)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSessionSelect(metaSession.id, e);
          }
        }}
        aria-expanded={isExpanded}
        aria-label={`Meta Agent: ${metaSession.title || 'Meta Agent'}. ${childSessions.length} child session${childSessions.length === 1 ? '' : 's'}.${groupOperationalLabel ? ` Status: ${groupOperationalLabel}.` : ''}`}
        data-testid="meta-agent-group-header"
      >
        {/* Expand/collapse chevron */}
        <button
          className="shrink-0 flex items-center justify-center w-4 h-4 bg-transparent border-none text-[var(--nim-text-muted)] cursor-pointer p-0"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
        >
          <MaterialSymbol
            icon="chevron_right"
            size={14}
            className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
          />
        </button>

        {/* Hub icon */}
        <div className={`shrink-0 flex items-center justify-center ${
          isActive ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'
        }`}>
          <MaterialSymbol icon="hub" size={16} fill={isActive} />
        </div>

        {/* Title */}
        <span className={`flex-1 text-xs whitespace-nowrap overflow-hidden text-ellipsis ${
          isActive ? 'font-medium text-[var(--nim-text)]' : 'text-[var(--nim-text)]'
        }`}>
          {metaSession.title || 'Meta Agent'}
        </span>

        {/* Child count badge */}
        {childSessions.length > 0 && (
          <span className="shrink-0 text-[0.5625rem] px-1.5 py-[0.0625rem] rounded-[0.625rem] bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] font-medium">
            {childSessions.length}
          </span>
        )}

        {/* Timestamp */}
        <span className="shrink-0 text-[0.6875rem] text-[var(--nim-text-faint)]">
          <SessionRelativeTime sessionId={metaSession.id} fallbackTimestamp={metaSession.updatedAt || metaSession.createdAt} />
        </span>

        {/* Aggregate status */}
        <div className="shrink-0 flex items-center">
          <MetaAgentGroupStatus groupKey={groupKey} />
        </div>
      </div>

      {/* Child sessions */}
      {isExpanded && childSessions.length > 0 && (
        <div className="pl-5" data-testid="meta-agent-children">
          {childSessions.map((session) => (
            <MetaAgentChildRow
              key={session.id}
              session={session}
              isActive={activeSessionId === session.id}
              onSelect={(e) => onSessionSelect(session.id, e)}
              onContextMenu={(e) => openContextMenu(session, e)}
            />
          ))}
        </div>
      )}

      {contextMenuSession && (
        <SessionContextMenu
          sessionId={contextMenuSession.id}
          title={contextMenuSession.title || 'Untitled Session'}
          position={contextMenuPosition}
          onClose={closeContextMenu}
          isArchived={contextMenuSession.isArchived}
          isPinned={contextMenuSession.isPinned}
          phase={contextMenuSession.phase}
          parentSessionId={contextMenuSession.parentSessionId}
          onPinToggle={onSessionPinToggle ? (isPinned) => onSessionPinToggle(contextMenuSession.id, isPinned) : undefined}
          onBranch={contextMenuSession.agentRole === 'meta-agent' ? undefined : onSessionBranch ? () => onSessionBranch(contextMenuSession.id) : undefined}
          onArchive={!contextMenuSession.isArchived ? () => handleArchive(contextMenuSession) : undefined}
          onUnarchive={contextMenuSession.isArchived ? () => handleUnarchive(contextMenuSession) : undefined}
          onDelete={
            (contextMenuSession.agentRole === 'meta-agent' && onMetaSessionDelete)
            || (contextMenuSession.agentRole !== 'meta-agent' && onSessionDelete)
              ? () => handleDelete(contextMenuSession)
              : undefined
          }
        />
      )}
    </div>
  );
});
