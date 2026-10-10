import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { VList, type VListHandle, type CacheSnapshot } from 'virtua';
import type { TranscriptViewMessage } from '../../../ai/server/types';
import type { ToolCallDiffLoadResult } from '../../../ai/server/transcript';
import { isInteractiveWidgetTool, partitionUnansweredQuestions, stripMcpPrefix } from '../../../ai/server/interactivePromptTools';
import type { TranscriptSettings } from '../types';
import type { TranscriptFileLocation } from './MarkdownRenderer';
import { MaterialSymbol } from '../../icons/MaterialSymbol';
import { formatMessageTime } from '../../../utils/dateUtils';
import { copyToClipboard } from '../../../utils/clipboard';
import { TranscriptSearchBar } from './TranscriptSearchBar';
import { setSessionIsAtBottom, getSessionIsAtBottom } from '../../../store/atoms/transcriptScroll';
import { isAppleMobileWebKit } from '../../../utils/platform';
import { usePendingPermissionNavigation } from './usePendingPermissionNavigation';
import { usePendingQuestionNavigation } from './usePendingQuestionNavigation';
import { useElapsedTimeRef } from './CustomToolWidgets/useElapsedTime';
import type { SubagentChildContext, TranscriptToolShared } from './TranscriptToolCard';
import { TranscriptMessageRow, computeTranscriptRowInfos, type TranscriptRowInfo } from './TranscriptMessageRow';

// Edit/diff extraction moved with the tool card; re-exported for existing importers.
export {
  parseUnifiedDiffToReplacements,
  extractCodexFileChanges,
  toolCallDiffsToEdits,
  extractEditsFromToolMessage,
  formatSubagentAuditLabel,
} from './TranscriptToolCard';
// Per-session VList cache - survives component remounts so returning to a session
// doesn't re-measure all items from scratch
const vlistCacheMap = new Map<string, CacheSnapshot>();

function summarizeRenderTeammates(
  teammates: Array<{ agentId: string; status: 'running' | 'completed' | 'errored' | 'idle' }> | undefined
): string {
  if (!teammates || teammates.length === 0) return 'none';
  return teammates.map(tm => `${tm.agentId}:${tm.status}`).join(', ');
}

function emitRichTranscriptRenderTrace(event: string, payload: Record<string, unknown>): void {
  // console.info(`[RenderTrace][RichTranscriptView] ${event} ${JSON.stringify(payload)}`);
}

// Inject RichTranscriptView styles once (for animations, scrollbar, and complex selectors)
const injectRichTranscriptStyles = () => {
  const styleId = 'rich-transcript-view-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    /* Avatar color-mix backgrounds */
    .rich-transcript-message-avatar.user {
      background-color: color-mix(in srgb, var(--nim-success) 20%, transparent);
      color: var(--nim-success);
    }
    .rich-transcript-message-avatar.assistant {
      background-color: color-mix(in srgb, var(--nim-primary) 20%, transparent);
      color: var(--nim-primary);
    }

    /* Edit card icon background */
    .rich-transcript-edit-card__icon {
      background-color: color-mix(in srgb, var(--nim-primary) 12%, transparent);
    }

    /* Edit card status backgrounds */
    .rich-transcript-edit-card__status--success {
      background-color: color-mix(in srgb, var(--nim-success) 15%, transparent);
    }
    .rich-transcript-edit-card__status--error {
      background-color: color-mix(in srgb, var(--nim-error) 15%, transparent);
    }

    /* Streaming avatar background */
    .rich-transcript-streaming-avatar {
      background-color: color-mix(in srgb, var(--nim-primary) 20%, transparent);
      color: var(--nim-primary);
    }

    /* Sub-agent styling */
    .rich-transcript-tool-card.sub-agent {
      background-color: color-mix(in srgb, var(--nim-primary) 5%, var(--nim-bg-secondary));
      border-color: color-mix(in srgb, var(--nim-primary) 20%, var(--nim-border));
    }

    /* Agent team teammate styling */
    .rich-transcript-tool-card.teammate {
      background-color: color-mix(in srgb, var(--nim-primary) 8%, var(--nim-bg-secondary));
      border-color: color-mix(in srgb, var(--nim-primary) 30%, var(--nim-border));
      border-left: 3px solid var(--nim-primary);
    }

    /* Teammate message notification styling */
    .rich-transcript-teammate-notification {
      background-color: transparent;
      border-left: 2px solid color-mix(in srgb, var(--nim-primary) 25%, transparent);
      padding: 0.25rem 0.5rem;
    }
    .rich-transcript-teammate-notification details > summary {
      cursor: pointer;
      user-select: none;
    }
    .rich-transcript-teammate-notification details > summary::-webkit-details-marker,
    .rich-transcript-teammate-notification details > summary::marker {
      display: none;
      content: '';
    }
    .rich-transcript-teammate-notification .teammate-content {
      font-size: 0.8125rem;
      line-height: 1.5;
      color: var(--nim-text-muted);
    }
    .rich-transcript-teammate-notification .teammate-content p:first-child {
      margin-top: 0;
    }
    .rich-transcript-teammate-notification .teammate-content p:last-child {
      margin-bottom: 0;
    }
    .rich-transcript-teammate-notification details[open] > summary .teammate-chevron {
      transform: rotate(90deg);
    }

    /* VList scrollbar styling */
    .rich-transcript-vlist {
      scrollbar-width: thin;
      scrollbar-color: var(--nim-scrollbar-thumb) transparent;
    }
    .rich-transcript-vlist::-webkit-scrollbar {
      width: 8px;
    }
    .rich-transcript-vlist::-webkit-scrollbar-track {
      background: transparent;
    }
    .rich-transcript-vlist::-webkit-scrollbar-thumb {
      background-color: var(--nim-scrollbar-thumb);
      border-radius: 4px;
    }
    .rich-transcript-vlist::-webkit-scrollbar-thumb:hover {
      background-color: var(--nim-scrollbar-thumb-hover);
    }

    /* VList inner container styling */
    .rich-transcript-vlist > div {
      display: flex;
      flex-direction: column;
      max-width: 64rem;
      margin: 0 auto;
      padding: 0 0.75rem;
    }
    .rich-transcript-content.compact .rich-transcript-vlist > div {
      max-width: 72rem;
    }

    /* Copy button hover visibility */
    .rich-transcript-message-copy-action {
      opacity: 0;
      transition: opacity 0.15s ease-in-out;
    }
    .rich-transcript-message-content:hover .rich-transcript-message-copy-action {
      opacity: 1;
    }
    .rich-transcript-message-copy-action:has(.copied) {
      opacity: 1;
    }

    
    /* Animations */
    @keyframes thinking-pulse {
      0%, 100% {
        opacity: 0.4;
        transform: scale(0.9);
      }
      50% {
        opacity: 1;
        transform: scale(1.1);
      }
    }
    .rich-transcript-waiting-dot {
      animation: thinking-pulse 1.4s ease-in-out infinite;
    }
    .rich-transcript-waiting-dot:nth-child(1) { animation-delay: 0s; }
    .rich-transcript-waiting-dot:nth-child(2) { animation-delay: 0.2s; }
    .rich-transcript-waiting-dot:nth-child(3) { animation-delay: 0.4s; }

    @keyframes highlight {
      0%, 100% { background-color: inherit; }
      50% { background-color: var(--nim-bg-hover); }
    }
    .rich-transcript-message.highlight-message {
      animation: highlight 2s ease-in-out;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .rich-transcript-cursor {
      animation: pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }

    /* Scroll-ready fade-in transition to prevent flash when switching sessions */
    .rich-transcript-messages-wrapper {
      opacity: 0;
      transition: opacity 0.15s ease-out;
    }
    .rich-transcript-messages-wrapper.scroll-ready {
      opacity: 1;
    }
  `;
  document.head.appendChild(style);
};

// Initialize styles on module load
if (typeof document !== 'undefined') {
  injectRichTranscriptStyles();
}

/**
 * Inline component for displaying prompt additions (system prompt, user message, and attachments)
 * Shows as collapsible sections after user messages when the developer option is enabled
 * Persists across messages so users can reference additions from previous prompts
 */
const PromptAdditionsInline: React.FC<{
  systemPromptAddition: string | null;
  userMessageAddition: string | null;
  attachments?: Array<{ type: string; filename: string; mimeType?: string; filepath?: string }>;
  timestamp: number;
}> = ({ systemPromptAddition, userMessageAddition, attachments, timestamp }) => {
  const [isSystemExpanded, setIsSystemExpanded] = useState(false);
  const [isUserExpanded, setIsUserExpanded] = useState(false);
  const [isAttachmentsExpanded, setIsAttachmentsExpanded] = useState(false);

  const hasSystemPrompt = !!(systemPromptAddition && systemPromptAddition.trim().length > 0);
  const hasUserMessage = !!(userMessageAddition && userMessageAddition.trim().length > 0);
  const hasAttachments = !!(attachments && attachments.length > 0);

  if (!hasSystemPrompt && !hasUserMessage && !hasAttachments) {
    return null;
  }

  const formatTimestamp = (ts: number) => {
    return new Date(ts).toLocaleTimeString();
  };

  // Helper to render an expandable section
  const renderExpandableSection = (
    title: string,
    isExpanded: boolean,
    setExpanded: (v: boolean) => void,
    badge: string,
    content: React.ReactNode,
    hasMore: boolean
  ) => (
    <div className={hasMore ? 'mb-2' : ''}>
      <button
        onClick={() => setExpanded(!isExpanded)}
        className="flex items-center gap-1 bg-transparent border-none text-[var(--nim-text)] cursor-pointer p-1 text-xs font-medium hover:bg-[var(--nim-bg-hover)] rounded w-full text-left"
      >
        <span
          style={{
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s ease',
            display: 'inline-block',
            fontSize: '10px',
          }}
        >
          {'\u25B6'}
        </span>
        {title}
        <span className="text-[11px] text-[var(--nim-text-muted)] font-normal ml-1">
          ({badge})
        </span>
      </button>
      {isExpanded && (
        <div className="mt-1 ml-3">
          {content}
        </div>
      )}
    </div>
  );

  return (
    <div
      className="ml-6 mt-2 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-tertiary)] text-xs"
      style={{ maxHeight: '400px', overflowY: 'auto' }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--nim-border)]">
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase"
          style={{
            backgroundColor: 'var(--nim-warning)',
            color: 'var(--nim-bg)',
          }}
        >
          Dev
        </span>
        <span className="text-[var(--nim-text-muted)]">Prompt Additions</span>
        <span className="ml-auto text-[11px] text-[var(--nim-text-faint)]">
          {formatTimestamp(timestamp)}
        </span>
      </div>

      <div className="p-2">
        {/* Attachments Section */}
        {hasAttachments && renderExpandableSection(
          'Attachments',
          isAttachmentsExpanded,
          setIsAttachmentsExpanded,
          `${attachments!.length} file${attachments!.length > 1 ? 's' : ''}`,
          <div className="space-y-1">
            {attachments!.map((att, idx) => (
              <div
                key={idx}
                className="flex items-center gap-2 p-2 bg-[var(--nim-bg)] rounded border border-[var(--nim-border)] text-[11px] text-[var(--nim-text-muted)]"
              >
                <span
                  className="px-1 py-0.5 rounded text-[9px] font-medium uppercase"
                  style={{
                    backgroundColor: att.type === 'image' ? 'var(--nim-info)' : 'var(--nim-primary)',
                    color: 'white',
                  }}
                >
                  {att.type}
                </span>
                <span className="font-medium text-[var(--nim-text)]">{att.filename}</span>
                {att.mimeType && (
                  <span className="text-[var(--nim-text-faint)]">({att.mimeType})</span>
                )}
              </div>
            ))}
          </div>,
          hasSystemPrompt || hasUserMessage
        )}

        {/* System Prompt Section */}
        {hasSystemPrompt && renderExpandableSection(
          'System Prompt Addition',
          isSystemExpanded,
          setIsSystemExpanded,
          `${systemPromptAddition!.length} chars`,
          <pre
            className="m-0 p-2 bg-[var(--nim-bg)] rounded border border-[var(--nim-border)] text-[11px] leading-relaxed text-[var(--nim-text-muted)] overflow-auto"
            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '150px' }}
          >
            {systemPromptAddition}
          </pre>,
          hasUserMessage
        )}

        {/* User Message Addition Section */}
        {hasUserMessage && renderExpandableSection(
          'User Message Addition',
          isUserExpanded,
          setIsUserExpanded,
          `${userMessageAddition!.length} chars`,
          <pre
            className="m-0 p-2 bg-[var(--nim-bg)] rounded border border-[var(--nim-border)] text-[11px] leading-relaxed text-[var(--nim-text-muted)] overflow-auto"
            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '150px' }}
          >
            {userMessageAddition}
          </pre>,
          false
        )}
      </div>
    </div>
  );
};


interface RichTranscriptViewProps {
  sessionId: string;
  sessionStatus?: string;
  isProcessing?: boolean; // Whether the session is currently processing a request
  /** When true, session is waiting for user input — suppresses the "Thinking..." indicator */
  hasPendingInteractivePrompt?: boolean;
  messages: TranscriptViewMessage[];
  provider?: string;
  settings?: TranscriptSettings;
  onSettingsChange?: (settings: TranscriptSettings) => void;
  showSettings?: boolean;
  documentContext?: { filePath?: string };
  workspacePath?: string;
  /** Optional: render additional content in the empty state (e.g., command suggestions) */
  renderEmptyExtra?: () => React.ReactNode;
  /**
   * If true, suppress the default "ready to assist with" help block in the
   * empty state -- the host's `renderEmptyExtra` becomes the primary content.
   */
  hideEmptyHelp?: boolean;
  /** Optional: Read a file from the filesystem (for custom widgets that need to load persisted files) */
  readFile?: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
  /** Optional: Open a file in the editor, optionally scrolled to a line */
  onOpenFile?: (filePath: string, location?: TranscriptFileLocation) => void;
  /** Optional: Navigate to a session by ID (for @@session reference links) */
  onOpenSession?: (sessionId: string) => void;
  /** Optional: Callback to trigger /compact command */
  onCompact?: () => void | Promise<void>;
  /** Optional: Prompt additions for debugging (system prompt, user message, and attachments) */
  promptAdditions?: {
    systemPromptAddition: string | null;
    userMessageAddition: string | null;
    attachments?: Array<{ type: string; filename: string; mimeType?: string; filepath?: string }>;
    timestamp: number;
    messageIndex: number; // Index of user message this belongs to (for stable positioning)
  } | null;
  /** Optional: Current teammates/agents from session metadata, used to show status on spawn cards */
  currentTeammates?: Array<{ agentId: string; status: 'running' | 'completed' | 'errored' | 'idle' }>;
  /** Optional: noun used in waiting text when teammates/workers are still running */
  waitingForNoun?: string;
  /** Optional: background tasks the session is draining after the lead turn ended */
  backgroundTasks?: Array<{ description: string; startedAt: number }>;
  /** Optional: App start time (epoch ms) for rendering restart indicator line (dev mode only) */
  appStartTime?: number;
  /** Optional: Render a file using a host-provided embedded editor surface */
  renderEmbeddedFile?: (params: { filePath: string; defaultExpanded?: boolean }) => React.ReactNode;
  /**
   * Optional: Predicate the host uses to declare whether a given file
   * will be rendered by `renderEmbeddedFile`. Lets the runtime suppress
   * the redundant diff/new-file view when an embedded preview will take
   * over. The host owns the custom editor registry; this is how the
   * runtime asks without crossing the package boundary.
   */
  canEmbedFile?: (filePath: string) => boolean;
  /** Host callback for lazy, workspace-scoped history diff hydration. */
  loadToolCallDiffs?: (toolCallItemId: string, toolCallTimestamp?: number) => Promise<ToolCallDiffLoadResult>;
  /**
   * Optional: callback fired when the transcript find-in-page search bar
   * shows or hides. The parent uses this to shift `FloatingTranscriptActions`
   * (which sits absolutely-positioned at top-right of the same container)
   * down so the phase pill no longer overlaps the search bar's chevron / list
   * / close buttons on narrow widths. See #309.
   */
  onSearchBarVisibilityChange?: (visible: boolean) => void;
  /**
   * Optional: persist at-bottom state in the global per-session atom.
   * Disable for secondary transcript mounts like hover previews so they
   * don't stomp the main transcript's scroll-follow state.
   */
  persistScrollState?: boolean;
  // Note: Interactive widgets read their host from interactiveWidgetHostAtom(sessionId)
}

const defaultSettings: TranscriptSettings = {
  showToolCalls: true,
  compactMode: false,
  collapseTools: false,
  showThinking: true,
  showSessionInit: false,
};


const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 50;
const DESKTOP_TRANSCRIPT_BUFFER_PX = 10000;
const MOBILE_TRANSCRIPT_BUFFER_PX = 800;

export function isTranscriptAtBottom(distanceFromBottom: number): boolean {
  return distanceFromBottom < TRANSCRIPT_BOTTOM_THRESHOLD_PX;
}

export function shouldAutoScrollTranscript(
  wasAtBottom: boolean,
  distanceFromBottom: number,
  hasActiveSelection = false
): boolean {
  // Never yank the viewport while the user is dragging a text selection in the
  // transcript — the jump collapses the highlight they are making, which is the
  // single most common "I can't copy from the chat" complaint during streaming.
  if (hasActiveSelection) return false;
  return wasAtBottom || isTranscriptAtBottom(distanceFromBottom);
}

/**
 * True when the user has scrolled to the native top but the first row is still
 * drawn above it. On iOS WebKit virtua defers size-correction jumps until a
 * scroll gesture ends (writing scrollTop mid-momentum kills the momentum), and
 * reports the pending amount through a negative `getItemOffset(0)`. Rows above
 * the viewport are estimated before they are measured, so a long flick upward
 * bounces off a false top several messages into the session.
 */
export function isAtFalseTranscriptTop(scrollOffset: number, firstRowOffset: number): boolean {
  return scrollOffset <= 1 && firstRowOffset < -1;
}

/**
 * True only when there is a live, non-collapsed text selection whose anchor sits
 * inside the transcript root. Scopes the auto-scroll suppression to selections
 * made in the transcript, so selecting text elsewhere (the composer, a sidebar)
 * never blocks the chat from following new messages.
 */
export function hasActiveTranscriptSelection(root: HTMLElement | null): boolean {
  if (!root || typeof window === 'undefined') return false;
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const anchor = selection.anchorNode;
  return anchor != null && root.contains(anchor);
}

/**
 * The interactive-prompt tool set and the MCP prefix rule live in
 * `ai/server/interactivePromptTools` because the transcript parser and the live
 * Claude Code stream path need the same answers (#1341). Re-exported here so
 * existing importers and the renderer's `sessions.ts` mirror keep working.
 */
export { stripMcpPrefix, isInteractiveWidgetTool };



const getTranscriptMessageKey = (
  sessionId: string,
  message: TranscriptViewMessage,
  index: number
): string => {
  const stableId =
    Number.isFinite(message.id) ? `id-${message.id}` :
    Number.isFinite(message.sequence) ? `seq-${message.sequence}` :
    `idx-${index}`;
  return `${sessionId}-${stableId}`;
};


export const RichTranscriptView = React.forwardRef<
  { scrollToMessage: (index: number) => void; scrollToTop: () => void },
  RichTranscriptViewProps
>(({ sessionId, sessionStatus, isProcessing, hasPendingInteractivePrompt, messages, provider, settings: propsSettings, onSettingsChange, showSettings, documentContext, workspacePath, renderEmptyExtra, hideEmptyHelp, readFile, onOpenFile, onOpenSession, onCompact, promptAdditions, currentTeammates, waitingForNoun, backgroundTasks, appStartTime, renderEmbeddedFile, canEmbedFile, loadToolCallDiffs, onSearchBarVisibilityChange, persistScrollState = true }, ref) => {
  const [collapsedMessages, setCollapsedMessages] = useState<Set<number>>(new Set());
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const scrollButtonRef = useRef<HTMLDivElement>(null);
  const scrollButtonElementRef = useRef<HTMLButtonElement>(null);
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const [showSearchBar, setShowSearchBar] = useState(false);


  // Notify the parent when the find-in-page search bar visibility changes
  // so it can shift `FloatingTranscriptActions` (sibling, absolutely positioned
  // at top-right of the same container) down and avoid the pill-over-buttons
  // overlap reported in #309.
  useEffect(() => {
    onSearchBarVisibilityChange?.(showSearchBar);
  }, [showSearchBar, onSearchBarVisibilityChange]);

  const [isScrollReady, setIsScrollReady] = useState(false);
  const [isContainerVisible, setIsContainerVisible] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const viewRootRef = useRef<HTMLDivElement>(null);
  const vlistRef = useRef<VListHandle>(null);
  // Set when a scroll gesture hits a false top (see isAtFalseTranscriptTop);
  // onScrollEnd finishes the trip to the first row once virtua applies its jump.
  const hitFalseTopRef = useRef(false);
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const isAtBottomRef = useRef(
    persistScrollState ? getSessionIsAtBottom(sessionId) : true
  );

  // Desktop gets a wider buffer to reduce row churn near selection;
  // iOS WKWebView uses a smaller buffer for memory pressure.
  const isMobileWebKit = useMemo(() => isAppleMobileWebKit(), []);
  const vlistBufferSize = isMobileWebKit ? MOBILE_TRANSCRIPT_BUFFER_PX : DESKTOP_TRANSCRIPT_BUFFER_PX;

  const { pendingPermissionIndices, pendingPermissionsVisibleRef, showPermissionBanner, setShowPermissionBanner } =
    usePendingPermissionNavigation({ messages, sessionId, sessionStatus, isProcessing, currentTeammates, vlistRef });
  const { pendingQuestions, jumpToQuestion } = usePendingQuestionNavigation({
    messages, sessionId, vlistRef, scrollContainerRef, ready: isScrollReady && isContainerVisible,
  });

  const settings = propsSettings || defaultSettings;
  const previousRenderRef = useRef<{
    messagesRef: TranscriptViewMessage[];
    messageCount: number;
    sessionStatus: string | undefined;
    isProcessing: boolean | undefined;
    hasPendingInteractivePrompt: boolean | undefined;
    currentTeammatesRef: unknown;
    currentTeammatesSummary: string;
    isContainerVisible: boolean;
    isScrollReady: boolean;
    showPermissionBanner: boolean;
    showSearchBar: boolean;
  } | null>(null);

  useEffect(() => {
    isAtBottomRef.current = persistScrollState ? getSessionIsAtBottom(sessionId) : true;
  }, [persistScrollState, sessionId]);

  const setAtBottomState = useCallback((isAtBottom: boolean) => {
    isAtBottomRef.current = isAtBottom;
    if (persistScrollState) {
      setSessionIsAtBottom(sessionId, isAtBottom);
    }
  }, [persistScrollState, sessionId]);

  const getAtBottomState = useCallback(() => {
    return isAtBottomRef.current;
  }, []);

  // Save VList cache when switching sessions or unmounting.
  // This lets returning to a session skip expensive re-measurement of all item sizes.
  useEffect(() => {
    return () => {
      if (vlistRef.current && sessionId) {
        vlistCacheMap.set(sessionId, vlistRef.current.cache);
      }
    };
  }, [sessionId]);

  // Track container visibility - when parent is display:none (e.g. mode switch),
  // VList gets 0 height and renders ALL items instead of virtualizing.
  // Skip rendering the message list entirely when hidden.
  useEffect(() => {
    const el = viewRootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        setIsContainerVisible(entries[0]?.isIntersecting ?? false);
      },
      { threshold: 0 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const nextState = {
      messagesRef: messages,
      messageCount: messages.length,
      sessionStatus,
      isProcessing,
      hasPendingInteractivePrompt,
      currentTeammatesRef: currentTeammates,
      currentTeammatesSummary: summarizeRenderTeammates(currentTeammates),
      isContainerVisible,
      isScrollReady,
      showPermissionBanner,
      showSearchBar,
    };
    const previous = previousRenderRef.current;
    if (!previous) {
      emitRichTranscriptRenderTrace('initial', {
        sessionId,
        messageCount: nextState.messageCount,
        sessionStatus,
        isProcessing,
        hasPendingInteractivePrompt,
        currentTeammates: nextState.currentTeammatesSummary,
        isContainerVisible,
        isScrollReady,
        showPermissionBanner,
        showSearchBar,
      });
    } else {
      const reasons: string[] = [];
      if (previous.messagesRef !== nextState.messagesRef) reasons.push(`messages-ref ${previous.messageCount}->${nextState.messageCount}`);
      if (previous.sessionStatus !== nextState.sessionStatus) reasons.push(`sessionStatus ${String(previous.sessionStatus)}->${String(nextState.sessionStatus)}`);
      if (previous.isProcessing !== nextState.isProcessing) reasons.push(`isProcessing ${String(previous.isProcessing)}->${String(nextState.isProcessing)}`);
      if (previous.hasPendingInteractivePrompt !== nextState.hasPendingInteractivePrompt) reasons.push(`pendingPrompt ${String(previous.hasPendingInteractivePrompt)}->${String(nextState.hasPendingInteractivePrompt)}`);
      if (previous.currentTeammatesRef !== nextState.currentTeammatesRef) reasons.push(`currentTeammates ${previous.currentTeammatesSummary}->${nextState.currentTeammatesSummary}`);
      if (previous.isContainerVisible !== nextState.isContainerVisible) reasons.push(`isContainerVisible ${String(previous.isContainerVisible)}->${String(nextState.isContainerVisible)}`);
      if (previous.isScrollReady !== nextState.isScrollReady) reasons.push(`isScrollReady ${String(previous.isScrollReady)}->${String(nextState.isScrollReady)}`);
      if (previous.showPermissionBanner !== nextState.showPermissionBanner) reasons.push(`showPermissionBanner ${String(previous.showPermissionBanner)}->${String(nextState.showPermissionBanner)}`);
      if (previous.showSearchBar !== nextState.showSearchBar) reasons.push(`showSearchBar ${String(previous.showSearchBar)}->${String(nextState.showSearchBar)}`);
      emitRichTranscriptRenderTrace('render', {
        sessionId,
        reasons,
        messageCount: nextState.messageCount,
        sessionStatus,
        isProcessing,
        hasPendingInteractivePrompt,
        currentTeammates: nextState.currentTeammatesSummary,
        isContainerVisible,
        isScrollReady,
        showPermissionBanner,
        showSearchBar,
      });
    }
    previousRenderRef.current = nextState;
  });

  const runningTeammates = useMemo(
    () => currentTeammates?.filter(t => t.status === 'running') ?? [],
    [currentTeammates]
  );

  // Question tool calls with no result, split by the last user message. The
  // superseded ones render as skipped even when no durable result row exists
  // (older transcripts).
  const unansweredQuestions = useMemo(() => partitionUnansweredQuestions(messages), [messages]);
  // Keyed on content so the Set keeps its identity across streamed frames;
  // sub-agent tool cards receive it and would otherwise re-render every frame.
  const skippedQuestionIdsKey = unansweredQuestions.superseded.map(question => question.id).join('\u0000');
  const skippedQuestionIds = useMemo(
    () => new Set(skippedQuestionIdsKey ? skippedQuestionIdsKey.split('\u0000') : []),
    [skippedQuestionIdsKey]
  );

  // Determine if we're waiting for a response (used for scroll behavior and UI)
  const isWaitingForResponse = useMemo(() => {
    // Session is waiting for the USER to answer — not thinking, don't show the indicator.
    // Check the prop (live IPC state) AND scan messages directly (survives session reloads).
    if (hasPendingInteractivePrompt) return false;
    // Only an OPEN question means the agent is waiting on the user. A question
    // the user moved past by sending a new message must not hide Thinking.
    const hasPendingQuestion = unansweredQuestions.open.length > 0;
    if (hasPendingQuestion) return false;
    // Check isProcessing prop first (most reliable for queued prompts from mobile)
    if (isProcessing) return true;
    if (sessionStatus === 'running') return true;
    if (sessionStatus === 'waiting' && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      return lastMessage.type === 'user_message';
    }
    if (runningTeammates.length > 0) return true;
    return false;
  }, [messages, sessionStatus, isProcessing, hasPendingInteractivePrompt, runningTeammates, unansweredQuestions]);

  /**
   * Anchored to the last user message, the same anchor "Finished in ..." uses.
   * A turn resumed without a fresh user message reads high; inherited.
   */
  const turnStartedAt = useMemo(() => {
    if (!isWaitingForResponse) return undefined;
    // Draining background work: count from when the oldest task started.
    if (backgroundTasks?.length) return Math.min(...backgroundTasks.map(t => t.startedAt));
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'user_message') return messages[i].createdAt?.getTime();
    }
    return undefined;
  }, [isWaitingForResponse, messages, backgroundTasks]);

  // Ref callback rather than state; see the hook for why.
  const turnElapsedRef = useElapsedTimeRef(turnStartedAt);

  // Compute waiting indicator text — show agent/teammate count when lead is idle but agents are running
  const waitingText = useMemo(() => {
    if (!isWaitingForResponse) return '';
    if (backgroundTasks?.length) {
      return backgroundTasks.length === 1
        ? `Waiting on background task: ${backgroundTasks[0].description || 'background task'}`
        : `Waiting on ${backgroundTasks.length} background tasks...`;
    }
    if (runningTeammates.length > 0 && !isProcessing && sessionStatus !== 'running') {
      const singular = waitingForNoun || 'agent';
      const plural = singular.endsWith('s') ? singular : `${singular}s`;
      const label = runningTeammates.length === 1 ? singular : plural;
      return `Waiting for ${runningTeammates.length} ${label} to complete...`;
    }
    return 'Thinking...';
  }, [isProcessing, isWaitingForResponse, runningTeammates, sessionStatus, waitingForNoun, backgroundTasks]);

  // Compute effective target index for prompt additions display
  // Use the stored messageIndex if valid, otherwise find the last user message
  const promptAdditionsTargetIndex = useMemo(() => {
    if (!promptAdditions) return -1;
    const storedIndex = promptAdditions.messageIndex;
    // Check if stored index is valid and points to a user message
    if (storedIndex >= 0 && storedIndex < messages.length && messages[storedIndex]?.type === 'user_message') {
      return storedIndex;
    }
    // Fallback: find the last user message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'user_message') {
        return i;
      }
    }
    return -1;
  }, [messages, promptAdditions]);

  // Compute restart line position: find the first visible message after appStartTime
  // The red restart indicator line renders before this message, or at the bottom if all messages precede the restart
  // Only shown for sessions that existed before the restart (have pre-restart messages)
  const { restartAfterIndex, restartAtBottom } = useMemo(() => {
    if (!appStartTime || messages.length === 0) return { restartAfterIndex: -1, restartAtBottom: false };
    // Only show restart indicator if this session has messages from before the restart
    const hasPreRestartMessages = messages.some(m => (m.createdAt?.getTime() ?? 0) <= appStartTime);
    if (!hasPreRestartMessages) return { restartAfterIndex: -1, restartAtBottom: false };
    // If all messages are before restart, show at bottom
    if ((messages[messages.length - 1].createdAt?.getTime() ?? 0) <= appStartTime) return { restartAfterIndex: -1, restartAtBottom: true };
    // Find the first message after restart that will actually be rendered visibly:
    // Skip tool messages (they render hidden, grouped with the next assistant message)
    for (let i = 0; i < messages.length; i++) {
      if ((messages[i].createdAt?.getTime() ?? 0) > appStartTime && messages[i].type !== 'tool_call') {
        return { restartAfterIndex: i, restartAtBottom: false };
      }
    }
    return { restartAfterIndex: -1, restartAtBottom: false };
  }, [messages, appStartTime]);

  // Codex SDK reuses item IDs across session resumes, which can create
  // duplicate tool_call events with the same providerToolCallId. When
  // duplicates exist, hide the earlier (superseded) ones so only the
  // latest version renders (typically the completed one).
  const supersededToolIndices = useMemo(() => {
    const indices = new Set<number>();
    // Map from providerToolCallId -> last seen message index
    const lastSeenByToolId = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      const id = messages[i].toolCall?.providerToolCallId;
      if (id) {
        const prev = lastSeenByToolId.get(id);
        if (prev !== undefined) {
          // Mark the earlier one as superseded
          indices.add(prev);
        }
        lastSeenByToolId.set(id, i);
      }
    }
    return indices;
  }, [messages]);

  // Expose scroll method via ref
  React.useImperativeHandle(ref, () => ({
    scrollToMessage: (index: number) => {
      if (!vlistRef.current) return;
      vlistRef.current.scrollToIndex(index, { align: 'center' });
      // Highlight after scroll settles
      setTimeout(() => {
        const messageDiv = messageRefs.current.get(index);
        if (messageDiv) {
          messageDiv.classList.add('highlight-message');
          setTimeout(() => {
            messageDiv.classList.remove('highlight-message');
          }, 2000);
        }
      }, 100);
    },
    scrollToTop: () => {
      vlistRef.current?.scrollToIndex(0, { align: 'start' });
    }
  }), []);

  // Reset scroll-ready state when session changes or container hides
  useEffect(() => {
    setIsScrollReady(false);
  }, [sessionId, isContainerVisible]);

  // Initialize scroll to bottom when session loads or container becomes visible
  useEffect(() => {
    if (!isContainerVisible) return;

    if (messages.length === 0) {
      // Empty session is ready immediately
      setIsScrollReady(true);
      return;
    }

    // Single RAF: wrapper is opacity:0 until scroll-ready, so intermediate state is invisible.
    // With itemSize hint + cache, VList can estimate scroll position accurately on first try.
    let frame: number;
    frame = requestAnimationFrame(() => {
      if (pendingQuestions.length === 0) {
        vlistRef.current?.scrollToIndex(messages.length - 1, { align: 'end' });
      }
      frame = requestAnimationFrame(() => {
        setIsScrollReady(true);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [sessionId, isContainerVisible]); // Re-run when session changes or container becomes visible

  // Auto-scroll to bottom when messages change (if user was at bottom)
  useEffect(() => {
    if (pendingQuestions.length > 0) return;
    const wasAtBottom = getAtBottomState();

    const frame = requestAnimationFrame(() => {
      if (!vlistRef.current) return;
      const scrollSize = vlistRef.current.scrollSize;
      const viewportSize = vlistRef.current.viewportSize;
      const scrollOffset = vlistRef.current.scrollOffset;
      const distanceFromBottom = scrollSize - scrollOffset - viewportSize;

      const hasActiveSelection = hasActiveTranscriptSelection(viewRootRef.current);
      if (shouldAutoScrollTranscript(wasAtBottom, distanceFromBottom, hasActiveSelection)) {
        // Account for the "Thinking..." indicator which is an extra item after messages
        const lastIndex = isWaitingForResponse ? messages.length : messages.length - 1;
        vlistRef.current.scrollToIndex(lastIndex, { align: 'end' });
        setAtBottomState(true);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [getAtBottomState, messages, isWaitingForResponse, setAtBottomState, pendingQuestions.length]);

  // Listen for routed search events from AgentWorkstreamPanel
  // Only respond if this session is the active one
  useEffect(() => {
    const handleFind = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail?.sessionId === sessionId) {
        setShowSearchBar(true);
      }
    };

    const handleFindNext = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail?.sessionId === sessionId && showSearchBar) {
        window.dispatchEvent(new CustomEvent('transcript-search-next'));
      }
    };

    const handleFindPrevious = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail?.sessionId === sessionId && showSearchBar) {
        window.dispatchEvent(new CustomEvent('transcript-search-prev'));
      }
    };

    window.addEventListener('transcript:find', handleFind);
    window.addEventListener('transcript:find-next', handleFindNext);
    window.addEventListener('transcript:find-previous', handleFindPrevious);

    return () => {
      window.removeEventListener('transcript:find', handleFind);
      window.removeEventListener('transcript:find-next', handleFindNext);
      window.removeEventListener('transcript:find-previous', handleFindPrevious);
    };
  }, [sessionId, showSearchBar]);

  const scrollToBottom = useCallback(() => {
    if (!vlistRef.current) return;
    // Account for the "Thinking..." indicator which is an extra item after messages
    const lastIndex = isWaitingForResponse ? messages.length : messages.length - 1;
    vlistRef.current.scrollToIndex(lastIndex, { align: 'end' });
  }, [messages.length, isWaitingForResponse]);

  const toggleMessageCollapse = useCallback((index: number) => {
    setCollapsedMessages(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const toggleToolExpand = useCallback((toolId: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(toolId)) {
        next.delete(toolId);
      } else {
        next.add(toolId);
      }
      return next;
    });
  }, []);

  const copyTranscriptViewMessageContent = useCallback(async (message: TranscriptViewMessage, index: number) => {
    try {
      await copyToClipboard(message.text ?? '');
      setCopiedMessageIndex(index);
      setTimeout(() => setCopiedMessageIndex(null), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  }, []);

  const registerMessageRef = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) {
      messageRefs.current.set(index, el);
    } else {
      messageRefs.current.delete(index);
    }
  }, []);

  // Auto-expand sub-agent (Task) tools. Keep the same Set when every id is
  // already expanded: a new Set re-renders every row holding a tool card.
  useEffect(() => {
    setExpandedTools(prev => {
      let next: Set<string> | null = null;
      for (const msg of messages) {
        if (msg.type === 'subagent' && msg.subagentId && !prev.has(msg.subagentId)) {
          next ??= new Set(prev);
          next.add(msg.subagentId);
        }
      }
      return next ?? prev;
    });
  }, [messages]);

  const subagentContext = useMemo<SubagentChildContext>(
    () => ({ expandedTools, skippedQuestionIds, currentTeammates }),
    [expandedTools, skippedQuestionIds, currentTeammates]
  );

  const toolShared = useMemo<TranscriptToolShared>(
    () => ({
      sessionId,
      workspacePath,
      readFile,
      onOpenFile,
      onOpenSession,
      renderEmbeddedFile,
      canEmbedFile,
      loadToolCallDiffs,
      onToggleTool: toggleToolExpand,
    }),
    [sessionId, workspacePath, readFile, onOpenFile, onOpenSession, renderEmbeddedFile, canEmbedFile, loadToolCallDiffs, toggleToolExpand]
  );

  // Neighbour-derived row state in one pass. Unchanged infos keep their
  // identity (compared against the previous pass), so memoized rows skip.
  const previousRowInfosRef = useRef<TranscriptRowInfo[] | null>(null);
  const rowInfos = useMemo(() => {
    const next = computeTranscriptRowInfos(
      messages,
      {
        showToolCalls: settings.showToolCalls,
        expandedTools,
        supersededToolIndices,
        skippedQuestionIds,
        subagentContext,
        isWaitingForResponse,
        restartAfterIndex,
      },
      previousRowInfosRef.current
    );
    previousRowInfosRef.current = next;
    return next;
  }, [messages, settings.showToolCalls, expandedTools, supersededToolIndices, skippedQuestionIds, subagentContext, isWaitingForResponse, restartAfterIndex]);

  // Rendered message rows. Each row's outer div carries `data-message-index`
  // and registers its DOM node in `messageRefs` so imperative scroll and
  // selection helpers can find them.
  const renderedMessages = messages.map((message, index) => (
    <TranscriptMessageRow
      key={getTranscriptMessageKey(sessionId, message, index)}
      message={message}
      index={index}
      info={rowInfos[index]}
      isCollapsed={collapsedMessages.has(index)}
      isCopied={copiedMessageIndex === index}
      showThinking={settings.showThinking}
      compactMode={settings.compactMode}
      provider={provider}
      documentContext={documentContext}
      appStartTime={appStartTime}
      onCompact={onCompact}
      toolShared={toolShared}
      onToggleCollapse={toggleMessageCollapse}
      onCopy={copyTranscriptViewMessageContent}
      registerMessageRef={registerMessageRef}
    />
  ));

  return (
    <div ref={viewRootRef} className="rich-transcript-view h-full flex flex-col bg-[var(--nim-bg)] relative overflow-x-hidden select-text">
      {/* Search Bar */}
      <TranscriptSearchBar
        isVisible={showSearchBar}
        messages={messages}
        containerRef={scrollContainerRef}
        onClose={() => setShowSearchBar(false)}
        onScrollToMessage={(index) => {
          vlistRef.current?.scrollToIndex(index, { align: 'center' });
        }}
      />

      {/* Settings Panel */}
      {showSettings && onSettingsChange && (
        <div className="rich-transcript-settings py-2 px-3 border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
          <div className="rich-transcript-settings-controls flex flex-wrap gap-3 text-xs">
            <label className="rich-transcript-settings-label flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.showToolCalls}
                onChange={(e) => onSettingsChange({ ...settings, showToolCalls: e.target.checked })}
                className="rich-transcript-settings-checkbox rounded border border-[var(--nim-border)]"
              />
              <span>Show Tool Calls</span>
            </label>
            <label className="rich-transcript-settings-label flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.compactMode}
                onChange={(e) => onSettingsChange({ ...settings, compactMode: e.target.checked })}
                className="rich-transcript-settings-checkbox rounded border border-[var(--nim-border)]"
              />
              <span>Compact Mode</span>
            </label>
            <label className="rich-transcript-settings-label flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.showThinking}
                onChange={(e) => onSettingsChange({ ...settings, showThinking: e.target.checked })}
                className="rich-transcript-settings-checkbox rounded border border-[var(--nim-border)]"
              />
              <span>Show Thinking</span>
            </label>
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        className="rich-transcript-scroll-container flex-1 min-h-0 relative overflow-hidden"
      >
        <div className={`rich-transcript-content mx-auto py-1 h-full ${settings.compactMode ? 'compact' : 'normal'}`}>
          {messages.length === 0 && !isWaitingForResponse ? (
            <div className="rich-transcript-empty flex flex-col items-center p-8 px-4 h-full max-w-4xl mx-auto">

              {hideEmptyHelp ? (
                <div className="rich-transcript-empty-extras-wrap flex-1 flex flex-col items-center justify-center w-full">
                  {renderEmptyExtra?.()}
                </div>
              ) : (
                renderEmptyExtra?.()
              )}
            </div>
          ) : !isContainerVisible ? (
            /* Skip VList rendering when container is hidden (display:none parent).
               VList with 0 height renders ALL items instead of virtualizing,
               causing massive DOM bloat and style recalculation. */
            null
          ) : (
            <div className={`rich-transcript-messages rich-transcript-messages-wrapper flex flex-col max-w-full overflow-x-hidden h-full ${isScrollReady ? 'scroll-ready' : ''}`}>
              <VList
                  ref={vlistRef}
                  className="rich-transcript-vlist !h-full !w-full"
                  style={{ height: '100%' }}
                  bufferSize={vlistBufferSize}
                  itemSize={90}
                  cache={vlistCacheMap.get(sessionId)}
                  onScrollEnd={() => {
                    if (!hitFalseTopRef.current) return;
                    hitFalseTopRef.current = false;
                    // Programmatic scrollToIndex applies jumps immediately and
                    // re-measures until stable, so it lands on the real first row.
                    vlistRef.current?.scrollToIndex(0, { align: 'start' });
                  }}
                  onScroll={(offset) => {
                    // Track if we're at the bottom for auto-scroll using per-session atom
                    if (vlistRef.current) {
                      if (isAtFalseTranscriptTop(offset, vlistRef.current.getItemOffset(0))) {
                        hitFalseTopRef.current = true;
                      } else if (offset > vlistRef.current.viewportSize / 2) {
                        // User headed back down in the same gesture; don't yank them up.
                        hitFalseTopRef.current = false;
                      }
                      const scrollSize = vlistRef.current.scrollSize;
                      const viewportSize = vlistRef.current.viewportSize;
                      const distanceFromBottom = scrollSize - offset - viewportSize;
                      const isAtBottom = isTranscriptAtBottom(distanceFromBottom);
                      // Update the per-session atom - this persists across component remounts
                      setAtBottomState(isAtBottom);
                      if (scrollButtonRef.current) {
                        const show = distanceFromBottom > viewportSize;
                        scrollButtonRef.current.style.opacity = show ? '1' : '0';
                        // Only the button opts back into pointer events, and only while visible.
                        // Clearing it lets the button inherit the container's pointer-events: none.
                        if (scrollButtonElementRef.current) {
                          scrollButtonElementRef.current.style.pointerEvents = show ? 'auto' : '';
                        }
                      }
                      // Check if any pending permission widgets are visible in viewport
                      if (pendingPermissionIndices.length > 0) {
                        const firstVisibleIdx = vlistRef.current.findItemIndex(offset);
                        const lastVisibleIdx = vlistRef.current.findItemIndex(offset + viewportSize);
                        const anyVisible = pendingPermissionIndices.some(
                          idx => idx >= firstVisibleIdx && idx <= lastVisibleIdx
                        );
                        if (pendingPermissionsVisibleRef.current !== anyVisible) {
                          pendingPermissionsVisibleRef.current = anyVisible;
                          setShowPermissionBanner(!anyVisible);
                        }
                      } else if (showPermissionBanner) {
                        setShowPermissionBanner(false);
                      }
                  }
                  }}
                >
                  {renderedMessages}
                  {/* Restart indicator at bottom when all messages precede the restart (dev mode only) */}
                  {restartAtBottom && (
                    <div key="restart-bottom" className="flex items-center gap-3 my-2 px-3">
                      <div className="flex-1 h-px bg-[var(--nim-error)]" />
                      <span className="text-[11px] font-medium text-[var(--nim-error)] whitespace-nowrap">
                        Nimbalyst restarted {formatMessageTime(appStartTime!)}
                      </span>
                      <div className="flex-1 h-px bg-[var(--nim-error)]" />
                    </div>
                  )}
                  {isWaitingForResponse && (
                    <div key="waiting" className="rich-transcript-waiting flex items-center gap-2 text-[var(--nim-text-muted)] italic py-2 px-4 mb-2">
                      <div className="rich-transcript-waiting-dots flex gap-1">
                        <div className="rich-transcript-waiting-dot w-2 h-2 rounded-full bg-[var(--nim-primary)]" />
                        <div className="rich-transcript-waiting-dot w-2 h-2 rounded-full bg-[var(--nim-primary)]" />
                        <div className="rich-transcript-waiting-dot w-2 h-2 rounded-full bg-[var(--nim-primary)]" />
                      </div>
                      <span className="rich-transcript-waiting-text">{waitingText}</span>
                      {turnStartedAt !== undefined && (
                        <span
                          ref={turnElapsedRef}
                          className="rich-transcript-waiting-elapsed tabular-nums not-italic text-[var(--nim-text-faint)]"
                          data-testid="turn-elapsed"
                        />
                      )}
                    </div>
                  )}
              </VList>
            </div>
          )}
        </div>

        {/* Pending permissions banner - shown when pending permission widgets are scrolled out of view */}
        {showPermissionBanner && pendingPermissionIndices.length > 0 && (
          <div className="sticky bottom-12 flex justify-center z-10 pointer-events-none">
            <button
              onClick={() => {
                const targetIdx = pendingPermissionIndices[0];
                vlistRef.current?.scrollToIndex(targetIdx, { align: 'center' });
              }}
              className="pointer-events-auto flex items-center gap-2 px-4 py-2 bg-[var(--nim-primary)] text-white rounded-full shadow-lg text-sm font-medium cursor-pointer border-none transition-all hover:brightness-110"
            >
              <MaterialSymbol icon="shield" size={16} />
              {pendingPermissionIndices.length} pending permission{pendingPermissionIndices.length > 1 ? 's' : ''} — click to review
            </button>
          </div>
        )}

        {/* Scroll to bottom button - uses ref + opacity to avoid layout shifts that interfere with text selection.
            The container spans the full pane width, so it must stay pointer-events-none in every state;
            only the button opts back in, otherwise it becomes a dead band for clicks and the wheel. */}
        <div ref={scrollButtonRef} className="rich-transcript-scroll-button-container sticky bottom-3 flex justify-center pointer-events-none opacity-0 transition-opacity">
          <button
            ref={scrollButtonElementRef}
            onClick={scrollToBottom}
            className="rich-transcript-scroll-button w-9 h-9 flex items-center justify-center bg-[var(--nim-primary)] text-white rounded-full border-none shadow-lg cursor-pointer transition-all hover:bg-[var(--nim-primary-hover)] hover:scale-110"
            title="Scroll to bottom"
          >
            <MaterialSymbol icon="arrow_downward" size={20} />
          </button>
        </div>
      </div>
      {pendingQuestions.length > 0 && (
        <div className="rich-transcript-question-navigation shrink-0 flex justify-end border-t border-[var(--nim-border)] bg-[var(--nim-bg)] px-3 py-2">
          <button
            onClick={() => jumpToQuestion(pendingQuestions[0])}
            aria-label="Jump to question"
            className="rich-transcript-question-button flex items-center gap-1.5 px-3 py-1.5 bg-[var(--nim-primary)] text-[var(--nim-on-primary)] rounded-md text-xs font-medium cursor-pointer border-none hover:brightness-110"
          >
            <MaterialSymbol icon="help" size={16} />
            Jump to question
          </button>
        </div>
      )}
    </div>
  );
});

RichTranscriptView.displayName = 'RichTranscriptView';
