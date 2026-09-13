/**
 * DocumentSessionControl - the editor header's AI-session affordance.
 *
 * Data source is `sessions:get-by-file` — the same `session_files` query the
 * old dropdown used, which already returns id, title, provider, updatedAt and
 * cross-worktree grouping. Nothing new is stored for this control.
 *
 * Two trigger states:
 * - Nothing has touched the file -> the original sparkle icon button.
 * - Otherwise -> a `SessionReferenceChip` for the most recent session, plus a
 *   caret. Clicking the chip opens that session; only the caret opens the menu,
 *   matching how the chip behaves everywhere else.
 *
 * The list loads on mount rather than on first open, because the chip has to
 * know the last session before the user clicks anything. That is one query per
 * open editor tab; the main-process handler caches, and tab counts are small.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { workspaceFileLinksRevisionAtom } from '../../store/atoms/sessionFiles';
import { ProviderIcon } from '@nimbalyst/runtime/ui/icons/ProviderIcons';
import { SessionReferenceChip } from '@nimbalyst/runtime/ui/AgentTranscript/session/SessionReferenceChip';
import { useFloatingMenu, FloatingPortal } from '../../hooks/useFloatingMenu';
import { isWorktreePath } from '../../../shared/pathUtils';

/** A row from `sessions:get-by-file`. */
export interface FileSession {
  id: string;
  title: string;
  provider: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  worktreeId?: string | null;
  isCurrentWorkspace?: boolean;
  lastFileEditAt?: number;
  fileAttribution?: 'inferred' | 'recorded';
}

/**
 * What a host lets the user do with this document's sessions. Supplied as one
 * bag so a host can't half-wire the control and leave inert rows behind.
 */
export interface DocumentSessionActions {
  /** Open an existing session in the chat panel beside this document. */
  openInChat?: (sessionId: string) => void;
  /** Open an existing session in Agent mode. */
  openInAgentMode?: (sessionId: string) => void;
  /** Start a new session about this document. */
  startNew?: () => void;
}

export interface DocumentSessionControlProps {
  filePath: string;
  workspaceId?: string;
  actions?: DocumentSessionActions;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

const GroupHeader: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="document-session-group-header px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--nim-text-faint)] bg-[var(--nim-bg-secondary)]">
    {children}
  </div>
);

const SessionRow: React.FC<{
  session: FileSession;
  isPrimary?: boolean;
  onClick?: () => void;
  onOpenInAgentMode?: () => void;
}> = ({ session, isPrimary, onClick, onOpenInAgentMode }) => (
  <div
    className={`document-session-row py-2 px-3 flex items-center gap-2 ${onClick ? 'cursor-pointer hover:bg-[var(--nim-bg-hover)]' : ''}`}
    data-testid="document-session-row"
    data-session-id={session.id}
    data-primary={isPrimary ? 'true' : undefined}
    onClick={onClick}
  >
    <span className="shrink-0 text-[var(--nim-text-muted)]"><ProviderIcon provider={session.provider} size={14} /></span>
    <div className="document-session-row-title text-sm font-medium whitespace-nowrap overflow-hidden text-ellipsis text-[var(--nim-text)] flex-1 min-w-0">
      {session.title}
    </div>
    {isPrimary && (
      <span className="document-session-row-current text-[10px] uppercase tracking-wider text-[var(--nim-text-faint)] shrink-0">
        Current
      </span>
    )}
    {session.fileAttribution === 'inferred' && (
      <span className="text-xs text-[var(--nim-text-faint)]" title="Inferred from a shell command and a file change during its execution. Other external writers may not be detected.">
        Inferred edit
      </span>
    )}
    <div className="document-session-row-time text-xs text-[var(--nim-text-faint)] shrink-0">{formatRelativeTime(session.lastFileEditAt ?? session.updatedAt)}</div>
    {onOpenInAgentMode && (
      <button
        className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-tertiary)] transition-colors duration-150 bg-transparent border-none cursor-pointer"
        title="Open in Agent mode"
        aria-label="Open in Agent mode"
        onClick={(e) => { e.stopPropagation(); onOpenInAgentMode(); }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      </button>
    )}
  </div>
);

export const DocumentSessionControl: React.FC<DocumentSessionControlProps> = ({
  filePath,
  workspaceId,
  actions,
}) => {
  const menu = useFloatingMenu({ placement: 'bottom-end' });
  const { isOpen, setIsOpen } = menu;

  const [sessions, setSessions] = useState<FileSession[]>([]);
  const [loading, setLoading] = useState(false);
  const fileLinksRevision = useAtomValue(workspaceFileLinksRevisionAtom(workspaceId ?? ''));

  useEffect(() => {
    if (!filePath || !workspaceId || !window.electronAPI) {
      setSessions([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    window.electronAPI
      .invoke('sessions:get-by-file', workspaceId, filePath)
      .then((result: FileSession[]) => {
        if (cancelled) return;
        setSessions(Array.isArray(result) ? result : []);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('[DocumentSessionControl] Failed to load sessions for file:', error);
        setSessions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [filePath, workspaceId, fileLinksRevision]);

  // The pill is "the last session that touched this file". The handler already
  // sorts current-workspace sessions first, which is not the same as most
  // recent, so pick by timestamp explicitly.
  const primarySession = useMemo(
    () => sessions.reduce<FileSession | undefined>(
      (latest, s) => (!latest || (s.lastFileEditAt ?? s.updatedAt) > (latest.lastFileEditAt ?? latest.updatedAt) ? s : latest),
      undefined,
    ),
    [sessions],
  );

  const openSession = useCallback((sessionId: string) => {
    setIsOpen(false);
    if (actions?.openInChat) actions.openInChat(sessionId);
    else actions?.openInAgentMode?.(sessionId);
  }, [actions, setIsOpen]);

  const openSessionInAgentMode = useCallback((sessionId: string) => {
    setIsOpen(false);
    actions?.openInAgentMode?.(sessionId);
  }, [actions, setIsOpen]);

  const startNewSession = useCallback(() => {
    setIsOpen(false);
    actions?.startNew?.();
  }, [actions, setIsOpen]);

  const canOpen = Boolean(actions?.openInChat || actions?.openInAgentMode);

  const isInWorktree = workspaceId ? isWorktreePath(workspaceId) : false;
  const currentWorkspaceSessions = useMemo(() => sessions.filter(s => s.isCurrentWorkspace), [sessions]);
  const otherSessions = useMemo(() => sessions.filter(s => !s.isCurrentWorkspace), [sessions]);
  const hasGroups = currentWorkspaceSessions.length > 0 && otherSessions.length > 0;

  const renderRows = (rows: FileSession[]) => rows.map((session) => (
    <SessionRow
      key={session.id}
      session={session}
      isPrimary={session.id === primarySession?.id}
      onClick={canOpen ? () => openSession(session.id) : undefined}
      onOpenInAgentMode={actions?.openInAgentMode ? () => openSessionInAgentMode(session.id) : undefined}
    />
  ));

  const caretButton = (
    <button
      type="button"
      ref={menu.refs.setReference}
      {...menu.getReferenceProps()}
      data-testid="document-session-caret"
      aria-label="AI sessions for this document"
      title="AI sessions for this document"
      className={`document-session-caret w-4 h-5 rounded-r border-none bg-transparent cursor-pointer flex items-center justify-center transition-colors duration-150 text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] ${
        isOpen ? 'text-[var(--nim-text)]' : ''
      }`}
      onClick={() => setIsOpen(!isOpen)}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );

  const trigger = primarySession ? (
    <div
      className="document-session-chip flex items-center gap-0.5 rounded-[10px] hover:bg-[var(--nim-bg-hover)] transition-colors duration-150"
      data-testid="document-session-chip"
      data-session-id={primarySession.id}
    >
      <SessionReferenceChip
        sessionId={primarySession.id}
        variant="compact"
        fallbackMeta={{ title: primarySession.title, provider: primarySession.provider }}
        onOpen={openSession}
      />
      {caretButton}
    </div>
  ) : (
    <button
      type="button"
      ref={menu.refs.setReference}
      {...menu.getReferenceProps()}
      data-testid="ai-sessions-button"
      className={`unified-header-button nim-btn-icon w-7 h-7 rounded border-none bg-transparent cursor-pointer flex items-center justify-center transition-all duration-150 text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] ${
        isOpen ? 'active bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)]' : ''
      }`}
      onClick={() => setIsOpen(!isOpen)}
      title="AI Sessions"
    >
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" opacity="0.8" />
        <path d="M14 16L18 12L20 14L16 18M14 16L16 18L10 24H8V22L14 16Z" opacity="0.8" />
      </svg>
    </button>
  );

  return (
    <div className="document-session-control relative flex items-center" data-testid="document-session-control">
      {trigger}

      {isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            data-testid="document-session-menu"
            className="document-session-menu min-w-[300px] max-w-[400px] overflow-y-auto rounded-md z-[1000] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
          >
            {loading ? (
              <div className="document-session-loading p-4 text-center text-[13px] text-[var(--nim-text-muted)]">
                Loading sessions...
              </div>
            ) : sessions.length > 0 ? (
              hasGroups ? (
                <>
                  <GroupHeader>{isInWorktree ? 'This worktree' : 'This project'}</GroupHeader>
                  {renderRows(currentWorkspaceSessions)}
                  <GroupHeader>Other sessions</GroupHeader>
                  {renderRows(otherSessions)}
                </>
              ) : (
                renderRows(sessions)
              )
            ) : (
              <div className="document-session-empty p-4 text-center text-[13px] text-[var(--nim-text-muted)]">
                No AI sessions have opened this file yet
              </div>
            )}

            {actions?.startNew && (
              <div className="document-session-start-container px-3 py-2.5 border-t border-[var(--nim-border)]">
                <button
                  type="button"
                  data-testid="document-session-new"
                  className="document-session-start-button w-full py-1.5 px-3 border border-[var(--nim-border)] rounded text-[13px] font-medium text-left cursor-pointer flex items-center gap-2 transition-all duration-150 text-[var(--nim-text-muted)] bg-transparent hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] hover:border-[var(--nim-primary)]"
                  onClick={startNewSession}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  Start new session on this file
                </button>
              </div>
            )}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
};
