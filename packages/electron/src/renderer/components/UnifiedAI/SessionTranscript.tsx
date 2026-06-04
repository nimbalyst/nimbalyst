/**
 * SessionTranscript - Encapsulated transcript + input for a single session
 *
 * This component is designed to be swapped in/out based on which session tab is active.
 * It manages all session-specific state via Jotai atoms:
 * - Draft input text
 * - Draft attachments
 * - Queued prompts
 * - Todos
 *
 * It does NOT manage:
 * - Layout (sidebar, editor area)
 * - Session switching/tabs
 * - File edits aggregation (parent handles this)
 */

import React, { useCallback, useRef, useImperativeHandle, forwardRef, useEffect, useState, useMemo } from 'react';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { store, registerInteractiveWidgetHost, unregisterInteractiveWidgetHost } from '@nimbalyst/runtime/store';
import type { SessionData, ChatAttachment, TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';
import { AgentTranscriptPanel } from '@nimbalyst/runtime/ui/AgentTranscript/components/AgentTranscriptPanel';
import type { InteractiveWidgetHost, PermissionScope } from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';
import type { TodoItem } from '@nimbalyst/runtime/ui/AgentTranscript/types';
import { isToolLikeMessage } from '@nimbalyst/runtime/ui/AgentTranscript/utils/messageTypeHelpers';
import { AIInput, AIInputRef } from './AIInput';
import { PromptQueueList } from './PromptQueueList';
import { TranscriptEmbeddedFileCard } from './TranscriptEmbeddedFileCard';
import { getDiffPeekSizeForInteractiveWidgetHost } from './interactiveWidgetHostProxy';
import { customEditorRegistry } from '../CustomEditors/registry';
import { useDialog } from '../../contexts/DialogContext';
import { FileGutter } from '../AIChat/FileGutter';
import { recordClaudeActivity } from '../../store/listeners/claudeUsageListeners';
import { recordCodexActivity } from '../../store/listeners/codexUsageListeners';
import { PendingReviewBanner } from '../AIChat/PendingReviewBanner';
import { WakeupBanner } from '../AIChat/WakeupBanner';
import type { AIMode } from './ModeTag';
// Note: ExitPlanMode, AskUserQuestion, and ToolPermission use inline widgets via InteractiveWidgetHost (in runtime package)
import { SlashCommandSuggestions } from './SlashCommandSuggestions';
import { InlineTipDisplay } from '../../tips/InlineTipDisplay';
import { activeTipIdAtom } from '../../tips/atoms';
import { supportsWorkspaceSlashCommands } from '../Typeahead/slashCommandAutocomplete';
import type { TextSelection } from './TextSelectionIndicator';
import { type SerializableDocumentContext } from '../../hooks/useDocumentContext';
import { diffTreeGroupByDirectoryAtom, setDiffTreeGroupByDirectoryAtom } from '../../store/atoms/projectState';
import {
  sessionDraftInputAtom,
  sessionDraftAttachmentsAtom,
  sessionStoreAtom,
  sessionLoadedAtom,
  sessionMessagesAtom,
  sessionProviderAtom,
  sessionTokenUsageAtom,
  sessionStatusAtom,
  sessionCurrentTeammatesAtom,
  sessionCurrentTodosAtom,
  sessionWorktreePathAtom,
  sessionDocumentContextAtom,
  sessionEffortLevelRawAtom,
  sessionLoadingAtom,
  sessionModeAtom,
  sessionModelAtom,
  sessionArchivedAtom,
  sessionProcessingAtom,
  sessionHasPendingInteractivePromptAtom,
  sessionWorktreeIdAtom,
  sessionPhaseAtom,
  sessionRegistryAtom,
  loadSessionDataAtom,
  reloadSessionDataAtom,
  updateSessionStoreAtom,
  navigateSessionHistoryAtom,
  resetSessionHistoryAtom,
  createChildSessionAtom,
  sessionChildrenAtom,
  sessionParentIdAtom,
  // DB-derived atoms for durable prompts
  sessionPendingPromptsAtom,
  // Note: ExitPlanMode, AskUserQuestion, and ToolPermission use inline widgets, no atom needed
  refreshPendingPromptsAtom,
  respondToPromptAtom,
  // Centralized transcript state atoms
  sessionErrorAtom,
  sessionQueuedPromptsAtom,
  sessionPendingReviewFilesAtom,
  clearSessionError,
  loadInitialQueuedPrompts,
} from '../../store';
import { streamCompletionSignalAtom } from '../../store/atoms/sessionTranscript';
import { convertToWorkstreamAtom, sessionPromptAdditionsAtom, sessionLastSubmitAtAtom, sessionDraftLocalModifiedAtAtom, nextOptimisticId } from '../../store/atoms/sessions';
import { clearAIInputHistoryAtom } from '../../store/atoms/aiInputUndo';
import { scrollToTeammateAtom, scrollToMessageAtom, requestOpenSessionAtom } from '../../store/atoms/agentMode';
import { usePostHog } from 'posthog-js/react';
import { setAgentModeSettingsAtom, showPromptAdditionsAtom, hasExternalEditorAtom, externalEditorNameAtom, openInExternalEditorAtom, defaultAgentModelAtom, defaultEffortLevelAtom, chatShowToolCallsAtom } from '../../store/atoms/appSettings';
import { supportsEffortLevel, parseEffortLevel, type EffortLevel } from '../../utils/modelUtils';
import { buildPlanImplementationPrompt, resolvePlanFilePath } from '../../utils/pathUtils';
import { resolveTranscriptClickPath } from '../../utils/resolveTranscriptClickPath';
import { autoCommitEnabledAtom, setAutoCommitEnabledAtom } from '../../store/atoms/autoCommitAtoms';
import { diffPeekSizeAtom, setDiffPeekSizeAtom } from '../../store/atoms/diffPeekSizeAtoms';
import { registerSessionWorkspace, loadInitialSessionFileState } from '../../store/listeners/fileStateListeners';
import { SESSION_PHASE_COLUMNS, setSessionPhaseAtom, type SessionPhase } from '../../store/atoms/sessionKanban';

/**
 * Detect a metadata value that's the artifact of `{...stringValue, ...}` -
 * the spread treats each character of the string as a numeric-keyed
 * property, producing objects with millions of `"0"`, `"1"`, ... entries.
 * Spreading such an object via `...metadata` later in the render path
 * throws V8's "RangeError: Too many properties to enumerate" and crashes
 * the session view. Two known sessions in production hit this state via
 * a legacy bad write upstream; the row should be cleaned DB-side, but
 * the UI must not crash before that runs.
 *
 * Heuristic uses only the `in` operator (O(1) property lookups) so we
 * never trigger the same enumeration that would re-throw the RangeError.
 * If keys "0","1","2" all exist as own properties AND none of the real
 * metadata field names do, treat as the spread-of-string artifact.
 */
function isCorruptedSpreadOfString(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (!('0' in obj) || !('1' in obj) || !('2' in obj)) return false;
  // Known real metadata fields. Any one of them present means the object
  // has at least some legitimate structure even if it also has stray
  // numeric keys (which we'd rather keep than wipe).
  const realKeys = ['tags', 'phase', 'metadata', 'tokenUsage', 'hasUnread', 'effortLevel', 'linkedTrackerItemIds'];
  for (const k of realKeys) {
    if (k in obj) return false;
  }
  return true;
}

/**
 * Expand @@[name](shortId) session mentions to @@[name](fullUuid).
 * Short IDs (5 chars) are used in the textarea for readability;
 * at send time we resolve them to full UUIDs for the agent.
 */
function expandSessionMentions(
  message: string,
  registry: Map<string, import('@nimbalyst/runtime').SessionMeta>
): string {
  return message.replace(/@@\[([^\]]+)\]\(([a-f0-9]+)\)/g, (_match, name, shortId) => {
    for (const [fullId] of registry) {
      if (fullId.startsWith(shortId)) {
        return `@@[${name}](${fullId})`;
      }
    }
    // No match found -- leave as-is
    return _match;
  });
}

function makeOptimisticError(text: string, extra?: Partial<TranscriptViewMessage>): TranscriptViewMessage {
  return {
    id: nextOptimisticId(),
    sequence: -1,
    createdAt: new Date(),
    type: 'system_message',
    text,
    subagentId: null,
    isError: true,
    systemMessage: { systemType: 'error' },
    ...extra,
  };
}

function summarizeTeammates(
  teammates: Array<{ agentId: string; status: 'running' | 'completed' | 'errored' | 'idle' }> | undefined
): string {
  if (!teammates || teammates.length === 0) return 'none';
  return teammates.map(tm => `${tm.agentId}:${tm.status}`).join(', ');
}

function emitSessionRenderTrace(event: string, payload: Record<string, unknown>): void {
  // console.info(`[RenderTrace][SessionTranscript] ${event} ${JSON.stringify(payload)}`);
}

function makeOptimisticUserMessage(
  text: string,
  mode?: 'agent' | 'planning',
  attachments?: ChatAttachment[],
): TranscriptViewMessage {
  return {
    id: nextOptimisticId(),
    sequence: -1,
    createdAt: new Date(),
    type: 'user_message',
    text,
    subagentId: null,
    mode,
    attachments,
  };
}

interface Todo {
  status: 'pending' | 'in_progress' | 'completed';
  content: string;
  activeForm: string;
}

export interface SessionTranscriptRef {
  focusInput: () => void;
}

export interface SessionTranscriptProps {
  sessionId: string;
  workspacePath: string;

  // UI mode affects placeholder text and features
  mode: 'chat' | 'agent';

  // Whether to hide the internal sidebar (parent may render an external one)
  hideSidebar?: boolean;

  // Whether to collapse the transcript (hide messages, show only input and dialogs)
  // Used when editor is maximized but we still want to show the AI input
  collapseTranscript?: boolean;

  // Click handlers
  onFileClick?: (filePath: string) => void;
  onTodoClick?: (todo: TodoItem) => void;

  // Archive callbacks
  onCloseAndArchive?: (sessionId: string) => void;
  onSessionTitleChanged?: (sessionId: string, title: string) => void;

  // Clear session callback (for files mode - creates new standalone session)
  onClearSession?: () => void;

  // Clear agent session callback (for agent mode - creates new session in worktree or workstream)
  onClearAgentSession?: () => void;

  // Create new session in worktree callback (returns new session ID)
  // Used by handleExitPlanModeStartNewSession when in a worktree
  onCreateWorktreeSession?: (worktreeId: string) => Promise<string | null>;

  // Document context (for chat mode where parent provides it)
  documentContext?: SerializableDocumentContext;

  // On-demand getter for document context (preferred over static documentContext)
  // Async because it reads file content from disk for consistency across all editor types
  getDocumentContext?: () => Promise<SerializableDocumentContext>;

  // Optional: additional active workers to merge into transcript teammate status.
  // Used by meta-agent mode to surface delegated child sessions.
  additionalTeammates?: Array<{ agentId: string; status: 'running' | 'completed' | 'errored' | 'idle' }>;

  // Optional: noun used in waiting text when other workers are still running.
  waitingForNoun?: string;
}

/**
 * Serialize document context for IPC calls.
 * Always sends full content - backend handles diff optimization.
 */
function serializeDocumentContext(
  documentContext: SerializableDocumentContext | undefined
): SerializableDocumentContext | undefined {
  if (!documentContext) return undefined;
  return {
    filePath: documentContext.filePath,
    content: documentContext.content,
    fileType: documentContext.fileType,
    textSelection: documentContext.textSelection,
    textSelectionTimestamp: documentContext.textSelectionTimestamp,
    mockupSelection: documentContext.mockupSelection,
    mockupDrawing: documentContext.mockupDrawing,
    editorContext: documentContext.editorContext,
    editorContextTimestamp: documentContext.editorContextTimestamp,
  };
}

// Read transcript-linked files through the main process so file widgets can
// open persisted outputs and generated artifacts consistently.
const readFile = async (filePath: string): Promise<{ success: boolean; content?: string; error?: string }> => {
  try {
    const result = await window.electronAPI.readFileContent(filePath);
    if (!result) {
      return { success: false, error: `File not found: ${filePath}` };
    }
    if (!result.success) {
      return { success: false, error: result.error || 'Failed to read file' };
    }
    return { success: true, content: result.content };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to read file'
    };
  }
};

/**
 * Helper to persist or clear a metadata field on a session.
 * Handles both the IPC call and local store update.
 * Uses store.get() to fetch current sessionData, so callers don't need to pass it.
 */
async function updateSessionMetadataField<T>(
  sessionId: string,
  field: string,
  value: T | null,
  _sessionData: SessionData | null,  // Deprecated - kept for backwards compatibility, not used
  updateSessionStore: (params: { sessionId: string; updates: Partial<SessionData> }) => void
): Promise<void> {
  try {
    // Update local store FIRST (before async IPC) to ensure immediate availability
    const currentSessionData = store.get(sessionStoreAtom(sessionId));

    if (currentSessionData) {
      const newMetadata = {
        ...(currentSessionData.metadata as Record<string, unknown> || {}),
        [field]: value
      };
      updateSessionStore({
        sessionId,
        updates: {
          metadata: newMetadata
        }
      });
    }

    // Then persist to database
    await window.electronAPI.invoke('sessions:update-metadata', sessionId, {
      metadata: { [field]: value }
    });
  } catch (error) {
    console.error(`[SessionTranscript] Failed to update ${field} metadata:`, error);
  }
}

// Props for the input wrapper — same as AIInput minus the value/onChange
// pair (which the wrapper owns) and attachments handling (we wire it up
// directly so the attachments subscription is isolated too).
type SessionAIInputProps = Omit<
  React.ComponentProps<typeof AIInput>,
  'value' | 'onChange' | 'attachments' | 'onAttachmentAdd' | 'onAttachmentRemove'
> & {
  sessionId: string;
  workspacePath: string;
  enableAttachments: boolean;
  onAttachmentAdd?: (attachment: ChatAttachment) => void;
  onAttachmentRemove?: (attachmentId: string) => void;
};

/**
 * Thin wrapper that owns the draft-input and draft-attachments
 * subscriptions for one session. Extracted from SessionTranscript so that
 * each keystroke re-renders only this component (and the textarea inside
 * AIInput) instead of cascading through the entire transcript / banners /
 * queue list — which used to break text selection in the messages area.
 *
 * Also owns the debounced persistence of the draft to PGLite (formerly in
 * SessionTranscript), since that effect needs to fire on every draftInput
 * change.
 */
const SessionAIInput = forwardRef<AIInputRef, SessionAIInputProps>(function SessionAIInput(
  { sessionId, workspacePath, enableAttachments, onAttachmentAdd, onAttachmentRemove, ...rest },
  ref,
) {
  const [draftInput, setDraftInputRaw] = useAtom(sessionDraftInputAtom(sessionId));
  const draftAttachments = useAtomValue(sessionDraftAttachmentsAtom(sessionId));
  const setDraftLocalModifiedAt = useSetAtom(sessionDraftLocalModifiedAtAtom(sessionId));

  const handleChange = useCallback((value: string) => {
    setDraftInputRaw(value);
    setDraftLocalModifiedAt(Date.now());
  }, [setDraftInputRaw, setDraftLocalModifiedAt]);

  // Debounced persistence of draft input to database — survives restarts.
  useEffect(() => {
    if (!workspacePath) return;
    const timeoutId = setTimeout(() => {
      window.electronAPI.invoke('ai:saveDraftInput', sessionId, draftInput, workspacePath)
        .catch(err => console.error('[SessionAIInput] Failed to persist draft input:', err));
    }, 1000);
    return () => clearTimeout(timeoutId);
  }, [sessionId, draftInput, workspacePath]);

  return (
    <AIInput
      ref={ref}
      value={draftInput}
      onChange={handleChange}
      workspacePath={workspacePath}
      sessionId={sessionId}
      attachments={enableAttachments ? draftAttachments : undefined}
      onAttachmentAdd={enableAttachments ? onAttachmentAdd : undefined}
      onAttachmentRemove={enableAttachments ? onAttachmentRemove : undefined}
      {...rest}
    />
  );
});

/**
 * SessionTranscript - Fully encapsulated transcript + input for one session
 */
export const SessionTranscript = forwardRef<SessionTranscriptRef, SessionTranscriptProps>(({
  sessionId,
  workspacePath,
  mode,
  hideSidebar = false,
  collapseTranscript = false,
  onFileClick,
  onTodoClick,
  onCloseAndArchive,
  onSessionTitleChanged,
  onClearSession,
  onClearAgentSession,
  onCreateWorktreeSession,
  documentContext,
  getDocumentContext,
  additionalTeammates,
  waitingForNoun,
}, ref) => {
  const posthog = usePostHog();
  const inputRef = useRef<AIInputRef>(null);
  const transcriptPanelRef = useRef<{ scrollToMessage: (index: number) => void; scrollToTop: () => void }>(null);

  // Get effective document context - prefer getter for fresh data (reads from disk at call time)
  const getEffectiveDocumentContext = useCallback(async () => {
    return getDocumentContext ? await getDocumentContext() : documentContext;
  }, [getDocumentContext, documentContext]);

  // Get current file path for selection indicator - use static prop only
  // (getDocumentContext is async so can't be used in render - it's called on-demand when sending messages)
  const currentFilePath = documentContext?.filePath;

  // ============================================================
  // Session state via Jotai atoms - component owns its own data
  // Use derived atoms to avoid re-rendering on unrelated changes
  // ============================================================
  const messages = useAtomValue(sessionMessagesAtom(sessionId));
  const provider = useAtomValue(sessionProviderAtom(sessionId));
  const tokenUsage = useAtomValue(sessionTokenUsageAtom(sessionId));
  const isDataLoading = useAtomValue(sessionLoadingAtom(sessionId));
  const chatShowToolCalls = useAtomValue(chatShowToolCallsAtom);
  const [aiMode, setAiMode] = useAtom(sessionModeAtom(sessionId));
  const [currentModel, setCurrentModel] = useAtom(sessionModelAtom(sessionId));
  const [isArchived, setIsArchived] = useAtom(sessionArchivedAtom(sessionId));
  const [isProcessing, setIsProcessing] = useAtom(sessionProcessingAtom(sessionId));
  const hasPendingInteractivePrompt = useAtomValue(sessionHasPendingInteractivePromptAtom(sessionId));
  const worktreeId = useAtomValue(sessionWorktreeIdAtom(sessionId));
  const hasSessionData = useAtomValue(sessionLoadedAtom(sessionId));
  // NOTE: deliberately NOT subscribing to sessionUpdatedAtAtom. updatedAt churns
  // ~10 Hz during streaming, and nothing downstream actually depends on it
  // for rendering — AgentTranscriptPanel/RichTranscriptView ignore it in their
  // memo comparators. Subscribing here was repainting the input/queue/banners
  // every few ms and breaking text selection.
  const sessionStatus = useAtomValue(sessionStatusAtom(sessionId));
  const metadataTeammates = useAtomValue(sessionCurrentTeammatesAtom(sessionId));
  const currentTodos = useAtomValue(sessionCurrentTodosAtom(sessionId)) as Todo[];
  const sessionWorktreePath = useAtomValue(sessionWorktreePathAtom(sessionId));
  const sessionDocumentContext = useAtomValue(sessionDocumentContextAtom(sessionId));
  const rawEffortLevel = useAtomValue(sessionEffortLevelRawAtom(sessionId));
  const loadSessionData = useSetAtom(loadSessionDataAtom);
  const reloadSessionData = useSetAtom(reloadSessionDataAtom);
  const updateSessionStore = useSetAtom(updateSessionStoreAtom);

  // Child session creation for "start new session" option
  const createChildSession = useSetAtom(createChildSessionAtom);
  const convertToWorkstream = useSetAtom(convertToWorkstreamAtom);
  const sessionChildren = useAtomValue(sessionChildrenAtom(sessionId));
  const sessionParentId = useAtomValue(sessionParentIdAtom(sessionId));
  const defaultModel = useAtomValue(defaultAgentModelAtom);
  const defaultEffortLevel = useAtomValue(defaultEffortLevelAtom);

  const sessionData = useMemo(() => {
    if (!hasSessionData) return null;
    const snapshot = store.get(sessionStoreAtom(sessionId));
    // Guard against corrupted metadata: some legacy rows have a metadata
    // value that's the result of `{...stringValue, ...}`, producing an
    // object with millions of numeric-string keys (each char of the
    // original JSON as its own property). Spreading that into the
    // memoized object below throws "RangeError: Too many properties to
    // enumerate" and crashes the transcript. Sniff for the spread-of-
    // string shape and fall back to an empty object rather than crashing.
    // The underlying row should also be repaired DB-side, but this keeps
    // the UI usable until then.
    const rawMetadata = snapshot?.metadata;
    const safeMetadata = isCorruptedSpreadOfString(rawMetadata)
      ? {}
      : (rawMetadata ?? {});
    return {
      ...(snapshot ?? {}),
      id: snapshot?.id ?? sessionId,
      workspacePath: snapshot?.workspacePath ?? workspacePath,
      worktreePath: sessionWorktreePath ?? snapshot?.worktreePath ?? undefined,
      messages,
      provider,
      tokenUsage,
      documentContext: sessionDocumentContext ?? snapshot?.documentContext,
      // Read updatedAt imperatively from the snapshot — see note above on why
      // we don't subscribe to it.
      updatedAt: snapshot?.updatedAt ?? 0,
      metadata: {
        ...safeMetadata,
        effortLevel: rawEffortLevel ?? (safeMetadata as Record<string, unknown> | undefined)?.effortLevel ?? null,
        sessionStatus,
        currentTeammates: metadataTeammates,
        currentTodos,
      },
    } as SessionData;
  }, [
    hasSessionData,
    sessionId,
    workspacePath,
    messages,
    provider,
    tokenUsage,
    sessionDocumentContext,
    sessionWorktreePath,
    rawEffortLevel,
    sessionStatus,
    metadataTeammates,
    currentTodos,
  ]);

  // Effort level: read from session metadata, fall back to global default
  const showEffortLevel = useMemo(() => supportsEffortLevel(currentModel), [currentModel]);
  const effortLevel = useMemo(() => {
    return rawEffortLevel != null ? parseEffortLevel(rawEffortLevel) : defaultEffortLevel;
  }, [rawEffortLevel, defaultEffortLevel]);

  // Memoize the teammate list passed to AgentTranscriptPanel so its memo
  // comparison doesn't see a new array reference on every keystroke. Without
  // this, typing in the AI input re-rendered SessionTranscript (intended),
  // which created a fresh `transcriptTeammates` array (regression), which
  // tripped AgentTranscriptPanel's `currentTeammates` reference check and
  // re-rendered the entire transcript per character typed.
  const transcriptTeammates = useMemo(() => [
    ...(metadataTeammates ?? []),
    ...(additionalTeammates ?? []),
  ], [metadataTeammates, additionalTeammates]);

  const previousRenderRef = useRef<{
    messageCount: number;
    messageRef: TranscriptViewMessage[] | undefined;
    tokenUsageRef: unknown;
    tokenUsageSummary: string;
    provider: unknown;
    isProcessing: boolean;
    hasPendingInteractivePrompt: boolean;
    aiMode: unknown;
    currentModel: unknown;
    isArchived: boolean;
    pendingReviewFilesRef: unknown;
    pendingReviewFilesSummary: string;
    pendingPromptsCount: number;
    queuedPromptsCount: number;
    todosRef: unknown;
    todosSummary: string;
    sessionErrorRef: unknown;
    promptAdditionsRef: unknown;
    currentPhase: unknown;
    appStartTime: number | null;
    scrollToTeammateTarget: string | null;
    scrollToMessageTarget: string | null;
    sessionStatus: unknown;
    metadataTeammatesRef: unknown;
    metadataTeammatesSummary: string;
    additionalTeammatesRef: unknown;
    additionalTeammatesSummary: string;
    mergedTeammatesRef: unknown;
    mergedTeammatesSummary: string;
    updatedAt: unknown;
  } | null>(null);

  // Draft input setters only — the actual draftInput / draftAttachments
  // subscriptions live inside <SessionAIInput>. Subscribing here would
  // re-render the entire transcript on every keystroke and break text
  // selection in the messages area. Code paths that need the current value
  // (handleSend, handleQueue, openSessionWithDraft callers) read it
  // imperatively via store.get().
  const setDraftInputRaw = useSetAtom(sessionDraftInputAtom(sessionId));
  const setDraftAttachments = useSetAtom(sessionDraftAttachmentsAtom(sessionId));
  const setLastSubmitAt = useSetAtom(sessionLastSubmitAtAtom(sessionId));
  const setDraftLocalModifiedAt = useSetAtom(sessionDraftLocalModifiedAtAtom(sessionId));
  const clearAIInputHistory = useSetAtom(clearAIInputHistoryAtom);

  // Wrap setDraftInput to track local modification time for sync echo rejection
  const setDraftInput = useCallback((value: string | ((prev: string) => string)) => {
    setDraftInputRaw(value);
    setDraftLocalModifiedAt(Date.now());
  }, [setDraftInputRaw, setDraftLocalModifiedAt]);

  // Prompt history navigation via Jotai atoms
  const navigateHistory = useSetAtom(navigateSessionHistoryAtom);
  const resetHistory = useSetAtom(resetSessionHistoryAtom);

  // Show prompt additions setting (dev mode only)
  const showPromptAdditionsSetting = useAtomValue(showPromptAdditionsAtom);
  const isDevelopment = import.meta.env.DEV;
  const showPromptAdditions = isDevelopment && showPromptAdditionsSetting;

  // App start time for restart indicator (dev mode only)
  const [appStartTime, setAppStartTime] = useState<number | null>(null);
  useEffect(() => {
    if (!isDevelopment) return;
    window.electronAPI.extensionDevTools.getProcessInfo()
      .then(info => setAppStartTime(info.startTime))
      .catch(() => {}); // Silently ignore if not available
  }, [isDevelopment]);

  // File action atoms
  const hasExternalEditor = useAtomValue(hasExternalEditorAtom);
  const externalEditorName = useAtomValue(externalEditorNameAtom);
  const openInExternalEditor = useSetAtom(openInExternalEditorAtom);

  // Local state
  const todos = currentTodos;
  const pendingReviewFiles = useAtomValue(sessionPendingReviewFilesAtom(sessionId));
  // Prompt additions state (dev mode) - uses Jotai atom for persistence across navigation
  const [promptAdditions, setPromptAdditions] = useAtom(sessionPromptAdditionsAtom(sessionId));
  // Queued prompts - centralized in atom, updated by sessionTranscriptListeners
  const [queuedPrompts, setQueuedPrompts] = useAtom(sessionQueuedPromptsAtom(sessionId));

  // ============================================================
  // DB-derived pending prompts (durable across session switches/restarts)
  // ============================================================
  const pendingPrompts = useAtomValue(sessionPendingPromptsAtom(sessionId));
  const refreshPendingPrompts = useSetAtom(refreshPendingPromptsAtom);
  const respondToPrompt = useSetAtom(respondToPromptAtom);

  // Note: ExitPlanMode, AskUserQuestion, and ToolPermission use inline widgets via InteractiveWidgetHost
  // Note: GitCommitProposal widget renders directly from tool call data
  // No atom sync needed - widget uses toolCall.id as proposalId

  // Error state - centralized in atom, updated by sessionTranscriptListeners
  const sessionError = useAtomValue(sessionErrorAtom(sessionId));

  // Track mode at last message send to detect mode transitions via toggle button

  // Track if we're currently queueing a message (prevents double-submission)
  const [isQueueing, setIsQueueing] = useState(false);

  // Diff tree grouping state
  const [groupByDirectory] = useAtom(diffTreeGroupByDirectoryAtom);
  const setDiffTreeGroupByDirectory = useSetAtom(setDiffTreeGroupByDirectoryAtom);

  // Agent mode settings (for persisting default model)
  const setAgentModeSettings = useSetAtom(setAgentModeSettingsAtom);

  // Auto-commit setting
  const autoCommitEnabled = useAtomValue(autoCommitEnabledAtom);
  const setAutoCommitEnabled = useSetAtom(setAutoCommitEnabledAtom);

  // Diff peek popover size (shared with git extension)
  const diffPeekSize = useAtomValue(diffPeekSizeAtom);
  const setDiffPeekSize = useSetAtom(setDiffPeekSizeAtom);

  // Session phase for kanban board
  const currentPhase = useAtomValue(sessionPhaseAtom(sessionId));
  const setSessionPhase = useSetAtom(setSessionPhaseAtom);
  const handleSetPhase = useCallback((phase: string | null) => {
    setSessionPhase({ sessionId, phase: phase as SessionPhase | null });
  }, [sessionId, setSessionPhase]);

  const setGroupByDirectory = useCallback((value: boolean) => {
    if (workspacePath) {
      setDiffTreeGroupByDirectory({ groupByDirectory: value, workspacePath });
    }
  }, [workspacePath, setDiffTreeGroupByDirectory]);

  // ============================================================
  // Load session data on mount
  // ============================================================
  useEffect(() => {
    if (!sessionId || !workspacePath) return;
    if (!hasSessionData) {
      loadSessionData({ sessionId, workspacePath });
    } else if (!isProcessing) {
      // Session data exists but session is idle/completed -- reload from DB
      // to pick up any messages that arrived after the cached snapshot
      // (e.g., the user navigated away during streaming and came back after completion)
      reloadSessionData({ sessionId, workspacePath });
    }
  }, [sessionId, workspacePath, hasSessionData, isProcessing, loadSessionData, reloadSessionData]);

  // Ensure centralized file/pending atoms are initialized for this session in Files mode.
  useEffect(() => {
    if (!sessionId || !workspacePath) return;
    registerSessionWorkspace(sessionId, workspacePath);
    loadInitialSessionFileState(sessionId, workspacePath).catch((error) => {
      console.error('[SessionTranscript] Failed to load initial session file state:', error);
    });
  }, [sessionId, workspacePath]);

  // ============================================================
  // Auto-focus input when session data loads
  // ============================================================
  const hasFocusedRef = useRef(false);
  const visibilityObserverRef = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    if (!hasSessionData || hasFocusedRef.current) return;

    // Defer to next tick so the DOM is ready after render
    const timerId = setTimeout(() => {
      const el = inputRef.current?.textarea ?? inputRef.current as unknown as HTMLElement;
      // If the element is inside a hidden container (display:none), focus()
      // silently fails (especially on Windows). Use an IntersectionObserver
      // to retry when the element becomes visible.
      if (el && el.offsetParent === null) {
        visibilityObserverRef.current?.disconnect();
        visibilityObserverRef.current = new IntersectionObserver((entries) => {
          if (entries[0]?.isIntersecting && !hasFocusedRef.current) {
            hasFocusedRef.current = true;
            inputRef.current?.focus();
            visibilityObserverRef.current?.disconnect();
            visibilityObserverRef.current = null;
          }
        });
        visibilityObserverRef.current.observe(el);
        return;
      }

      inputRef.current?.focus();
      hasFocusedRef.current = true;
    }, 0);

    return () => {
      clearTimeout(timerId);
      visibilityObserverRef.current?.disconnect();
      visibilityObserverRef.current = null;
    };
  }, [hasSessionData]);

  // ============================================================
  // IPC events handled by centralized listeners (sessionStateListeners.ts, sessionTranscriptListeners.ts)
  // - ai:message-logged → sessionStateListeners reloads session data
  // - session:title-updated → sessionStateListeners updates sessionStoreAtom
  // - ai:tokenUsageUpdated → sessionTranscriptListeners updates sessionStoreAtom
  // - ai:error → sessionTranscriptListeners updates sessionErrorAtom
  // ============================================================
  const { confirm } = useDialog();

  // Handle errors from centralized atom
  useEffect(() => {
    if (!sessionError) return;

    const handleError = async () => {
      // For tool search errors (common with alternative AI providers like Bedrock)
      if (sessionError.isBedrockToolError) {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const settingsShortcut = isMac ? 'Cmd+,' : 'Ctrl+,';
        await confirm({
          title: 'MCP Tool Configuration Required',
          message: [
            'Some alternative AI providers don\'t fully support deferred tool loading (tool search).',
            '',
            'To fix this:',
            `1. Open Settings (${settingsShortcut})`,
            '2. Go to "Claude Code" panel',
            '3. In the "Environment Variables" section, add:',
            '   ENABLE_TOOL_SEARCH = false',
            '4. Save and retry your request'
          ].join('\n'),
          confirmLabel: 'OK',
          cancelLabel: ''
        });
      }

      // For Codex sessions, OpenAI auth errors are already displayed by the
      // canonical transcript events (via the persisted raw event). Skip creating a
      // duplicate in-memory error message that would show two auth widgets.
      const isCodexOpenAIAuthError = provider === 'openai-codex' &&
        sessionError.message.toLowerCase().includes('api.openai.com') &&
        (sessionError.message.toLowerCase().includes('401 unauthorized') ||
         (sessionError.message.toLowerCase().includes('401') && sessionError.message.toLowerCase().includes('authentication')));

      if (!isCodexOpenAIAuthError) {
        // Add error as an assistant message so user can see what went wrong.
        // isCodexAuthRequired short-circuits the rendered text to a CTA widget
        // that opens the Codex auth section in settings; the raw error string
        // becomes the widget's fallback subtitle.
        const extra: Partial<TranscriptViewMessage> = {};
        if (sessionError.isAuthError) extra.isAuthError = true;
        if (sessionError.isCodexAuthRequired) extra.isCodexAuthRequired = true;
        const errorMessage = makeOptimisticError(
          `Error: ${sessionError.message}`,
          Object.keys(extra).length > 0 ? extra : undefined,
        );
        updateSessionStore({
          sessionId,
          updates: {
            messages: [...messages, errorMessage],
          },
        });
      }
      setIsProcessing(false);

      // Clear the error from the atom after handling
      clearSessionError(sessionId);
    };

    handleError();
  }, [sessionError, sessionId, provider, messages, updateSessionStore, setIsProcessing, confirm]);

  // Derived values
  const isLoading = isProcessing;
  const sessionHasMessages = messages.length > 0;

  // ============================================================
  // Confirmation dialogs (ExitPlanMode, AskUserQuestion, ToolPermission)
  // All prompts are DB-backed and derived from sessionPendingPromptsAtom
  // ============================================================

  // Refresh pending prompts when session loads
  // Note: AskUserQuestion now uses inline widget, no need to register in global store
  useEffect(() => {
    if (sessionId) {
      refreshPendingPrompts(sessionId);
    }
  }, [sessionId, refreshPendingPrompts]);

  // Note: ai:askUserQuestionAnswered handled by sessionStateListeners.ts
  // Note: ai:promptAdditions handled by sessionTranscriptListeners.ts

  // Clear prompt additions when dev mode is disabled
  useEffect(() => {
    if (!showPromptAdditions) {
      setPromptAdditions(null);
    }
  }, [showPromptAdditions, setPromptAdditions]);

  // ============================================================
  // Queued prompts - centralized in sessionTranscriptListeners.ts
  // ============================================================
  // Load initial queued prompts when session loads
  useEffect(() => {
    if (sessionId) {
      loadInitialQueuedPrompts(sessionId);
    }
  }, [sessionId]);

  // Reload queued prompts when AI finishes processing (in case any were added)
  const prevIsLoadingRef = useRef(isLoading);
  useEffect(() => {
    if (prevIsLoadingRef.current && !isLoading) {
      loadInitialQueuedPrompts(sessionId);
    }
    prevIsLoadingRef.current = isLoading;
  }, [isLoading, sessionId]);

  // Trigger queue processing when queuedPrompts change and AI is idle
  useEffect(() => {
    if (queuedPrompts.length > 0 && !isLoading && workspacePath) {
      window.electronAPI.invoke('ai:triggerQueueProcessing', sessionId, workspacePath)
        .catch(error => {
          console.error('[SessionTranscript] Failed to trigger queue processing:', error);
        });
    }
  }, [queuedPrompts.length, isLoading, sessionId, workspacePath]);

  // ============================================================
  // Expose ref methods
  // ============================================================
  useImperativeHandle(ref, () => ({
    focusInput: () => inputRef.current?.focus(),
  }));

  // ============================================================
  // Handlers
  // ============================================================
  const handleAttachmentAdd = useCallback((attachment: ChatAttachment) => {
    setDraftAttachments(prev => [...prev, attachment]);
  }, [setDraftAttachments]);

  const handleAttachmentRemove = useCallback((attachmentId: string) => {
    setDraftAttachments(prev => prev.filter(a => a.id !== attachmentId));
  }, [setDraftAttachments]);

  const handleQueue = useCallback(async (message: string) => {
    if (!message.trim() || isQueueing) return;
    setIsQueueing(true);

    try {
      // Get fresh document context at queue time (reads from disk)
      const effectiveContext = await getEffectiveDocumentContext();
      const serializableContext = serializeDocumentContext(effectiveContext);

      // Read attachments imperatively — we don't subscribe to keep typing
      // from re-rendering the entire transcript.
      const currentAttachments = store.get(sessionDraftAttachmentsAtom(sessionId)) ?? [];

      // If there's already a pending queued prompt, append to it instead of
      // creating a separate entry. This bundles multiple queued messages into
      // one prompt, matching how Claude Code handles stacked queries.
      const lastQueued = queuedPrompts[queuedPrompts.length - 1];
      let combinedPrompt = message.trim();
      let combinedAttachments = currentAttachments;

      if (lastQueued) {
        // Delete the existing queued prompt so we can replace it
        await window.electronAPI.invoke('ai:deleteQueuedPrompt', lastQueued.id);
        combinedPrompt = lastQueued.prompt + '\n\n' + message.trim();
        // Merge attachments from both prompts
        combinedAttachments = [...(lastQueued.attachments || []), ...currentAttachments];
      }

      const result = await window.electronAPI.invoke(
        'ai:createQueuedPrompt',
        sessionId,
        combinedPrompt,
        combinedAttachments,
        serializableContext
      ) as { id: string; prompt: string; timestamp: number };

      setQueuedPrompts(prev => {
        // Remove the old queued prompt (if we merged into it) and add the new combined one
        const filtered = lastQueued ? prev.filter(p => p.id !== lastQueued.id) : prev;
        return [...filtered, {
          id: result.id,
          prompt: combinedPrompt,
          timestamp: result.timestamp,
          documentContext: serializableContext,
          attachments: combinedAttachments
        }];
      });

      setLastSubmitAt(Date.now());
      setDraftInput('');
      setDraftAttachments([]);
      clearAIInputHistory(sessionId);
    } catch (error) {
      console.error('[SessionTranscript] Failed to queue prompt:', error);
    } finally {
      setIsQueueing(false);
    }
  }, [sessionId, getEffectiveDocumentContext, setDraftInput, setDraftAttachments, setLastSubmitAt, isQueueing, queuedPrompts, clearAIInputHistory]);

  const handleSend = useCallback(async () => {
    // Read draft state imperatively — we deliberately don't subscribe to
    // these atoms in SessionTranscript (see SessionAIInput).
    const currentDraftInput = store.get(sessionDraftInputAtom(sessionId)) ?? '';
    if (!currentDraftInput.trim() || !sessionData) return;

    if (isLoading) {
      handleQueue(currentDraftInput.trim());
      return;
    }

    let message = currentDraftInput.trim();
    const attachments = store.get(sessionDraftAttachmentsAtom(sessionId)) ?? [];

    // Intercept /plan command - strip it and switch to planning mode
    // Match "/plan" only when followed by whitespace or end of string (not "/planning" or "/planify")
    let overrideMode = aiMode;
    const planCommandMatch = message.match(/^\/plan(?:\s|$)/);

    if (planCommandMatch) {
      overrideMode = 'planning';
      // Remove /plan from the message, keeping the rest
      message = message.slice(planCommandMatch[0].length).trim();

      // Update mode in atom and session metadata - must succeed before proceeding
      setAiMode('planning');
      try {
        await window.electronAPI.invoke('sessions:update-metadata', sessionId, { mode: 'planning' });
      } catch (error) {
        console.error('[SessionTranscript] Failed to update session mode:', error);
        // Revert local state since persistence failed
        setAiMode(aiMode);
        // Show error to user
        const errorMessage = makeOptimisticError('Failed to switch to planning mode. Please try again.');
        updateSessionStore({
          sessionId,
          updates: {
            messages: [...messages, errorMessage],
          },
        });
        return;
      }

      // If no message after /plan, don't send (just switched mode)
      if (!message) {
        setDraftInput('');
        setDraftAttachments([]);
        clearAIInputHistory(sessionId);
        return;
      }
    }

    // Intercept /implement command - switch to agent mode if in planning mode
    // This allows the /implement command (or planning:implement) to actually code
    // Match "/implement", "/planning:implement", and the legacy "/nimbalyst-planning:implement" form
    const implementCommandMatch = message.match(/^\/(?:nimbalyst-planning:|planning:)?implement(?:\s|$)/);
    if (implementCommandMatch && overrideMode === 'planning') {
      // Switch to agent mode for implementation
      overrideMode = 'agent';
      setAiMode('agent');
      try {
        await window.electronAPI.invoke('sessions:update-metadata', sessionId, { mode: 'agent' });
      } catch (error) {
        console.error('[SessionTranscript] Failed to update session mode for implement:', error);
        // Continue anyway - the command should still work even if mode update fails
      }
    }

    // Intercept /clear command - create new session attached to current
    const clearCommandMatch = message.match(/^\/clear(?:\s|$)/);
    if (clearCommandMatch) {
      // Clear the draft input immediately
      setDraftInput('');
      setDraftAttachments([]);
      clearAIInputHistory(sessionId);

      if (mode === 'chat') {
        // Files mode: Create a new standalone session (same as +new button)
        onClearSession?.();
      } else {
        // Agent mode: Let parent component handle session creation
        // (handles worktree sessions, workstreams, and single sessions properly)
        onClearAgentSession?.();
      }
      return; // Don't send the /clear message to the AI
    }

    // Expand @@[name](shortId) -> @@[name](fullUuid) for agent consumption
    const sessionRegistry = store.get(sessionRegistryAtom);
    message = expandSessionMentions(message, sessionRegistry);

    setLastSubmitAt(Date.now());
    setDraftInput('');
    setDraftAttachments([]);
    clearAIInputHistory(sessionId);
    resetHistory(sessionId); // Reset prompt history navigation
    // Optimistically set processing state - will be confirmed by session:started event
    setIsProcessing(true);

    const userMessage = makeOptimisticUserMessage(
      message,
      overrideMode as 'agent' | 'planning' | undefined,
      attachments.length > 0 ? attachments : undefined,
    );
    updateSessionStore({
      sessionId,
      updates: {
        messages: [...messages, userMessage],
      },
    });

    try {
      // Get fresh document context at send time (reads from disk)
      const effectiveContext = await getEffectiveDocumentContext();

      // Always send full document content - backend handles diff optimization
      const docContext = {
        ...serializeDocumentContext(effectiveContext),
        attachments: attachments.length > 0 ? attachments : undefined,
        mode: overrideMode,
        inputType: 'user' as const,
      };

      await window.electronAPI.invoke('ai:sendMessage', message, docContext, sessionId, workspacePath);

      // Record activity for usage tracking (wake up polling if sleeping)
      if (provider?.startsWith('claude')) {
        recordClaudeActivity();
      } else if (provider === 'openai-codex') {
        recordCodexActivity();
      }
    } catch (error) {
      console.error('[SessionTranscript] Failed to send message:', error);
      // Show error in transcript so user knows what went wrong
      const errorMessage = makeOptimisticError(
        `Error: ${error instanceof Error ? error.message : 'Failed to send message'}`,
      );
      updateSessionStore({
        sessionId,
        updates: {
          messages: [...messages, userMessage, errorMessage],
        },
      });
      setIsProcessing(false);
    }
  }, [sessionId, sessionData, isLoading, getEffectiveDocumentContext, aiMode, workspacePath, setDraftInput, setDraftAttachments, setLastSubmitAt, resetHistory, updateSessionStore, handleQueue, setIsProcessing, messages, mode, onClearSession, onClearAgentSession, clearAIInputHistory]);

  // Launch a sibling session from a `launch: new-session` action prompt.
  // Builds the originating-session mention prefix here (in the renderer) so the
  // main process doesn't have to know about session titles or shortIds, and
  // delegates the spawn + draft/focus orchestration to the action-prompts IPC.
  const handleLaunchActionInNewSession = useCallback(
    async (action: import('../../store/atoms/actionPrompts').ActionPrompt) => {
      if (!workspacePath) return;
      if (!action?.config || action.config.launch !== 'new-session') return;

      const registry = store.get(sessionRegistryAtom);
      const parentMeta = registry.get(sessionId);
      const parentTitle = (parentMeta?.title || 'Session').trim();
      // Action body comes first so slash commands like /implement and /review
      // remain at character 0 of the prompt (Claude Code only recognizes them
      // when they lead the message).
      //
      // Append the full UUID (not the 5-char short ID used in the composer)
      // for two reasons:
      //   1. The receiving session's MarkdownRenderer only treats a link as a
      //      session reference when the href matches the full UUID format
      //      (SESSION_UUID_RE in runtime/MarkdownRenderer.tsx). A short ID
      //      renders as plain text.
      //   2. The receiving agent's session-context MCP tools
      //      (get_session_summary, etc.) take a full UUID; a 5-char prefix
      //      isn't resolvable on the server side and we don't run the
      //      composer-side expandSessionMentions() pass on this path.
      const prompt = `${action.body}\n\nOriginating session: @@[${parentTitle}](${sessionId})`;

      try {
        await window.electronAPI.invoke('action-prompts:launch-new-session', {
          workspacePath,
          parentSessionId: sessionId,
          prompt,
          actionLabel: action.label,
          config: {
            model: action.config.model,
            foreground: action.config.foreground,
            autoSubmit: action.config.autoSubmit,
            worktree: action.config.worktree,
          },
        });
      } catch (err) {
        console.error('[SessionTranscript] Failed to launch action in new session:', err);
      }
    },
    [workspacePath, sessionId]
  );

  const handleCancel = useCallback(async () => {
    try {
      await window.electronAPI.invoke('ai:cancelRequest', sessionId);
      // Note: session:interrupted event will also set this to false via sessionStateListeners
      setIsProcessing(false);
    } catch (error) {
      console.error('[SessionTranscript] Failed to cancel request:', error);
    }
  }, [sessionId, setIsProcessing]);

  const handleFileClick = useCallback((filePath: string) => {
    const baseDir = sessionWorktreePath ?? workspacePath;
    onFileClick?.(resolveTranscriptClickPath(filePath, baseDir));
  }, [onFileClick, sessionWorktreePath, workspacePath]);

  const setRequestOpenSession = useSetAtom(requestOpenSessionAtom);
  const handleOpenSession = useCallback((targetSessionId: string) => {
    setRequestOpenSession(targetSessionId);
  }, [setRequestOpenSession]);

  const handleOpenInExternalEditor = useCallback((filePath: string) => {
    openInExternalEditor(filePath);
  }, [openInExternalEditor]);

  const renderEmbeddedFile = useCallback(({ filePath, defaultExpanded }: { filePath: string; defaultExpanded?: boolean }) => {
    return (
      <TranscriptEmbeddedFileCard
        filePath={filePath}
        onOpenFile={handleFileClick}
        defaultExpanded={defaultExpanded}
      />
    );
  }, [handleFileClick]);

  const canEmbedFile = useCallback((filePath: string) => {
    const registration = customEditorRegistry.findRegistrationForFile(filePath);
    return !!registration?.supportsTranscriptEmbed;
  }, []);

  const handleCompact = useCallback(async () => {
    if (!sessionData) return;

    const message = '/compact';
    const userMessage = makeOptimisticUserMessage(
      message,
      aiMode as 'agent' | 'planning' | undefined,
    );
    updateSessionStore({
      sessionId,
      updates: {
        messages: [...messages, userMessage],
      },
    });

    try {
      // Get fresh document context at compact time (reads from disk)
      const effectiveContext = await getEffectiveDocumentContext();
      const docContext = {
        ...serializeDocumentContext(effectiveContext),
        mode: aiMode,
        inputType: 'user' as const,
      };

      await window.electronAPI.invoke('ai:sendMessage', message, docContext, sessionId, workspacePath);
    } catch (error) {
      console.error('[SessionTranscript] Failed to send /compact command:', error);
    }
  }, [sessionId, sessionData, messages, getEffectiveDocumentContext, aiMode, workspacePath, updateSessionStore]);

  const handleTodoClick = useCallback((todo: TodoItem) => {
    onTodoClick?.(todo);
  }, [onTodoClick]);

  const handleNavigateHistory = useCallback((direction: 'up' | 'down') => {
    navigateHistory({ sessionId, direction });
  }, [sessionId, navigateHistory]);

  const handleCancelQueuedPrompt = useCallback(async (id: string) => {
    try {
      await window.electronAPI.invoke('ai:deleteQueuedPrompt', id);
      setQueuedPrompts(prev => prev.filter(p => p.id !== id));
    } catch (error) {
      console.error('[SessionTranscript] Failed to cancel queued prompt:', error);
    }
  }, []);

  const handleEditQueuedPrompt = useCallback(async (id: string, prompt: string) => {
    try {
      await window.electronAPI.invoke('ai:deleteQueuedPrompt', id);
      setQueuedPrompts(prev => prev.filter(p => p.id !== id));
      // Append to any existing draft so editing multiple queued items doesn't
      // clobber prior text; matches how handleQueue bundles consecutive
      // queued prompts with a blank-line separator.
      setDraftInput(prev => prev.trim().length > 0 ? `${prev}\n\n${prompt}` : prompt);
      inputRef.current?.focus();
    } catch (error) {
      console.error('[SessionTranscript] Failed to edit queued prompt:', error);
    }
  }, [setDraftInput]);

  const handleSendNowQueuedPrompt = useCallback(async (_id: string, _prompt: string) => {
    try {
      // Two-step send-now: (1) interrupt the current turn (graceful for
      // Claude Code, hard abort for other providers via the BaseAIProvider
      // default); (2) explicitly trigger queue processing. The natural
      // completion-handler path also triggers it, and the server's
      // sessionsProcessingQueue guard de-dupes, so this is safe to call.
      // We don't rely on the isLoading auto-effect because session:completed
      // may race or, in some edge cases, may not fire cleanly after abort.
      await window.electronAPI.invoke('ai:interruptCurrentTurn', sessionId);
      if (workspacePath) {
        await window.electronAPI.invoke('ai:triggerQueueProcessing', sessionId, workspacePath);
      }
    } catch (error) {
      console.error('[SessionTranscript] Failed to interrupt for send-now:', error);
    }
  }, [sessionId, workspacePath]);

  const handleCloseAndArchive = useCallback(async () => {
    try {
      await window.electronAPI.invoke('sessions:update-metadata', sessionId, { isArchived: true });
      setIsArchived(true);
      onCloseAndArchive?.(sessionId);
    } catch (error) {
      console.error('[SessionTranscript] Failed to archive session:', error);
    }
  }, [sessionId, setIsArchived, onCloseAndArchive]);

  const handleUnarchive = useCallback(async () => {
    try {
      await window.electronAPI.invoke('sessions:update-metadata', sessionId, { isArchived: false });
      setIsArchived(false);
    } catch (error) {
      console.error('[SessionTranscript] Failed to unarchive session:', error);
    }
  }, [sessionId, setIsArchived]);

  const handleAIModeChange = useCallback(async (newMode: AIMode) => {
    setAiMode(newMode);
    try {
      await window.electronAPI.invoke('sessions:update-metadata', sessionId, { mode: newMode });
    } catch (error) {
      console.error('[SessionTranscript] Failed to update mode:', error);
    }
  }, [sessionId, setAiMode]);

  const handleModelChange = useCallback(async (modelId: string) => {
    const previousModel = currentModel;
    setCurrentModel(modelId);
    // Save as the default model for new sessions
    setAgentModeSettings({ defaultModel: modelId });
    try {
      await window.electronAPI.invoke('sessions:update-metadata', sessionId, { model: modelId });
    } catch (error) {
      console.error('[SessionTranscript] Failed to update model:', error);
      setCurrentModel(previousModel);
      setAgentModeSettings({ defaultModel: previousModel });
    }
  }, [currentModel, sessionId, setCurrentModel, setAgentModeSettings]);

  const handleEffortLevelChange = useCallback(async (level: EffortLevel) => {
    const previousLevel = effortLevel;
    await updateSessionMetadataField(sessionId, 'effortLevel', level, null, updateSessionStore);
    setAgentModeSettings({ defaultEffortLevel: level });
    posthog?.capture('ai_effort_level_changed', {
      effort_level: level,
      previous_level: previousLevel,
    });
  }, [sessionId, updateSessionStore, setAgentModeSettings, effortLevel, posthog]);

  const handleCommandSelect = useCallback((command: string) => {
    setDraftInput(command);
    inputRef.current?.focus();
  }, [setDraftInput]);

  // Confirmation handlers
  const handleExitPlanModeApprove = useCallback(async (requestId: string, confirmSessionId: string) => {
    try {
      // Use the unified respondToPromptAtom which persists to DB and notifies provider
      const success = await respondToPrompt({
        sessionId: confirmSessionId,
        promptId: requestId,
        promptType: 'exit_plan_mode_request',
        response: { approved: true },
      });

      if (success) {
        setAiMode('agent');

        // Track exit plan mode response
        posthog?.capture('exit_plan_mode_response', {
          decision: 'approved',
        });
      }
    } catch (error) {
      console.error('[SessionTranscript] Failed to send ExitPlanMode approval:', error);
    }
  }, [respondToPrompt, setAiMode, posthog]);

  const handleExitPlanModeDeny = useCallback(async (requestId: string, confirmSessionId: string, feedback?: string) => {
    try {
      // Use the unified respondToPromptAtom which persists to DB and notifies provider
      await respondToPrompt({
        sessionId: confirmSessionId,
        promptId: requestId,
        promptType: 'exit_plan_mode_request',
        response: { approved: false, feedback },
      });

      // Track exit plan mode response
      posthog?.capture('exit_plan_mode_response', {
        decision: 'denied',
        has_feedback: !!feedback,
      });
    } catch (error) {
      console.error('[SessionTranscript] Failed to send ExitPlanMode denial:', error);
    }
  }, [respondToPrompt, posthog]);

  const openSessionWithDraft = useCallback((targetSessionId: string, draftInput: string) => {
    if (!workspacePath) {
      console.error('[SessionTranscript] Cannot open session with draft without workspacePath');
      return;
    }

    window.dispatchEvent(new CustomEvent('open-ai-session', {
      detail: {
        sessionId: targetSessionId,
        workspacePath,
        draftInput,
      }
    }));
  }, [workspacePath]);

  const stopExitPlanModeSession = useCallback(async (requestId: string, confirmSessionId: string) => {
    // Mark the prompt as cancelled in DB so it doesn't reappear
    await respondToPrompt({
      sessionId: confirmSessionId,
      promptId: requestId,
      promptType: 'exit_plan_mode_request',
      response: { approved: false, cancelled: true },
    });

    // Cancel the entire agent session - this will abort the waiting ExitPlanMode request
    await window.electronAPI.invoke('ai:cancelRequest', confirmSessionId);
  }, [respondToPrompt]);

  // Handler for "Start new session to implement" option
  // Creates a new session and opens it with a populated draft before stopping the current plan session.
  // For worktree sessions: creates a new session in the same worktree (no parent-child hierarchy)
  // For regular sessions: creates a workstream hierarchy (converts to workstream if needed)
  const handleExitPlanModeStartNewSession = useCallback(async (requestId: string, confirmSessionId: string, planFilePath: string) => {
    try {
      let newSessionId: string | null = null;

      // Check if we're in a worktree session
      if (worktreeId && onCreateWorktreeSession) {
        // Worktree sessions: create a new session in the same worktree (NOT a workstream)
        // This avoids creating workstreams-within-worktrees which is not supported
        console.log('[SessionTranscript] Creating new session in worktree:', worktreeId);
        newSessionId = await onCreateWorktreeSession(worktreeId);
      } else {
        // Regular sessions: use workstream hierarchy logic
        const hasChildren = sessionChildren.length > 0;

        if (hasChildren || sessionParentId) {
          // Already part of a workstream hierarchy - create a child of the appropriate parent
          // If sessionParentId exists, we're a child session - create sibling under the same parent
          // If hasChildren, we're the root - create child under us
          const parentId = sessionParentId || confirmSessionId;
          newSessionId = await createChildSession({
            parentSessionId: parentId,
            workspacePath: workspacePath || '',
            provider: 'claude-code',
            model: defaultModel,
          });
        } else {
          // Single session - convert to workstream first, which creates a sibling session
          const result = await convertToWorkstream({
            sessionId: confirmSessionId,
            workspacePath: workspacePath || '',
            model: defaultModel,
          });
          if (result?.siblingId) {
            newSessionId = result.siblingId;
          }
        }
      }

      if (!newSessionId) {
        console.error('[SessionTranscript] Failed to create new implementation session');
        return;
      }

      const basePath = sessionWorktreePath || workspacePath;
      const absolutePlanPath = resolvePlanFilePath(planFilePath, basePath);
      if (!absolutePlanPath && planFilePath) {
        console.warn('[SessionTranscript] Could not resolve plan file path, using raw path in draft:', planFilePath);
      }

      const implementationPrompt = buildPlanImplementationPrompt({
        planFilePath,
        basePath,
      });

      openSessionWithDraft(newSessionId, implementationPrompt);
      await stopExitPlanModeSession(requestId, confirmSessionId);

      posthog?.capture('exit_plan_mode_response', {
        decision: 'start_new_session',
        is_worktree: !!worktreeId,
      });

      console.log('[SessionTranscript] Created new session for implementation:', newSessionId, 'with draft prompt:', implementationPrompt);
    } catch (error) {
      console.error('[SessionTranscript] Failed to start new session for implementation:', error);
    }
  }, [sessionChildren, sessionParentId, workspacePath, worktreeId, onCreateWorktreeSession, createChildSession, convertToWorkstream, sessionWorktreePath, posthog, defaultModel, openSessionWithDraft, stopExitPlanModeSession]);

  const handleExitPlanModeCancel = useCallback(async (requestId: string, confirmSessionId: string) => {
    try {
      await stopExitPlanModeSession(requestId, confirmSessionId);

      // Track cancellation
      posthog?.capture('exit_plan_mode_response', {
        decision: 'cancelled',
      });
    } catch (error) {
      console.error('[SessionTranscript] Failed to cancel ExitPlanMode:', error);
    }
  }, [stopExitPlanModeSession, posthog]);

  // Note: AskUserQuestion, ToolPermission handlers removed - now handled by inline widgets via InteractiveWidgetHost

  // Set the interactive widget host in the atom - widgets read from here.
  // This provides methods for widgets to call that have access to atoms, callbacks, and analytics.
  //
  // We use a *stable proxy* whose methods read from `liveHostRef` (refreshed
  // every render), and a multi-owner registry (`registerInteractiveWidgetHost`)
  // so two SessionTranscripts displaying the same session -- e.g. one in
  // Files-mode ChatSidebar and one in Agent mode -- can coexist without
  // clobbering each other's host. Without multi-owner, the chat sidebar's
  // host effect unmount/cleanup would null the atom even though the
  // agent-mode transcript is still mounted, leaving the AskUserQuestion
  // widget stuck with no host (header visible, options blank) until the
  // user switched sessions.
  const liveHostRef = useRef<InteractiveWidgetHost | null>(null);
  // Build the live host on every render so its closures stay current.
  const liveHost: InteractiveWidgetHost = {
      sessionId,
      workspacePath: workspacePath || '',
      worktreeId,

      // AskUserQuestion operations
      askUserQuestionSubmit: async (questionId: string, answers: Record<string, string>) => {
        await window.electronAPI.invoke('claude-code:answer-question', { questionId, answers, sessionId });
        posthog?.capture('ask_user_question_answered', {
          numQuestions: Object.keys(answers).length,
        });
      },
      askUserQuestionCancel: async (questionId: string) => {
        await window.electronAPI.invoke('claude-code:cancel-question', { questionId, sessionId });
        posthog?.capture('ask_user_question_cancelled');
      },

      // RequestUserInput operations - durable prompt path
      requestUserInputSubmit: async (promptId: string, answers) => {
        await window.electronAPI.invoke('messages:respond-to-prompt', {
          sessionId,
          promptId,
          promptType: 'request_user_input_request' as const,
          response: { answers, cancelled: false },
          respondedBy: 'desktop' as const,
        });
        // Counts of each field type, no PII.
        const fieldTypeCounts: Record<string, number> = {};
        for (const a of Object.values(answers)) {
          fieldTypeCounts[a.type] = (fieldTypeCounts[a.type] ?? 0) + 1;
        }
        posthog?.capture('request_user_input_answered', {
          numFields: Object.keys(answers).length,
          fieldTypeCounts,
        });
        refreshPendingPrompts(sessionId);
      },
      requestUserInputCancel: async (promptId: string) => {
        await window.electronAPI.invoke('messages:respond-to-prompt', {
          sessionId,
          promptId,
          promptType: 'request_user_input_request' as const,
          response: { answers: {}, cancelled: true },
          respondedBy: 'desktop' as const,
        });
        posthog?.capture('request_user_input_cancelled');
        refreshPendingPrompts(sessionId);
      },

      // ExitPlanMode operations
      exitPlanModeApprove: async (requestId: string) => {
        await handleExitPlanModeApprove(requestId, sessionId);
      },
      exitPlanModeStartNewSession: async (requestId: string, planFilePath: string) => {
        await handleExitPlanModeStartNewSession(requestId, sessionId, planFilePath);
      },
      exitPlanModeDeny: async (requestId: string, feedback?: string) => {
        await handleExitPlanModeDeny(requestId, sessionId, feedback);
      },
      exitPlanModeCancel: async (requestId: string) => {
        await handleExitPlanModeCancel(requestId, sessionId);
      },

      // Tool permission operations
      toolPermissionSubmit: async (requestId: string, response: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' }) => {
        await window.electronAPI.invoke('claude-code:answer-tool-permission', {
          requestId,
          sessionId,
          response,
        });

        posthog?.capture('tool_permission_responded', {
          decision: response.decision,
          scope: response.scope,
        });

        // Refresh pending prompts from DB
        refreshPendingPrompts(sessionId);
      },
      toolPermissionCancel: async (requestId: string) => {
        // Try SDK cancel (might fail for old/inactive sessions - that's OK)
        try {
          await window.electronAPI.invoke('claude-code:cancel-tool-permission', {
            requestId,
            sessionId,
          });
        } catch (error) {
          // Debug logging - uncomment if needed
          // console.log('[SessionTranscript] SDK cancel failed (session may be inactive):', error);
        }

        // Always mark as cancelled in DB so it doesn't reappear
        await respondToPrompt({
          sessionId,
          promptId: requestId,
          promptType: 'permission_request',
          response: { decision: 'deny', scope: 'once', cancelled: true },
        });

        // Refresh pending prompts from DB
        refreshPendingPrompts(sessionId);
      },

      // Auto-commit
      autoCommitEnabled,
      setAutoCommitEnabled: (enabled: boolean) => {
        setAutoCommitEnabled(enabled);
      },

      // Git commit operations
      gitCommit: async (proposalId: string, files: string[], message: string) => {
        try {
          // Execute the git commit via IPC
          // Use worktree path for git operations when in a worktree session
          const gitWorkspacePath = sessionWorktreePath || workspacePath;
          const result = await window.electronAPI.invoke(
            'git:commit',
            gitWorkspacePath,
            message,
            files
          ) as { success: boolean; commitHash?: string; commitDate?: string; error?: string };

          // Send response via unified IPC channel for the durable prompt.
          // A real failure (success=false with an error) maps to action='error',
          // not 'cancelled'. 'cancelled' is reserved for the explicit user-cancel
          // path; collapsing failures into 'cancelled' makes the widget render
          // the cancelled state instead of surfacing the error to the user.
          await window.electronAPI.invoke('messages:respond-to-prompt', {
            sessionId,
            promptId: proposalId,
            promptType: 'git_commit_proposal_request' as const,
            response: {
              action: result.success ? 'committed' : 'error',
              commitHash: result.commitHash,
              commitDate: result.commitDate,
              error: result.error,
              filesCommitted: result.success ? files : undefined,
              commitMessage: result.success ? message : undefined,
            },
            respondedBy: 'desktop' as const,
          });

          return result;
        } catch (error) {
          const errorResult = {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };

          // IPC threw outright. Surface as action='error' for the same reason
          // as above: the user needs to see the failure, not a cancelled state.
          await window.electronAPI.invoke('messages:respond-to-prompt', {
            sessionId,
            promptId: proposalId,
            promptType: 'git_commit_proposal_request' as const,
            response: {
              action: 'error',
              error: errorResult.error,
            },
            respondedBy: 'desktop' as const,
          });

          return errorResult;
        }
      },
      gitCommitCancel: async (proposalId: string) => {
        // Send cancel response via unified IPC
        await window.electronAPI.invoke('messages:respond-to-prompt', {
          sessionId,
          promptId: proposalId,
          promptType: 'git_commit_proposal_request' as const,
          response: {
            action: 'cancelled',
          },
          respondedBy: 'desktop' as const,
        });
      },

      gitFileDiff: async (filePath: string) => {
        try {
          const gitWorkspacePath = sessionWorktreePath || workspacePath;
          const result = await window.electronAPI.invoke(
            'git:file-diff',
            gitWorkspacePath,
            { path: filePath, group: 'working' as const }
          ) as { unifiedDiff: string; isBinary: boolean };
          return { unifiedDiff: result.unifiedDiff, isBinary: result.isBinary };
        } catch (err) {
          console.error('[SessionTranscript] gitFileDiff failed:', err);
          throw err;
        }
      },

      // Diff peek popover size (persisted via AI settings)
      diffPeekSize,
      setDiffPeekSize: (size: { width: number; height: number }) => {
        setDiffPeekSize(size);
      },

      // Super Loop blocked feedback
      superLoopBlockedFeedback: async (feedback: string) => {
        try {
          // 1. Look up the super loop ID for this session
          const iterationResult = await window.electronAPI.invoke(
            'super-loop:get-iteration-by-session',
            sessionId
          ) as { success: boolean; iteration?: { superLoopId: string } | null };

          if (!iterationResult?.success || !iterationResult.iteration) {
            return { success: false, error: 'Could not find Super Loop for this session' };
          }

          const superLoopId = iterationResult.iteration.superLoopId;

          // 2. Send feedback message to the same session
          const feedbackMessage = `The user has provided feedback to help overcome the blockers:\n\n${feedback}\n\nProcess this feedback. Then call the super_loop_progress_update tool with status "running" to clear the blocked state and include a learning entry summarizing the user's feedback.`;

          // 3. Set up stream completion listener using centralized atom signal
          // (avoids dynamic IPC subscriptions which cause memory leaks)
          const signalAtom = streamCompletionSignalAtom(sessionId);
          const initialSignal = store.get(signalAtom);
          const streamComplete = new Promise<void>((resolve) => {
            // Check if signal already advanced (unlikely but safe)
            if (store.get(signalAtom) !== initialSignal) {
              resolve();
              return;
            }
            const unsub = store.sub(signalAtom, () => {
              unsub();
              resolve();
            });
          });

          // 4. Send the message
          await window.electronAPI.invoke(
            'ai:sendMessage',
            feedbackMessage,
            { inputType: 'user' },
            sessionId,
            workspacePath
          );

          // 5. Wait for Claude to finish processing
          await streamComplete;

          // 6. Continue the blocked loop
          await window.electronAPI.invoke(
            'super-loop:continue-blocked',
            superLoopId,
            feedback
          );

          posthog?.capture('super_loop_blocked_feedback_submitted', {
            superLoopId,
            feedbackLength: feedback.length,
          });

          return { success: true };
        } catch (error) {
          console.error('[SessionTranscript] superLoopBlockedFeedback failed:', error);
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },

      // Common operations
      openFile: async (filePath: string) => {
        if (onFileClick) {
          onFileClick(filePath);
        } else {
          await window.electronAPI.invoke('workspace:open-file', { workspacePath, filePath });
        }
      },
      trackEvent: (eventName: string, properties?: Record<string, unknown>) => {
        posthog?.capture(eventName, properties);
      },
  };
  liveHostRef.current = liveHost;

  useEffect(() => {
    // Stable proxy: identity is fixed for the lifetime of this {sessionId,
    // workspacePath, worktreeId} tuple. Methods delegate to the live ref so
    // closures stay current without re-registering the host on every render.
    const proxy: InteractiveWidgetHost = {
      get sessionId() { return liveHostRef.current?.sessionId ?? sessionId; },
      get workspacePath() { return liveHostRef.current?.workspacePath ?? (workspacePath || ''); },
      get worktreeId() { return liveHostRef.current?.worktreeId ?? worktreeId; },
      get autoCommitEnabled() { return liveHostRef.current?.autoCommitEnabled ?? false; },
      get diffPeekSize() { return getDiffPeekSizeForInteractiveWidgetHost(liveHostRef.current); },
      askUserQuestionSubmit: (...args) => liveHostRef.current!.askUserQuestionSubmit(...args),
      askUserQuestionCancel: (...args) => liveHostRef.current!.askUserQuestionCancel(...args),
      requestUserInputSubmit: (...args) => liveHostRef.current!.requestUserInputSubmit(...args),
      requestUserInputCancel: (...args) => liveHostRef.current!.requestUserInputCancel(...args),
      exitPlanModeApprove: (...args) => liveHostRef.current!.exitPlanModeApprove(...args),
      exitPlanModeStartNewSession: (...args) => liveHostRef.current!.exitPlanModeStartNewSession(...args),
      exitPlanModeDeny: (...args) => liveHostRef.current!.exitPlanModeDeny(...args),
      exitPlanModeCancel: (...args) => liveHostRef.current!.exitPlanModeCancel(...args),
      toolPermissionSubmit: (...args) => liveHostRef.current!.toolPermissionSubmit(...args),
      toolPermissionCancel: (...args) => liveHostRef.current!.toolPermissionCancel(...args),
      setAutoCommitEnabled: (...args) => liveHostRef.current!.setAutoCommitEnabled(...args),
      gitCommit: (...args) => liveHostRef.current!.gitCommit(...args),
      gitCommitCancel: (...args) => liveHostRef.current!.gitCommitCancel(...args),
      gitFileDiff: (...args) => liveHostRef.current!.gitFileDiff!(...args),
      setDiffPeekSize: (...args) => liveHostRef.current!.setDiffPeekSize!(...args),
      superLoopBlockedFeedback: (...args) => liveHostRef.current!.superLoopBlockedFeedback(...args),
      openFile: (...args) => liveHostRef.current!.openFile(...args),
      trackEvent: (...args) => liveHostRef.current!.trackEvent(...args),
    };

    registerInteractiveWidgetHost(sessionId, proxy);
    return () => {
      unregisterInteractiveWidgetHost(sessionId, proxy);
    };
  }, [sessionId, workspacePath, worktreeId]);

  // Feature flags
  const enableSlashCommands = supportsWorkspaceSlashCommands(provider);
  const enableAttachments = true;
  const enableHistoryNavigation = true;

  // Last user message timestamp for mockup annotation indicator
  const lastUserMessageTimestamp = React.useMemo(() => {
    const userMessages = messages.filter(m => m.type === 'user_message');
    if (userMessages.length === 0) return null;
    return userMessages[userMessages.length - 1].createdAt?.getTime() || null;
  }, [messages]);

  // Extra content rendered in the empty-session panel: an inline contextual
  // tip (any provider) above the slash command suggestions (claude-code
  // only). InlineTipDisplay registers itself with TipProvider so tips only
  // activate while this surface is mounted.
  const renderEmptyExtra = React.useCallback(() => {
    if (messages.length > 0) return null;
    return (
      <div className="rich-transcript-empty-extras w-full max-w-[640px] flex flex-col items-center gap-6">
        <InlineTipDisplay />
        {provider === 'claude-code' && (
          <SlashCommandSuggestions
            provider={provider}
            hasMessages={false}
            workspacePath={workspacePath}
            sessionId={sessionId}
            onCommandSelect={handleCommandSelect}
          />
        )}
      </div>
    );
  }, [provider, messages.length, workspacePath, sessionId, handleCommandSelect]);

  // When a tip is being shown in the empty panel, hide the generic
  // "ready to assist with" help block so the tip is the focal point.
  const activeTipId = useAtomValue(activeTipIdAtom);
  const hideEmptyHelp = activeTipId !== null && messages.length === 0;

  // Scroll-to-teammate: when the atom fires for this session, find the spawn
  // message and scroll the transcript to it.
  const scrollToTeammate = useAtomValue(scrollToTeammateAtom);
  const setScrollToTeammate = useSetAtom(scrollToTeammateAtom);
  useEffect(() => {
    if (!scrollToTeammate || scrollToTeammate.sessionId !== sessionId) return;
    const { agentId } = scrollToTeammate;

    // Find the Task tool call that spawned this agent and map to the visible row index.
    // In RichTranscriptView, tool messages are rendered with the NEXT assistant message.
    const findVisibleSpawnIndex = (): number | null => {
      const msgs = messages;
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        if (msg.type !== 'subagent') {
          continue;
        }

        const resultText = msg.subagent?.resultSummary ?? '';
        const agentIdFromResult = resultText.match(/\bagent_id:\s*([^\s,;]+)/i)?.[1]?.replace(/^[`"'([{]+|[`"',.;:)\]}]+$/g, '');

        const isMatch =
          msg.subagentId === agentId ||
          agentIdFromResult === agentId ||
          resultText.includes(`agent_id: ${agentId}`);
        if (!isMatch) {
          continue;
        }

        // Tool rows are hidden when followed by an assistant row; scroll to that visible assistant.
        let targetIdx = i + 1;
        while (targetIdx < msgs.length && isToolLikeMessage(msgs[targetIdx])) {
          targetIdx++;
        }
        if (targetIdx < msgs.length && msgs[targetIdx].type === 'assistant_message') {
          return targetIdx;
        }

        // Orphaned tool messages render at their own index.
        return i;
      }

      return null;
    };

    const targetIdx = findVisibleSpawnIndex();
    if (targetIdx === null) {
      // Keep pending request so it can resolve when messages update.
      return;
    }

    transcriptPanelRef.current?.scrollToMessage(targetIdx);
    setScrollToTeammate(null);
  }, [scrollToTeammate, setScrollToTeammate, sessionId, messages]);

  // Scroll-to-message: when PromptQuickOpen selects a prompt, scroll to the
  // matching user message by timestamp.
  const scrollToMessage = useAtomValue(scrollToMessageAtom);
  const setScrollToMessage = useSetAtom(scrollToMessageAtom);
  useEffect(() => {
    if (!scrollToMessage || scrollToMessage.sessionId !== sessionId) return;
    const { timestamp } = scrollToMessage;

    // Find the user message whose timestamp matches the prompt's createdAt.
    const targetIdx = messages.findIndex(msg =>
      msg.type === 'user_message' && Math.abs((msg.createdAt?.getTime() || 0) - timestamp) < 1000
    );

    if (targetIdx === -1) {
      // Messages may not be loaded yet; keep the request pending.
      return;
    }

    // Use double-RAF to run AFTER the auto-scroll-to-bottom effect in
    // RichTranscriptView (which uses a single RAF on messages change).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        transcriptPanelRef.current?.scrollToMessage(targetIdx);
      });
    });
    setScrollToMessage(null);
  }, [scrollToMessage, setScrollToMessage, sessionId, messages]);

  useEffect(() => {
    if (!import.meta.env.DEV || !sessionData) return;

    const nextState = {
      messageCount: sessionData.messages?.length ?? 0,
      messageRef: sessionData.messages,
      tokenUsageRef: tokenUsage,
      tokenUsageSummary: JSON.stringify(tokenUsage ?? null),
      provider,
      isProcessing,
      hasPendingInteractivePrompt,
      aiMode,
      currentModel,
      isArchived,
      pendingReviewFilesRef: pendingReviewFiles,
      pendingReviewFilesSummary: JSON.stringify(Array.from(pendingReviewFiles).sort()),
      pendingPromptsCount: pendingPrompts.length,
      queuedPromptsCount: queuedPrompts.length,
      todosRef: todos,
      todosSummary: JSON.stringify(todos),
      sessionErrorRef: sessionError,
      promptAdditionsRef: promptAdditions,
      currentPhase,
      appStartTime,
      scrollToTeammateTarget: scrollToTeammate ? `${scrollToTeammate.sessionId}:${scrollToTeammate.agentId}` : null,
      scrollToMessageTarget: scrollToMessage ? `${scrollToMessage.sessionId}:${scrollToMessage.timestamp}` : null,
      sessionStatus: sessionData.metadata?.sessionStatus,
      metadataTeammatesRef: metadataTeammates,
      metadataTeammatesSummary: summarizeTeammates(metadataTeammates),
      additionalTeammatesRef: additionalTeammates,
      additionalTeammatesSummary: summarizeTeammates(additionalTeammates),
      mergedTeammatesRef: transcriptTeammates,
      mergedTeammatesSummary: summarizeTeammates(transcriptTeammates),
      updatedAt: sessionData.updatedAt,
    };

    const previous = previousRenderRef.current;
    if (!previous) {
      emitSessionRenderTrace('initial', {
        sessionId,
        messageCount: nextState.messageCount,
        tokenUsage: nextState.tokenUsageSummary,
        provider: nextState.provider,
        isProcessing: nextState.isProcessing,
        hasPendingInteractivePrompt: nextState.hasPendingInteractivePrompt,
        aiMode: nextState.aiMode,
        currentModel: nextState.currentModel,
        isArchived: nextState.isArchived,
        pendingReviewFiles: nextState.pendingReviewFilesSummary,
        pendingPromptsCount: nextState.pendingPromptsCount,
        queuedPromptsCount: nextState.queuedPromptsCount,
        todos: nextState.todosSummary,
        hasSessionError: Boolean(nextState.sessionErrorRef),
        hasPromptAdditions: Boolean(nextState.promptAdditionsRef),
        currentPhase: nextState.currentPhase,
        appStartTime: nextState.appStartTime,
        scrollToTeammateTarget: nextState.scrollToTeammateTarget,
        scrollToMessageTarget: nextState.scrollToMessageTarget,
        sessionStatus: nextState.sessionStatus,
        metadataTeammates: nextState.metadataTeammatesSummary,
        additionalTeammates: nextState.additionalTeammatesSummary,
        mergedTeammates: nextState.mergedTeammatesSummary,
        updatedAt: nextState.updatedAt,
      });
    } else {
      const reasons: string[] = [];
      if (previous.messageRef !== nextState.messageRef) reasons.push(`messages-ref ${previous.messageCount}->${nextState.messageCount}`);
      if (previous.tokenUsageRef !== nextState.tokenUsageRef) reasons.push(`tokenUsage ${previous.tokenUsageSummary}->${nextState.tokenUsageSummary}`);
      if (previous.provider !== nextState.provider) reasons.push(`provider ${String(previous.provider)}->${String(nextState.provider)}`);
      if (previous.isProcessing !== nextState.isProcessing) reasons.push(`isProcessing ${String(previous.isProcessing)}->${String(nextState.isProcessing)}`);
      if (previous.hasPendingInteractivePrompt !== nextState.hasPendingInteractivePrompt) reasons.push(`pendingInteractivePrompt ${String(previous.hasPendingInteractivePrompt)}->${String(nextState.hasPendingInteractivePrompt)}`);
      if (previous.aiMode !== nextState.aiMode) reasons.push(`aiMode ${String(previous.aiMode)}->${String(nextState.aiMode)}`);
      if (previous.currentModel !== nextState.currentModel) reasons.push(`currentModel ${String(previous.currentModel)}->${String(nextState.currentModel)}`);
      if (previous.isArchived !== nextState.isArchived) reasons.push(`isArchived ${String(previous.isArchived)}->${String(nextState.isArchived)}`);
      if (previous.pendingReviewFilesRef !== nextState.pendingReviewFilesRef) reasons.push(`pendingReviewFiles ${previous.pendingReviewFilesSummary}->${nextState.pendingReviewFilesSummary}`);
      if (previous.pendingPromptsCount !== nextState.pendingPromptsCount) reasons.push(`pendingPrompts ${previous.pendingPromptsCount}->${nextState.pendingPromptsCount}`);
      if (previous.queuedPromptsCount !== nextState.queuedPromptsCount) reasons.push(`queuedPrompts ${previous.queuedPromptsCount}->${nextState.queuedPromptsCount}`);
      if (previous.todosRef !== nextState.todosRef) reasons.push(`todos ${previous.todosSummary}->${nextState.todosSummary}`);
      if (previous.sessionErrorRef !== nextState.sessionErrorRef) reasons.push(`sessionError ${String(Boolean(previous.sessionErrorRef))}->${String(Boolean(nextState.sessionErrorRef))}`);
      if (previous.promptAdditionsRef !== nextState.promptAdditionsRef) reasons.push(`promptAdditions ${String(Boolean(previous.promptAdditionsRef))}->${String(Boolean(nextState.promptAdditionsRef))}`);
      if (previous.currentPhase !== nextState.currentPhase) reasons.push(`currentPhase ${String(previous.currentPhase)}->${String(nextState.currentPhase)}`);
      if (previous.appStartTime !== nextState.appStartTime) reasons.push(`appStartTime ${String(previous.appStartTime)}->${String(nextState.appStartTime)}`);
      if (previous.scrollToTeammateTarget !== nextState.scrollToTeammateTarget) reasons.push(`scrollToTeammate ${String(previous.scrollToTeammateTarget)}->${String(nextState.scrollToTeammateTarget)}`);
      if (previous.scrollToMessageTarget !== nextState.scrollToMessageTarget) reasons.push(`scrollToMessage ${String(previous.scrollToMessageTarget)}->${String(nextState.scrollToMessageTarget)}`);
      if (previous.sessionStatus !== nextState.sessionStatus) reasons.push(`sessionStatus ${String(previous.sessionStatus)}->${String(nextState.sessionStatus)}`);
      if (previous.metadataTeammatesRef !== nextState.metadataTeammatesRef) reasons.push(`metadata-teammates ${previous.metadataTeammatesSummary}->${nextState.metadataTeammatesSummary}`);
      if (previous.additionalTeammatesRef !== nextState.additionalTeammatesRef) reasons.push(`additional-teammates ${previous.additionalTeammatesSummary}->${nextState.additionalTeammatesSummary}`);
      if (previous.mergedTeammatesRef !== nextState.mergedTeammatesRef) reasons.push(`merged-teammates ${previous.mergedTeammatesSummary}->${nextState.mergedTeammatesSummary}`);
      if (previous.updatedAt !== nextState.updatedAt) reasons.push(`updatedAt ${String(previous.updatedAt)}->${String(nextState.updatedAt)}`);
      emitSessionRenderTrace('render', {
        sessionId,
        reasons,
        messageCount: nextState.messageCount,
        tokenUsage: nextState.tokenUsageSummary,
        provider: nextState.provider,
        isProcessing: nextState.isProcessing,
        hasPendingInteractivePrompt: nextState.hasPendingInteractivePrompt,
        aiMode: nextState.aiMode,
        currentModel: nextState.currentModel,
        isArchived: nextState.isArchived,
        pendingReviewFiles: nextState.pendingReviewFilesSummary,
        pendingPromptsCount: nextState.pendingPromptsCount,
        queuedPromptsCount: nextState.queuedPromptsCount,
        todos: nextState.todosSummary,
        hasSessionError: Boolean(nextState.sessionErrorRef),
        hasPromptAdditions: Boolean(nextState.promptAdditionsRef),
        currentPhase: nextState.currentPhase,
        appStartTime: nextState.appStartTime,
        scrollToTeammateTarget: nextState.scrollToTeammateTarget,
        scrollToMessageTarget: nextState.scrollToMessageTarget,
        sessionStatus: nextState.sessionStatus,
        metadataTeammates: nextState.metadataTeammatesSummary,
        additionalTeammates: nextState.additionalTeammatesSummary,
        mergedTeammates: nextState.mergedTeammatesSummary,
        updatedAt: nextState.updatedAt,
      });
    }

    previousRenderRef.current = nextState;
  }, [
    sessionId,
    sessionData,
    tokenUsage,
    provider,
    isProcessing,
    hasPendingInteractivePrompt,
    aiMode,
    currentModel,
    isArchived,
    pendingReviewFiles,
    pendingPrompts,
    queuedPrompts,
    todos,
    sessionError,
    promptAdditions,
    currentPhase,
    appStartTime,
    scrollToTeammate,
    scrollToMessage,
    metadataTeammates,
    additionalTeammates,
    transcriptTeammates,
  ]);

  // Loading state
  if (!sessionData) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--nim-text-muted)',
        }}
        data-session-id={sessionId}
      >
        {isDataLoading ? 'Loading session...' : 'Session not found'}
      </div>
    );
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', minHeight: 0 }}
      data-session-id={sessionId}
    >
      {/* Main transcript area - hidden when collapsed */}
      {!collapseTranscript && (
        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
          <AgentTranscriptPanel
            ref={transcriptPanelRef}
            sessionId={sessionId}
            sessionData={sessionData}
            todos={todos}
            isProcessing={isLoading}
            hasPendingInteractivePrompt={hasPendingInteractivePrompt}
            onFileClick={handleFileClick}
            onOpenSession={handleOpenSession}
            hideSidebar={hideSidebar || mode === 'chat'}
            showFloatingActions={mode === 'agent'}
            workspacePath={workspacePath}
            initialSettings={{
              showToolCalls: chatShowToolCalls,
              compactMode: false,
              collapseTools: false,
              showThinking: true,
              showSessionInit: false
            }}
            renderEmptyExtra={renderEmptyExtra}
            hideEmptyHelp={hideEmptyHelp}
            isArchived={isArchived}
            onCloseAndArchive={handleCloseAndArchive}
            onUnarchive={handleUnarchive}
            readFile={readFile}
            renderFilesHeader={mode === 'agent' ? () => (
              <>
                <WakeupBanner sessionId={sessionId} />
                <PendingReviewBanner workspacePath={workspacePath} sessionId={sessionId} />
              </>
            ) : undefined}
            pendingReviewFiles={pendingReviewFiles}
            groupByDirectory={groupByDirectory}
            onGroupByDirectoryChange={setGroupByDirectory}
            onOpenInExternalEditor={hasExternalEditor ? handleOpenInExternalEditor : undefined}
            externalEditorName={externalEditorName}
            onCompact={handleCompact}
            promptAdditions={showPromptAdditions ? promptAdditions : null}
            currentTeammates={transcriptTeammates}
            waitingForNoun={waitingForNoun}
            appStartTime={appStartTime ?? undefined}
            renderEmbeddedFile={renderEmbeddedFile}
            canEmbedFile={canEmbedFile}
            currentPhase={currentPhase}
            phaseColumns={SESSION_PHASE_COLUMNS}
            onSetPhase={handleSetPhase}
          />
        </div>
      )}

      {/* Wakeup + pending review banners - only in chat mode, hidden when collapsed */}
      {mode === 'chat' && !collapseTranscript && (
        <>
          <WakeupBanner sessionId={sessionId} />
          <PendingReviewBanner workspacePath={workspacePath} sessionId={sessionId} />
        </>
      )}

      {/* Edited files gutter at bottom - only in chat mode, hidden when collapsed */}
      {mode === 'chat' && !collapseTranscript && (
        <FileGutter
          sessionId={sessionId}
          workspacePath={workspacePath}
          type="edited"
          onFileClick={handleFileClick}
          pendingReviewFiles={pendingReviewFiles}
        />
      )}

      {/* Queue display */}
      <PromptQueueList
        queue={queuedPrompts}
        onCancel={handleCancelQueuedPrompt}
        onEdit={handleEditQueuedPrompt}
        onSendNow={isLoading ? handleSendNowQueuedPrompt : undefined}
      />

      {/* Note: All interactive prompts (ToolPermission, ExitPlanMode, AskUserQuestion) use inline widgets in transcript */}

      {/* Input area — wrapped so the draftInput subscription doesn't
          re-render the entire SessionTranscript on every keystroke. */}
      <SessionAIInput
        ref={inputRef}
        testId={mode === 'chat' ? 'files-mode-chat-input' : 'agent-mode-chat-input'}
        onSend={handleSend}
        onCancel={handleCancel}
        isLoading={isLoading}
        workspacePath={workspacePath}
        sessionId={sessionId}
        enableAttachments={enableAttachments}
        onAttachmentAdd={handleAttachmentAdd}
        onAttachmentRemove={handleAttachmentRemove}
        enableSlashCommands={enableSlashCommands}
        onNavigateHistory={enableHistoryNavigation ? handleNavigateHistory : undefined}
        placeholder={
          mode === 'chat'
            ? "Ask a question. @ for files, @@ for sessions, / for commands"
            : enableSlashCommands
              ? "Type your message... (Enter to send, Shift+Enter for new line, @ for files, @@ for sessions, / for commands)"
              : "Type your message... (Enter to send, Shift+Enter for new line, @ for files, @@ for sessions, / for commands)"
        }
        mode={aiMode}
        onModeChange={handleAIModeChange}
        currentModel={currentModel}
        onModelChange={handleModelChange}
        sessionHasMessages={sessionHasMessages}
        currentProvider={provider ?? null}
        effortLevel={effortLevel}
        onEffortLevelChange={handleEffortLevelChange}
        showEffortLevel={showEffortLevel}
        tokenUsage={tokenUsage}
        provider={provider}
        onQueue={handleQueue}
        queueCount={queuedPrompts.length}
        currentFilePath={currentFilePath}
        lastUserMessageTimestamp={lastUserMessageTimestamp}
        onLaunchActionInNewSession={handleLaunchActionInNewSession}
      />
    </div>
  );
});

SessionTranscript.displayName = 'SessionTranscript';
