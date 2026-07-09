import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { VList, type VListHandle, type CacheSnapshot } from 'virtua';
import type { TranscriptViewMessage, SessionData } from '../../../ai/server/types';
import type { TranscriptSettings } from '../types';
import { MessageSegment } from './MessageSegment';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ProviderIcon } from '../../icons/ProviderIcons';
import { MaterialSymbol } from '../../icons/MaterialSymbol';
import { formatMessageTime, formatDuration, formatTurnFinishedAt } from '../../../utils/dateUtils';
import { copyToClipboard } from '../../../utils/clipboard';
import { JSONViewer } from './JSONViewer';
import { formatToolArguments, extractFilePathFromArgs } from '../utils/pathResolver';
import { EditToolResultCard } from './EditToolResultCard';
import { TranscriptSearchBar } from './TranscriptSearchBar';
import { formatToolDisplayName } from '../utils/toolNameFormatter';
import { isToolLikeMessage } from '../utils/messageTypeHelpers';
import { getCustomToolWidget, ToolWidgetErrorBoundary, type ToolCallDiffResult } from './CustomToolWidgets';
import { useTranscriptToolWidgetRegistryVersion } from '../contributions';
import { ToolCallChanges } from './ToolCallChanges';
import { setSessionIsAtBottom, getSessionIsAtBottom } from '../../../store/atoms/transcriptScroll';
import { isAppleMobileWebKit } from '../../../utils/platform';

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

const REMINDER_KIND_LABELS: Record<string, string> = {
  session_naming: 'Session metadata reminder',
  wakeup_resume: 'Resumed from scheduled wakeup',
};

// Keyed by the known PermissionDeniedReasonType values from the SDK. Typed
// here as a partial record so an unknown value (forward-compatible SDK
// addition) falls back to the raw string or "SDK" in the renderer.
const REASON_TYPE_LABELS: Partial<Record<string, string>> = {
  classifier: 'Auto-mode classifier',
  mode: 'Permission mode',
  rule: 'Permission rule',
  asyncAgent: 'Async agent',
};

const PermissionDeniedCard: React.FC<{
  message: TranscriptViewMessage;
}> = ({ message }) => {
  const payload = message.systemMessage;
  const toolName = payload?.deniedToolName ?? 'unknown tool';
  const reason = payload?.deniedReason;
  const reasonType = payload?.deniedReasonType;
  const reasonLabel = (reasonType && REASON_TYPE_LABELS[reasonType]) ?? reasonType ?? 'SDK';

  return (
    <div
      data-testid="permission-denied-card"
      className="permission-denied-card ml-6 mb-2 rounded-md border border-[var(--nim-error)] bg-[var(--nim-error-bg,rgba(239,68,68,0.08))] px-3 py-2"
    >
      <div className="flex items-center gap-2 text-xs text-[var(--nim-error)]">
        <MaterialSymbol icon="block" size={14} />
        <span className="font-semibold uppercase tracking-[0.08em]">Tool denied</span>
        <span className="text-[var(--nim-text-muted)]">·</span>
        <code className="text-[11px] font-mono text-[var(--nim-text)]">{toolName}</code>
        <span className="ml-auto text-[10px] text-[var(--nim-text-faint)]">
          {formatMessageTime(message.createdAt?.getTime() ?? 0)}
        </span>
      </div>
      {reason && (
        <p className="m-0 mt-1.5 text-[0.875rem] leading-relaxed text-[var(--nim-text-muted)] whitespace-normal break-words">
          {reason}
        </p>
      )}
      <p className="m-0 mt-1 text-[10px] uppercase tracking-wide text-[var(--nim-text-faint)]">
        Source: {reasonLabel}
      </p>
    </div>
  );
};

const SystemReminderCard: React.FC<{
  message: TranscriptViewMessage;
}> = ({ message }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const content = (message.text ?? '')
    .replace(/^\s*<SYSTEM_REMINDER>/, '')
    .replace(/<\/SYSTEM_REMINDER>\s*$/, '')
    .replace(/`([^`]+)`/g, '$1')
    .trim();

  if (!content) {
    return null;
  }

  const reminderKind =
    message.systemMessage?.reminderKind ??
    (typeof message.metadata?.reminderKind === 'string'
      ? (message.metadata.reminderKind as string)
      : undefined);
  const label =
    (reminderKind && REMINDER_KIND_LABELS[reminderKind]) ?? 'System Reminder';

  return (
    <div className="rich-transcript-system-reminder ml-6 mb-2 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-tertiary)] px-3 py-2">
      <button
        type="button"
        onClick={() => setIsExpanded(v => !v)}
        className="flex w-full items-center gap-2 text-left text-xs text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]"
        aria-expanded={isExpanded}
      >
        <MaterialSymbol
          icon="chevron_right"
          size={14}
          className={`shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
        />
        <MaterialSymbol icon="notification_important" size={14} />
        <span className="font-medium uppercase tracking-[0.08em]">{label}</span>
        <span className="ml-auto text-[10px] text-[var(--nim-text-faint)]">
          {formatMessageTime(message.createdAt?.getTime() ?? 0)}
        </span>
      </button>
      {isExpanded && (
        <p className="m-0 mt-2 text-[0.875rem] leading-relaxed text-[var(--nim-text-muted)] whitespace-normal break-words">
          {content}
        </p>
      )}
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
  /** Optional: Open a file in the editor */
  onOpenFile?: (filePath: string) => void;
  /** Optional: Navigate to a session by ID (for @@session reference links) */
  onOpenSession?: (sessionId: string) => void;
  /** Optional: Callback to trigger /compact command */
  onCompact?: () => void;
  /** Optional: Edit a previously-sent user message and rewind the conversation to it.
   * `hasDownstream` is true when messages follow the edited one (so the host can
   * confirm the destructive truncation). */
  onEditUserMessage?: (rawMessageId: number, currentText: string, hasDownstream: boolean) => void;
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

// Lowercased tool names that should render with EditToolResultCard.
// 'applypatch'/'apply_patch' covers Codex ACP's apply_patch tool, which
// emits its diff via a `changes: { [path]: { type, unified_diff } }` shape
// (parsed in extractEditsFromToolMessage).
// OpenAI Codex SDK's `file_change` tool is NOT in this set -- the raw
// item.completed payload has no diff content, so its dispatch goes through
// the main-process transcript enrichment path, which resolves fileDiffs before
// the renderer sees the transcript row.
const EDIT_TOOL_NAMES = new Set([
  'edit', 'write', 'multi-edit', 'multiedit', 'multi_edit',
  'applypatch', 'apply_patch',
]);

const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 50;
const DESKTOP_TRANSCRIPT_BUFFER_PX = 10000;
const MOBILE_TRANSCRIPT_BUFFER_PX = 800;

export function isTranscriptAtBottom(distanceFromBottom: number): boolean {
  return distanceFromBottom < TRANSCRIPT_BOTTOM_THRESHOLD_PX;
}

export function shouldAutoScrollTranscript(
  wasAtBottom: boolean,
  distanceFromBottom: number
): boolean {
  return wasAtBottom || isTranscriptAtBottom(distanceFromBottom);
}

const isEditToolName = (name?: string): boolean => {
  if (!name) return false;
  const normalized = name.toLowerCase();
  if (EDIT_TOOL_NAMES.has(normalized)) return true;
  if (normalized.endsWith('__edit')) return true;
  if (normalized.endsWith(':edit')) return true;
  return false;
};

const WRITE_TOOL_NAMES = new Set(['write', 'notebookedit']);

/**
 * Interactive tool widgets that require the user to act. These render even when
 * `settings.showToolCalls` is false, so the user can still respond to prompts
 * (permission grants, plan-mode exits, question answers, structured input
 * prompts, commit proposals).
 */
const INTERACTIVE_WIDGET_TOOLS = new Set([
  'ToolPermission',
  'ExitPlanMode',
  'AskUserQuestion',
  'PromptForUserInput',
  'RequestUserInput',
  'GitCommitProposal',
  'git_commit_proposal',
  'developer_git_commit_proposal',
  'developer.git_commit_proposal',
]);

/**
 * MCP tools arrive as `mcp__<server>__<toolName>` (server name may contain
 * dashes or underscores). When the tool was registered with a bare name like
 * `AskUserQuestion` on the in-app MCP server, the SDK forwards it as
 * `mcp__nimbalyst-mcp__AskUserQuestion`. Strict equality against the bare set
 * misses, so the suppression / grouping logic below uses the un-prefixed name.
 *
 * Exported for tests; mirrored on the renderer in `sessions.ts`.
 */
export function stripMcpPrefix(toolName: string): string {
  const match = toolName.match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/);
  return match ? match[1] : toolName;
}

export function isInteractiveWidgetTool(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  return INTERACTIVE_WIDGET_TOOLS.has(stripMcpPrefix(toolName));
}

const isFileModifyingTool = (name?: string): boolean => {
  if (!name) return false;
  const normalized = name.toLowerCase();
  if (EDIT_TOOL_NAMES.has(normalized)) return true;
  if (WRITE_TOOL_NAMES.has(normalized)) return true;
  if (normalized.endsWith('__edit')) return true;
  if (normalized.endsWith(':edit')) return true;
  if (normalized.endsWith('__write')) return true;
  if (normalized.endsWith(':write')) return true;
  return false;
};

const countLines = (s: string | undefined | null): number => {
  if (!s) return 0;
  const lines = s.split('\n');
  // Don't count trailing empty line from final newline
  if (lines.length > 0 && lines[lines.length - 1] === '') return lines.length - 1;
  return lines.length;
};

/**
 * Compute file modification stats for a turn by scanning tool messages.
 * Returns null if no file modifications were detected.
 */
const computeTurnFileStats = (
  messages: TranscriptViewMessage[],
  turnStartIdx: number,
  turnEndIdx: number
): { filesModified: number; linesAdded: number; linesRemoved: number } | null => {
  const modifiedFiles = new Set<string>();
  let totalAdded = 0;
  let totalRemoved = 0;

  for (let i = turnStartIdx + 1; i <= turnEndIdx; i++) {
    const msg = messages[i];
    if (msg.type !== 'tool_call' || !msg.toolCall) continue;

    const toolName = msg.toolCall.toolName;
    if (!isFileModifyingTool(toolName)) continue;
    if (msg.isError) continue;

    const args = msg.toolCall.arguments;
    if (!args) continue;

    const filePath = args.file_path || args.filePath || args.notebook_path || args.path;
    if (typeof filePath === 'string') {
      modifiedFiles.add(filePath);
    }

    const normalized = (toolName || '').toLowerCase();
    const isEdit = EDIT_TOOL_NAMES.has(normalized) || normalized.endsWith('__edit') || normalized.endsWith(':edit');

    if (isEdit) {
      const oldStr = args.old_string as string | undefined;
      const newStr = args.new_string as string | undefined;
      if (oldStr != null || newStr != null) {
        totalRemoved += countLines(oldStr);
        totalAdded += countLines(newStr);
      }
    } else {
      // Write / NotebookEdit - new content
      const content = args.content as string | undefined;
      if (content) {
        totalAdded += countLines(content);
      }
    }
  }

  if (modifiedFiles.size === 0 && totalAdded === 0 && totalRemoved === 0) return null;
  return { filesModified: modifiedFiles.size, linesAdded: totalAdded, linesRemoved: totalRemoved };
};

const safeParseJson = (value: string): any | null => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const looksLikeJson = (value: string) => {
  const trimmed = value.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
};

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

const getTranscriptToolKey = (
  toolMsg: TranscriptViewMessage,
  fallbackIndex: number,
  depth: number
): string => {
  const stableId =
    toolMsg.toolCall?.providerToolCallId ||
    toolMsg.subagentId ||
    (Number.isFinite(toolMsg.id) ? `id-${toolMsg.id}` : null) ||
    (Number.isFinite(toolMsg.sequence) ? `seq-${toolMsg.sequence}` : null) ||
    `idx-${fallbackIndex}`;
  // Append fallbackIndex as a tiebreaker. Some providers report the same
  // providerToolCallId for both a parent tool and a derived/echo row at the
  // same depth, which would collide if we keyed by stableId alone.
  return `tool-${depth}-${stableId}-i${fallbackIndex}`;
};

const stableSerialize = (value: unknown): string => {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`);

  return `{${entries.join(',')}}`;
};

const buildEditSignature = (edit: Record<string, any>): string => {
  const resolvedPath = edit.filePath || edit.file_path || edit.targetFilePath || '';
  return stableSerialize({
    filePath: resolvedPath,
    replacements: edit.replacements,
    oldString: edit.old_string ?? edit.oldText,
    newString: edit.new_string ?? edit.newText,
    content: edit.content,
    applied: edit.applied,
    type: edit.type,
  });
};

/**
 * Parse a unified diff string into the `replacements: [{oldText, newText}]`
 * shape DiffViewer expects. Hunks are split on `@@` headers; one replacement
 * is emitted per hunk so the rendered diff preserves hunk boundaries.
 *
 * Used to bridge Codex ACP's `apply_patch` tool output (which carries hunks
 * as a single unified diff string) into the same renderer Claude's Edit uses.
 */
export const parseUnifiedDiffToReplacements = (
  unifiedDiff: string
): Array<{ oldText: string; newText: string }> => {
  if (!unifiedDiff) return [];
  const lines = unifiedDiff.split('\n');
  const replacements: Array<{ oldText: string; newText: string }> = [];
  let oldBuf: string[] = [];
  let newBuf: string[] = [];
  let inHunk = false;

  const flush = () => {
    if (oldBuf.length === 0 && newBuf.length === 0) return;
    replacements.push({ oldText: oldBuf.join('\n'), newText: newBuf.join('\n') });
    oldBuf = [];
    newBuf = [];
  };

  for (const line of lines) {
    if (line.startsWith('@@')) {
      flush();
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line === '') continue; // trailing newline / blank between hunks
    if (line.startsWith('\\ ')) continue; // "\ No newline at end of file"
    if (line.startsWith('-')) {
      oldBuf.push(line.slice(1));
    } else if (line.startsWith('+')) {
      newBuf.push(line.slice(1));
    } else {
      const ctx = line.startsWith(' ') ? line.slice(1) : line;
      oldBuf.push(ctx);
      newBuf.push(ctx);
    }
  }
  flush();
  return replacements;
};

/**
 * Detect Codex `apply_patch`'s `changes` shape -- a record keyed by file
 * path whose values are `{ type: 'add'|'update'|'delete'|'move',
 * unified_diff?: string, move_path?: string|null }`. Returns one synthesized
 * edit per entry, ready for EditToolResultCard.
 */
const extractApplyPatchChanges = (changes: unknown): any[] => {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return [];
  const out: any[] = [];
  for (const [path, raw] of Object.entries(changes as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const kind = typeof entry.type === 'string' ? entry.type : undefined;
    const unifiedDiff = typeof entry.unified_diff === 'string' ? entry.unified_diff : undefined;

    if (kind === 'add') {
      // Codex apply_patch carries the full new-file body as `content` for
      // type: 'add'. Older variants (or other apply_patch implementations)
      // may instead provide a unified_diff whose `+` lines comprise the
      // file -- prefer `content` but fall back to extracting from the diff.
      let content = '';
      if (typeof entry.content === 'string') {
        content = entry.content;
      } else if (unifiedDiff) {
        content = unifiedDiff
          .split('\n')
          .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
          .map((l) => l.slice(1))
          .join('\n');
      }
      out.push({ filePath: path, type: 'add', operation: 'create', content });
      continue;
    }

    if (kind === 'delete') {
      out.push({ filePath: path, type: 'delete', operation: 'delete', content: '' });
      continue;
    }

    if (unifiedDiff) {
      const replacements = parseUnifiedDiffToReplacements(unifiedDiff);
      out.push({
        filePath: path,
        type: kind ?? 'update',
        operation: 'edit',
        replacements,
      });
    }
  }
  return out;
};

/**
 * Map resolved `ToolCallDiffResult[]` into the edit-record shape
 * EditToolResultCard expects. Used by transcript rows that are enriched in
 * main before the renderer sees them (for example Codex `file_change`).
 */
export const toolCallDiffsToEdits = (diffs: any[]): any[] => {
  const out: any[] = [];
  for (const diff of diffs) {
    if (!diff || typeof diff !== 'object') continue;
    const filePath = typeof diff.filePath === 'string' ? diff.filePath : undefined;
    if (!filePath) continue;
    const operation = typeof diff.operation === 'string' ? diff.operation : 'edit';

    if (operation === 'create') {
      // Prefer the explicit `content` field when the matcher provided it
      // (Write/Edit tools include the file body directly). For Codex
      // `file_change` with kind='add', the matcher returns
      // `diffs: [{ oldString: '', newString: <full body> }]` from its
      // history-snapshot fallback because the SDK's FileChangeItem.changes
      // doesn't carry content -- pull the body off newString in that case
      // so NewFilePreview renders with the actual file contents instead
      // of an empty preview.
      let content = typeof diff.content === 'string' ? diff.content : '';
      if (!content && Array.isArray(diff.diffs) && diff.diffs.length > 0) {
        content = diff.diffs
          .map((d: any) => (typeof d?.newString === 'string' ? d.newString : ''))
          .join('');
      }
      out.push({
        filePath,
        type: 'add',
        operation: 'create',
        content,
      });
      continue;
    }

    const replacements = Array.isArray(diff.diffs)
      ? diff.diffs
          .filter((d: any) => d && typeof d === 'object')
          .map((d: any) => ({
            oldText: typeof d.oldString === 'string' ? d.oldString : '',
            newText: typeof d.newString === 'string' ? d.newString : '',
          }))
      : [];

    if (operation === 'delete') {
      // ToolCallMatcher returns the file's last-known content as a single
      // diff entry for delete. Render it as red-only by clearing newText.
      const first = replacements[0] ?? { oldText: '', newText: '' };
      out.push({
        filePath,
        type: 'delete',
        operation: 'delete',
        old_string: first.oldText,
        new_string: '',
      });
      continue;
    }

    out.push({
      filePath,
      type: 'update',
      operation: 'edit',
      replacements: replacements.length > 0 ? replacements : undefined,
    });
  }
  return out;
};

export const extractEditsFromToolMessage = (message: TranscriptViewMessage): any[] => {
  const tool = message.toolCall;
  if (!tool) return [];

  const args = tool.arguments as Record<string, any> | undefined;
  const fallbackPath =
    tool.targetFilePath ||
    (args?.file_path as string | undefined) ||
    (args?.filePath as string | undefined) ||
    (args?.path as string | undefined);

  const edits: any[] = [];
  const visited = new WeakSet<object>();
  const seenEditSignatures = new Set<string>();

  const pushEdit = (raw: any, fallback?: string) => {
    if (!raw || typeof raw !== 'object') return;
    const normalized: any = { ...raw };

    if (Array.isArray(normalized.content)) {
      const flattened = normalized.content
        .map((block: any) => {
          if (typeof block === 'string') return block;
          if (block && typeof block.text === 'string') return block.text;
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
      if (flattened) {
        normalized.content = flattened;
      }
    }

    if (
      !normalized.filePath &&
      !normalized.file_path &&
      !normalized.targetFilePath &&
      fallback
    ) {
      normalized.filePath = fallback;
    }

    const signature = buildEditSignature(normalized);
    if (seenEditSignatures.has(signature)) {
      return;
    }
    seenEditSignatures.add(signature);
    edits.push(normalized);
  };

  const visit = (value: any, localFallback?: string) => {
    if (value === null || value === undefined) return;
    const fallback = localFallback || fallbackPath;

    if (Array.isArray(value)) {
      value.forEach(item => visit(item, fallback));
      return;
    }

    if (typeof value === 'string') {
      if (looksLikeJson(value)) {
        const parsed = safeParseJson(value);
        if (parsed) {
          visit(parsed, fallback);
        }
      }
      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    if (visited.has(value as object)) {
      return;
    }
    visited.add(value as object);

    const candidate = value as Record<string, any>;
    const candidateFilePath =
      candidate.file_path ||
      candidate.filePath ||
      candidate.targetFilePath ||
      candidate.file ||
      fallback;

    const hasReplacementArray = Array.isArray(candidate.replacements) && candidate.replacements.length > 0;
    const hasTextContent = typeof candidate.content === 'string' && candidate.content.trim().length > 0;
    const hasContentBlocks =
      Array.isArray(candidate.content) &&
      candidate.content.some((block: any) => typeof block === 'string' || typeof block?.text === 'string');
    const hasDiffLike =
      typeof candidate.diff === 'string' ||
      typeof candidate.newText === 'string' ||
      typeof candidate.oldText === 'string' ||
      typeof candidate.new_string === 'string' ||
      typeof candidate.old_string === 'string';

    if (hasReplacementArray || hasTextContent || hasContentBlocks || hasDiffLike) {
      pushEdit(candidate, candidateFilePath);
    }

    if (candidate.edit) {
      const editPath = candidate.edit?.file_path || candidate.edit?.filePath || candidateFilePath;
      visit(candidate.edit, editPath);
    }

    if (Array.isArray(candidate.edits)) {
      candidate.edits.forEach((entry: any) => {
        const entryPath = entry?.file_path || entry?.filePath || candidateFilePath;
        visit(entry, entryPath);
      });
    }

    Object.entries(candidate).forEach(([key, child]) => {
      if (key === 'edit' || key === 'edits' || key === 'replacements') {
        return;
      }

      if (typeof child === 'string' && looksLikeJson(child)) {
        const parsed = safeParseJson(child);
        if (parsed) {
          visit(parsed, candidateFilePath);
        }
        return;
      }

      if (child && typeof child === 'object') {
        visit(child, candidateFilePath);
      }
    });
  };

  // Codex ACP `apply_patch` carries its diff under `changes: { [path]: { type, unified_diff } }`
  // in either args or result. Detect first so the rest of the recursive walk
  // doesn't fall back to dumping the raw JSON.
  const fromArgs = extractApplyPatchChanges((args as any)?.changes);
  if (fromArgs.length > 0) {
    return fromArgs;
  }
  const resultObj =
    typeof tool.result === 'string' && looksLikeJson(tool.result)
      ? safeParseJson(tool.result)
      : tool.result;
  const fromResult = extractApplyPatchChanges((resultObj as any)?.changes);
  if (fromResult.length > 0) {
    return fromResult;
  }

  // Note: toolCall.changes contains {path, patch} metadata -- not edit instructions.
  // Edits are extracted from tool arguments and result payloads via visit() below.

  if (args) {
    visit(args);
  }

  if (tool.result) {
    visit(tool.result);
  }

  return edits;
};

export const RichTranscriptView = React.forwardRef<
  { scrollToMessage: (index: number) => void; scrollToTop: () => void },
  RichTranscriptViewProps
>(({ sessionId, sessionStatus, isProcessing, hasPendingInteractivePrompt, messages, provider, settings: propsSettings, onSettingsChange, showSettings, documentContext, workspacePath, renderEmptyExtra, hideEmptyHelp, readFile, onOpenFile, onOpenSession, onCompact, onEditUserMessage, promptAdditions, currentTeammates, waitingForNoun, appStartTime, renderEmbeddedFile, canEmbedFile, onSearchBarVisibilityChange, persistScrollState = true }, ref) => {
  const [collapsedMessages, setCollapsedMessages] = useState<Set<number>>(new Set());
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const scrollButtonRef = useRef<HTMLDivElement>(null);
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  // Edit/rewind: which user message (by raw id) is being edited inline, plus its draft.
  const [editingRawMessageId, setEditingRawMessageId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [showSearchBar, setShowSearchBar] = useState(false);

  // Subscribe to the transcript tool-widget registry so extension
  // enable/disable cycles cause this view to re-render and pick up
  // newly contributed widgets without a session reload.
  useTranscriptToolWidgetRegistryVersion();

  // Notify the parent when the find-in-page search bar visibility changes
  // so it can shift `FloatingTranscriptActions` (sibling, absolutely positioned
  // at top-right of the same container) down and avoid the pill-over-buttons
  // overlap reported in #309.
  useEffect(() => {
    onSearchBarVisibilityChange?.(showSearchBar);
  }, [showSearchBar, onSearchBarVisibilityChange]);

  const pendingPermissionsVisibleRef = useRef(true);
  const [showPermissionBanner, setShowPermissionBanner] = useState(false);
  const [isScrollReady, setIsScrollReady] = useState(false);
  const [isContainerVisible, setIsContainerVisible] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const viewRootRef = useRef<HTMLDivElement>(null);
  const vlistRef = useRef<VListHandle>(null);
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const isAtBottomRef = useRef(
    persistScrollState ? getSessionIsAtBottom(sessionId) : true
  );

  // Desktop gets a wider buffer to reduce row churn near selection;
  // iOS WKWebView uses a smaller buffer for memory pressure.
  const isMobileWebKit = useMemo(() => isAppleMobileWebKit(), []);
  const vlistBufferSize = isMobileWebKit ? MOBILE_TRANSCRIPT_BUFFER_PX : DESKTOP_TRANSCRIPT_BUFFER_PX;

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

  // Determine if we're waiting for a response (used for scroll behavior and UI)
  const isWaitingForResponse = useMemo(() => {
    // Session is waiting for the USER to answer — not thinking, don't show the indicator.
    // Check the prop (live IPC state) AND scan messages directly (survives session reloads).
    if (hasPendingInteractivePrompt) return false;
    // Match BOTH the bare tool name and the MCP-prefixed form
    // (`mcp__nimbalyst-mcp__AskUserQuestion`); strict equality on just the
    // bare name left the "Thinking…" indicator rendered on top of the
    // already-rendered AskUserQuestion widget.
    const hasPendingQuestion = messages.some(
      msg => isToolLikeMessage(msg)
        && !!msg.toolCall
        && stripMcpPrefix(msg.toolCall.toolName ?? '') === 'AskUserQuestion'
        && !msg.toolCall.result
    );
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
  }, [messages, sessionStatus, isProcessing, hasPendingInteractivePrompt, runningTeammates]);

  // Compute waiting indicator text — show agent/teammate count when lead is idle but agents are running
  const waitingText = useMemo(() => {
    if (!isWaitingForResponse) return '';
    if (runningTeammates.length > 0 && !isProcessing && sessionStatus !== 'running') {
      const singular = waitingForNoun || 'agent';
      const plural = singular.endsWith('s') ? singular : `${singular}s`;
      const label = runningTeammates.length === 1 ? singular : plural;
      return `Waiting for ${runningTeammates.length} ${label} to complete...`;
    }
    return 'Thinking...';
  }, [isProcessing, isWaitingForResponse, runningTeammates, sessionStatus, waitingForNoun]);

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

  // Find pending (unresolved) ToolPermission widgets and the VList indices where they're actually rendered.
  // Tool messages are hidden (display:none) and rendered inside the next assistant message via toolMessagesBefore,
  // so we need to find the assistant message index for scroll targeting.
  const pendingPermissionIndices = useMemo(() => {
    // Don't show banner for stopped/completed sessions.
    // Session is active if processing, running/waiting status, or teammates are still running.
    const hasActiveTeammates = currentTeammates?.some(t => t.status === 'running' || t.status === 'idle') ?? false;
    const sessionActive = isProcessing || sessionStatus === 'running' || sessionStatus === 'waiting' || hasActiveTeammates;
    if (!sessionActive) return [];
    const indices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (isToolLikeMessage(msg) && msg.toolCall?.toolName === 'ToolPermission' && !msg.toolCall.result) {
        // Find the next assistant message that renders this tool via toolMessagesBefore
        let targetIdx = i + 1;
        while (targetIdx < messages.length && isToolLikeMessage(messages[targetIdx])) {
          targetIdx++;
        }
        if (targetIdx < messages.length && messages[targetIdx].type === 'assistant_message') {
          indices.push(targetIdx); // Scroll to the assistant message that contains this widget
        } else {
          indices.push(i); // Orphaned tool - rendered at its own index
        }
      }
    }
    return indices;
  }, [messages, isProcessing, sessionStatus, currentTeammates]);

  // Update banner visibility when pending permissions are resolved or new ones appear
  useEffect(() => {
    if (pendingPermissionIndices.length === 0) {
      setShowPermissionBanner(false);
      pendingPermissionsVisibleRef.current = true;
    } else {
      // Always show banner initially when pending permissions exist.
      // The onScroll handler will hide it if the permissions are actually visible.
      // This fixes the case where auto-scroll pushes past the permission widget
      // while isAtBottom is true (making us incorrectly assume visibility).
      setShowPermissionBanner(true);
      pendingPermissionsVisibleRef.current = false;

      // Schedule a visibility check after auto-scroll completes (auto-scroll uses double RAF).
      // Triple RAF ensures we run after auto-scroll's double RAF + the resulting scroll event.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (pendingPermissionIndices.length === 0) return;
            if (!vlistRef.current) return;
            const offset = vlistRef.current.scrollOffset;
            const viewportSize = vlistRef.current.viewportSize;
            const firstVisibleIdx = vlistRef.current.findItemIndex(offset);
            const lastVisibleIdx = vlistRef.current.findItemIndex(offset + viewportSize);
            const anyVisible = pendingPermissionIndices.some(
              idx => idx >= firstVisibleIdx && idx <= lastVisibleIdx
            );
            pendingPermissionsVisibleRef.current = anyVisible;
            setShowPermissionBanner(!anyVisible);
          });
        });
      });
    }
  }, [pendingPermissionIndices, sessionId]);

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
    requestAnimationFrame(() => {
      vlistRef.current?.scrollToIndex(messages.length - 1, { align: 'end' });
      requestAnimationFrame(() => {
        setIsScrollReady(true);
      });
    });
  }, [sessionId, isContainerVisible]); // Re-run when session changes or container becomes visible

  // Auto-scroll to bottom when messages change (if user was at bottom)
  useEffect(() => {
    const wasAtBottom = getAtBottomState();

    requestAnimationFrame(() => {
      if (!vlistRef.current) return;
      const scrollSize = vlistRef.current.scrollSize;
      const viewportSize = vlistRef.current.viewportSize;
      const scrollOffset = vlistRef.current.scrollOffset;
      const distanceFromBottom = scrollSize - scrollOffset - viewportSize;

      if (shouldAutoScrollTranscript(wasAtBottom, distanceFromBottom)) {
        // Account for the "Thinking..." indicator which is an extra item after messages
        const lastIndex = isWaitingForResponse ? messages.length : messages.length - 1;
        vlistRef.current.scrollToIndex(lastIndex, { align: 'end' });
        setAtBottomState(true);
      }
    });
  }, [getAtBottomState, messages, isWaitingForResponse, setAtBottomState]);

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

  const toggleMessageCollapse = (index: number) => {
    setCollapsedMessages(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const cancelMessageEdit = useCallback(() => {
    setEditingRawMessageId(null);
    setEditDraft('');
  }, []);

  const submitMessageEdit = useCallback((rawMessageId: number, indexInList: number) => {
    if (!onEditUserMessage) return;
    const text = editDraft;
    const hasDownstream = indexInList < messages.length - 1;
    setEditingRawMessageId(null);
    setEditDraft('');
    onEditUserMessage(rawMessageId, text, hasDownstream);
  }, [onEditUserMessage, editDraft, messages.length]);

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

  const copyTranscriptViewMessageContent = async (message: TranscriptViewMessage, index: number) => {
    try {
      await copyToClipboard(message.text ?? '');
      setCopiedMessageIndex(index);
      setTimeout(() => setCopiedMessageIndex(null), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  // Auto-expand sub-agent (Task) tools
  useEffect(() => {
    const subAgentIds = new Set<string>();
    messages.forEach(msg => {
      if (msg.type === 'subagent' && msg.subagentId) {
        subAgentIds.add(msg.subagentId);
      }
    });

    if (subAgentIds.size > 0) {
      setExpandedTools(prev => {
        const next = new Set(prev);
        subAgentIds.forEach(id => next.add(id));
        return next;
      });
    }
  }, [messages]);

  // Helper to check if message is a login-required error
  // Uses SDK's first-class isAuthError flag when available (preferred)
  // Falls back to string matching for backwards compatibility with old messages
  const isLoginRequiredError = (message: TranscriptViewMessage) => {
    // First-class detection via SDK's isAuthError flag (most reliable)
    if (message.isAuthError === true) {
      return true;
    }

    // Codex app-server pre-flight auth required -- treat the same so the
    // last-message-only widget gating in shouldShowLoginWidgetForIndex applies.
    if (message.isCodexAuthRequired === true) {
      return true;
    }

    // Fallback to string matching for backwards compatibility
    // IMPORTANT: Only match specific authentication error patterns, NOT generic words
    const content = message.text || '';
    const lowerContent = content.toLowerCase();
    return (
      lowerContent.includes('invalid api key') ||
      lowerContent.includes('please run /login') ||
      // Match "401 unauthorized" or "unauthorized error" but not just "unauthorized" alone
      lowerContent.includes('401 unauthorized') ||
      lowerContent.includes('unauthorized error') ||
      lowerContent.includes('authentication required') ||
      lowerContent.includes('oauth token has expired') ||
      lowerContent.includes('token has expired') ||
      lowerContent.includes('expired token') ||
      lowerContent.includes('please obtain a new token') ||
      lowerContent.includes('refresh your existing token') ||
      lowerContent.includes('authentication_error') ||
      // Match "/login" only at word boundary (not in URLs)
      /\b\/login\b/.test(lowerContent)
    );
  };

  // Helper to check if we should show the login widget for a given message index
  // Only show the widget if this is a login error AND it's the last message in the session
  // This prevents redundant widgets from being shown when scrolling through history
  const shouldShowLoginWidgetForIndex = (index: number): boolean => {
    const message = messages[index];
    if (!isLoginRequiredError(message) || message.type === 'user_message') {
      return false;
    }

    // Only show the login widget if this is the last message in the session
    // This prevents re-rendering/re-checking login status when scrolling through old messages
    return index === messages.length - 1;
  };

  // Helper to get provider display name
  const getProviderDisplayName = (provider?: string): string => {
    switch (provider) {
      case 'claude':
        return 'Claude';
      case 'claude-code':
        return 'Claude Agent';
      case 'claude-code-cli':
        return 'Claude Code CLI';
      case 'openai':
      case 'openai-codex':
        return 'OpenAI';
      case 'lmstudio':
        return 'LM Studio';
      default:
        return 'Agent';
    }
  };

  // Helper to extract text content from tool result
  const extractResultText = (result: any): string | null => {
    if (typeof result === 'string') {
      return result;
    }

    // Handle array of content blocks (Anthropic format)
    if (Array.isArray(result)) {
      const textParts: string[] = [];
      for (const block of result) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        }
      }
      return textParts.length > 0 ? textParts.join('\n') : null;
    }

    return null;
  };

  // Recursive tool rendering helper
  const renderToolCard = (toolMsg: TranscriptViewMessage, toolIndex: number, depth: number = 0): JSX.Element | null => {
    if (!toolMsg.toolCall) return null;

    // Hide Task tool calls that were cancelled as siblings of a parallel spawn.
    // These get exactly "<tool_use_error>Sibling tool call errored</tool_use_error>"
    // as their result and were never actually started.
    if (toolMsg.toolCall.toolName === 'Task' && toolMsg.isError) {
      const result = toolMsg.toolCall.result;
      const resultStr = typeof result === 'string' ? result : '';
      if (/^\s*(<tool_use_error>)?\s*Sibling tool call errored\s*(<\/tool_use_error>)?\s*$/.test(resultStr)) {
        return null;
      }
    }

    const tool = toolMsg.toolCall;
    const toolId = tool.providerToolCallId || tool.toolName || `tool-${toolIndex}`;
    const toolRenderKey = getTranscriptToolKey(toolMsg, toolIndex, depth);
    const isExpanded = expandedTools.has(toolId);
    const isSubAgent = toolMsg.type === 'subagent';
    const isTeammate = isSubAgent && !!(toolMsg.subagent?.teammateName || toolMsg.subagent?.teamName);
    const hasChildren = isSubAgent && toolMsg.subagent?.childEvents && toolMsg.subagent.childEvents.length > 0;

    // Check for custom widget first
    const CustomWidget = tool.toolName ? getCustomToolWidget(tool.toolName) : undefined;
    if (CustomWidget) {
      return (
        <div
          key={toolRenderKey}
          className={`rich-transcript-tool-container mb-2 ${depth > 0 ? 'nested ml-0' : ''}`}
          style={{ marginLeft: depth > 0 ? '1rem' : '0' }}
        >
          <ToolWidgetErrorBoundary toolName={tool.toolName}>
            <CustomWidget
              message={toolMsg}
              isExpanded={isExpanded}
              onToggle={() => toggleToolExpand(toolId)}
              workspacePath={workspacePath}
              sessionId={sessionId}
              readFile={readFile}
            />
          </ToolWidgetErrorBoundary>
        </div>
      );
    }

    // Codex SDK `file_change` rows are enriched with resolved diffs in main
    // before the transcript reaches the renderer. Render them through the same
    // EditToolResultCard path as Claude's Edit tool.
    if (tool.toolName === 'file_change' && tool.fileDiffs && tool.fileDiffs.length > 0) {
      return (
        <div
          key={toolRenderKey}
          className={`rich-transcript-tool-container mb-2 ${depth > 0 ? 'nested ml-0' : ''}`}
          style={{ marginLeft: depth > 0 ? '1rem' : '0' }}
        >
          <EditToolResultCard
            toolMessage={toolMsg}
            edits={toolCallDiffsToEdits(tool.fileDiffs)}
            workspacePath={workspacePath}
            onOpenFile={onOpenFile}
            renderEmbeddedFile={renderEmbeddedFile}
            canEmbedFile={canEmbedFile}
          />
        </div>
      );
    }

    const editTool = isEditToolName(tool.toolName);
    const editEntries = editTool ? extractEditsFromToolMessage(toolMsg) : [];
    const toolDisplayName = formatToolDisplayName(tool.toolName || '') || tool.toolName || 'Tool';

    if (editTool && editEntries.length > 0) {
      return (
        <div
          key={toolRenderKey}
          className={`rich-transcript-tool-container mb-2 ${depth > 0 ? 'nested ml-0' : ''}`}
          style={{ marginLeft: depth > 0 ? '1rem' : '0' }}
        >
          <EditToolResultCard
            toolMessage={toolMsg}
            edits={editEntries}
            workspacePath={workspacePath}
            onOpenFile={onOpenFile}
            renderEmbeddedFile={renderEmbeddedFile}
            canEmbedFile={canEmbedFile}
          />
        </div>
      );
    }

    // Extract description from arguments for sub-agents
    const toolArgs = tool.arguments as Record<string, any> | undefined;
    const description = (isSubAgent && toolArgs?.description ? toolArgs.description : null) as string | null;
    const prompt = (isSubAgent && toolArgs?.prompt ? toolArgs.prompt : null) as string | null;

    // Extract result text
    const resultText = tool.result ? extractResultText(tool.result) : null;

    // Special styling for sub-agents and teammates
    const cardClass = isTeammate
      ? 'rich-transcript-tool-card teammate rounded border border-[var(--nim-border)] overflow-hidden'
      : isSubAgent
        ? 'rich-transcript-tool-card sub-agent rounded border border-[var(--nim-border)] overflow-hidden'
        : depth > 0
          ? 'rich-transcript-tool-card child-tool rounded border border-[var(--nim-border)] overflow-hidden bg-[var(--nim-bg-tertiary)]'
          : 'rich-transcript-tool-card rounded border border-[var(--nim-border)] overflow-hidden bg-[var(--nim-bg-secondary)]';

    return (
      <div key={toolRenderKey} className={`rich-transcript-tool-container mb-2 ${depth > 0 ? 'nested ml-0' : ''}`} style={{ marginLeft: depth > 0 ? '1rem' : '0' }}>
        <div className={cardClass}>
          <button onClick={() => toggleToolExpand(toolId)} className="rich-transcript-tool-button w-full py-1 px-2 flex items-center gap-1.5 text-left border-none cursor-pointer text-sm bg-transparent">
            {isTeammate ? (
              // Group icon for team teammates
              <MaterialSymbol icon="group" size={16} className="rich-transcript-tool-icon sub-agent-icon w-4 h-4 text-[var(--nim-primary)] shrink-0" />
            ) : isSubAgent && toolArgs?.run_in_background ? (
              // Cloud icon for background (async) agents
              <MaterialSymbol icon="cloud_sync" size={16} className="rich-transcript-tool-icon sub-agent-icon w-4 h-4 text-[var(--nim-primary)] shrink-0" />
            ) : isSubAgent ? (
              // Document icon for synchronous sub-agents
              <MaterialSymbol icon="description" size={16} className="rich-transcript-tool-icon sub-agent-icon w-4 h-4 text-[var(--nim-primary)] shrink-0" />
            ) : (
              // Wrench icon for regular tools
              <MaterialSymbol icon="build" size={16} className="rich-transcript-tool-icon w-4 h-4 text-[var(--nim-primary)] shrink-0" />
            )}
            <span className="rich-transcript-tool-name font-mono text-sm text-[var(--nim-text)] font-medium" title={tool.toolName || undefined}>
              {isTeammate
                ? (toolMsg.subagent?.teammateName || 'Teammate')
                : isSubAgent
                  ? (toolArgs?.run_in_background ? 'Background Agent' : 'Sub-Agent')
                  : toolDisplayName}
              {isTeammate && toolMsg.subagent?.teammateMode && (
                <span className="rich-transcript-tool-subagent-type text-[var(--nim-text-muted)] font-normal text-xs ml-1">({toolMsg.subagent?.teammateMode})</span>
              )}
              {isSubAgent && !isTeammate && toolMsg.subagent?.agentType && (
                <span className="rich-transcript-tool-subagent-type text-[var(--nim-primary)] font-semibold"> [{toolMsg.subagent?.agentType}]</span>
              )}
            </span>
            {!isSubAgent && tool.arguments && (() => {
              const argStr = formatToolArguments(tool.toolName, tool.arguments, workspacePath);
              if (!argStr) return null;

              // Check if there's a clickable file path (only for tools that reference actual files)
              const filePath = extractFilePathFromArgs(tool.toolName, tool.arguments);
              const isClickable = onOpenFile && filePath;

              if (isClickable) {
                return (
                  <span
                    role="link"
                    tabIndex={0}
                    className="rich-transcript-tool-args rich-transcript-tool-args-link text-[var(--nim-text-muted)] flex-1 overflow-hidden text-ellipsis whitespace-nowrap bg-transparent border-none p-0 m-0 font-inherit text-[var(--nim-link)] cursor-pointer no-underline text-left hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenFile(filePath);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        e.preventDefault();
                        onOpenFile(filePath);
                      }
                    }}
                    title={`Open ${filePath}`}
                  >
                    {argStr}
                  </span>
                );
              }
              return <span className="rich-transcript-tool-args text-[var(--nim-text-muted)] flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{argStr}</span>;
            })()}
            {/* Status indicator: sub-agents/teammates show live status, regular tools show success/error */}
            {isSubAgent ? (() => {
              // Look up teammate status from session metadata
              // Try tool.teammateAgentId first, then extract agent_id from result text
              let agentId = toolMsg.subagentId;
              if (!agentId && tool.result && typeof tool.result === 'string') {
                const match = tool.result.match(/agent_id:\s*(\S+)/);
                if (match) agentId = match[1].replace(/[.,]$/, '');
              }
              const teammateStatus = agentId ? currentTeammates?.find(t => t.agentId === agentId)?.status : undefined;
              // If no metadata yet but spawn succeeded (isError due to interception), assume running
              const effectiveStatus = teammateStatus || (tool.result && toolMsg.isError ? 'running' : tool.result ? 'completed' : null);
              if (effectiveStatus === 'running') {
                return (
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="inline-block w-3 h-3 border-2 border-[var(--nim-bg-tertiary)] border-t-[var(--nim-primary)] rounded-full animate-spin" />
                    <span className="text-[11px] text-[var(--nim-text-muted)]">Running</span>
                  </span>
                );
              }
              if (effectiveStatus === 'idle') {
                return (
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="text-[var(--nim-primary)] text-[10px]">&#9675;</span>
                    <span className="text-[11px] text-[var(--nim-text-muted)]">Idle</span>
                  </span>
                );
              }
              if (effectiveStatus === 'completed') {
                return (
                  <span className="flex items-center gap-1 shrink-0">
                    <MaterialSymbol icon="check_circle" size={14} className="text-[var(--nim-success)]" />
                    <span className="text-[11px] text-[var(--nim-text-muted)]">Done</span>
                  </span>
                );
              }
              if (effectiveStatus === 'errored') {
                return (
                  <span className="flex items-center gap-1 shrink-0">
                    <MaterialSymbol icon="cancel" size={14} className="text-[var(--nim-error)]" />
                    <span className="text-[11px] text-[var(--nim-text-muted)]">Errored</span>
                  </span>
                );
              }
              // Still waiting for result / no status yet - show progress spinner if available
              if (!tool.result && tool.progress.length > 0) {
                return (
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="inline-block w-3 h-3 border-2 border-[var(--nim-primary)] border-t-transparent rounded-full animate-spin" />
                    <span className="text-[11px] text-[var(--nim-text-muted)]">Running</span>
                  </span>
                );
              }
              return null;
            })() : (
              <>
                {tool.result && !toolMsg.isError && (
                  <MaterialSymbol icon="check_circle" size={16} className="rich-transcript-tool-success w-4 h-4 text-[var(--nim-success)] shrink-0" />
                )}
                {tool.result && toolMsg.isError && (
                  <MaterialSymbol icon="cancel" size={16} className="rich-transcript-tool-error w-4 h-4 text-[var(--nim-error)] shrink-0" />
                )}
              </>
            )}
            <MaterialSymbol icon={isExpanded ? "expand_more" : "chevron_right"} size={16} className="rich-transcript-tool-chevron w-3 h-3 text-[var(--nim-text-faint)]" />
          </button>

          {isExpanded && (
            <div className="rich-transcript-tool-expanded p-2 text-sm border-t border-[var(--nim-border)]">
              {/* Show description for sub-agents */}
              {isSubAgent && description && (
                <div className="rich-transcript-tool-section mb-1.5">
                  <div className="rich-transcript-tool-description text-sm text-[var(--nim-text)] leading-relaxed mb-2">{description}</div>
                </div>
              )}

              {/* Show prompt for sub-agents (collapsable) */}
              {isSubAgent && prompt && (
                <details className="rich-transcript-tool-details my-2">
                  <summary className="rich-transcript-tool-details-summary text-xs text-[var(--nim-text-faint)] cursor-pointer py-1 select-none hover:text-[var(--nim-text-muted)]">View full prompt</summary>
                  <div className="rich-transcript-tool-details-content mt-1 text-sm">
                    <MarkdownRenderer content={prompt} isUser={false} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />
                  </div>
                </details>
              )}

              {/* Show regular tool arguments (not for sub-agents) */}
              {!isSubAgent && tool.arguments && Object.keys(tool.arguments).length > 0 && (
                <div className="rich-transcript-tool-section mb-1.5">
                  <div className="rich-transcript-tool-section-label text-[var(--nim-text-faint)] mb-0.5 text-xs">Arguments:</div>
                  <JSONViewer data={tool.arguments} maxHeight="16rem" />
                </div>
              )}

              {/* Recursively render child tools */}
              {hasChildren && (
                <div className="rich-transcript-tool-section mb-1.5">
                  <div className="rich-transcript-tool-section-label text-[var(--nim-text-faint)] mb-0.5 text-xs">
                    {isTeammate ? 'Teammate' : 'Sub-agent'} Actions ({(toolMsg.subagent?.childEvents ?? []).length}):
                  </div>
                  <div className="rich-transcript-subagent-children flex flex-col gap-1 mt-2">
                    {(toolMsg.subagent?.childEvents ?? []).map((childMsg: TranscriptViewMessage, childIdx: number) =>
                      renderToolCard(childMsg, childIdx, depth + 1)
                    )}
                  </div>
                </div>
              )}

              {/* Show progress indicator for running sub-agents/teammates */}
              {isSubAgent && !tool.result && tool.progress.length > 0 && (
                <div className="rich-transcript-tool-section mb-1.5 flex items-center gap-2 text-xs text-[var(--nim-text-muted)]">
                  <span className="inline-block w-3 h-3 border-2 border-[var(--nim-primary)] border-t-transparent rounded-full animate-spin" />
                  <span>Running <span className="font-mono text-[var(--nim-text)]">{tool.progress[tool.progress.length - 1]?.progressContent}</span></span>
                  <span>({Math.round(tool.progress[tool.progress.length - 1]?.elapsedSeconds ?? 0)}s)</span>
                </div>
              )}

              {/* Show result - extract text from JSON if possible */}
              {tool.result && (
                <details className="rich-transcript-tool-details my-2" open={!isSubAgent}>
                  <summary className="rich-transcript-tool-details-summary text-xs text-[var(--nim-text-faint)] cursor-pointer py-1 select-none hover:text-[var(--nim-text-muted)]">
                    {isSubAgent ? 'View result' : 'Result'}
                  </summary>
                  <div className="rich-transcript-tool-details-content mt-1 text-sm">
                    {resultText ? (
                      <MarkdownRenderer content={resultText} isUser={false} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />
                    ) : typeof tool.result === 'string' ? (
                      <MarkdownRenderer content={tool.result} isUser={false} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />
                    ) : (
                      <JSONViewer data={tool.result} maxHeight="16rem" />
                    )}
                  </div>
                </details>
              )}

              {/* File changes caused by this tool call */}
              {!isSubAgent && tool.fileDiffs && tool.fileDiffs.length > 0 && (
                <ToolCallChanges
                  diffs={tool.fileDiffs}
                  isExpanded={isExpanded}
                  workspacePath={workspacePath}
                  onOpenFile={onOpenFile}
                  renderEmbeddedFile={renderEmbeddedFile}
                  canEmbedFile={canEmbedFile}
                />
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  // Rendered message rows. Each row's outer div carries `data-message-index`
  // and registers its DOM node in `messageRefs` so imperative scroll and
  // selection helpers can find them.
  const renderedMessages = messages.map((message, index) => {
    const messageKey = getTranscriptMessageKey(sessionId, message, index);
    // Skip tool calls superseded by a later event with the same providerToolCallId
    if (supersededToolIndices.has(index)) {
      return <div key={messageKey} style={{ display: 'none' }} />;
    }

    const isUser = message.type === 'user_message';
    const isTool = isToolLikeMessage(message);
    const isCollapsed = collapsedMessages.has(index);

    // Hide assistant/tool messages that sit between agent notifications.
    // These are the agent's internal processing turns after receiving a teammate/sub-agent
    // message - they appear as dark bars with scrollbars and add visual noise.
    // NEVER hide interactive tool widgets (ToolPermission, ExitPlanMode, etc.) that require user action.
    // Also never hide assistant messages that would carry interactive widgets in toolMessagesBefore.
    if (message.type === 'assistant_message' || isToolLikeMessage(message)) {
      const isInteractiveWidget = isToolLikeMessage(message)
        && isInteractiveWidgetTool(message.toolCall?.toolName);
      // For assistant messages, check if preceding tool messages contain interactive widgets
      let hasInteractiveToolsBefore = false;
      if (message.type === 'assistant_message') {
        let checkPrev = index - 1;
        while (checkPrev >= 0 && isToolLikeMessage(messages[checkPrev])) {
          if (isInteractiveWidgetTool(messages[checkPrev].toolCall?.toolName)) {
            hasInteractiveToolsBefore = true;
            break;
          }
          checkPrev--;
        }
      }
      if (!isInteractiveWidget && !hasInteractiveToolsBefore) {
        // Walk back to find the nearest user message (skipping tool and assistant messages)
        let prevIdx = index - 1;
        while (prevIdx >= 0 && messages[prevIdx].type !== 'user_message') prevIdx--;
        if (prevIdx >= 0 && messages[prevIdx].metadata?.isTeammateMessage) {
          // The most recent user message before this is a teammate notification.
          // Only hide empty processing turns (no substantive content).
          const hasNoContent = !message.text?.trim();
          if (hasNoContent) {
            return <div key={messageKey} style={{ display: 'none' }} />;
          }
        }
      }
    }

    // Find tool messages that should be grouped with this message
    const toolMessagesBefore: { message: TranscriptViewMessage, index: number }[] = [];
    if (message.type === 'assistant_message') {
      let checkIdx = index - 1;
      while (checkIdx >= 0 && isToolLikeMessage(messages[checkIdx])) {
        toolMessagesBefore.unshift({ message: messages[checkIdx], index: checkIdx });
        checkIdx--;
      }
    }

    // Skip rendering tool messages - they'll be rendered with their assistant message
    if (isTool) {
      let nextIndex = index + 1;
      while (nextIndex < messages.length && isToolLikeMessage(messages[nextIndex])) {
        nextIndex++;
      }
      if (nextIndex < messages.length && messages[nextIndex].type === 'assistant_message') {
        // Return empty div for virtualization (can't return null)
        return <div key={messageKey} style={{ display: 'none' }} />;
      }
    }

    // Check if this is the start of a new message group
    let effectivePrevMessage = null;
    let checkIdx = index - 1;
    while (checkIdx >= 0 && isToolLikeMessage(messages[checkIdx])) {
      checkIdx--;
    }
    if (checkIdx >= 0) {
      effectivePrevMessage = messages[checkIdx];
    }
    const isNewGroup = !effectivePrevMessage || effectivePrevMessage.type !== message.type;

    // Render orphaned tool calls.
    // When settings.showToolCalls is false, hide non-interactive tool
    // rows from the chat view but always render interactive widgets
    // (ToolPermission / ExitPlanMode / AskUserQuestion /
    // PromptForUserInput / RequestUserInput / GitCommitProposal)
    // so the user can still act on prompts.
    if (isTool && message.toolCall) {
      const isInteractiveWidget = isInteractiveWidgetTool(message.toolCall.toolName);
      if (!settings.showToolCalls && !isInteractiveWidget) {
        return null;
      }
      return (
        <div key={messageKey} className="rich-transcript-tool-container orphan ml-6 mb-2">
          {renderToolCard(message, index, 0)}
        </div>
      );
    }

    // Render teammate/sub-agent messages as compact inline notifications
    if (isUser && message.metadata?.isTeammateMessage) {
      const teammateName = (message.metadata?.teammateName as string) || 'agent';
      const label = `Received message from agent ${teammateName}`;
      const content = message.text?.trim();
      // Show first line as preview (truncated)
      const firstLine = content?.split('\n')[0] || '';
      const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + '...' : firstLine;
      const hasMoreContent = content && (content.includes('\n') || content.length > 100);
      return (
        <div
          key={messageKey}
          data-message-index={index}
          ref={(el) => {
            if (el) {
              messageRefs.current.set(index, el);
            } else {
              messageRefs.current.delete(index);
            }
          }}
          className="rich-transcript-message rich-transcript-teammate-notification rounded-md relative max-w-full overflow-x-hidden break-words mb-1"
        >
          {hasMoreContent ? (
            <details>
              <summary className="flex items-center gap-1.5 py-0.5 text-xs text-[var(--nim-text-faint)] hover:text-[var(--nim-text-muted)]">
                <MaterialSymbol icon="chevron_right" size={14} className="teammate-chevron transition-transform shrink-0 w-3.5" />
                <span className="flex-1 truncate">{label}: {preview}</span>
                <span className="text-[10px] shrink-0">{formatMessageTime(message.createdAt?.getTime() ?? 0)}</span>
              </summary>
              <div className="teammate-content ml-5 mt-1 mb-0.5">
                <MarkdownRenderer content={content} isUser={false} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />
              </div>
            </details>
          ) : (
            <div className="flex items-center gap-1.5 py-0.5 text-xs text-[var(--nim-text-faint)]">
              <MaterialSymbol icon="chevron_right" size={14} className="shrink-0 w-3.5 invisible" />
              <span className="flex-1 truncate">{label}: {content}</span>
              <span className="text-[10px] shrink-0">{formatMessageTime(message.createdAt?.getTime() ?? 0)}</span>
            </div>
          )}
        </div>
      );
    }

    if (message.type === 'system_message' && message.systemMessage?.systemType === 'permission_denied') {
      // Auto-mode classifier denials are paired with a re-prompt from the
      // PermissionDenied SDK hook (see AgentToolHooks.createPermissionDeniedHook).
      // The user sees the regular ToolPermission widget with the classifier
      // reason in its warnings, so rendering the red "Tool denied" card on top
      // of that would be redundant and confusing -- skip it.
      //
      // Other deny sources (`rule`, `mode`, `asyncAgent`, headless auto-deny)
      // stay visible because no re-prompt happens for those paths.
      if (message.systemMessage.deniedReasonType === 'classifier') {
        return null;
      }
      return (
        <div
          key={messageKey}
          data-message-index={index}
          ref={(el) => {
            if (el) messageRefs.current.set(index, el);
          }}
        >
          <PermissionDeniedCard message={message} />
        </div>
      );
    }

    if ((message.type === 'system_message' && message.systemMessage?.systemType !== 'error') || (message.metadata?.promptType as string) === 'system_reminder') {
      return (
        <div
          key={messageKey}
          data-message-index={index}
          ref={(el) => {
            if (el) {
              messageRefs.current.set(index, el);
            } else {
              messageRefs.current.delete(index);
            }
          }}
        >
          <SystemReminderCard message={message} />
        </div>
      );
    }

    return (
      <div
        key={messageKey}
        data-message-index={index}
        ref={(el) => {
          if (el) {
            messageRefs.current.set(index, el);
          } else {
            messageRefs.current.delete(index);
          }
        }}
        className={`rich-transcript-message rounded-md relative max-w-full overflow-x-hidden break-words mb-2 ${isUser ? 'user bg-[var(--nim-bg-secondary)]' : 'assistant bg-[var(--nim-bg)]'} ${settings.compactMode ? 'compact p-2' : 'normal p-3'} ${!isNewGroup ? 'continuation -mt-1' : ''}`}
      >
        {/* Restart indicator line (dev mode only) - rendered before the first message after restart */}
        {restartAfterIndex >= 0 && index === restartAfterIndex && (
          <div className="flex items-center gap-3 mb-3">
            <div className="flex-1 h-px bg-[var(--nim-error)]" />
            <span className="text-[11px] font-medium text-[var(--nim-error)] whitespace-nowrap">
              Nimbalyst restarted {formatMessageTime(appStartTime!)}
            </span>
            <div className="flex-1 h-px bg-[var(--nim-error)]" />
          </div>
        )}
        {isNewGroup && (
          <div className="rich-transcript-message-header flex items-center gap-2 mb-1.5">
            <div className={`rich-transcript-message-avatar w-7 h-7 rounded-full shrink-0 flex items-center justify-center ${isUser ? 'user' : 'assistant'}`}>
              {isUser ? (
                <MaterialSymbol icon="person" size={18} />
              ) : (
                <ProviderIcon provider={provider || 'claude-code'} size={18} />
              )}
            </div>
            <div className="rich-transcript-message-meta flex-1 flex items-baseline gap-2">
              <span className="rich-transcript-message-sender font-medium text-[var(--nim-text)] text-sm">
                {isUser ? 'You' : getProviderDisplayName(provider)}
              </span>
              {isUser && message.mode === 'planning' && (
                <span
                  className="text-[10px] rounded-full font-medium"
                  style={{ backgroundColor: '#3b82f6', color: 'white', padding: '2px 6px' }}
                >
                  Plan
                </span>
              )}
              <span className="rich-transcript-message-time text-xs text-[var(--nim-text-faint)]">
                {formatMessageTime(message.createdAt?.getTime() ?? 0)}
              </span>
            </div>
            <div className="rich-transcript-message-actions flex items-center gap-1">
              {(message.text ?? '').length > 200 && (
                <button
                  onClick={() => toggleMessageCollapse(index)}
                  className="rich-transcript-collapse-button p-1 rounded-md bg-transparent border-none text-[var(--nim-text-faint)] cursor-pointer transition-colors hover:bg-[var(--nim-bg-secondary)] hover:text-[var(--nim-text-muted)]"
                  title={isCollapsed ? "Show full message" : "Collapse message"}
                >
                  {isCollapsed ? (
                    <MaterialSymbol icon="visibility" size={16} />
                  ) : (
                    <MaterialSymbol icon="visibility_off" size={16} />
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        {toolMessagesBefore.length > 0 && (() => {
          // Filter out non-interactive tool messages when settings.showToolCalls
          // is off; always keep interactive widgets so the user can act on prompts.
          const visibleToolMessages = settings.showToolCalls
            ? toolMessagesBefore
            : toolMessagesBefore.filter(
                ({ message: toolMsg }) => isInteractiveWidgetTool(toolMsg.toolCall?.toolName)
              );
          if (visibleToolMessages.length === 0) return null;
          return (
            <div className={`rich-transcript-tool-messages flex flex-col gap-2 mb-1.5 ${isNewGroup ? 'indented ml-6' : ''}`}>
              {visibleToolMessages.map(({ message: toolMsg, index: toolIndex }) =>
                renderToolCard(toolMsg, toolIndex, 0)
              )}
            </div>
          );
        })()}

        <div className={`rich-transcript-message-content relative ${isNewGroup ? 'ml-6' : 'no-indent ml-0'}`}>
          {/* Edit (user messages) + Copy buttons - show on hover */}
          <div className="rich-transcript-message-copy-action absolute -top-1 right-0 z-[1] flex items-center gap-1">
            {isUser && message.rawMessageId != null && onEditUserMessage && editingRawMessageId == null && (
              <button
                onClick={() => { setEditingRawMessageId(message.rawMessageId!); setEditDraft(message.text ?? ''); }}
                className="rich-transcript-edit-button p-1.5 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] cursor-pointer transition-all flex items-center justify-center hover:bg-[var(--nim-bg-hover)]"
                title="Edit message & rewind"
              >
                <MaterialSymbol icon="edit" size={16} className="text-[var(--nim-text-faint)]" />
              </button>
            )}
            <button
              onClick={() => copyTranscriptViewMessageContent(message, index)}
              className={`rich-transcript-copy-button p-1.5 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] cursor-pointer transition-all flex items-center justify-center hover:bg-[var(--nim-bg-hover)] ${copiedMessageIndex === index ? 'copied' : ''}`}
              title="Copy as Markdown"
            >
              {copiedMessageIndex === index ? (
                <MaterialSymbol icon="check" size={16} className="text-[var(--nim-success)]" />
              ) : (
                <MaterialSymbol icon="content_copy" size={16} className="text-[var(--nim-text-faint)]" />
              )}
            </button>
          </div>
          {editingRawMessageId != null && message.rawMessageId === editingRawMessageId ? (
            <div className="rich-transcript-edit-form flex flex-col gap-2 select-text">
              <textarea
                className="w-full min-h-[3rem] rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-2 text-sm text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] resize-y"
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                autoFocus
                rows={Math.min(12, Math.max(2, editDraft.split('\n').length + 1))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (editDraft.trim()) submitMessageEdit(message.rawMessageId!, index);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelMessageEdit();
                  }
                }}
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={cancelMessageEdit}
                  className="px-2.5 py-1 rounded-md text-xs bg-transparent border border-[var(--nim-border)] text-[var(--nim-text-muted)] cursor-pointer hover:bg-[var(--nim-bg-secondary)]"
                >
                  Cancel
                </button>
                <button
                  onClick={() => submitMessageEdit(message.rawMessageId!, index)}
                  disabled={!editDraft.trim()}
                  className="rich-transcript-edit-save px-2.5 py-1 rounded-md text-xs bg-[var(--nim-primary)] border-none text-white cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Save &amp; rewind
                </button>
              </div>
            </div>
          ) : (
            <MessageSegment
              message={message}
              isUser={isUser}
              isCollapsed={isCollapsed}
              showToolCalls={false}
              showThinking={settings.showThinking}
              expandedTools={expandedTools}
              onToggleToolExpand={toggleToolExpand}
              documentContext={documentContext}
              shouldShowLoginWidget={shouldShowLoginWidgetForIndex(index)}
              sessionId={sessionId}
              isLastMessage={index === messages.length - 1}
              onOpenFile={onOpenFile}
              onOpenSession={onOpenSession}
              onCompact={onCompact}
              provider={provider}
            />
          )}
        </div>

        {/* Show elapsed time at the end of a completed assistant turn */}
        {!isUser && (() => {
          // Check if this is the last message in the assistant group
          let nextNonToolIdx = index + 1;
          while (nextNonToolIdx < messages.length && isToolLikeMessage(messages[nextNonToolIdx])) {
            nextNonToolIdx++;
          }
          const isEndOfGroup = nextNonToolIdx >= messages.length || messages[nextNonToolIdx].type !== 'assistant_message';
          if (!isEndOfGroup) return null;
          // Don't show for the last assistant group if still streaming
          if (isWaitingForResponse && nextNonToolIdx >= messages.length) return null;
          // Find the preceding user-input message that triggered this turn
          // Only consider genuine user input (isUserInput), not system-generated user-role messages
          let startIdx = index - 1;
          while (startIdx >= 0 && !(messages[startIdx].type === 'user_message')) {
            startIdx--;
          }
          if (startIdx < 0) return null; // No preceding user input message
          const startTimestamp = messages[startIdx].createdAt?.getTime() ?? 0;
          const endTimestamp = message.createdAt?.getTime() ?? 0;
          const duration = formatDuration(startTimestamp, endTimestamp);
          if (!duration || duration === '0ms') return null;
          const finishedAt = formatTurnFinishedAt(endTimestamp);
          const fileStats = computeTurnFileStats(messages, startIdx, index);
          return (
            <div className="rich-transcript-turn-elapsed text-xs text-[var(--nim-text-faint)] mt-2 ml-6">
              Finished in {duration}
              {finishedAt && <span> {finishedAt}</span>}
              {fileStats && (
                <span>
                  {' · '}{fileStats.filesModified} file{fileStats.filesModified !== 1 ? 's' : ''}
                  {fileStats.linesAdded > 0 && <span className="text-[var(--nim-success)] opacity-60"> +{fileStats.linesAdded}</span>}
                  {fileStats.linesRemoved > 0 && <span className="text-[var(--nim-error)] opacity-60"> -{fileStats.linesRemoved}</span>}
                </span>
              )}
            </div>
          );
        })()}

      </div>
    );
  });

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
        className="rich-transcript-scroll-container flex-1 relative overflow-hidden"
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
                  onScroll={(offset) => {
                    // Track if we're at the bottom for auto-scroll using per-session atom
                    if (vlistRef.current) {
                      const scrollSize = vlistRef.current.scrollSize;
                      const viewportSize = vlistRef.current.viewportSize;
                      const distanceFromBottom = scrollSize - offset - viewportSize;
                      const isAtBottom = isTranscriptAtBottom(distanceFromBottom);
                      // Update the per-session atom - this persists across component remounts
                      setAtBottomState(isAtBottom);
                      if (scrollButtonRef.current) {
                        const show = distanceFromBottom > viewportSize;
                        scrollButtonRef.current.style.opacity = show ? '1' : '0';
                        scrollButtonRef.current.style.pointerEvents = show ? '' : 'none';
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

        {/* Scroll to bottom button - uses ref + opacity/pointer-events to avoid layout shifts that interfere with text selection */}
        <div ref={scrollButtonRef} className="rich-transcript-scroll-button-container sticky bottom-3 flex justify-center opacity-0 transition-opacity">
          <button
            onClick={scrollToBottom}
            className="rich-transcript-scroll-button w-9 h-9 flex items-center justify-center bg-[var(--nim-primary)] text-white rounded-full border-none shadow-lg cursor-pointer transition-all hover:bg-[var(--nim-primary-hover)] hover:scale-110 pointer-events-auto"
            title="Scroll to bottom"
          >
            <MaterialSymbol icon="arrow_downward" size={20} />
          </button>
        </div>
      </div>
    </div>
  );
});

RichTranscriptView.displayName = 'RichTranscriptView';
