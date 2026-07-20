/**
 * WorkstreamSessionTabs - Manages session tabs + displays active session panel.
 *
 * This component sits at the bottom of the workstream panel (below editor tabs).
 * It contains:
 * - SessionTabBar: horizontal tabs for all sessions in the workstream (always visible)
 * - AgentSessionPanel: the active session's content
 *
 * The tab bar is always shown - even for single sessions - so the user can see
 * which session is active and use the "+" button to add more sessions.
 */

import React, { useCallback, useState, useRef, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol, ProviderIcon } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { sessionArchivedAtom, sessionRegistryAtom } from '../../store/atoms/sessions';
import { AgentSessionPanel } from './AgentSessionPanel';
import {
  sessionTitleAtom,
  sessionProviderAtom,
  sessionProcessingAtom,
  sessionUnreadAtom,
  createChildSessionAtom,
} from '../../store';
import { defaultAgentModelAtom } from '../../store/atoms/appSettings';
import { convertToWorkstreamAtom } from '../../store/atoms/sessions';
import { workstreamHasChildrenAtom } from '../../store/atoms/workstreamState';
import { SessionContextMenu } from '../AgenticCoding/SessionContextMenu';
import type { SerializableDocumentContext } from '../../hooks/useDocumentContext';

export interface WorkstreamSessionTabsProps {
  workspacePath: string;
  workstreamId: string;
  sessions: string[]; // Array of session IDs
  activeSessionId: string | null;
  onSessionSelect: (sessionId: string) => void;
  onFileClick?: (filePath: string) => void;
  worktreeId?: string | null; // If set, this is a worktree session (add sessions to worktree, not convert to workstream)
  onAddSessionToWorktree?: (worktreeId: string) => Promise<void>; // Callback to add session to worktree
  onCreateWorktreeSession?: (worktreeId: string) => Promise<string | null>; // Callback to create session in worktree (returns session ID)
  onSessionArchive?: (sessionId: string) => void; // Callback to archive a session
  onSessionUnarchive?: (sessionId: string) => void; // Callback to unarchive a session
  onSessionRename?: (sessionId: string, newName: string) => void; // Callback to rename a session
  /** Static document context (scopes the "+ selection" chips to the active editor tab) */
  documentContext?: SerializableDocumentContext;
  /** Getter for document context from the workstream editor (for AI file/selection context) */
  getDocumentContext?: () => Promise<SerializableDocumentContext>;
  /** When true, collapse the transcript but keep tab bar and AI input visible */
  collapseTranscript?: boolean;
}

/**
 * Individual session tab - subscribes to atoms for isolated re-renders.
 */
const SessionTab: React.FC<{
  sessionId: string;
  isActive: boolean;
  onClick: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onRename?: (newName: string) => void;
}> = React.memo(({ sessionId, isActive, onClick, onArchive, onUnarchive, onRename }) => {
  const title = useAtomValue(sessionTitleAtom(sessionId));
  const provider = useAtomValue(sessionProviderAtom(sessionId));
  const isProcessing = useAtomValue(sessionProcessingAtom(sessionId));
  const hasUnread = useAtomValue(sessionUnreadAtom(sessionId));
  const isArchived = useAtomValue(sessionArchivedAtom(sessionId));

  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });

  // Rename state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  }, []);

  const handleRenameSubmit = useCallback(() => {
    const trimmedValue = renameValue.trim();
    if (trimmedValue && trimmedValue !== title && onRename) {
      onRename(trimmedValue);
    }
    setIsRenaming(false);
  }, [renameValue, title, onRename]);

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

  // Focus and select input when entering rename mode
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  return (
    <div className="relative">
      <button
        className={`session-tab flex items-center gap-1.5 px-2.5 py-[5px] border-none rounded text-xs font-medium cursor-pointer whitespace-nowrap transition-colors duration-150 ${
          isActive
            ? 'active bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)]'
            : 'bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]'
        } ${hasUnread ? 'unread' : ''} ${isArchived ? 'opacity-60' : ''}`}
        onClick={onClick}
        onContextMenu={handleContextMenu}
        title={title || 'Untitled'}
      >
        {isProcessing && (
          <span className="session-tab-processing-dot w-1.5 h-1.5 rounded-full bg-[var(--nim-primary)] animate-pulse" />
        )}
        <ProviderIcon
          provider={provider}
          size={14}
          className={`session-tab-icon shrink-0 ${isActive ? 'opacity-100' : 'opacity-80'}`}
        />
        {isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            className="session-tab-rename-input w-full max-w-[150px] px-1 py-0 text-xs font-medium border border-[var(--nim-primary)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] outline-none"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameSubmit}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className={`session-tab-title max-w-[150px] overflow-hidden text-ellipsis ${hasUnread ? 'font-semibold' : ''}`}>
            {title || 'Untitled'}
          </span>
        )}
        {hasUnread && !isRenaming && (
          <span className="session-tab-unread-dot w-1.5 h-1.5 rounded-full bg-[var(--nim-warning)]" />
        )}
      </button>

      {/* Context Menu */}
      {showContextMenu && (
        <SessionContextMenu
          sessionId={sessionId}
          title={title || 'Untitled'}
          position={contextMenuPosition}
          onClose={() => setShowContextMenu(false)}
          isArchived={isArchived}
          onRename={onRename ? () => { setRenameValue(title || ''); setIsRenaming(true); } : undefined}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
        />
      )}
    </div>
  );
});

SessionTab.displayName = 'SessionTab';

/**
 * Session tab bar - always shows session tabs + "+" button.
 * For single sessions, shows the session tab (so user can see what's selected).
 * For multi-session workstreams, shows all tabs.
 */
const SessionTabBar: React.FC<{
  sessions: string[];
  activeSessionId: string | null;
  onSessionSelect: (sessionId: string) => void;
  onNewSession: () => void;
  onSessionArchive?: (sessionId: string) => void;
  onSessionUnarchive?: (sessionId: string) => void;
  onSessionRename?: (sessionId: string, newName: string) => void;
}> = React.memo(({ sessions, activeSessionId, onSessionSelect, onNewSession, onSessionArchive, onSessionUnarchive, onSessionRename }) => {
  // Always show the tab bar - even for single sessions, the user should see their session tab
  return (
    <div className="session-tab-bar flex flex-wrap items-center gap-0.5 px-3 pt-1 pb-1.5 bg-[var(--nim-bg-secondary)] border-t-[3px] border-b border-[var(--nim-border)] shrink-0">
      {sessions.map((sessionId) => (
        <SessionTab
          key={sessionId}
          sessionId={sessionId}
          isActive={sessionId === activeSessionId}
          onClick={() => onSessionSelect(sessionId)}
          onArchive={onSessionArchive ? () => onSessionArchive(sessionId) : undefined}
          onUnarchive={onSessionUnarchive ? () => onSessionUnarchive(sessionId) : undefined}
          onRename={onSessionRename ? (newName) => onSessionRename(sessionId, newName) : undefined}
        />
      ))}
      <button
        className="session-tab-new nim-btn-icon-sm text-[var(--nim-text-faint)] hover:text-[var(--nim-text-muted)] active:bg-[var(--nim-bg-tertiary)]"
        onClick={onNewSession}
        title="New session in workstream"
      >
        <MaterialSymbol icon="add" size={16} />
      </button>
    </div>
  );
});

SessionTabBar.displayName = 'SessionTabBar';

/**
 * WorkstreamSessionTabs manages both the tab bar and the active session panel.
 */
export const WorkstreamSessionTabs: React.FC<WorkstreamSessionTabsProps> = React.memo(({
  workspacePath,
  workstreamId,
  sessions,
  activeSessionId,
  onSessionSelect,
  onFileClick,
  worktreeId,
  onAddSessionToWorktree,
  onCreateWorktreeSession,
  onSessionArchive,
  onSessionUnarchive,
  onSessionRename,
  documentContext,
  getDocumentContext,
  collapseTranscript = false,
}) => {
  const hasChildren = useAtomValue(workstreamHasChildrenAtom(workstreamId));
  const createChildSession = useSetAtom(createChildSessionAtom);
  const convertToWorkstream = useSetAtom(convertToWorkstreamAtom);
  const defaultModel = useAtomValue(defaultAgentModelAtom);

  // Handle creating a new child session
  const handleNewSession = useCallback(async () => {
    // If this is a worktree, use the callback to add a session to it
    if (worktreeId && onAddSessionToWorktree) {
      await onAddSessionToWorktree(worktreeId);
      return;
    }

    // Resolve the actual parent ID - if workstreamId is a child session, use its parent
    const registry = store.get(sessionRegistryAtom);
    const sessionMeta = registry.get(workstreamId);
    const resolvedParentId = sessionMeta?.parentSessionId || workstreamId;

    // Regular workstream logic
    if (hasChildren || resolvedParentId !== workstreamId) {
      // Already a workstream (has children, or we resolved to a parent) - create a child
      await createChildSession({
        parentSessionId: resolvedParentId,
        workspacePath,
        model: defaultModel,
      });
    } else {
      // Single session - convert to workstream first
      await convertToWorkstream({
        sessionId: workstreamId,
        workspacePath,
        model: defaultModel,
      });
    }
  }, [workstreamId, workspacePath, hasChildren, worktreeId, onAddSessionToWorktree, createChildSession, convertToWorkstream, defaultModel]);

  if (!activeSessionId) {
    return (
      <div className="workstream-session-tabs-empty flex items-center justify-center h-full text-[var(--nim-text-muted)] text-sm">
        <p>Loading sessions...</p>
      </div>
    );
  }

  return (
    <div className={`workstream-session-tabs flex flex-col overflow-hidden ${collapseTranscript ? '' : 'h-full'}`}>
      <SessionTabBar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSessionSelect={onSessionSelect}
        onNewSession={handleNewSession}
        onSessionArchive={onSessionArchive}
        onSessionUnarchive={onSessionUnarchive}
        onSessionRename={onSessionRename}
      />

      <div className={`workstream-session-tabs-content overflow-hidden ${collapseTranscript ? '' : 'flex-1 min-h-0'}`}>
        <AgentSessionPanel
          key={activeSessionId}
          sessionId={activeSessionId}
          workspacePath={workspacePath}
          onFileClick={onFileClick}
          onClearAgentSession={handleNewSession}
          onCreateWorktreeSession={onCreateWorktreeSession}
          documentContext={documentContext}
          getDocumentContext={getDocumentContext}
          collapseTranscript={collapseTranscript}
        />
      </div>
    </div>
  );
});

WorkstreamSessionTabs.displayName = 'WorkstreamSessionTabs';
