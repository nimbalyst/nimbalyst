/**
 * MobileSessionControlHandler
 *
 * Handles session control messages from mobile devices.
 * The sync layer passes generic messages - this handler interprets them
 * and dispatches to the appropriate AI session logic.
 */

import type { SyncProvider, SessionControlMessage } from '@nimbalyst/runtime/sync';
import {
  isAskUserQuestionProvider,
  isExitPlanModeProvider,
  isToolPermissionProvider,
} from '@nimbalyst/runtime/ai/server';
import { AISessionsRepository, type PermissionScope } from '@nimbalyst/runtime';
import { ipcMain, BrowserWindow } from 'electron';
import { logger } from '../../utils/logger';
import { TrayManager } from '../../tray/TrayManager';
import { resolvePromptTargets } from '../../mcp/tools/codexToolCallResolver';
import {
  getRequestUserInputResponseChannel,
  getRequestUserInputFallbackResponseChannel,
  getToolPermissionResponseChannel,
} from '../../mcp/tools/interactiveToolHandlers';
import { deliverMobilePromptResponse, resolveSessionProvider } from './MobilePromptDelivery';
import {
  getGitCommitProposalResponseChannel,
  resolveGitCommitProposalPromptId,
} from './gitCommitProposalPromptUtils';
import { buildToolPermissionResponseRecord } from './claudeCliToolPermission';
import { getGitSubprocessEnv } from '../gitEnv';
import { findWindowByWorkspace } from '../../window/WindowManager';

const log = logger.ai;

/**
 * Known control message types.
 * The handler interprets these - the sync layer doesn't care about them.
 */
export type ControlMessageType =
  | 'cancel'
  | 'question_response'  // Legacy - kept for backwards compatibility
  | 'prompt_response'    // New unified prompt response type
  | 'prompt'
  | 'archive';

// ============================================================
// Payload Types
// ============================================================

interface QuestionResponsePayload {
  questionId: string;
  answers: Record<string, string>;
  cancelled?: boolean;
}

interface PromptPayload {
  promptId: string;
  prompt: string;
}

/**
 * Unified prompt response payload.
 * All interactive prompts use this structure.
 */
export interface PromptResponsePayload {
  promptType: 'ask_user_question' | 'exit_plan_mode' | 'tool_permission' | 'git_commit' | 'request_user_input';
  promptId: string;
  response:
    | AskUserQuestionResponse
    | ExitPlanModeResponse
    | ToolPermissionResponse
    | GitCommitResponse
    | RequestUserInputResponse;
}

interface RequestUserInputResponse {
  answers: Record<string, unknown>;
  cancelled?: boolean;
}

interface AskUserQuestionResponse {
  answers: Record<string, string>;
  cancelled?: boolean;
}

interface ExitPlanModeResponse {
  approved: boolean;
  feedback?: string;
  startNewSession?: boolean;
}

interface ToolPermissionResponse {
  decision: 'allow' | 'deny';
  scope: PermissionScope;
}

interface GitCommitResponse {
  action: 'committed' | 'cancelled';
  files?: string[];
  message?: string;
}

/**
 * Callbacks the mobile control handler needs from AIService. Passed in so
 * this module stays free of a circular dependency on AIService.
 */
export interface MobileSessionControlCallbacks {
  /**
   * Trigger queue processing for a session. Used by `case 'prompt'` so when
   * iOS delivers a prompt while the desktop session is idle (or busy), the
   * desktop reliably picks it up from the queued_prompts DB.
   */
  triggerQueuedPromptProcessing(sessionId: string, workspacePath: string): Promise<boolean>;

  /**
   * Reset any prompts stuck in 'executing' back to 'pending' for the given
   * session. Used by `case 'cancel'` so a queued prompt in-flight when
   * mobile cancels isn't left permanently wedged.
   */
  rollbackExecutingPrompts(sessionId: string): Promise<number>;
}

/**
 * Initialize the mobile session control handler.
 * Listens for control messages from the sync layer and dispatches to appropriate handlers.
 */
export function initMobileSessionControlHandler(
  syncProvider: SyncProvider,
  findWindowByWorkspace: (workspacePath: string) => BrowserWindow | null | undefined,
  callbacks: MobileSessionControlCallbacks
): () => void {
  if (!syncProvider.onSessionControlMessage) {
    log.warn('Sync provider does not support session control messages');
    return () => {};
  }

  const cleanup = syncProvider.onSessionControlMessage((message) => {
    handleControlMessage(message, findWindowByWorkspace, callbacks);
  });

  // log.info('Mobile session control handler initialized');

  return cleanup;
}

/**
 * Dispatch a control message to the appropriate handler
 */
function handleControlMessage(
  message: SessionControlMessage,
  findWindowByWorkspace: (workspacePath: string) => BrowserWindow | null | undefined,
  callbacks: MobileSessionControlCallbacks
): void {
  log.info('Received control message:', message.type, 'for session:', message.sessionId);

  switch (message.type) {
    case 'cancel':
      void handleCancel(message.sessionId, callbacks);
      break;

    // Legacy handler - kept for backwards compatibility with older mobile versions
    case 'question_response': {
      const payload = message.payload as unknown as QuestionResponsePayload;
      void handleAskUserQuestionResponse(
        message.sessionId,
        payload.questionId,
        payload.answers,
        payload.cancelled ?? false,
        findWindowByWorkspace
      );
      break;
    }

    // New unified prompt response handler
    case 'prompt_response': {
      const payload = message.payload as unknown as PromptResponsePayload;
      handlePromptResponse(
        message.sessionId,
        payload,
        findWindowByWorkspace
      );
      break;
    }

    case 'prompt': {
      // iOS has already written the prompt into queued_prompts via sync.
      // The control message is the trigger: nudge the desktop to start
      // processing so iOS sees the prompt actually run (otherwise the
      // queue auto-trigger only fires on isLoading transitions, which
      // can race or miss the idle case entirely).
      void handlePromptTrigger(message.sessionId, callbacks);
      break;
    }

    case 'archive': {
      const payload = message.payload as { isArchived?: boolean } | undefined;
      const isArchived = payload?.isArchived ?? true;
      handleArchive(message.sessionId, isArchived);
      break;
    }

    default:
      log.warn('Unknown control message type:', message.type);
  }
}

/**
 * Look up the session's workspacePath and ask AIService to drain the queue.
 */
async function handlePromptTrigger(
  sessionId: string,
  callbacks: MobileSessionControlCallbacks
): Promise<void> {
  try {
    const session = await AISessionsRepository.get(sessionId);
    if (!session?.workspacePath) {
      log.warn('Received prompt control message for unknown session:', sessionId);
      return;
    }
    log.info('Triggering queue processing from mobile prompt control:', sessionId);
    await callbacks.triggerQueuedPromptProcessing(sessionId, session.workspacePath);
  } catch (err) {
    log.error('Failed to handle mobile prompt control message:', err);
  }
}

/**
 * Resolve an interactive prompt programmatically (e.g. from the voice agent),
 * reusing the exact same resolution path mobile uses for `prompt_response`
 * session-control messages. The provider/MCP-waiter/DB-poll fallbacks and the
 * renderer notifications are all handled by `handlePromptResponse`.
 */
export function resolveVoicePromptResponse(
  sessionId: string,
  payload: PromptResponsePayload,
): void {
  handlePromptResponse(sessionId, payload, findWindowByWorkspace);
}

/**
 * Handle unified prompt response - dispatches to type-specific handlers
 */
function handlePromptResponse(
  sessionId: string,
  payload: PromptResponsePayload,
  findWindowByWorkspace: (workspacePath: string) => BrowserWindow | null | undefined
): void {
  log.info('Handling prompt response:', payload.promptType, 'promptId:', payload.promptId);

  switch (payload.promptType) {
    case 'ask_user_question': {
      const response = payload.response as AskUserQuestionResponse;
      void handleAskUserQuestionResponse(
        sessionId,
        payload.promptId,
        response.answers,
        response.cancelled ?? false,
        findWindowByWorkspace
      );
      break;
    }

    case 'exit_plan_mode': {
      const response = payload.response as ExitPlanModeResponse;
      handleExitPlanModeResponse(
        sessionId,
        payload.promptId,
        response,
        findWindowByWorkspace
      );
      break;
    }

    case 'tool_permission': {
      const response = payload.response as ToolPermissionResponse;
      handleToolPermissionResponse(
        sessionId,
        payload.promptId,
        response,
        findWindowByWorkspace
      );
      break;
    }

    case 'git_commit': {
      const response = payload.response as GitCommitResponse;
      handleGitCommitResponse(
        sessionId,
        payload.promptId,
        response,
        findWindowByWorkspace
      );
      break;
    }

    case 'request_user_input': {
      const response = payload.response as RequestUserInputResponse;
      handleRequestUserInputResponse(sessionId, payload.promptId, response);
      break;
    }

    default:
      log.warn('Unknown prompt type:', payload.promptType);
  }
}

/**
 * Handle RequestUserInput response from mobile.
 *
 * The desktop MCP handler is waiting on a session-scoped IPC channel + a
 * DB-polling fallback. We try the IPC channel first (matches the MCP server's
 * fast path) and write a `request_user_input_response` row to the DB so the
 * polling fallback resolves even if no IPC waiter is registered (e.g., the
 * MCP transport dropped or the desktop wasn't open when the prompt was
 * created). Then notify all windows to clear the pending UI.
 */
function handleRequestUserInputResponse(
  sessionId: string,
  promptId: string,
  response: RequestUserInputResponse,
): void {
  log.info(
    `[Mobile] RequestUserInput response: promptId=${promptId}, sessionId=${sessionId}, cancelled=${response.cancelled === true}`,
  );

  const { rawId, waiterIds } = resolvePromptTargets(promptId);
  const answers = response.cancelled ? {} : (response.answers ?? {});
  const cancelled = response.cancelled === true;
  // A single payload for both the per-waiter and fallback channels: the
  // per-waiter listener reads only answers/cancelled/respondedBy and ignores
  // the extra id fields the fallback listener needs.
  const ipcPayload = {
    promptId,
    ...(rawId ? { rawPromptId: rawId } : {}),
    answers,
    cancelled,
    respondedBy: 'mobile' as const,
  };

  void deliverMobilePromptResponse({
    promptType: 'request_user_input',
    sessionId,
    waiterIds,
    // No in-process provider: request_user_input is an MCP-only prompt.
    mcpChannel: (sid, waiterId) => getRequestUserInputResponseChannel(sid, waiterId),
    fallbackChannel: (sid) => getRequestUserInputFallbackResponseChannel(sid),
    ipcPayload,
    dbRecord: {
      type: 'request_user_input_response',
      promptId,
      ...(rawId ? { rawPromptId: rawId } : {}),
      waiterIds,
      answers,
      cancelled,
      respondedBy: 'mobile',
      respondedAt: Date.now(),
    },
    notify: () => {
      notifyAllWindows('ai:requestUserInputResolved', { sessionId, promptId });
    },
  });
}

/**
 * Handle a cancel command
 */
async function handleCancel(
  sessionId: string,
  callbacks: MobileSessionControlCallbacks
): Promise<void> {
  // Defensive cleanup (provider-agnostic): if a queued prompt was in-flight when
  // mobile cancelled, the DB row would otherwise stay 'executing' and be invisible
  // to listPending. Rollback so the queue isn't wedged after this cancel.
  const rollbackQueuedPrompts = async () => {
    try {
      const rolledBack = await callbacks.rollbackExecutingPrompts(sessionId);
      if (rolledBack > 0) {
        log.info(`Mobile cancel: rolled back ${rolledBack} executing prompt(s) for session ${sessionId}`);
      }
    } catch (rollbackErr) {
      log.error('Mobile cancel: rollbackExecutingPrompts failed:', rollbackErr);
    }
  };

  // claude-code-cli is an external CLI process with NO in-process provider —
  // abort it by sending Ctrl-C to the terminal PTY, mirroring the desktop
  // `ai:cancelRequest` handler (AIService.ts).
  const { providerType, provider } = await resolveSessionProvider(sessionId);
  if (providerType === 'claude-code-cli') {
    const { getTerminalSessionManager } = await import('../TerminalSessionManager');
    const terminalManager = getTerminalSessionManager();
    if (!terminalManager.isTerminalActive(sessionId)) {
      log.warn('Mobile cancel: no active claude-code-cli terminal for session:', sessionId);
      return;
    }
    await rollbackQueuedPrompts();
    terminalManager.writeToTerminal(sessionId, '\x03');
    log.info('Mobile cancel: sent Ctrl+C to CLI session', sessionId);
    notifyAllWindows('ai:sessionCancelled', { sessionId });
    return;
  }

  if (provider && 'abort' in provider) {
    log.info('Aborting session:', sessionId);
    await rollbackQueuedPrompts();
    (provider as { abort: () => void }).abort();

    // Notify renderer to update UI
    notifyAllWindows('ai:sessionCancelled', { sessionId });
  } else {
    log.warn('No provider found or provider does not support abort:', sessionId);
  }
}

/**
 * Handle an archive/unarchive command from mobile
 */
async function handleArchive(sessionId: string, isArchived: boolean): Promise<void> {
  log.info(`${isArchived ? 'Archiving' : 'Unarchiving'} session from mobile:`, sessionId);

  try {
    await AISessionsRepository.updateMetadata(sessionId, { isArchived });

    // Notify renderer to update UI
    notifyAllWindows('ai:sessionMetadataUpdated', { sessionId, isArchived });
  } catch (error) {
    log.error('Failed to archive session:', error);
  }
}

// ============================================================
// Prompt-Specific Handlers
// ============================================================

/**
 * Handle AskUserQuestion response from mobile
 */
async function handleAskUserQuestionResponse(
  sessionId: string,
  questionId: string,
  answers: Record<string, string>,
  cancelled: boolean,
  _findWindowByWorkspace: (workspacePath: string) => BrowserWindow | null | undefined
): Promise<void> {
  log.info(`[Mobile] AskUserQuestion response: questionId=${questionId}, sessionId=${sessionId}, cancelled=${cancelled}`);

  const { rawId, waiterIds } = resolvePromptTargets(questionId);
  const ipcPayload = {
    questionId,
    ...(rawId ? { rawQuestionId: rawId } : {}),
    answers: cancelled ? {} : answers,
    cancelled,
    respondedBy: 'mobile' as const,
    sessionId,
  };

  await deliverMobilePromptResponse({
    promptType: 'ask_user_question',
    sessionId,
    waiterIds,
    deliverToProvider: (provider) => {
      if (!provider || !isAskUserQuestionProvider(provider)) return false;
      if (cancelled) {
        for (const waiterId of waiterIds) {
          provider.rejectAskUserQuestion(waiterId, new Error('Question cancelled from mobile'), 'mobile');
        }
        return true;
      }
      for (const waiterId of waiterIds) {
        if (provider.resolveAskUserQuestion(waiterId, answers, sessionId, 'mobile')) return true;
      }
      return false;
    },
    mcpChannel: (sid, waiterId) => `ask-user-question-response:${sid}:${waiterId}`,
    fallbackChannel: (sid) => `ask-user-question:${sid}`,
    ipcPayload,
    dbRecord: {
      type: 'ask_user_question_response',
      questionId,
      ...(rawId ? { rawQuestionId: rawId } : {}),
      // Option (A): persist the full alias list so DB-poll recovery is
      // alias-aware without re-deriving aliases in the hot loop.
      waiterIds,
      answers: cancelled ? {} : answers,
      cancelled,
      respondedBy: 'mobile',
      respondedAt: Date.now(),
    },
    notify: () => {
      notifyAllWindows('ai:askUserQuestionAnswered', {
        sessionId,
        questionId,
        answers,
        answeredBy: 'mobile',
        cancelled,
      });
    },
  });
}

/**
 * Handle ExitPlanMode response from mobile
 */
function handleExitPlanModeResponse(
  sessionId: string,
  promptId: string,
  response: ExitPlanModeResponse,
  _findWindowByWorkspace: (workspacePath: string) => BrowserWindow | null | undefined
): void {
  log.info('Handling ExitPlanMode response:', promptId, 'approved:', response.approved);

  // ExitPlanMode has no MCP-over-IPC waiter (the SDK's canUseTool promise is
  // resolved directly on the provider). It DOES have a durable record read by
  // MetaAgentService to know a pending plan prompt was answered, so we persist
  // an `exit_plan_mode_response` row matching the desktop shape (SessionHandlers).
  void deliverMobilePromptResponse({
    promptType: 'exit_plan_mode',
    sessionId,
    deliverToProvider: (provider) => {
      if (!isExitPlanModeProvider(provider)) {
        log.warn('[Mobile] ExitPlanMode: provider cannot resolve confirmation for session:', sessionId);
        return false;
      }
      provider.resolveExitPlanModeConfirmation(
        promptId,
        {
          approved: response.approved,
          clearContext: response.startNewSession,
          feedback: response.feedback,
        },
        sessionId,
        'mobile',
      );
      return true;
    },
    dbRecord: {
      type: 'exit_plan_mode_response',
      requestId: promptId,
      approved: response.approved,
      clearContext: response.startNewSession,
      feedback: response.feedback,
      respondedBy: 'mobile',
      respondedAt: Date.now(),
    },
    notify: () => {
      notifyAllWindows('ai:exitPlanModeResponse', {
        sessionId,
        promptId,
        approved: response.approved,
        feedback: response.feedback,
        startNewSession: response.startNewSession,
        answeredBy: 'mobile',
      });
    },
  });
}

/**
 * Handle ToolPermission response from mobile
 */
function handleToolPermissionResponse(
  sessionId: string,
  promptId: string,
  response: ToolPermissionResponse,
  _findWindowByWorkspace: (workspacePath: string) => BrowserWindow | null | undefined
): void {
  log.info('Handling ToolPermission response:', promptId, 'decision:', response.decision, 'scope:', response.scope);

  void deliverMobilePromptResponse({
    promptType: 'tool_permission',
    sessionId,
    // The MCP waiter (claude-code-cli PreToolUse path) keys on the canonical
    // `tool-perm-…` id; provider-path sessions resolve via deliverToProvider.
    waiterIds: [promptId],
    deliverToProvider: (provider) => {
      if (!isToolPermissionProvider(provider)) {
        log.warn('[Mobile] ToolPermission: provider cannot resolve permission for session:', sessionId);
        return false;
      }
      provider.resolveToolPermission(promptId, response, sessionId, 'mobile');
      return true;
    },
    mcpChannel: (sid, waiterId) => getToolPermissionResponseChannel(sid, waiterId),
    ipcPayload: {
      requestId: promptId,
      sessionId,
      decision: response.decision,
      scope: response.scope,
      respondedBy: 'mobile',
    },
    dbRecord: buildToolPermissionResponseRecord({
      requestId: promptId,
      answer: response,
      respondedBy: 'mobile',
    }),
    notify: () => {
      notifyAllWindows('ai:toolPermissionResponse', {
        sessionId,
        promptId,
        decision: response.decision,
        scope: response.scope,
        answeredBy: 'mobile',
      });
      notifyAllWindows('ai:toolPermissionResolved', { sessionId, requestId: promptId });
    },
  });
}

/**
 * Handle GitCommit response from mobile
 * Mobile can approve the commit, but desktop must execute it
 */
async function handleGitCommitResponse(
  sessionId: string,
  promptId: string,
  response: GitCommitResponse,
  findWindowByWorkspace: (workspacePath: string) => BrowserWindow | null | undefined
): Promise<void> {
  log.info('Handling GitCommit response:', promptId, 'action:', response.action);
  const canonicalPromptId = await resolveGitCommitProposalPromptId(sessionId, promptId);

  // Helper to emit the proposal response to unblock the MCP tool
  const emitProposalResponse = async (result: {
    action: 'committed' | 'cancelled' | 'error';
    commitHash?: string;
    commitDate?: string;
    error?: string;
    filesCommitted?: string[];
    commitMessage?: string;
  }) => {
    const { ipcMain } = await import('electron');
    const responseChannel = getGitCommitProposalResponseChannel(sessionId, canonicalPromptId);
    ipcMain.emit(responseChannel, null, result);

    import('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository').then(({ AgentMessagesRepository }) => {
      AgentMessagesRepository.create({
        sessionId,
        source: 'nimbalyst',
        direction: 'output' as const,
        createdAt: new Date(),
        content: JSON.stringify({
          type: 'git_commit_proposal_response',
          proposalId: canonicalPromptId,
          action: result.action,
          commitHash: result.commitHash,
          commitDate: result.commitDate,
          error: result.error,
          filesCommitted: result.filesCommitted,
          commitMessage: result.commitMessage,
          respondedBy: 'mobile',
          respondedAt: Date.now(),
        }),
      }).catch((err) => {
        log.warn(`[Mobile] Failed to persist GitCommit response: ${err}`);
      });
    });

    // Notify renderer to clear the pending interactive prompt indicator
    notifyAllWindows('ai:gitCommitProposalResolved', { sessionId, proposalId: canonicalPromptId });
    TrayManager.getInstance().onPromptResolved(sessionId);
  };

  if (response.action === 'cancelled') {
    await emitProposalResponse({ action: 'cancelled' });
    return;
  }

  // For 'committed' action, we need to execute the git commit on desktop
  if (!response.files || !response.message) {
    log.error('GitCommit response missing files or message');
    await emitProposalResponse({ action: 'error', error: 'Missing files or message' });
    return;
  }

  // Look up the session's workspace path
  try {
    const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
    const session = await AISessionsRepository.get(sessionId);
    if (!session) {
      log.error('GitCommit: session not found:', sessionId);
      await emitProposalResponse({ action: 'error', error: 'Session not found' });
      return;
    }

    const workspacePath = session.workspacePath;
    if (!workspacePath) {
      log.error('GitCommit: no workspace path for session:', sessionId);
      await emitProposalResponse({ action: 'error', error: 'No workspace path' });
      return;
    }

    const {
      createGitCommitProposalResponse,
      executeGitCommit,
    } = await import('../../services/GitCommitService');
    const commitResult = await executeGitCommit(
      workspacePath,
      response.message,
      response.files,
      { logContext: '[GitCommit mobile]', env: getGitSubprocessEnv() }
    );
    await emitProposalResponse(
      createGitCommitProposalResponse(commitResult, response.files, response.message)
    );
  } catch (error) {
    log.error('[GitCommit mobile] Failed to execute commit:', error);
    await emitProposalResponse({
      action: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Helper to notify all windows
 */
function notifyAllWindows(channel: string, data: Record<string, unknown>): void {
  const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
  for (const win of windows) {
    win.webContents.send(channel, data);
  }
}
