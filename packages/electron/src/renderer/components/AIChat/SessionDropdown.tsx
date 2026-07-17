import React, { useState } from 'react';
import { MaterialSymbol, ProviderIcon } from '@nimbalyst/runtime';
import { parseModelInfo, getProviderLabel } from '../../utils/modelUtils';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import { formatDate } from '@nimbalyst/runtime';
import { useFloatingMenu, FloatingPortal } from '../../hooks/useFloatingMenu';
import { SessionOperationalIndicator } from '../AgenticCoding/SessionOperationalIndicator';

// SessionDropdownItem extends SessionData with message count for display
type SessionDropdownItem = Pick<SessionData, 'id' | 'createdAt' | 'title' | 'provider' | 'model'> & {
  messageCount?: number;
};

interface SessionDropdownProps {
  currentSessionId: string | null;
  sessions: SessionDropdownItem[];
  onSessionSelect: (sessionId: string) => void;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, newName: string) => void;
  onOpenSessionManager?: () => void;
}

export function SessionDropdown({
  currentSessionId,
  sessions,
  onSessionSelect,
  onNewSession,
  onDeleteSession,
  onRenameSession,
  onOpenSessionManager
}: SessionDropdownProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const menu = useFloatingMenu({ placement: 'bottom-end' });

  const getCurrentSession = () => {
    if (!currentSessionId) return null;
    return sessions.find(s => s.id === currentSessionId) || null;
  };

  const getCurrentSessionName = () => {
    const session = getCurrentSession();
    if (!session) return 'New Session';
    if (session.title) return session.title;
    return formatDate(session.createdAt);
  };

  const formatSessionName = (session: SessionDropdownItem) => {
    if (session.title) return session.title;
    return formatDate(session.createdAt);
  };

  const handleRename = (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    setRenamingId(sessionId);
    setRenameValue(session?.title || formatSessionName(session!));
  };

  const submitRename = () => {
    if (renamingId && renameValue.trim() && onRenameSession) {
      onRenameSession(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      submitRename();
    } else if (e.key === 'Escape') {
      setRenamingId(null);
      setRenameValue('');
    }
  };

  return (
    <div className="session-dropdown relative">
      <button
        ref={menu.refs.setReference}
        {...menu.getReferenceProps()}
        className="session-dropdown-trigger flex items-center gap-1 px-2 py-1.5 bg-transparent border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] text-[13px] cursor-pointer transition-all duration-200 h-8 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-border-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={() => menu.setIsOpen(!menu.isOpen)}
        title="Session History"
      >
        {currentSessionId && <SessionOperationalIndicator sessionId={currentSessionId} variant="dropdown" />}
        <ProviderIcon provider={getCurrentSession()?.provider || 'claude'} size={16} />
        <span className="session-dropdown-name overflow-hidden text-ellipsis whitespace-nowrap max-w-[200px]">{getCurrentSessionName()}</span>
        <MaterialSymbol
          icon="expand_more"
          size={16}
          className={`session-dropdown-arrow shrink-0 transition-transform duration-200 ${menu.isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            className="session-dropdown-menu min-w-[280px] max-w-[400px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.1)] z-[10000] overflow-hidden"
          >
            {onOpenSessionManager && (
              <button
                className="session-dropdown-all-sessions flex items-center gap-2 w-full px-3 py-2 bg-transparent border-none text-[var(--nim-text)] text-[13px] cursor-pointer transition-colors duration-200 text-left hover:bg-[var(--nim-bg-hover)]"
                onClick={() => {
                  onOpenSessionManager();
                  menu.setIsOpen(false);
                }}
              >
                <MaterialSymbol icon="folder_open" size={16} />
                <span>All Sessions</span>
              </button>
            )}
            {sessions.length > 0 && (
              <div className="session-dropdown-divider h-px bg-[var(--nim-border)] my-1" />
            )}
            <div className="session-dropdown-sessions max-h-[300px] overflow-y-auto">
              {sessions.map(session => (
                    <div
                      key={session.id}
                      className={`session-dropdown-item flex items-center justify-between px-3 py-2.5 border-none text-[var(--nim-text)] text-[13px] cursor-pointer transition-colors duration-200 w-full text-left hover:bg-[var(--nim-bg-hover)] ${session.id === currentSessionId ? 'active bg-[var(--nim-bg-selected)] font-medium' : ''}`}
                    >
                      {renamingId === session.id ? (
                        <input
                          type="text"
                          className="session-rename-input flex-1 px-1.5 py-1 border border-[var(--nim-primary)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] text-[13px] outline-none"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={submitRename}
                          onKeyDown={handleKeyDown}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <div
                          className="session-info flex-1 flex flex-col gap-0.5 min-w-0"
                          onClick={() => {
                            onSessionSelect(session.id);
                            menu.setIsOpen(false);
                          }}
                        >
                          <div className="session-name-row flex items-center gap-1.5">
                            <SessionOperationalIndicator sessionId={session.id} variant="dropdown" />
                            <span className="session-name overflow-hidden text-ellipsis whitespace-nowrap">{formatSessionName(session)}</span>
                            {session.provider && session.provider !== 'claude-code' && (
                              <span className={`session-provider-badge provider-${session.provider} inline-flex items-center px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide shrink-0`}>
                                {getProviderLabel(session.provider)}
                              </span>
                            )}
                            {session.model && (
                              <span className="session-model-badge inline-flex items-center px-1.5 py-px rounded text-[10px] font-medium bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] shrink-0">
                                {parseModelInfo(session.model)?.shortModelName}
                              </span>
                            )}
                          </div>
                          {session.messageCount !== undefined && session.messageCount > 0 && (
                            <span className="session-message-count text-[11px] text-[var(--nim-text-muted)]">{session.messageCount} turns</span>
                          )}
                        </div>
                      )}

                      <div className="session-actions flex gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100 [.session-dropdown-item:hover_&]:opacity-100">
                        {onRenameSession && (
                          <button
                            className="session-action-btn nim-btn-icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRename(session.id);
                            }}
                            title="Rename"
                          >
                            <MaterialSymbol icon="edit" size={14} />
                          </button>
                        )}
                        <button
                          className="session-action-btn delete nim-btn-icon hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-error)]"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm('Delete this session?')) {
                              onDeleteSession(session.id);
                            }
                          }}
                          title="Delete"
                        >
                          <MaterialSymbol icon="delete" size={14} />
                        </button>
                      </div>
                    </div>
              ))}
            </div>
            {sessions.length === 0 && (
              <div className="session-dropdown-empty p-5 text-center text-[var(--nim-text-muted)] text-[13px]">
                <span>No sessions yet</span>
              </div>
            )}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
