import React, { useCallback, useEffect, useState } from 'react';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import { getFileName } from '../../utils/pathUtils';
import type { TokenUsageCategory } from '@nimbalyst/runtime/ai/server/types';

interface SessionToImport {
  sessionId: string;
  workspacePath: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    categories?: TokenUsageCategory[];
  };
  syncStatus: 'new' | 'up-to-date' | 'needs-update';
  selected: boolean;
}

interface SessionsByWorkspace {
  [workspacePath: string]: SessionToImport[];
}

interface SessionImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (sessionIds: string[]) => Promise<void>;
  currentWorkspacePath: string;
  filterByWorkspace?: boolean; // If true, only show sessions for current workspace
}

export const SessionImportDialog: React.FC<SessionImportDialogProps> = ({
  isOpen,
  onClose,
  onImport,
  currentWorkspacePath,
  filterByWorkspace = true  // Default to filtering by current workspace
}) => {
  const [sessions, setSessions] = useState<SessionToImport[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopeNotice, setScopeNotice] = useState<string | null>(null);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  // Load sessions when dialog opens
  useEffect(() => {
    if (isOpen) {
      loadSessions();
    }
  }, [isOpen]);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    setScopeNotice(null);

    try {
      const scanSessions = async (workspacePath?: string) => {
        return window.electronAPI.invoke('claude-code:scan-sessions', { workspacePath });
      };

      // Prefer the current workspace for performance, but do not fail closed if
      // Claude stored the sessions under a sibling worktree, nested package
      // workspace, or a differently-resolved path.
      let result = await scanSessions(filterByWorkspace ? currentWorkspacePath : undefined);

      if (
        filterByWorkspace &&
        result.success &&
        Array.isArray(result.sessions) &&
        result.sessions.length === 0
      ) {
        result = await scanSessions();
        if (result.success && Array.isArray(result.sessions) && result.sessions.length > 0) {
          setScopeNotice('No sessions matched this exact workspace path. Showing all Claude Agent sessions instead.');
        }
      }

      if (result.success && Array.isArray(result.sessions)) {
        // Auto-select new and needs-update sessions
        const sessionsWithSelection = result.sessions.map((s: any) => ({
          ...s,
          selected: s.syncStatus === 'new' || s.syncStatus === 'needs-update',
        }));
        setSessions(sessionsWithSelection);

        const workspacePaths: string[] = Array.from(
          new Set(
            sessionsWithSelection.map((session: SessionToImport) => session.workspacePath)
          )
        );
        const initialExpanded = new Set<string>();
        if (workspacePaths.includes(currentWorkspacePath)) {
          initialExpanded.add(currentWorkspacePath);
        } else if (workspacePaths.length > 0) {
          initialExpanded.add(workspacePaths[0]);
        }
        setExpandedWorkspaces(initialExpanded);
      } else {
        setError(result.error || 'Failed to load sessions');
      }
    } catch (err) {
      console.error('[SessionImportDialog] Failed to load sessions:', err);
      setError('Failed to load sessions');
    } finally {
      setLoading(false);
    }
  }, [currentWorkspacePath, filterByWorkspace]);

  const handleImport = async () => {
    const selectedSessionIds = sessions
      .filter(s => s.selected)
      .map(s => s.sessionId);

    if (selectedSessionIds.length === 0) {
      return;
    }

    setImporting(true);
    setError(null);

    try {
      await onImport(selectedSessionIds);
      onClose();
    } catch (err) {
      console.error('[SessionImportDialog] Failed to import sessions:', err);
      setError('Failed to import sessions');
    } finally {
      setImporting(false);
    }
  };

  const toggleSession = (sessionId: string) => {
    setSessions(prev =>
      prev.map(s => (s.sessionId === sessionId ? { ...s, selected: !s.selected } : s))
    );
  };

  const toggleWorkspace = (workspacePath: string) => {
    const workspaceSessions = sessions.filter(s => s.workspacePath === workspacePath);
    const allSelected = workspaceSessions.every(s => s.selected);

    setSessions(prev =>
      prev.map(s =>
        s.workspacePath === workspacePath ? { ...s, selected: !allSelected } : s
      )
    );
  };

  const toggleExpandWorkspace = (workspacePath: string) => {
    setExpandedWorkspaces(prev => {
      const next = new Set(prev);
      if (next.has(workspacePath)) {
        next.delete(workspacePath);
      } else {
        next.add(workspacePath);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSessions(prev => prev.map(s => ({ ...s, selected: true })));
  };

  const deselectAll = () => {
    setSessions(prev => prev.map(s => ({ ...s, selected: false })));
  };

  // Filter sessions by search query
  const filteredSessions = sessions.filter(session => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return session.title.toLowerCase().includes(query);
  });

  // Group sessions by workspace and sort by updatedAt (most recent first)
  const sessionsByWorkspace: SessionsByWorkspace = filteredSessions.reduce((acc, session) => {
    if (!acc[session.workspacePath]) {
      acc[session.workspacePath] = [];
    }
    acc[session.workspacePath].push(session);
    return acc;
  }, {} as SessionsByWorkspace);

  // Sort sessions within each workspace by updatedAt (most recent first)
  Object.keys(sessionsByWorkspace).forEach(workspace => {
    sessionsByWorkspace[workspace].sort((a, b) => b.updatedAt - a.updatedAt);
  });

  const workspacePaths = Object.keys(sessionsByWorkspace).sort();

  // Count stats
  const totalSessions = sessions.length;
  const newSessions = sessions.filter(s => s.syncStatus === 'new').length;
  const needsUpdate = sessions.filter(s => s.syncStatus === 'needs-update').length;
  const inSync = sessions.filter(s => s.syncStatus === 'up-to-date').length;
  const selectedCount = sessions.filter(s => s.selected).length;

  if (!isOpen) {
    return null;
  }

  return (
    <div className="session-import-dialog-overlay nim-overlay" onClick={onClose}>
      <div
        className="session-import-dialog flex flex-col w-[90%] max-w-[900px] max-h-[85vh] rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg)] shadow-[0_8px_32px_rgba(0,0,0,0.3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="session-import-dialog-header flex items-center justify-between px-5 py-4 border-b border-[var(--nim-border)]">
          <h2 className="m-0 text-base font-semibold text-[var(--nim-text)]">Import Claude Agent Sessions</h2>
          <button
            className="session-import-dialog-close bg-transparent border-none text-[var(--nim-text-muted)] cursor-pointer p-1 flex items-center justify-center rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 4L4 12M4 4L12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="session-import-dialog-loading py-10 px-5 text-center text-[var(--nim-text-muted)]">
            <p>Scanning ~/.claude/projects/...</p>
          </div>
        ) : error ? (
          <div className="session-import-dialog-error py-10 px-5 text-center text-[var(--nim-text-muted)]">
            <p>{error}</p>
            <button
              className="mt-3 px-4 py-2 bg-[var(--nim-primary)] text-white border-none rounded cursor-pointer"
              onClick={loadSessions}
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <div className="session-import-dialog-stats flex gap-4 px-5 py-4 border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
              <div className="session-import-stat flex flex-col items-center gap-1">
                <span className="session-import-stat-value text-lg font-semibold text-[var(--nim-text)]">{totalSessions}</span>
                <span className="session-import-stat-label text-[11px] text-[var(--nim-text-faint)] uppercase tracking-[0.5px]">Total</span>
              </div>
              <div className="session-import-stat flex flex-col items-center gap-1">
                <span className="session-import-stat-value text-lg font-semibold text-[var(--nim-text)]">{newSessions}</span>
                <span className="session-import-stat-label text-[11px] text-[var(--nim-text-faint)] uppercase tracking-[0.5px]">New</span>
              </div>
              <div className="session-import-stat flex flex-col items-center gap-1">
                <span className="session-import-stat-value text-lg font-semibold text-[var(--nim-text)]">{needsUpdate}</span>
                <span className="session-import-stat-label text-[11px] text-[var(--nim-text-faint)] uppercase tracking-[0.5px]">Updates</span>
              </div>
              <div className="session-import-stat flex flex-col items-center gap-1">
                <span className="session-import-stat-value text-lg font-semibold text-[var(--nim-text)]">{inSync}</span>
                <span className="session-import-stat-label text-[11px] text-[var(--nim-text-faint)] uppercase tracking-[0.5px]">In Sync</span>
              </div>
            </div>

            <div className="session-import-dialog-search px-5 py-3 border-b border-[var(--nim-border)]">
              <input
                type="text"
                className="session-import-search-input nim-input text-sm"
                placeholder="Search sessions by title..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            {scopeNotice && (
              <div className="session-import-scope-notice px-5 py-2.5 border-b border-[var(--nim-border)] bg-[rgba(59,130,246,0.08)] text-[13px] text-[var(--nim-text-muted)]">
                {scopeNotice}
              </div>
            )}

            <div className="session-import-dialog-actions flex gap-2 px-5 py-3 border-b border-[var(--nim-border)]">
              <button
                onClick={selectAll}
                className="session-import-action-button px-3 py-1.5 text-[13px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              >
                Select All
              </button>
              <button
                onClick={deselectAll}
                className="session-import-action-button px-3 py-1.5 text-[13px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              >
                Deselect All
              </button>
            </div>

            <div className="session-import-dialog-content flex-1 overflow-y-auto py-3">
              {workspacePaths.length === 0 ? (
                <div className="session-import-empty py-10 px-5 text-center text-[var(--nim-text-muted)]">
                  <p>No Claude Agent sessions found</p>
                  <p className="session-import-empty-hint text-[13px] mt-2 text-[var(--nim-text-faint)]">
                    Sessions from the CLI will appear here
                  </p>
                </div>
              ) : (
                workspacePaths.map(workspacePath => {
                  const workspaceSessions = sessionsByWorkspace[workspacePath];
                  const isExpanded = expandedWorkspaces.has(workspacePath);
                  const workspaceName = getFileName(workspacePath) || workspacePath;
                  const allSelected = workspaceSessions.every(s => s.selected);
                  const someSelected = workspaceSessions.some(s => s.selected);

                  return (
                    <div key={workspacePath} className="session-import-workspace-group m-0">
                      <div className="session-import-workspace-header flex items-center gap-2 px-5 py-2.5 bg-[var(--nim-bg-secondary)] border-t border-[var(--nim-border)] cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]">
                        <button
                          className="session-import-workspace-toggle bg-transparent border-none text-[var(--nim-text-muted)] cursor-pointer p-0 flex items-center justify-center"
                          onClick={() => toggleExpandWorkspace(workspacePath)}
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            className="transition-transform duration-200"
                            style={{ transform: isExpanded ? 'rotate(90deg)' : 'none' }}
                          >
                            <path d="M6 12L10 8L6 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={input => {
                            if (input) {
                              input.indeterminate = someSelected && !allSelected;
                            }
                          }}
                          onChange={() => toggleWorkspace(workspacePath)}
                          aria-label={`Select all sessions in ${workspaceName}`}
                        />
                        <span className="session-import-workspace-name flex-1 font-medium text-[var(--nim-text)] text-sm">{workspaceName}</span>
                        <span className="session-import-workspace-count text-xs text-[var(--nim-text-faint)]">
                          ({workspaceSessions.length})
                        </span>
                      </div>

                      {isExpanded && (
                        <div className="session-import-session-list p-0">
                          {workspaceSessions.map(session => (
                            <div
                              key={session.sessionId}
                              data-id={session.sessionId}
                              className="session-import-session-item flex items-start gap-2.5 py-3 pr-5 pl-[50px] border-t border-[var(--nim-border)] transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
                            >
                              <input
                                type="checkbox"
                                checked={session.selected}
                                onChange={() => toggleSession(session.sessionId)}
                                aria-label={`Select ${session.title}`}
                                className="mt-0.5 cursor-pointer"
                              />
                              <div className="session-import-session-info flex-1 min-w-0">
                                <div className="session-import-session-title text-sm text-[var(--nim-text)] font-medium mb-1">{session.title}</div>
                                <div className="session-import-session-meta text-xs text-[var(--nim-text-muted)] flex items-center gap-1.5">
                                  <span>{getRelativeTimeString(session.updatedAt)}</span>
                                  <span>•</span>
                                  <span>{session.messageCount} messages</span>
                                  <span>•</span>
                                  <span>{session.tokenUsage.totalTokens.toLocaleString()} tokens</span>
                                  <span>•</span>
                                  <span
                                    className={`session-import-status-badge px-1.5 py-0.5 rounded text-[11px] font-medium ${
                                      session.syncStatus === 'new'
                                        ? 'bg-[rgba(76,175,80,0.15)] text-[rgb(76,175,80)]'
                                        : session.syncStatus === 'needs-update'
                                          ? 'bg-[rgba(255,152,0,0.15)] text-[rgb(255,152,0)]'
                                          : 'bg-[rgba(158,158,158,0.15)] text-[rgb(158,158,158)]'
                                    }`}
                                  >
                                    {session.syncStatus === 'new' && 'New'}
                                    {session.syncStatus === 'up-to-date' && 'In Sync'}
                                    {session.syncStatus === 'needs-update' && 'Has Updates'}
                                  </span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className="session-import-dialog-footer flex gap-2 justify-end px-5 py-4 border-t border-[var(--nim-border)]">
              <button
                className="session-import-button-secondary nim-btn-secondary"
                onClick={onClose}
                disabled={importing}
              >
                Cancel
              </button>
              <button
                className="session-import-button-primary nim-btn-primary"
                onClick={handleImport}
                disabled={importing || selectedCount === 0}
              >
                {importing ? 'Importing...' : `Import ${selectedCount} Session${selectedCount !== 1 ? 's' : ''}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
