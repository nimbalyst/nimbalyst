import React, { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ProviderIcon, MaterialSymbol } from '@nimbalyst/runtime';
import { getRelativeTimeString } from '../utils/dateFormatting';
import { sessionOrChildProcessingAtom, sessionUnreadAtom, sessionPendingPromptAtom } from '../store';
import { fileMentionOptionsAtom, searchFileMentionAtom } from '../store/atoms/fileMention';
import type { TypeaheadOption } from './Typeahead/GenericTypeahead';
import { KeyboardShortcuts, getShortcutDisplay } from '../../shared/KeyboardShortcuts';

import type { SessionMeta as SessionItem } from '../store';

/**
 * Status indicator that shows processing, pending prompt, or unread status.
 * Only re-renders when this session's state changes.
 */
const SessionStatusIndicator = memo<{ sessionId: string }>(({ sessionId }) => {
  const isProcessing = useAtomValue(sessionOrChildProcessingAtom(sessionId));
  const hasPendingPrompt = useAtomValue(sessionPendingPromptAtom(sessionId));
  const hasUnread = useAtomValue(sessionUnreadAtom(sessionId));

  // Priority: processing > pending prompt > unread
  if (isProcessing) {
    return (
      <div
        className="session-quick-open-status processing flex items-center justify-center w-5 h-5 text-[var(--nim-primary)] opacity-80"
        title="Processing..."
      >
        <MaterialSymbol icon="progress_activity" size={14} className="animate-spin" />
      </div>
    );
  }

  if (hasPendingPrompt) {
    return (
      <div
        className="session-quick-open-status pending-prompt flex items-center justify-center w-5 h-5 text-[var(--nim-warning)] animate-pulse"
        title="Waiting for your response"
      >
        <MaterialSymbol icon="help" size={14} />
      </div>
    );
  }

  if (hasUnread) {
    return (
      <div
        className="session-quick-open-status unread flex items-center justify-center w-5 h-5 text-[var(--nim-primary)]"
        title="Unread response"
      >
        <MaterialSymbol icon="circle" size={8} fill />
      </div>
    );
  }

  return null;
});

interface SessionQuickOpenProps {
  isOpen: boolean;
  onClose: () => void;
  workspacePath: string;
  onSessionSelect: (sessionId: string) => void;
  /** Pre-fill the search input when the modal opens (e.g. from File Quick Open or Cmd+Shift+L) */
  initialSearchQuery?: string;
  /** Callback to switch to Prompt Quick Open with the current search text */
  onSwitchToPrompts?: (query: string) => void;
}

export const SessionQuickOpen: React.FC<SessionQuickOpenProps> = ({
  isOpen,
  onClose,
  workspacePath,
  onSessionSelect,
  initialSearchQuery,
  onSwitchToPrompts,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [allSessions, setAllSessions] = useState<SessionItem[]>([]);
  const [mouseHasMoved, setMouseHasMoved] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultsListRef = useRef<HTMLUListElement>(null);

  // @ file search state
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileFilteredSessionIds, setFileFilteredSessionIds] = useState<string[] | null>(null);
  const [typeaheadIndex, setTypeaheadIndex] = useState(0);
  const searchDebounceRef = useRef<NodeJS.Timeout>();

  // Detect @ file search mode
  const isFileSearchMode = searchQuery.startsWith('@');
  const fileSearchQuery = isFileSearchMode ? searchQuery.slice(1) : '';
  const showTypeahead = isFileSearchMode && !selectedFilePath;

  // Subscribe to file mention typeahead options
  const fileOptions = useAtomValue(fileMentionOptionsAtom(workspacePath));
  const searchFileMention = useSetAtom(searchFileMentionAtom);

  // Update file mention search when in typeahead mode
  useEffect(() => {
    if (!isOpen || !showTypeahead) return;

    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }
    searchDebounceRef.current = setTimeout(() => {
      searchFileMention({ workspacePath, query: fileSearchQuery });
    }, 150);

    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
    };
  }, [isOpen, showTypeahead, fileSearchQuery, workspacePath]);

  // Query sessions by file when a file is selected
  useEffect(() => {
    if (!isOpen || !isFileSearchMode || !selectedFilePath) {
      setFileFilteredSessionIds(null);
      return;
    }

    // Convert relative path to absolute for the IPC call
    const absolutePath = selectedFilePath.startsWith('/')
      ? selectedFilePath
      : `${workspacePath}/${selectedFilePath}`;

    window.electronAPI.invoke('session-files:get-sessions-by-file', workspacePath, absolutePath, 'edited')
      .then((result: { success: boolean; sessionIds: string[] }) => {
        if (result.success) {
          setFileFilteredSessionIds(result.sessionIds);
        } else {
          setFileFilteredSessionIds([]);
        }
      })
      .catch(() => {
        setFileFilteredSessionIds([]);
      });
  }, [isOpen, isFileSearchMode, selectedFilePath, workspacePath]);

  // Handle typeahead file selection
  const handleFileTypeaheadSelect = useCallback((option: TypeaheadOption) => {
    const filePath = (option.data as any)?.path || option.label;
    setSelectedFilePath(filePath);
    setSearchQuery(`@${filePath}`);
    setSelectedIndex(0);
  }, []);

  // Filter sessions: either by file (@ mode) or by title (normal mode)
  const displaySessions = useMemo(() => {
    // File search mode with selected file -- filter by session IDs
    if (isFileSearchMode && selectedFilePath && fileFilteredSessionIds !== null) {
      return allSessions.filter(s => fileFilteredSessionIds.includes(s.id));
    }

    // File search mode but still in typeahead -- show all sessions (typeahead is on top)
    if (isFileSearchMode) {
      return allSessions;
    }

    // Normal title search
    if (!searchQuery.trim()) {
      return allSessions;
    }
    const query = searchQuery.toLowerCase();
    return allSessions.filter(session =>
      (session.title || 'New conversation').toLowerCase().includes(query)
    );
  }, [searchQuery, allSessions, isFileSearchMode, selectedFilePath, fileFilteredSessionIds]);

  // Load all sessions when modal opens
  useEffect(() => {
    if (isOpen && workspacePath) {
      window.electronAPI.invoke('sessions:list', workspacePath, { includeArchived: false })
        .then((result: { success: boolean; sessions: SessionItem[] }) => {
          // console.log('[SessionQuickOpen] sessions:list returned', result.sessions?.length, 'sessions');
          const sessionsWithParent = result.sessions?.filter(s => s.parentSessionId);
          // console.log('[SessionQuickOpen] Sessions with parentSessionId:', sessionsWithParent?.length, sessionsWithParent?.map(s => ({ id: s.id, title: s.title, parent: s.parentSessionId })));
          if (result.success && Array.isArray(result.sessions)) {
            setAllSessions(result.sessions);
          } else {
            setAllSessions([]);
          }
        })
        .catch((error: Error) => {
          console.error('[SessionQuickOpen] Failed to load sessions:', error);
          setAllSessions([]);
        });
    }
  }, [isOpen, workspacePath]);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      const query = initialSearchQuery || '';
      setSearchQuery(query);
      setSelectedIndex(0);
      setMouseHasMoved(false);
      setTypeaheadIndex(0);
      // If initialSearchQuery is an @ query with a full path, set it as selected
      if (query.startsWith('@') && query.length > 1) {
        setSelectedFilePath(query.slice(1));
      } else {
        setSelectedFilePath(null);
      }
      setFileFilteredSessionIds(null);
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Track mouse movement to distinguish between mouse hover and mouse at rest
  useEffect(() => {
    if (!isOpen) return;

    const handleMouseMove = () => {
      setMouseHasMoved(true);
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [isOpen]);

  // Scroll selected item into view
  useEffect(() => {
    if (!resultsListRef.current) return;

    const items = resultsListRef.current.querySelectorAll('.session-quick-open-item');
    const selectedItem = items[selectedIndex] as HTMLElement;

    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // When typeahead is showing, override arrow/enter to navigate the dropdown
      if (showTypeahead && fileOptions.length > 0) {
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            setTypeaheadIndex(prev =>
              prev < fileOptions.length - 1 ? prev + 1 : prev
            );
            return;
          case 'ArrowUp':
            e.preventDefault();
            setTypeaheadIndex(prev => prev > 0 ? prev - 1 : prev);
            return;
          case 'Enter':
            e.preventDefault();
            if (fileOptions[typeaheadIndex]) {
              handleFileTypeaheadSelect(fileOptions[typeaheadIndex]);
            }
            return;
          case 'Escape':
            e.preventDefault();
            // Clear the @ search and go back to normal mode
            setSearchQuery('');
            setSelectedFilePath(null);
            return;
        }
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev =>
            prev < displaySessions.length - 1 ? prev + 1 : prev
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => prev > 0 ? prev - 1 : prev);
          break;
        case 'Enter':
          e.preventDefault();
          if (displaySessions[selectedIndex]) {
            handleSessionSelect(displaySessions[selectedIndex].id);
          }
          break;
        case 'Tab':
          e.preventDefault();
          if (searchQuery && onSwitchToPrompts && !isFileSearchMode) {
            onSwitchToPrompts(searchQuery);
          }
          break;
        case 'Escape':
          e.preventDefault();
          if (isFileSearchMode && selectedFilePath) {
            // Clear file filter, go back to normal mode
            setSearchQuery('');
            setSelectedFilePath(null);
            setFileFilteredSessionIds(null);
          } else {
            onClose();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, displaySessions, onClose, searchQuery, onSwitchToPrompts, showTypeahead, fileOptions, typeaheadIndex, handleFileTypeaheadSelect, isFileSearchMode, selectedFilePath]);

  const handleSessionSelect = (sessionId: string) => {
    // Pass the session ID to the parent handler
    // The AgentMode component will handle loading the session and determining
    // if it's a child session that needs to open its parent workstream
    onSessionSelect(sessionId);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="session-quick-open-backdrop fixed inset-0 bg-black/50 z-[99998] nim-animate-fade-in"
        onClick={onClose}
      />
      <div className="session-quick-open-modal fixed top-[20%] left-1/2 -translate-x-1/2 w-[90%] max-w-[600px] max-h-[60vh] flex flex-col overflow-hidden rounded-lg z-[99999] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_20px_60px_rgba(0,0,0,0.3)]">
        <div className="session-quick-open-header p-3 border-b border-[var(--nim-border)]">
          <div className="text-[11px] font-medium text-[var(--nim-text-faint)] uppercase tracking-wide mb-2">Sessions</div>
          <div className="relative">
            {isFileSearchMode && selectedFilePath ? (
              <div className="session-quick-open-search flex items-center gap-2 w-full py-2 px-3 text-base rounded-md box-border bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] focus-within:border-[#007aff] focus-within:shadow-[0_0_0_3px_rgba(0,122,255,0.1)]">
                <span
                  className="shrink-0 flex items-center gap-1.5 max-w-[80%] px-2 py-0.5 rounded bg-[rgba(0,122,255,0.1)] text-[var(--nim-primary)] text-sm cursor-default"
                  title={selectedFilePath}
                >
                  <MaterialSymbol icon="description" size={14} className="shrink-0" />
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap direction-rtl text-left">
                    {selectedFilePath}
                  </span>
                  <button
                    className="shrink-0 flex items-center justify-center w-4 h-4 rounded-full border-none bg-transparent text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-tertiary)] cursor-pointer p-0"
                    onClick={() => {
                      setSearchQuery('');
                      setSelectedFilePath(null);
                      setFileFilteredSessionIds(null);
                      setTimeout(() => searchInputRef.current?.focus(), 0);
                    }}
                    title="Clear file filter"
                  >
                    <MaterialSymbol icon="close" size={12} />
                  </button>
                </span>
                <input
                  ref={searchInputRef}
                  type="text"
                  className="flex-1 min-w-0 bg-transparent border-none outline-none text-[var(--nim-text)] text-sm p-0"
                  placeholder="Filter sessions..."
                  value=""
                  readOnly
                />
              </div>
            ) : (
              <>
                <input
                  ref={searchInputRef}
                  type="text"
                  className="session-quick-open-search w-full py-2 px-3 text-base rounded-md outline-none box-border bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] focus:border-[#007aff] focus:shadow-[0_0_0_3px_rgba(0,122,255,0.1)]"
                  placeholder="Search sessions... (@ to search by file edited)"
                  value={searchQuery}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSearchQuery(val);
                    setSelectedIndex(0);
                    // If user edits away from the confirmed file path, clear the selection
                    if (selectedFilePath && val !== `@${selectedFilePath}`) {
                      setSelectedFilePath(null);
                      setFileFilteredSessionIds(null);
                    }
                    // Reset typeahead index when typing
                    if (val.startsWith('@')) {
                      setTypeaheadIndex(0);
                    }
                  }}
                />
                {searchQuery && onSwitchToPrompts && !isFileSearchMode && (
                  <button
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs flex items-center gap-1 px-2 py-1 rounded cursor-pointer border-none transition-colors duration-150 bg-transparent text-[var(--nim-text-faint)] hover:bg-[var(--nim-accent-subtle)] hover:text-[var(--nim-primary)]"
                    onClick={() => onSwitchToPrompts(searchQuery)}
                    title="Search in prompts"
                  >
                    <kbd className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-[var(--nim-bg)] border border-[var(--nim-border)] text-[var(--nim-text)]">Tab</kbd>
                    Search prompts
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        <div className="session-quick-open-results flex-1 overflow-y-auto min-h-[200px]">
          {/* File typeahead dropdown */}
          {showTypeahead && (
            <ul className="session-quick-open-typeahead list-none m-0 p-0">
              {fileOptions.length === 0 ? (
                <li className="py-6 px-4 text-center text-[var(--nim-text-faint)] text-sm">
                  {fileSearchQuery ? 'No files found' : 'Type to search files...'}
                </li>
              ) : (
                fileOptions.slice(0, 20).map((option, index) => (
                  <li
                    key={option.id}
                    className={`flex items-center gap-3 py-2 px-4 cursor-pointer transition-all duration-100 hover:bg-[var(--nim-bg-hover)] ${
                      index === typeaheadIndex ? 'bg-[rgba(0,122,255,0.1)]' : ''
                    }`}
                    onClick={() => handleFileTypeaheadSelect(option)}
                    onMouseEnter={() => {
                      if (mouseHasMoved) {
                        setTypeaheadIndex(index);
                      }
                    }}
                  >
                    <span className="shrink-0 flex items-center justify-center w-5 h-5 text-[var(--nim-text-muted)]">
                      {typeof option.icon === 'string' ? (
                        <MaterialSymbol icon={option.icon} size={16} />
                      ) : (
                        option.icon
                      )}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="text-sm text-[var(--nim-text)] block overflow-hidden text-ellipsis whitespace-nowrap">
                        {option.label}
                      </span>
                      {option.description && (
                        <span className="text-xs text-[var(--nim-text-faint)] block overflow-hidden text-ellipsis whitespace-nowrap">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </li>
                ))
              )}
            </ul>
          )}

          {/* Session results (hidden when typeahead is showing) */}
          {!showTypeahead && displaySessions.length === 0 && (
            <div className="session-quick-open-empty p-10 text-center text-[var(--nim-text-faint)]">
              {isFileSearchMode && selectedFilePath
                ? `No sessions edited ${selectedFilePath}`
                : searchQuery ? 'No sessions found' : 'No recent sessions'}
            </div>
          )}
          {!showTypeahead && displaySessions.length > 0 && (
            <ul className="session-quick-open-list list-none m-0 p-0" ref={resultsListRef}>
              {displaySessions.map((session, index) => (
                <li
                  key={session.id}
                  className={`session-quick-open-item flex items-start gap-3 py-2.5 px-4 cursor-pointer border-l-[3px] border-transparent transition-all duration-100 hover:bg-[var(--nim-bg-hover)] ${
                    index === selectedIndex ? 'selected bg-[rgba(0,122,255,0.1)] border-l-[#007aff]' : ''
                  }`}
                  onClick={() => handleSessionSelect(session.id)}
                  onMouseEnter={() => {
                    if (mouseHasMoved) {
                      setSelectedIndex(index);
                    }
                  }}
                >
                  <div className="session-quick-open-item-icon shrink-0 flex items-center justify-center pt-0.5 text-[var(--nim-text-muted)]">
                    <ProviderIcon provider={session.provider || 'claude'} size={16} />
                  </div>
                  <div className="session-quick-open-item-content flex-1 min-w-0">
                    <div className="session-quick-open-item-name text-sm font-medium text-[var(--nim-text)] flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
                      {session.title || 'New conversation'}
                      {session.parentSessionId && (
                        <span className="session-quick-open-badge workstream-badge shrink-0 text-[10px] py-0.5 px-1.5 rounded-[3px] font-semibold bg-[var(--nim-primary)] text-white">
                          In Workstream
                        </span>
                      )}
                      {session.worktreeId && (
                        <span className="session-quick-open-badge worktree-badge shrink-0 text-[10px] py-0.5 px-1.5 rounded-[3px] font-semibold bg-[var(--nim-success)] text-white">
                          Worktree
                        </span>
                      )}
                      {session.messageCount > 0 && (
                        <span className="session-quick-open-badge shrink-0 text-[10px] py-0.5 px-1.5 rounded-[3px] font-semibold bg-[var(--nim-text-faint)] text-white">
                          {session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <div className="session-quick-open-item-meta text-xs text-[var(--nim-text-faint)] mt-0.5">
                      {getRelativeTimeString(session.updatedAt)}
                    </div>
                  </div>
                  <div className="session-quick-open-item-right shrink-0 flex items-center gap-1.5 ml-auto">
                    {session.uncommittedCount !== undefined && session.uncommittedCount > 0 && (
                      <span
                        className="session-quick-open-badge uncommitted shrink-0 text-[10px] py-0.5 px-1.5 rounded-[3px] font-semibold bg-[rgba(245,158,11,0.15)] text-[var(--nim-warning)]"
                        title={`${session.uncommittedCount} uncommitted change${session.uncommittedCount !== 1 ? 's' : ''}`}
                      >
                        {session.uncommittedCount}
                      </span>
                    )}
                    <SessionStatusIndicator sessionId={session.id} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="session-quick-open-footer flex justify-between py-2 px-4 border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
          <div className="flex gap-4">
            <span className="session-quick-open-hint text-[11px] text-[var(--nim-text-faint)] flex items-center gap-1">
              <kbd className="py-0.5 px-1.5 rounded-[3px] font-mono text-[10px] bg-[var(--nim-bg)] border border-[var(--nim-border)] text-[var(--nim-text)]">Up/Down</kbd> Navigate
            </span>
            <span className="session-quick-open-hint text-[11px] text-[var(--nim-text-faint)] flex items-center gap-1">
              <kbd className="py-0.5 px-1.5 rounded-[3px] font-mono text-[10px] bg-[var(--nim-bg)] border border-[var(--nim-border)] text-[var(--nim-text)]">Enter</kbd> {showTypeahead ? 'Select file' : 'Open'}
            </span>
            <span className="session-quick-open-hint text-[11px] text-[var(--nim-text-faint)] flex items-center gap-1">
              <kbd className="py-0.5 px-1.5 rounded-[3px] font-mono text-[10px] bg-[var(--nim-bg)] border border-[var(--nim-border)] text-[var(--nim-text)]">Esc</kbd> {isFileSearchMode ? 'Clear filter' : 'Close'}
            </span>
          </div>
          {isFileSearchMode && selectedFilePath && fileFilteredSessionIds !== null ? (
            <span className="session-quick-open-hint text-[11px] text-[var(--nim-primary)] flex items-center gap-1">
              {displaySessions.length} session{displaySessions.length !== 1 ? 's' : ''} edited this file
            </span>
          ) : (
            <span className="session-quick-open-hint text-[11px] text-[var(--nim-text-faint)] flex items-center gap-1">
              <kbd className="py-0.5 px-1.5 rounded-[3px] font-mono text-[10px] bg-[var(--nim-bg)] border border-[var(--nim-border)] text-[var(--nim-text)]">{getShortcutDisplay(KeyboardShortcuts.window.promptQuickOpen)}</kbd> Search prompts
            </span>
          )}
        </div>
      </div>
    </>
  );
};
