/**
 * ChatSidebar - Lightweight chat panel for files mode sidebar.
 *
 * This is the replacement for AIChat/AgenticPanel when used in chat mode.
 * It renders a single session tied to the current document context.
 * Supports resizable width and collapse/expand functionality.
 */

import React, { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import { SessionTranscript, SessionTranscriptRef } from '../UnifiedAI/SessionTranscript';
import { SessionDropdown } from '../AIChat/SessionDropdown';
import {
  sessionListChatAtom,
  refreshSessionListAtom,
  initSessionList,
} from '../../store';
import { defaultAgentModelAtom } from '../../store/atoms/appSettings';
import type { SerializableDocumentContext } from '../../hooks/useDocumentContext';
import { useResizeDragShield } from '../../hooks/useResizeDragShield';

export interface ChatSidebarRef {
  focusInput: () => void;
  insertPrompt: (text: string) => void;
  loadSession: (sessionId: string) => void;
}

export interface ChatSidebarProps {
  workspacePath: string;
  /** Whether the parent mode/panel is actively visible */
  isActive?: boolean;
  documentContext?: SerializableDocumentContext;
  /** Getter function for document context - async, reads from disk */
  getDocumentContext?: () => Promise<SerializableDocumentContext>;
  onFileOpen?: (filePath: string) => Promise<void>;
  /** Whether the sidebar is collapsed */
  isCollapsed?: boolean;
  /** Callback when collapse state should toggle */
  onToggleCollapse?: () => void;
  /** Current width of the sidebar */
  width?: number;
  /** Callback when width changes (during resize) */
  onWidthChange?: (width: number) => void;
  /** Callback to switch to agent mode, optionally opening a specific session */
  onSwitchToAgentMode?: (sessionId?: string) => void;
}

export const ChatSidebar = forwardRef<ChatSidebarRef, ChatSidebarProps>(({
  workspacePath,
  isActive = true,
  documentContext,
  getDocumentContext,
  onFileOpen,
  isCollapsed = false,
  onToggleCollapse,
  width = 350,
  onWidthChange,
  onSwitchToAgentMode,
}, ref) => {
  const transcriptRef = useRef<SessionTranscriptRef>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef(false);
  const pendingPromptRef = useRef<string | null>(null);
  const isInitializingRef = useRef(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Session list from Jotai - filtered for chat mode (no worktrees, no workstream parents)
  const sessionList = useAtomValue(sessionListChatAtom);
  const refreshSessions = useSetAtom(refreshSessionListAtom);

  // Default model for new sessions (user's last selected model)
  const defaultModel = useAtomValue(defaultAgentModelAtom);

  // Convert to format expected by SessionDropdown
  const availableSessions = useMemo(() => {
    return sessionList.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      name: s.title,
      title: s.title,
      messageCount: s.messageCount || 0,
      provider: s.provider,
      model: s.model,
    }));
  }, [sessionList]);

  // Expose methods through ref
  useImperativeHandle(ref, () => ({
    focusInput: () => {
      if (transcriptRef.current) {
        transcriptRef.current.focusInput();
      } else {
        pendingFocusRef.current = true;
      }
    },
    insertPrompt: (text: string) => {
      if (transcriptRef.current) {
        transcriptRef.current.insertPrompt(text);
      } else {
        pendingPromptRef.current = text;
      }
    },
    loadSession: (id: string) => {
      setSessionId(id);
    },
  }), []);

  useEffect(() => {
    if (isCollapsed || isLoading || !sessionId) return;

    const frameId = requestAnimationFrame(() => {
      const pendingPrompt = pendingPromptRef.current;
      if (pendingPrompt !== null) {
        pendingPromptRef.current = null;
        pendingFocusRef.current = false;
        transcriptRef.current?.insertPrompt(pendingPrompt);
        return;
      }
      if (pendingFocusRef.current) {
        pendingFocusRef.current = false;
        transcriptRef.current?.focusInput();
      }
    });

    return () => cancelAnimationFrame(frameId);
  }, [isCollapsed, isLoading, sessionId]);

  // Initialize session list on mount
  useEffect(() => {
    if (!isActive) return;
    initSessionList(workspacePath);
  }, [isActive, workspacePath]);

  // Initialize session - select most recent or create new if none exist
  // CRITICAL: Only runs once on mount to avoid creating duplicate sessions
  useEffect(() => {
    if (!isActive) {
      setIsLoading(false);
      return;
    }

    const initSession = async () => {
      // Prevent concurrent initialization
      if (isInitializingRef.current) {
        return;
      }
      isInitializingRef.current = true;

      try {
        setIsLoading(true);

        // Wait for session list to load (it's initialized in parallel above)
        // We need to give the session list time to populate
        await new Promise(resolve => setTimeout(resolve, 100));

        // Re-read session list after waiting
        const sessions = await window.electronAPI.invoke('sessions:list', workspacePath, {
          includeArchived: false,
        });

        if (sessions.success && Array.isArray(sessions.sessions)) {
          // Filter for chat sessions (no worktrees, no workstream parents)
          const chatSessions = sessions.sessions.filter((s: any) => {
            if (s.worktreeId) return false;
            if (s.childCount && s.childCount > 0) return false;
            return true;
          });

          // If we have existing chat sessions, use the most recent one
          if (chatSessions.length > 0) {
            setSessionId(chatSessions[0].id);
            setIsLoading(false);
            return;
          }
        }

        // No chat sessions exist - create a new one
        const newSessionId = crypto.randomUUID();
        // Parse provider from defaultModel using ModelIdentifier
        const modelId = defaultModel ? ModelIdentifier.tryParse(defaultModel) : null;
        const provider = modelId?.provider || 'claude-code';
        const result = await window.electronAPI.invoke(
          'sessions:create',
          {
            session: {
              id: newSessionId,
              provider,
              model: defaultModel,
              title: 'New Session',
            },
            workspaceId: workspacePath,
          }
        );
        if (result?.success) {
          setSessionId(newSessionId);
          // Refresh the session list to include the new session
          refreshSessions();
        }
      } catch (err) {
        console.error('[ChatSidebar] Failed to init session:', err);
      } finally {
        setIsLoading(false);
        isInitializingRef.current = false;
      }
    };

    initSession();
    // CRITICAL: Only run once on mount - workspacePath changes trigger full remount anyway
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, workspacePath]);

  const handleFileClick = useCallback(async (filePath: string) => {
    if (onFileOpen) {
      await onFileOpen(filePath);
    }
  }, [onFileOpen]);

  const handleSessionSelect = useCallback((selectedSessionId: string) => {
    setSessionId(selectedSessionId);
  }, []);

  const handleNewSession = useCallback(async () => {
    const newSessionId = crypto.randomUUID();
    // Parse provider from defaultModel using ModelIdentifier
    const modelId = defaultModel ? ModelIdentifier.tryParse(defaultModel) : null;
    const provider = modelId?.provider || 'claude-code';
    const result = await window.electronAPI.invoke(
      'sessions:create',
      {
        session: {
          id: newSessionId,
          provider,
          model: defaultModel,
          title: 'Chat',
        },
        workspaceId: workspacePath,
      }
    );
    if (result?.success) {
      setSessionId(newSessionId);
      refreshSessions();
    }
  }, [workspacePath, refreshSessions, defaultModel]);

  const handleDeleteSession = useCallback(async (sessionIdToDelete: string) => {
    await window.electronAPI.invoke('session:delete', sessionIdToDelete);
    refreshSessions();
    // If we deleted the current session, switch to another or create new
    if (sessionIdToDelete === sessionId) {
      const remaining = sessionList.filter(s => s.id !== sessionIdToDelete);
      if (remaining.length > 0) {
        setSessionId(remaining[0].id);
      } else {
        handleNewSession();
      }
    }
  }, [workspacePath, sessionId, sessionList, refreshSessions, handleNewSession]);

  const handleRenameSession = useCallback(async (sessionIdToRename: string, newName: string) => {
    await window.electronAPI.invoke('sessions:update-title', sessionIdToRename, newName);
    refreshSessions();
  }, [workspacePath, refreshSessions]);

  const startResize = useResizeDragShield({
    onMove: (event) => {
      if (!onWidthChange) return;
      // Calculate new width from right edge
      const newWidth = window.innerWidth - event.clientX;
      // Allow up to 50% of window width, with minimum of 280px
      const maxWidth = Math.floor(window.innerWidth * 0.5);
      const clampedWidth = Math.min(Math.max(280, newWidth), maxWidth);
      onWidthChange(clampedWidth);
    },
  });

  // When collapsed, render nothing (toggle button is in the title bar)
  if (isCollapsed || !isActive) {
    return null;
  }

  if (isLoading) {
    return (
      <div
        className="chat-sidebar chat-sidebar-loading flex flex-col h-full overflow-hidden bg-nim border-l border-nim relative items-center justify-center text-nim-muted"
        style={{ width: onWidthChange ? width : undefined }}
        data-session-id={sessionId}
      >
        <div className="chat-sidebar-spinner w-6 h-6 border-2 border-nim border-t-nim-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (!sessionId) {
    return (
      <div
        className="chat-sidebar chat-sidebar-error flex flex-col h-full overflow-hidden bg-nim border-l border-nim relative items-center justify-center text-nim-muted"
        style={{ width: onWidthChange ? width : undefined }}
        data-session-id={sessionId}
      >
        <p>Failed to load chat session</p>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      className="chat-sidebar flex flex-col h-full overflow-hidden bg-nim border-l border-nim relative"
      style={{ width: onWidthChange ? width : undefined }}
      data-testid="chat-sidebar-panel"
      data-session-id={sessionId}
    >
      {onWidthChange && (
        <div
          className="chat-sidebar-resize-handle absolute -left-0.5 top-0 bottom-0 w-[5px] cursor-col-resize z-10 before:content-[''] before:absolute before:left-0.5 before:top-0 before:bottom-0 before:w-0.5 before:bg-nim hover:before:bg-nim-primary"
          data-testid="chat-sidebar-resize-handle"
          onPointerDown={startResize}
          role="separator"
          aria-label="Resize AI chat sidebar"
          aria-orientation="vertical"
        />
      )}

      {/* Header with session dropdown */}
      <div className="chat-sidebar-header [container-type:inline-size] flex items-center gap-2 p-2 border-b border-nim justify-between shrink-0">
        <SessionDropdown
          currentSessionId={sessionId}
          sessions={availableSessions}
          onSessionSelect={handleSessionSelect}
          onNewSession={handleNewSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onOpenSessionManager={onSwitchToAgentMode}
          className="flex-1"
        />
        <div className="flex items-center gap-1 shrink-0">
          {onSwitchToAgentMode && (
            <button
              className="chat-sidebar-maximize-button flex items-center justify-center w-7 h-7 rounded-md text-nim-muted border-none cursor-pointer transition-colors duration-150 hover:bg-nim-bg-active hover:text-nim bg-transparent"
              onClick={() => onSwitchToAgentMode(sessionId ?? undefined)}
              title="Open in agent mode"
            >
              <MaterialSymbol icon="zoom_out_map" size={16} />
            </button>
          )}
          <button
            className="chat-sidebar-new-button flex items-center gap-1 px-3 py-1.5 rounded-md text-[0.8125rem] font-medium bg-nim-primary text-nim-on-primary border-none cursor-pointer transition-opacity duration-150 hover:opacity-90"
            onClick={handleNewSession}
            title="Start new conversation"
            aria-label="Start new conversation"
          >
            <MaterialSymbol icon="add" size={16} />
            <span className="chat-sidebar-new-label">New</span>
          </button>
        </div>
      </div>

      <SessionTranscript
        key={sessionId}
        ref={transcriptRef}
        sessionId={sessionId}
        workspacePath={workspacePath}
        mode="chat"
        hideSidebar={true}
        onFileClick={handleFileClick}
        onClearSession={handleNewSession}
        documentContext={documentContext}
        getDocumentContext={getDocumentContext}
      />
    </div>
  );
});

ChatSidebar.displayName = 'ChatSidebar';
