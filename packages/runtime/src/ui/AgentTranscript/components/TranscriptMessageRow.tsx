import React, { useCallback, useState } from 'react';
import type { TranscriptViewMessage } from '../../../ai/server/types';
import { isInteractiveWidgetTool } from '../../../ai/server/interactivePromptTools';
import { MessageSegment } from './MessageSegment';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ProviderIcon } from '../../icons/ProviderIcons';
import { MaterialSymbol } from '../../icons/MaterialSymbol';
import { formatMessageTime, formatDuration, formatTurnFinishedAt } from '../../../utils/dateUtils';
import { isToolLikeMessage } from '../utils/messageTypeHelpers';
import { AttachmentStagingDeniedCard } from './AttachmentStagingDeniedCard';
import {
  EDIT_TOOL_NAMES,
  TranscriptToolCard,
  getToolExpandId,
  getTranscriptToolKey,
  type SubagentChildContext,
  type TranscriptToolShared,
} from './TranscriptToolCard';

/**
 * One transcript row (a VList item). Everything a row used to derive from its
 * neighbouring messages is precomputed by `computeTranscriptRowInfos` in a
 * single pass, so the memoized row only sees its own message, its own
 * `TranscriptRowInfo`, primitives and stable callbacks. A streamed text frame
 * then re-renders only the row whose message (or info) actually changed.
 */

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

const WRITE_TOOL_NAMES = new Set(['write', 'notebookedit']);

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
  messages: readonly TranscriptViewMessage[],
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
/** Only checked when the message would render the login widget (last message). */
const isLoginRequiredError = (message: TranscriptViewMessage): boolean => {
  // First-class detection via SDK's isAuthError flag (most reliable)
  if (message.isAuthError === true) {
    return true;
  }

  // Codex app-server pre-flight auth required -- treat the same so the
  // last-message-only widget gating applies.
  if (message.isCodexAuthRequired === true) {
    return true;
  }

  // Fallback to string matching for backwards compatibility
  // IMPORTANT: Only match specific authentication error patterns, NOT generic words
  const lowerContent = (message.text || '').toLowerCase();
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

// ---------------------------------------------------------------------------
// Row info: neighbour-derived state, precomputed once per `messages` change
// ---------------------------------------------------------------------------

/** One tool card rendered inside a row, with the per-tool state it needs. */
export interface TranscriptToolEntry {
  message: TranscriptViewMessage;
  index: number;
  isExpanded: boolean;
  superseded: boolean;
  skipped?: boolean;
  /** Set only for sub-agent tools. */
  subagentContext?: SubagentChildContext;
}

/** "Finished in ..." line at the end of a completed assistant turn. */
export interface TranscriptTurnSummary {
  duration: string;
  finishedAt: string;
  fileStats: { filesModified: number; linesAdded: number; linesRemoved: number } | null;
}

export type TranscriptRowKind =
  | 'hidden'
  | 'orphanTool'
  | 'teammate'
  | 'attachmentDenied'
  | 'permissionDenied'
  | 'system'
  | 'message';

export interface TranscriptRowInfo {
  kind: TranscriptRowKind;
  isNewGroup: boolean;
  /** Tool cards this row renders: grouped tools before an assistant message, or the orphan tool itself. */
  toolEntries: readonly TranscriptToolEntry[] | null;
  /** attachmentDenied rows: the user message whose attachments were refused. */
  priorUserMessage: TranscriptViewMessage | null;
  turn: TranscriptTurnSummary | null;
  isLastMessage: boolean;
  showLoginWidget: boolean;
  showRestartLine: boolean;
}

export interface TranscriptRowInfoInputs {
  showToolCalls: boolean;
  expandedTools: ReadonlySet<string>;
  supersededToolIndices: ReadonlySet<number>;
  skippedQuestionIds: ReadonlySet<string>;
  /** Shared by every sub-agent entry; the parent memoizes it. */
  subagentContext: SubagentChildContext;
  isWaitingForResponse: boolean;
  restartAfterIndex: number;
}

const sameEntries = (
  a: readonly TranscriptToolEntry[] | null,
  b: readonly TranscriptToolEntry[] | null
): boolean => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.message !== y.message ||
      x.index !== y.index ||
      x.isExpanded !== y.isExpanded ||
      x.superseded !== y.superseded ||
      x.skipped !== y.skipped ||
      x.subagentContext !== y.subagentContext
    ) {
      return false;
    }
  }
  return true;
};

const sameTurn = (a: TranscriptTurnSummary | null, b: TranscriptTurnSummary | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.duration !== b.duration || a.finishedAt !== b.finishedAt) return false;
  const fa = a.fileStats;
  const fb = b.fileStats;
  if (fa === fb) return true;
  if (!fa || !fb) return false;
  return fa.filesModified === fb.filesModified && fa.linesAdded === fb.linesAdded && fa.linesRemoved === fb.linesRemoved;
};

/**
 * Builds a `TranscriptRowInfo` per message. Infos (and their `toolEntries`
 * arrays) that are unchanged from `previous` at the same index are returned
 * by identity, so a memoized row skips when nothing it shows changed.
 */
export function computeTranscriptRowInfos(
  messages: readonly TranscriptViewMessage[],
  inputs: TranscriptRowInfoInputs,
  previous: readonly TranscriptRowInfo[] | null
): TranscriptRowInfo[] {
  const n = messages.length;
  const {
    showToolCalls, expandedTools, supersededToolIndices, skippedQuestionIds,
    subagentContext, isWaitingForResponse, restartAfterIndex,
  } = inputs;

  const isTool = messages.map(isToolLikeMessage);
  // nextNonTool[i]: first index > i that is not tool-like (n when none).
  const nextNonTool = new Array<number>(n);
  let next = n;
  for (let i = n - 1; i >= 0; i--) {
    nextNonTool[i] = next;
    if (!isTool[i]) next = i;
  }

  const makeEntry = (k: number): TranscriptToolEntry => {
    const toolMsg = messages[k];
    const callId = toolMsg.toolCall?.providerToolCallId;
    return {
      message: toolMsg,
      index: k,
      isExpanded: expandedTools.has(getToolExpandId(toolMsg, k)),
      superseded: supersededToolIndices.has(k),
      skipped: callId ? skippedQuestionIds.has(callId) : undefined,
      subagentContext: toolMsg.type === 'subagent' ? subagentContext : undefined,
    };
  };

  const infos: TranscriptRowInfo[] = new Array(n);
  let lastUserIdx = -1;
  let prevNonToolIdx = -1;
  let toolRunStart = -1; // start of the contiguous tool run ending at i - 1

  for (let i = 0; i < n; i++) {
    const message = messages[i];
    const info: TranscriptRowInfo = {
      kind: 'message',
      isNewGroup: prevNonToolIdx < 0 || messages[prevNonToolIdx].type !== message.type,
      toolEntries: null,
      priorUserMessage: null,
      turn: null,
      isLastMessage: false,
      showLoginWidget: false,
      showRestartLine: false,
    };
    classifyRow(i, message, info);

    const prev = previous?.[i];
    if (prev) {
      if (sameEntries(prev.toolEntries, info.toolEntries)) info.toolEntries = prev.toolEntries;
      if (sameTurn(prev.turn, info.turn)) info.turn = prev.turn;
    }
    infos[i] =
      prev &&
      prev.kind === info.kind &&
      prev.isNewGroup === info.isNewGroup &&
      prev.toolEntries === info.toolEntries &&
      prev.priorUserMessage === info.priorUserMessage &&
      prev.turn === info.turn &&
      prev.isLastMessage === info.isLastMessage &&
      prev.showLoginWidget === info.showLoginWidget &&
      prev.showRestartLine === info.showRestartLine
        ? prev
        : info;

    if (isTool[i]) {
      if (toolRunStart < 0) toolRunStart = i;
    } else {
      toolRunStart = -1;
      prevNonToolIdx = i;
    }
    if (message.type === 'user_message') lastUserIdx = i;
  }
  return infos;

  function classifyRow(i: number, message: TranscriptViewMessage, info: TranscriptRowInfo): void {
    // Skip tool calls superseded by a later event with the same providerToolCallId
    if (supersededToolIndices.has(i)) {
      info.kind = 'hidden';
      return;
    }
    const isUser = message.type === 'user_message';
    const isAssistant = message.type === 'assistant_message';

    // Hide assistant/tool messages that sit between agent notifications.
    // These are the agent's internal processing turns after receiving a teammate/sub-agent
    // message. NEVER hide interactive tool widgets (ToolPermission, ExitPlanMode, etc.)
    // that require user action, nor assistant messages that carry them in their tool group.
    if (isAssistant || isTool[i]) {
      const isInteractiveWidget = isTool[i] && isInteractiveWidgetTool(message.toolCall?.toolName);
      let hasInteractiveToolsBefore = false;
      if (isAssistant && toolRunStart >= 0) {
        for (let k = i - 1; k >= toolRunStart; k--) {
          if (isInteractiveWidgetTool(messages[k].toolCall?.toolName)) {
            hasInteractiveToolsBefore = true;
            break;
          }
        }
      }
      if (!isInteractiveWidget && !hasInteractiveToolsBefore) {
        // The most recent user message before this is a teammate notification:
        // hide empty processing turns (no substantive content).
        if (lastUserIdx >= 0 && messages[lastUserIdx].metadata?.isTeammateMessage && !message.text?.trim()) {
          info.kind = 'hidden';
          return;
        }
      }
    }

    // Tool messages render inside the next assistant message's group.
    if (isTool[i]) {
      const j = nextNonTool[i];
      if (j < n && messages[j].type === 'assistant_message') {
        info.kind = 'hidden';
        return;
      }
    }

    // Orphaned tool calls. When showToolCalls is off, hide non-interactive tool
    // rows but always render interactive widgets so the user can act on prompts.
    if (isTool[i] && message.toolCall) {
      if (!showToolCalls && !isInteractiveWidgetTool(message.toolCall.toolName)) {
        info.kind = 'hidden';
        return;
      }
      info.kind = 'orphanTool';
      info.toolEntries = [makeEntry(i)];
      return;
    }

    if (isUser && message.metadata?.isTeammateMessage) {
      info.kind = 'teammate';
      return;
    }

    if (message.type === 'system_message' && message.systemMessage?.systemType === 'permission_denied') {
      if (message.systemMessage.isAttachmentStagingDenied) {
        info.kind = 'attachmentDenied';
        info.priorUserMessage = lastUserIdx >= 0 ? messages[lastUserIdx] : null;
        return;
      }
      // Auto-mode classifier denials are paired with a re-prompt from the
      // PermissionDenied SDK hook (see AgentToolHooks.createPermissionDeniedHook),
      // so the ToolPermission widget already shows the reason. Other deny
      // sources stay visible because no re-prompt happens for those paths.
      info.kind = message.systemMessage.deniedReasonType === 'classifier' ? 'hidden' : 'permissionDenied';
      return;
    }

    if ((message.type === 'system_message' && message.systemMessage?.systemType !== 'error') || (message.metadata?.promptType as string) === 'system_reminder') {
      info.kind = 'system';
      return;
    }

    info.kind = 'message';
    info.isLastMessage = i === n - 1;
    info.showLoginWidget = info.isLastMessage && !isUser && isLoginRequiredError(message);
    info.showRestartLine = restartAfterIndex >= 0 && i === restartAfterIndex;

    if (isAssistant && toolRunStart >= 0) {
      const entries: TranscriptToolEntry[] = [];
      for (let k = toolRunStart; k < i; k++) {
        if (showToolCalls || isInteractiveWidgetTool(messages[k].toolCall?.toolName)) {
          entries.push(makeEntry(k));
        }
      }
      info.toolEntries = entries.length > 0 ? entries : null;
    }

    // Elapsed time at the end of a completed assistant turn
    if (!isUser) {
      const j = nextNonTool[i];
      const isEndOfGroup = j >= n || messages[j].type !== 'assistant_message';
      // Not for the last assistant group while still streaming; needs a preceding user message.
      if (isEndOfGroup && !(isWaitingForResponse && j >= n) && lastUserIdx >= 0) {
        const startTimestamp = messages[lastUserIdx].createdAt?.getTime() ?? 0;
        const endTimestamp = message.createdAt?.getTime() ?? 0;
        const duration = formatDuration(startTimestamp, endTimestamp);
        if (duration && duration !== '0ms') {
          info.turn = {
            duration,
            finishedAt: formatTurnFinishedAt(endTimestamp),
            fileStats: computeTurnFileStats(messages, lastUserIdx, i),
          };
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

// MessageSegment only reads expandedTools when showToolCalls is true, and rows
// always pass false (tools render as TranscriptToolCards). A constant keeps
// its memo from breaking on every expand toggle.
const NO_EXPANDED_TOOLS: Set<string> = new Set();
const HIDDEN_STYLE: React.CSSProperties = { display: 'none' };

export interface TranscriptMessageRowProps {
  message: TranscriptViewMessage;
  index: number;
  info: TranscriptRowInfo;
  isCollapsed: boolean;
  isCopied: boolean;
  showThinking: boolean;
  compactMode: boolean;
  provider?: string;
  documentContext?: { filePath?: string };
  appStartTime?: number;
  onCompact?: () => void | Promise<void>;
  /** Stable; also carries sessionId, workspacePath, onOpenFile, onOpenSession. */
  toolShared: TranscriptToolShared;
  onToggleCollapse: (index: number) => void;
  onCopy: (message: TranscriptViewMessage, index: number) => void;
  registerMessageRef: (index: number, el: HTMLDivElement | null) => void;
}

function renderToolEntry(entry: TranscriptToolEntry, shared: TranscriptToolShared) {
  return (
    <TranscriptToolCard
      key={getTranscriptToolKey(entry.message, entry.index, 0)}
      toolMsg={entry.message}
      toolIndex={entry.index}
      depth={0}
      isExpanded={entry.isExpanded}
      superseded={entry.superseded}
      skipped={entry.skipped}
      shared={shared}
      subagentContext={entry.subagentContext}
    />
  );
}

export const TranscriptMessageRow = React.memo(function TranscriptMessageRow({
  message,
  index,
  info,
  isCollapsed,
  isCopied,
  showThinking,
  compactMode,
  provider,
  documentContext,
  appStartTime,
  onCompact,
  toolShared,
  onToggleCollapse,
  onCopy,
  registerMessageRef,
}: TranscriptMessageRowProps) {
  const setRef = useCallback(
    (el: HTMLDivElement | null) => registerMessageRef(index, el),
    [registerMessageRef, index]
  );
  const { sessionId, workspacePath, onOpenFile, onOpenSession } = toolShared;
  const isUser = message.type === 'user_message';
  const { isNewGroup } = info;

  switch (info.kind) {
    case 'hidden':
      // Empty div for virtualization (can't return null)
      return <div style={HIDDEN_STYLE} />;

    case 'orphanTool':
      return (
        <div className="rich-transcript-tool-container orphan ml-6 mb-2">
          {info.toolEntries?.map(entry => renderToolEntry(entry, toolShared))}
        </div>
      );

    case 'teammate': {
      // Teammate/sub-agent messages render as compact inline notifications
      const teammateName = (message.metadata?.teammateName as string) || 'agent';
      const label = `Received message from agent ${teammateName}`;
      const content = message.text?.trim();
      // Show first line as preview (truncated)
      const firstLine = content?.split('\n')[0] || '';
      const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + '...' : firstLine;
      const hasMoreContent = content && (content.includes('\n') || content.length > 100);
      return (
        <div
          data-message-index={index}
          ref={setRef}
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

    case 'attachmentDenied':
      return (
        <div data-message-index={index}>
          <AttachmentStagingDeniedCard
            sessionId={sessionId}
            systemMessage={message.systemMessage!}
            prompt={info.priorUserMessage?.text ?? ''}
            attachments={info.priorUserMessage?.attachments ?? []}
          />
        </div>
      );

    case 'permissionDenied':
      return (
        <div data-message-index={index} ref={setRef}>
          <PermissionDeniedCard message={message} />
        </div>
      );

    case 'system':
      return (
        <div data-message-index={index} ref={setRef}>
          <SystemReminderCard message={message} />
        </div>
      );

    case 'message':
      break;
  }

  const turn = info.turn;
  return (
    <div
      data-message-index={index}
      ref={setRef}
      className={`rich-transcript-message rounded-md relative max-w-full overflow-x-hidden break-words mb-2 ${isUser ? 'user bg-[var(--nim-bg-secondary)]' : 'assistant bg-[var(--nim-bg)]'} ${compactMode ? 'compact p-2' : 'normal p-3'} ${!isNewGroup ? 'continuation -mt-1' : ''}`}
    >
      {/* Restart indicator line (dev mode only) - rendered before the first message after restart */}
      {info.showRestartLine && (
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
                onClick={() => onToggleCollapse(index)}
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

      {info.toolEntries && (
        <div className={`rich-transcript-tool-messages flex flex-col gap-2 mb-1.5 ${isNewGroup ? 'indented ml-6' : ''}`}>
          {info.toolEntries.map(entry => renderToolEntry(entry, toolShared))}
        </div>
      )}

      <div className={`rich-transcript-message-content relative ${isNewGroup ? 'ml-6' : 'no-indent ml-0'}`}>
        {/* Copy button - shows on hover */}
        <div className="rich-transcript-message-copy-action absolute -top-1 right-0 z-[1]">
          <button
            onClick={() => onCopy(message, index)}
            className={`rich-transcript-copy-button p-1.5 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] cursor-pointer transition-all flex items-center justify-center hover:bg-[var(--nim-bg-hover)] ${isCopied ? 'copied' : ''}`}
            title="Copy as Markdown"
          >
            {isCopied ? (
              <MaterialSymbol icon="check" size={16} className="text-[var(--nim-success)]" />
            ) : (
              <MaterialSymbol icon="content_copy" size={16} className="text-[var(--nim-text-faint)]" />
            )}
          </button>
        </div>
        <MessageSegment
          message={message}
          isUser={isUser}
          isCollapsed={isCollapsed}
          showToolCalls={false}
          showThinking={showThinking}
          expandedTools={NO_EXPANDED_TOOLS}
          onToggleToolExpand={toolShared.onToggleTool}
          documentContext={documentContext}
          shouldShowLoginWidget={info.showLoginWidget}
          sessionId={sessionId}
          isLastMessage={info.isLastMessage}
          onOpenFile={onOpenFile}
          onOpenSession={onOpenSession}
          onCompact={onCompact}
          provider={provider}
          workspacePath={workspacePath}
        />
      </div>

      {turn && (
        <div className="rich-transcript-turn-elapsed text-xs text-[var(--nim-text-faint)] mt-2 ml-6">
          Finished in {turn.duration}
          {turn.finishedAt && <span> {turn.finishedAt}</span>}
          {turn.fileStats && (
            <span>
              {' · '}{turn.fileStats.filesModified} file{turn.fileStats.filesModified !== 1 ? 's' : ''}
              {turn.fileStats.linesAdded > 0 && <span className="text-[var(--nim-success)] opacity-60"> +{turn.fileStats.linesAdded}</span>}
              {turn.fileStats.linesRemoved > 0 && <span className="text-[var(--nim-error)] opacity-60"> -{turn.fileStats.linesRemoved}</span>}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
