import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { SessionData } from '../../../ai/server/types';
import type { TranscriptSettings, PromptMarker, FileEditSummary } from '../types';
import { RichTranscriptView } from './RichTranscriptView';
import { TranscriptSidebar } from './TranscriptSidebar';
import { FileEditsSidebar } from './FileEditsSidebar';
import { FloatingTranscriptActions } from './FloatingTranscriptActions';
import { formatISO } from '../../../utils/dateUtils';
import { MaterialSymbol } from '../../icons/MaterialSymbol';

interface Todo {
  status: 'pending' | 'in_progress' | 'completed';
  content: string;
  activeForm: string;
}

function summarizePanelTeammates(
  teammates: Array<{ agentId: string; status: 'running' | 'completed' | 'errored' | 'idle' }> | undefined
): string {
  if (!teammates || teammates.length === 0) return 'none';
  return teammates.map(tm => `${tm.agentId}:${tm.status}`).join(', ');
}

function logPanelMemoDiff(
  sessionId: string,
  reason: string,
  details?: Record<string, unknown>
): void {
  if (!import.meta.env.DEV) return;
  // console.info(`[RenderTrace][AgentTranscriptPanel.memo] ${JSON.stringify({
  //   sessionId,
  //   reason,
  //   ...details,
  // })}`);
}

interface AgentTranscriptPanelProps {
  sessionId: string;
  sessionData: SessionData;
  todos?: Todo[];
  isProcessing?: boolean; // Whether the session is currently processing a request
  /** When true, session is waiting for user input — suppresses the "Thinking..." indicator */
  hasPendingInteractivePrompt?: boolean;
  onSettingsChange?: (settings: TranscriptSettings) => void;
  showSettings?: boolean;
  initialSettings?: TranscriptSettings;
  onFileClick?: (filePath: string) => void;
  /** Optional: Navigate to a session by ID (for @@session reference links) */
  onOpenSession?: (sessionId: string) => void;
  hideSidebar?: boolean;  // Hide the prompts/files sidebar
  /** Show floating actions (prompts menu, archive) even when sidebar is hidden. Defaults to !hideSidebar */
  showFloatingActions?: boolean;
  workspacePath?: string; // Explicit workspace path (falls back to sessionData.workspacePath)
  /** Optional: render function for custom header content (receives prompts and navigation callback) */
  renderHeaderActions?: (props: {
    prompts: PromptMarker[];
    onNavigateToPrompt: (marker: PromptMarker) => void;
  }) => React.ReactNode;
  /** Optional: render additional content in the empty state (e.g., command suggestions) */
  renderEmptyExtra?: () => React.ReactNode;
  /**
   * If true, suppress the default "ready to assist with" help block in the
   * empty state. Hosts use this when `renderEmptyExtra` provides its own
   * primary content (e.g. an inline tip card) that should stand on its own.
   */
  hideEmptyHelp?: boolean;
  /** Whether the session is archived */
  isArchived?: boolean;
  /** Optional callback to close and archive the session */
  onCloseAndArchive?: () => void;
  /** Optional callback to unarchive the session */
  onUnarchive?: () => void;
  /** Optional: Read a file from the filesystem (for custom widgets that need to load persisted files) */
  readFile?: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
  /**
   * Files this session edited, supplied by the host.
   *
   * The panel deliberately does NOT fetch or subscribe for these. On desktop
   * the host reads `sessionFileEditsAtom`, which a central listener already
   * keeps current (see docs/IPC_LISTENERS.md); the panel used to run its own
   * duplicate, un-debounced query off the same IPC event. Mobile hosts have no
   * file-link store, so they pass nothing and the sidebar stays empty -- which
   * is what they already got.
   */
  fileEdits?: FileEditSummary[];
  /** Optional: render additional content above the file edits sidebar (e.g., pending review banner) */
  renderFilesHeader?: () => React.ReactNode;
  /** Optional: Set of file paths that have pending AI edits awaiting review */
  pendingReviewFiles?: Set<string>;
  /** Whether to group files by directory in the sidebar */
  groupByDirectory?: boolean;
  /** Callback when groupByDirectory changes */
  onGroupByDirectoryChange?: (value: boolean) => void;
  /** Optional: Callback to open file in external editor */
  onOpenInExternalEditor?: (filePath: string) => void;
  /** Optional: Display name for external editor (e.g., "VS Code") */
  externalEditorName?: string;
  /** Optional: Callback to trigger /compact command */
  onCompact?: () => void;
  /** Optional: Prompt additions for debugging (system prompt, user message, and attachments) */
  promptAdditions?: {
    systemPromptAddition: string | null;
    userMessageAddition: string | null;
    attachments?: Array<{ type: string; filename: string; mimeType?: string; filepath?: string }>;
    timestamp: number;
    messageIndex: number; // Index of user message this belongs to (for stable positioning)
  } | null;
  /** Optional: App start time (epoch ms) for rendering restart indicator line (dev mode only) */
  appStartTime?: number;
  /** Optional: Render a file using a host-provided embedded editor surface */
  renderEmbeddedFile?: (params: { filePath: string; defaultExpanded?: boolean }) => React.ReactNode;
  /** Optional: Predicate identifying files the host will render via renderEmbeddedFile */
  canEmbedFile?: (filePath: string) => boolean;
  /** Optional: merged teammate/worker statuses to drive transcript status UI */
  currentTeammates?: Array<{ agentId: string; status: 'running' | 'completed' | 'errored' | 'idle' }>;
  /** Optional: noun used in waiting text when teammates/workers are still running */
  waitingForNoun?: string;
  /** Current session phase for the kanban board */
  currentPhase?: string | null;
  /** Available phase columns for the kanban board picker */
  phaseColumns?: Array<{ value: string; label: string; color: string }>;
  /** Callback when phase is changed */
  onSetPhase?: (phase: string | null) => void;
  // Note: Interactive widgets read their host from interactiveWidgetHostAtom(sessionId)
}

/** Stable default so an omitted `fileEdits` prop doesn't churn memo identities. */
const EMPTY_FILE_EDITS: FileEditSummary[] = [];

const AgentTranscriptPanelComponent = React.forwardRef<
  { scrollToMessage: (index: number) => void; scrollToTop: () => void },
  AgentTranscriptPanelProps
>(({
  sessionId,
  sessionData,
  todos = [],
  isProcessing,
  hasPendingInteractivePrompt,
  onSettingsChange,
  showSettings,
  initialSettings,
  onFileClick,
  onOpenSession,
  hideSidebar = false,
  showFloatingActions,
  workspacePath: workspacePathProp,
  renderHeaderActions,
  renderEmptyExtra,
  hideEmptyHelp,
  isArchived,
  onCloseAndArchive,
  onUnarchive,
  readFile,
  fileEdits = EMPTY_FILE_EDITS,
  renderFilesHeader,
  pendingReviewFiles,
  groupByDirectory,
  onGroupByDirectoryChange,
  onOpenInExternalEditor,
  externalEditorName,
  onCompact,
  promptAdditions,
  appStartTime,
  renderEmbeddedFile,
  canEmbedFile,
  currentTeammates,
  waitingForNoun,
  currentPhase,
  phaseColumns,
  onSetPhase,
}, ref) => {
  // Show floating actions if explicitly enabled, otherwise default to showing when sidebar is visible
  const shouldShowFloatingActions = showFloatingActions ?? !hideSidebar;
  // Prefer worktree path for worktree sessions, then prop, then sessionData
  const effectiveWorkspacePath = sessionData.worktreePath || workspacePathProp || sessionData.workspacePath;
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    const stored = localStorage.getItem(`agent-transcript-sidebar-${sessionId}`);
    return stored === 'true';
  });

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem(`agent-transcript-sidebar-width-${sessionId}`);
    return stored ? parseInt(stored, 10) : 256; // 16rem = 256px
  });

  // Removed activeTab state - sidebar now only shows Files tab

  const [prompts, setPrompts] = useState<PromptMarker[]>([]);
  const transcriptRef = useRef<{ scrollToMessage: (index: number) => void; scrollToTop: () => void }>(null);

  // Resize logic
  const [isDragging, setIsDragging] = useState(false);

  // Mirror the find-in-page search bar visibility from RichTranscriptView so
  // FloatingTranscriptActions can shift down when the search bar is open.
  // Without this, the phase pill overlaps the search bar's right-side controls
  // (chevron, list, case-sensitive, close) on narrow widths. See #309.
  const [searchBarVisible, setSearchBarVisible] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(sidebarWidth);

  // Save sidebar state
  useEffect(() => {
    localStorage.setItem(`agent-transcript-sidebar-${sessionId}`, String(isSidebarCollapsed));
  }, [isSidebarCollapsed, sessionId]);

  // Save sidebar width
  useEffect(() => {
    localStorage.setItem(`agent-transcript-sidebar-width-${sessionId}`, String(sidebarWidth));
  }, [sidebarWidth, sessionId]);

  // Removed - no longer need to save active tab since sidebar only shows Files

  // Reset prompts when session changes
  useEffect(() => {
    setPrompts([]);
  }, [sessionId]);

  // Extract prompts from messages
  useEffect(() => {
    const userMessages = sessionData.messages
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => msg.type === 'user_message');

    const allMessages = sessionData.messages;
    const markers: PromptMarker[] = userMessages.map(({ msg, index }, promptIndex) => {
      // Find the next user-input message to bound this turn
      const nextUserMsg = userMessages[promptIndex + 1];
      const endBound = nextUserMsg ? nextUserMsg.index : allMessages.length;

      // Walk backward from endBound to find the last assistant/tool message in this turn
      let completionTimestamp: string | undefined;
      for (let i = endBound - 1; i > index; i--) {
        if (allMessages[i].type !== 'user_message') {
          completionTimestamp = formatISO(allMessages[i].createdAt.getTime()) || undefined;
          break;
        }
      }

      // Don't show completion for the last prompt if session is still processing
      if (promptIndex === userMessages.length - 1 && isProcessing) {
        completionTimestamp = undefined;
      }

      return {
        id: promptIndex + 1,
        sessionId,
        promptText: msg.text ?? '',
        outputIndex: index,
        timestamp: formatISO(msg.createdAt.getTime()) || new Date().toISOString(),
        completionTimestamp
      };
    });

    setPrompts(markers);
  }, [sessionData.messages, sessionId, isProcessing]);

  const handleNavigateToPrompt = useCallback((marker: PromptMarker) => {
    transcriptRef.current?.scrollToMessage(marker.outputIndex);
  }, []);

  // Expose methods to parent via ref
  React.useImperativeHandle(ref, () => ({
    scrollToMessage: (index: number) => {
      transcriptRef.current?.scrollToMessage(index);
    },
    scrollToTop: () => {
      transcriptRef.current?.scrollToTop();
    }
  }), []);

  // Handle resize drag
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startXRef.current = e.clientX;
    startWidthRef.current = sidebarWidth;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = startXRef.current - e.clientX; // Note: reversed because sidebar is on right
      const newWidth = Math.max(200, Math.min(600, startWidthRef.current + deltaX));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  return (
    <div className="agent-transcript-panel flex h-full relative">
      {/* Main Content */}
      <div className="flex-1 overflow-hidden relative">
        <RichTranscriptView
          ref={transcriptRef}
          sessionId={sessionId}
          sessionStatus={sessionData.metadata?.sessionStatus as string}
          isProcessing={isProcessing}
          hasPendingInteractivePrompt={hasPendingInteractivePrompt}
          messages={sessionData.messages}
          provider={sessionData.provider}
          settings={initialSettings}
          onSettingsChange={onSettingsChange}
          showSettings={showSettings}
          documentContext={sessionData.documentContext}
          workspacePath={effectiveWorkspacePath}
          renderEmptyExtra={renderEmptyExtra}
          hideEmptyHelp={hideEmptyHelp}
          readFile={readFile}
          onOpenFile={onFileClick}
          onOpenSession={onOpenSession}
          onCompact={onCompact}
          promptAdditions={promptAdditions}
          currentTeammates={currentTeammates ?? sessionData.metadata?.currentTeammates as Array<{ agentId: string; status: 'running' | 'completed' | 'errored' | 'idle' }> | undefined}
          waitingForNoun={waitingForNoun}
          appStartTime={appStartTime}
          renderEmbeddedFile={renderEmbeddedFile}
          canEmbedFile={canEmbedFile}
          onSearchBarVisibilityChange={setSearchBarVisible}
        />

        {/* Floating Actions - show based on showFloatingActions prop */}
        {shouldShowFloatingActions && (
          <FloatingTranscriptActions
            prompts={prompts}
            isSidebarCollapsed={hideSidebar || isSidebarCollapsed}
            onToggleSidebar={hideSidebar ? undefined : () => setIsSidebarCollapsed(!isSidebarCollapsed)}
            onNavigateToPrompt={handleNavigateToPrompt}
            currentPhase={currentPhase}
            phaseColumns={phaseColumns}
            onSetPhase={onSetPhase}
            searchBarVisible={searchBarVisible}
          />
        )}

        {/* Custom header actions (e.g., for mobile prompts menu in Capacitor) */}
        {renderHeaderActions && renderHeaderActions({ prompts, onNavigateToPrompt: handleNavigateToPrompt })}
      </div>

      {/* Sidebar with tabs - hidden if hideSidebar is true */}
      {!hideSidebar && (
        <>
          {/* Draggable Divider */}
          {!isSidebarCollapsed && (
            <div
              onMouseDown={handleMouseDown}
              className={`w-1 cursor-ew-resize shrink-0 relative ${isDragging ? 'bg-nim-border-focus' : 'bg-nim-border transition-colors duration-150'}`}
            >
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-10 pointer-events-none" />
            </div>
          )}
          <div
            className={`flex flex-col shrink-0 ${isSidebarCollapsed ? 'w-0 transition-all duration-300 ease-in-out' : ''}`}
            style={isSidebarCollapsed ? undefined : { width: `${sidebarWidth}px` }}
          >
        {!isSidebarCollapsed && (
          <>
            {/* Header with Files label */}
            <div className="session-files-right-panel flex items-center gap-2 p-3 border-b border-nim bg-nim-secondary">
              <MaterialSymbol icon="description" size={16} />
              <span className="font-medium text-nim">Files Edited</span>
              {fileEdits.length > 0 && (
                <span className="ml-auto py-0.5 px-1.5 bg-nim-tertiary rounded text-[11px] font-medium text-nim-faint">
                  {fileEdits.length}
                </span>
              )}
            </div>

            {/* Files Content */}
            <div className="flex-1 overflow-hidden flex flex-col">
              {/* Optional header content (e.g., pending review banner) */}
              {renderFilesHeader && renderFilesHeader()}

              <div className="flex-1 overflow-hidden">
                <FileEditsSidebar
                  fileEdits={fileEdits}
                  onFileClick={onFileClick}
                  workspacePath={effectiveWorkspacePath}
                  pendingReviewFiles={pendingReviewFiles}
                  groupByDirectory={groupByDirectory}
                  onGroupByDirectoryChange={onGroupByDirectoryChange}
                  onOpenInExternalEditor={onOpenInExternalEditor}
                  externalEditorName={externalEditorName}
                />
              </div>

              {/* TodoList below tab content */}
              {Array.isArray(todos) && todos.length > 0 && (
                <div className="border-t border-nim bg-nim-secondary p-3 max-h-[150px] overflow-auto">
                  <div className="mb-2 text-xs font-medium text-nim-muted">
                    Tasks ({todos.filter(t => t.status === 'completed').length}/{todos.length})
                  </div>
                  <div className="flex flex-col gap-1">
                    {todos.map((todo, index) => {
                      const displayText = todo.status === 'in_progress' ? todo.activeForm : todo.content;
                      return (
                        <div key={index} className={`flex items-start gap-2 text-xs text-nim ${todo.status === 'completed' ? 'opacity-60' : ''}`}>
                          <div className="mt-0.5 shrink-0 text-[0.625rem]">
                            {todo.status === 'pending' && <span>○</span>}
                            {todo.status === 'in_progress' && <span className="animate-spin inline-block">◐</span>}
                            {todo.status === 'completed' && <span className="text-nim-primary">●</span>}
                          </div>
                          <div className={`flex-1 break-words ${todo.status === 'completed' ? 'line-through' : ''}`}>
                            {displayText}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
          </div>
        </>
      )}
    </div>
  );
});

const getSessionStatus = (sessionData: SessionData): string | undefined => {
  const status = sessionData.metadata?.sessionStatus;
  return typeof status === 'string' ? status : undefined;
};

/**
 * Memoized version of AgentTranscriptPanel.
 * This prevents unnecessary re-renders when parent components re-render
 * (e.g., SessionTranscript re-renders on every keystroke for controlled input).
 *
 * Custom comparison function checks if the props that affect rendering have actually changed.
 */
export const AgentTranscriptPanel = React.memo(
  AgentTranscriptPanelComponent,
  (prevProps, nextProps) => {
    // Session ID changed - must re-render
    if (prevProps.sessionId !== nextProps.sessionId) {
      logPanelMemoDiff(nextProps.sessionId, 'sessionId', {
        prev: prevProps.sessionId,
        next: nextProps.sessionId,
      });
      return false;
    }

    // Processing state changed - must re-render (affects spinner, etc.)
    if (prevProps.isProcessing !== nextProps.isProcessing) {
      logPanelMemoDiff(nextProps.sessionId, 'isProcessing', {
        prev: prevProps.isProcessing,
        next: nextProps.isProcessing,
      });
      return false;
    }
    if (prevProps.hasPendingInteractivePrompt !== nextProps.hasPendingInteractivePrompt) {
      logPanelMemoDiff(nextProps.sessionId, 'hasPendingInteractivePrompt', {
        prev: prevProps.hasPendingInteractivePrompt,
        next: nextProps.hasPendingInteractivePrompt,
      });
      return false;
    }

    // Archived state changed - must re-render
    if (prevProps.isArchived !== nextProps.isArchived) {
      logPanelMemoDiff(nextProps.sessionId, 'isArchived', {
        prev: prevProps.isArchived,
        next: nextProps.isArchived,
      });
      return false;
    }

    // Sidebar visibility changed - must re-render
    if (prevProps.hideSidebar !== nextProps.hideSidebar) {
      logPanelMemoDiff(nextProps.sessionId, 'hideSidebar');
      return false;
    }
    if (prevProps.showFloatingActions !== nextProps.showFloatingActions) {
      logPanelMemoDiff(nextProps.sessionId, 'showFloatingActions');
      return false;
    }

    // Group by directory changed - must re-render
    if (prevProps.groupByDirectory !== nextProps.groupByDirectory) {
      logPanelMemoDiff(nextProps.sessionId, 'groupByDirectory', {
        prev: prevProps.groupByDirectory,
        next: nextProps.groupByDirectory,
      });
      return false;
    }

    // Workspace path changed - must re-render
    if (prevProps.workspacePath !== nextProps.workspacePath) {
      logPanelMemoDiff(nextProps.sessionId, 'workspacePath');
      return false;
    }

    // Pending review files changed - must re-render
    if (prevProps.pendingReviewFiles !== nextProps.pendingReviewFiles) {
      logPanelMemoDiff(nextProps.sessionId, 'pendingReviewFiles');
      return false;
    }

    // Todos changed - check array equality
    if (prevProps.todos?.length !== nextProps.todos?.length) {
      logPanelMemoDiff(nextProps.sessionId, 'todos.length', {
        prev: prevProps.todos?.length ?? 0,
        next: nextProps.todos?.length ?? 0,
      });
      return false;
    }
    if (prevProps.todos && nextProps.todos) {
      for (let i = 0; i < prevProps.todos.length; i++) {
        const prev = prevProps.todos[i];
        const next = nextProps.todos[i];
        if (prev.status !== next.status || prev.content !== next.content || prev.activeForm !== next.activeForm) {
          logPanelMemoDiff(nextProps.sessionId, `todos[${i}]`, { prev, next });
          return false;
        }
      }
    }

    // SessionData - check critical fields only
    const prevData = prevProps.sessionData;
    const nextData = nextProps.sessionData;

    // Messages changed - check array reference (reloadSessionData creates new array)
    if (prevData.messages !== nextData.messages) {
      logPanelMemoDiff(nextProps.sessionId, 'sessionData.messages', {
        prevCount: prevData.messages?.length ?? 0,
        nextCount: nextData.messages?.length ?? 0,
        prevUpdatedAt: prevData.updatedAt,
        nextUpdatedAt: nextData.updatedAt,
      });
      return false;
    }

    // Provider changed - must re-render
    if (prevData.provider !== nextData.provider) {
      logPanelMemoDiff(nextProps.sessionId, 'sessionData.provider', {
        prev: prevData.provider,
        next: nextData.provider,
      });
      return false;
    }

    // Only re-render for metadata fields that actually affect transcript rendering.
    // A full metadata reference check caused idle-session churn (read-state, updatedAt, etc.)
    // which remounted virtualized rows and dropped text selection.
    if (getSessionStatus(prevData) !== getSessionStatus(nextData)) {
      logPanelMemoDiff(nextProps.sessionId, 'sessionStatus', {
        prev: getSessionStatus(prevData),
        next: getSessionStatus(nextData),
      });
      return false;
    }

    // Document context changed - check reference
    if (prevData.documentContext !== nextData.documentContext) {
      logPanelMemoDiff(nextProps.sessionId, 'documentContext');
      return false;
    }

    // Token usage changed - check reference
    if (prevData.tokenUsage !== nextData.tokenUsage) {
      logPanelMemoDiff(nextProps.sessionId, 'tokenUsage');
      return false;
    }

    // Worker status affects inline transcript state even when messages don't change.
    if (prevProps.currentTeammates !== nextProps.currentTeammates) {
      logPanelMemoDiff(nextProps.sessionId, 'currentTeammates', {
        prev: summarizePanelTeammates(prevProps.currentTeammates),
        next: summarizePanelTeammates(nextProps.currentTeammates),
      });
      return false;
    }

    // App start time changed - must re-render (restart indicator)
    if (prevProps.appStartTime !== nextProps.appStartTime) {
      logPanelMemoDiff(nextProps.sessionId, 'appStartTime', {
        prev: prevProps.appStartTime,
        next: nextProps.appStartTime,
      });
      return false;
    }

    // Phase changed - must re-render (floating actions phase picker)
    if (prevProps.currentPhase !== nextProps.currentPhase) {
      logPanelMemoDiff(nextProps.sessionId, 'currentPhase', {
        prev: prevProps.currentPhase,
        next: nextProps.currentPhase,
      });
      return false;
    }

    // All checks passed - skip re-render
    return true;
  }
);
