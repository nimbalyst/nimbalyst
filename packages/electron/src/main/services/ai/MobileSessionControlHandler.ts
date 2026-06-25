/**
 * MobileSessionControlHandler
 *
 * Handles session control messages from mobile devices.
 * The sync layer passes generic messages - this handler interprets them
 * and dispatches to the appropriate AI session logic.
 */

import type { SyncProvider, SessionControlMessage } from '@nimbalyst/runtime/sync';
import { ProviderFactory } from '@nimbalyst/runtime/ai/server';
import type { BrowserWindow } from 'electron';
import { logger } from '../../utils/logger';
import type { PermissionScope } from '@nimbalyst/runtime';
import { TrayManager } from '../../tray/TrayManager';
import { resolveRequestUserInputPromptTargets } from '../../mcp/tools/codexToolCallResolver';
import {
  getGitCommitProposalResponseChannel,
  resolveGitCommitProposalPromptId,
} from './gitCommitProposalPromptUtils';
import { buildToolPermissionResponseRecord } from './claudeCliToolPermission';
import {
  getMobileTranscriptHistoryPageJson,
  getMobileTranscriptTailJson,
} from '../../utils/transcriptHelpers';
import { getGitSubprocessEnv } from '../gitEnv';

const log = logger.ai;
const PROJECT_CONTROL_SESSION_ID = '__mobile_project__';

/**
 * Known control message types.
 * The handler interprets these - the sync layer doesn't care about them.
 */
export type ControlMessageType =
  | 'cancel'
  | 'question_response'  // Legacy - kept for backwards compatibility
  | 'prompt_response'    // New unified prompt response type
  | 'prompt'
  | 'delete_queued_prompt'
  | 'send_queued_prompt_now'
  | 'archive'
  | 'pin'
  | 'delete'
  | 'create_project'
  | 'create_project_response'
  | 'load_transcript_history';

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

interface QueuedPromptPayload {
  promptId?: string;
}

interface PinPayload {
  isPinned?: boolean;
}

interface CreateProjectPayload {
  requestId?: string;
  name?: string;
  path?: string;
}

interface TranscriptHistoryPayload {
  count?: number;
  beforeRawMessageId?: number | null;
  requestId?: string;
}

/**
 * Unified prompt response payload.
 * All interactive prompts use this structure.
 */
interface PromptResponsePayload {
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

  /** Delete a pending queued prompt before it has been claimed for execution. */
  deleteQueuedPrompt(sessionId: string, promptId: string): Promise<boolean>;

  /** Interrupt the active turn if needed, then trigger pending queue processing. */
  sendQueuedPromptNow(sessionId: string, promptId?: string): Promise<boolean>;

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
    handleControlMessage(syncProvider, message, findWindowByWorkspace, callbacks);
  });

  // log.info('Mobile session control handler initialized');

  return cleanup;
}

/**
 * Dispatch a control message to the appropriate handler
 */
function handleControlMessage(
  syncProvider: SyncProvider,
  message: SessionControlMessage,
  findWindowByWorkspace: (workspacePath: string) => BrowserWindow | null | undefined,
  callbacks: MobileSessionControlCallbacks
): void {
  log.info('Received control message:', message.type, 'for session:', message.sessionId);

  if (message.sentBy === 'desktop') {
    return;
  }

  switch (message.type) {
    case 'cancel':
      void handleCancel(message.sessionId, callbacks);
      break;

    // Legacy handler - kept for backwards compatibility with older mobile versions
    case 'question_response': {
      const payload = message.payload as unknown as QuestionResponsePayload;
      handleAskUserQuestionResponse(
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

    case 'delete_queued_prompt': {
      const payload = message.payload as unknown as QueuedPromptPayload | undefined;
      if (!payload?.promptId) {
        log.warn('delete_queued_prompt missing promptId:', message.sessionId);
        break;
      }
      void handleDeleteQueuedPrompt(message.sessionId, payload.promptId, callbacks);
      break;
    }

    case 'send_queued_prompt_now': {
      const payload = message.payload as unknown as QueuedPromptPayload | undefined;
      void handleSendQueuedPromptNow(message.sessionId, payload?.promptId, callbacks);
      break;
    }

    case 'archive': {
      const payload = message.payload as { isArchived?: boolean } | undefined;
      const isArchived = payload?.isArchived ?? true;
      void handleArchive(syncProvider, message.sessionId, isArchived);
      break;
    }

    case 'pin': {
      const payload = message.payload as PinPayload | undefined;
      void handlePin(syncProvider, message.sessionId, payload?.isPinned ?? true);
      break;
    }

    case 'delete': {
      void handleDelete(syncProvider, message.sessionId);
      break;
    }

    case 'create_project': {
      const payload = message.payload as CreateProjectPayload | undefined;
      void handleCreateProject(syncProvider, payload);
      break;
    }

    case 'load_transcript_history': {
      const payload = message.payload as TranscriptHistoryPayload | undefined;
      void handleLoadTranscriptHistory(syncProvider, message.sessionId, payload);
      break;
    }

    default:
      log.warn('Unknown control message type:', message.type);
  }
}

async function handleLoadTranscriptHistory(
  syncProvider: SyncProvider,
  sessionId: string,
  payload?: TranscriptHistoryPayload,
): Promise<void> {
  try {
    const count = Number.isFinite(payload?.count)
      ? Math.max(40, Math.min(120, Math.floor(payload?.count as number)))
      : 100;
    const beforeRawMessageId = typeof payload?.beforeRawMessageId === 'number' && Number.isFinite(payload.beforeRawMessageId)
      ? Math.max(1, Math.floor(payload.beforeRawMessageId))
      : null;
    const pageJson = await getMobileTranscriptHistoryPageJson(sessionId, {
      count,
      beforeRawMessageId,
      requestId: payload?.requestId,
    });
    if (!pageJson) {
      log.warn('No mobile transcript history page available:', sessionId, 'count:', count, 'before:', beforeRawMessageId);
      return;
    }

    syncProvider.pushChange?.(sessionId, {
      type: 'metadata_updated',
      metadata: {
        mobileTranscriptHistoryPageJson: pageJson,
        mobileTranscriptHistoryPageUpdatedAt: Date.now(),
      },
    });
  } catch (err) {
    log.error('Failed to handle load_transcript_history control message:', err);
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
    const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
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

async function handleDeleteQueuedPrompt(
  sessionId: string,
  promptId: string,
  callbacks: MobileSessionControlCallbacks
): Promise<void> {
  try {
    const deleted = await callbacks.deleteQueuedPrompt(sessionId, promptId);
    log.info(`Mobile queued prompt delete ${deleted ? 'succeeded' : 'ignored'}:`, sessionId, promptId);
  } catch (err) {
    log.error('Failed to delete queued prompt from mobile:', err);
  }
}

async function handleSendQueuedPromptNow(
  sessionId: string,
  promptId: string | undefined,
  callbacks: MobileSessionControlCallbacks
): Promise<void> {
  try {
    const sent = await callbacks.sendQueuedPromptNow(sessionId, promptId);
    log.info(`Mobile queued prompt send-now ${sent ? 'triggered' : 'ignored'}:`, sessionId, promptId);
  } catch (err) {
    log.error('Failed to send queued prompt now from mobile:', err);
  }
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
      handleAskUserQuestionResponse(
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

  const { ipcMain } = require('electron');
  const { waiterPromptIds: promptIdAliases, rawPromptId } =
    resolveRequestUserInputPromptTargets(promptId);

  import('../../mcp/tools/interactiveToolHandlers').then(({
    getRequestUserInputResponseChannel,
    getRequestUserInputFallbackResponseChannel,
  }) => {
    let hasWaiter = false;
    for (const promptIdAlias of promptIdAliases) {
      const channel = getRequestUserInputResponseChannel(sessionId, promptIdAlias);
      if (ipcMain.listenerCount(channel) > 0) {
        hasWaiter = true;
        log.info(`[Mobile] Emitting on RequestUserInput channel: ${channel}`);
        ipcMain.emit(channel, {}, {
          answers: response.cancelled ? {} : (response.answers ?? {}),
          cancelled: response.cancelled === true,
          respondedBy: 'mobile',
        });
      }
    }
    const fallbackChannel = getRequestUserInputFallbackResponseChannel(sessionId);
    if (!hasWaiter && ipcMain.listenerCount(fallbackChannel) > 0) {
      hasWaiter = true;
      log.info(`[Mobile] Emitting on RequestUserInput fallback channel: ${fallbackChannel}`);
      ipcMain.emit(fallbackChannel, {}, {
        promptId,
        ...(rawPromptId ? { rawPromptId } : {}),
        answers: response.cancelled ? {} : (response.answers ?? {}),
        cancelled: response.cancelled === true,
        respondedBy: 'mobile',
      });
    }
    if (!hasWaiter) {
      log.info(`[Mobile] No MCP waiter for RequestUserInput on ${promptIdAliases.join(', ')} -- relying on DB poll`);
    }
  }).catch((err) => {
    log.warn('[Mobile] Failed to import interactiveToolHandlers:', err);
  });

  // DB fallback: write a response row so the MCP server's polling loop resolves.
  import('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository').then(({ AgentMessagesRepository }) => {
    AgentMessagesRepository.create({
      sessionId,
      source: 'claude-code',
      direction: 'output' as const,
      createdAt: new Date(),
      content: JSON.stringify({
        type: 'request_user_input_response',
        promptId,
        ...(rawPromptId ? { rawPromptId } : {}),
        answers: response.cancelled ? {} : (response.answers ?? {}),
        cancelled: response.cancelled === true,
        respondedBy: 'mobile',
        respondedAt: Date.now(),
      }),
    }).catch((err) => {
      log.warn(`[Mobile] Failed to persist RequestUserInput response: ${err}`);
    });
  });

  // Notify all windows to clear the pending UI.
  notifyAllWindows('ai:requestUserInputResolved', { sessionId, promptId });
  TrayManager.getInstance().onPromptResolved(sessionId);
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
  const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
  const session = await AISessionsRepository.get(sessionId);
  if (session?.provider === 'claude-code-cli') {
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

  const provider = ProviderFactory.getProvider((session?.provider as Parameters<typeof ProviderFactory.getProvider>[0]) || 'claude-code', sessionId);
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
async function handleArchive(syncProvider: SyncProvider, sessionId: string, isArchived: boolean): Promise<void> {
  log.info(`${isArchived ? 'Archiving' : 'Unarchiving'} session from mobile:`, sessionId);

  try {
    const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
    await AISessionsRepository.updateMetadata(sessionId, { isArchived });
    await publishSessionMetadataToMobileIndex(syncProvider, sessionId, { isArchived });

    // Notify renderer to update UI
    notifyAllWindows('ai:sessionMetadataUpdated', { sessionId, isArchived });
  } catch (error) {
    log.error('Failed to archive session:', error);
  }
}

async function handlePin(syncProvider: SyncProvider, sessionId: string, isPinned: boolean): Promise<void> {
  log.info(`${isPinned ? 'Pinning' : 'Unpinning'} session from mobile:`, sessionId);

  try {
    const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
    await AISessionsRepository.updateMetadata(sessionId, { isPinned } as any);
    await publishSessionMetadataToMobileIndex(syncProvider, sessionId, { isPinned } as any);
    notifyAllWindows('ai:sessionMetadataUpdated', { sessionId, isPinned });
  } catch (error) {
    log.error('Failed to update pinned state from mobile:', error);
  }
}

async function publishSessionMetadataToMobileIndex(
  syncProvider: SyncProvider,
  sessionId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  syncProvider.pushChange?.(sessionId, {
    type: 'metadata_updated',
    metadata: metadata as any,
  });

  if (!syncProvider.syncSessionsToIndex) {
    return;
  }

  const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
  const session = await AISessionsRepository.get(sessionId);
  if (!session?.workspacePath) {
    return;
  }

  type SessionIndexDataForProvider = Parameters<NonNullable<SyncProvider['syncSessionsToIndex']>>[0][number];
  const indexData: SessionIndexDataForProvider = {
    id: session.id,
    title: session.title || 'Untitled',
    provider: session.provider || 'unknown',
    model: session.model,
    mode: session.mode,
    sessionType: session.sessionType || 'session',
    parentSessionId: session.parentSessionId || undefined,
    worktreeId: session.worktreeId,
    isArchived: session.isArchived ?? false,
    isPinned: session.isPinned ?? false,
    hasBeenNamed: session.hasBeenNamed,
    branchedFromSessionId: session.branchedFromSessionId,
    branchPointMessageId: session.branchPointMessageId,
    branchedAt: session.branchedAt,
    workspaceId: session.workspacePath,
    workspacePath: session.workspacePath,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    metadata: session.metadata as Record<string, any> | undefined,
  };

  syncProvider.syncSessionsToIndex([indexData], { syncMessages: false });
}

async function handleDelete(syncProvider: SyncProvider, sessionId: string): Promise<void> {
  log.info('Deleting session from mobile:', sessionId);

  try {
    const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
    const session = await AISessionsRepository.get(sessionId);
    ProviderFactory.destroyProvider(sessionId);
    await AISessionsRepository.delete(sessionId);
    await syncProvider.pushChange?.(sessionId, { type: 'session_deleted' });
    notifyAllWindows('sessions:session-deleted', {
      sessionId,
      workspacePath: session?.workspacePath,
      parentSessionId: session?.parentSessionId,
    });
    notifyAllWindows('ai:sessionDeleted', { sessionId });
  } catch (error) {
    log.error('Failed to delete session from mobile:', error);
  }
}

async function handleCreateProject(
  syncProvider: SyncProvider,
  payload?: CreateProjectPayload,
): Promise<void> {
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId : undefined;
  if (!requestId) {
    log.warn('create_project missing requestId');
    return;
  }

  try {
    const projectName = sanitizeProjectName(payload?.name);
    if (!projectName) {
      throw new Error('Project name is required.');
    }

    const fs = await import('fs/promises');
    const path = await import('path');
    const projectPath = resolveProjectPathForMobileCreate(payload?.path, projectName, path);
    await fs.mkdir(projectPath, { recursive: true });

    const { getSessionSyncConfig, setSessionSyncConfig } = await import('../../utils/store');
    const currentSyncConfig = getSessionSyncConfig();
    if (!currentSyncConfig?.serverUrl) {
      throw new Error('Desktop sync is not configured.');
    }
    const enabledProjects = Array.from(new Set([...(currentSyncConfig.enabledProjects ?? []), projectPath]));
    setSessionSyncConfig({
      ...currentSyncConfig,
      enabled: enabledProjects.length > 0,
      enabledProjects,
    });

    await syncProvider.syncProjectConfig?.(projectPath, {
      commands: [],
      lastCommandsUpdate: Date.now(),
    });

    const { createWindow, findWindowByWorkspace } = await import('../../window/WindowManager');
    if (!findWindowByWorkspace(projectPath)) {
      createWindow(false, true, projectPath);
    }

    await sendProjectCreateResponse(syncProvider, {
      requestId,
      success: true,
      projectId: projectPath,
      name: path.basename(projectPath) || projectName,
    });
  } catch (error) {
    log.error('Failed to create project from mobile:', error);
    await sendProjectCreateResponse(syncProvider, {
      requestId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function sanitizeProjectName(name: unknown): string {
  if (typeof name !== 'string') {
    return '';
  }
  return name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

function resolveProjectPathForMobileCreate(
  requestedPath: unknown,
  projectName: string,
  path: typeof import('path'),
): string {
  if (typeof requestedPath === 'string' && requestedPath.trim()) {
    const trimmed = requestedPath.trim();
    const expanded = trimmed === '~' || trimmed.startsWith('~/')
      ? path.join(process.env.HOME || '', trimmed.slice(trimmed === '~' ? 1 : 2))
      : trimmed;
    return path.resolve(expanded);
  }
  return path.join(process.env.HOME || process.cwd(), 'Nimbalyst Projects', projectName);
}

async function sendProjectCreateResponse(
  syncProvider: SyncProvider,
  payload: {
    requestId: string;
    success: boolean;
    projectId?: string;
    name?: string;
    error?: string;
  },
): Promise<void> {
  if (!syncProvider.sendSessionControlMessage) {
    return;
  }
  await syncProvider.sendSessionControlMessage({
    sessionId: PROJECT_CONTROL_SESSION_ID,
    type: 'create_project_response',
    payload,
    timestamp: Date.now(),
    sentBy: 'desktop',
  });
}

// ============================================================
// Prompt-Specific Handlers
// ============================================================

/**
 * Handle AskUserQuestion response from mobile
 */
function handleAskUserQuestionResponse(
  sessionId: string,
  questionId: string,
  answers: Record<string, string>,
  cancelled: boolean,
  _findWindowByWorkspace: (workspacePath: string) => BrowserWindow | null | undefined
): void {
  log.info(`[Mobile] AskUserQuestion response: questionId=${questionId}, sessionId=${sessionId}, cancelled=${cancelled}`);

  let providerResolved = false;
  const provider = ProviderFactory.getProvider('claude-code', sessionId);

  if (provider) {
    if (cancelled) {
      if ('rejectAskUserQuestion' in provider) {
        (provider as { rejectAskUserQuestion: (questionId: string, error: Error) => void })
          .rejectAskUserQuestion(questionId, new Error('Question cancelled from mobile'));
        providerResolved = true;
      }
    } else {
      if ('resolveAskUserQuestion' in provider) {
        providerResolved = (provider as { resolveAskUserQuestion: (questionId: string, answers: Record<string, string>, sessionId: string, source: string) => boolean })
          .resolveAskUserQuestion(questionId, answers, sessionId, 'mobile');
      }
    }
  } else {
    log.warn('[Mobile] No provider found for session:', sessionId);
  }

  // When AskUserQuestion comes through MCP, the provider's pendingAskUserQuestions map
  // is empty, so resolveAskUserQuestion returns false. Fall back to IPC emission +
  // database write so the MCP server's IPC listeners or database polling can resolve it.
  if (!providerResolved) {
    const { ipcMain } = require('electron');

    // Try MCP-specific IPC channel
    const mcpChannel = `ask-user-question-response:${sessionId}:${questionId}`;
    const hasMcpWaiter = ipcMain.listenerCount(mcpChannel) > 0;
    if (hasMcpWaiter) {
      log.info(`[Mobile] Emitting on MCP channel: ${mcpChannel}`);
      ipcMain.emit(mcpChannel, {}, {
        questionId,
        answers: cancelled ? {} : answers,
        cancelled,
        respondedBy: 'mobile',
        sessionId,
      });
    }

    // Try session fallback IPC channel
    const fallbackChannel = `ask-user-question:${sessionId}`;
    const hasFallbackWaiter = ipcMain.listenerCount(fallbackChannel) > 0;
    if (hasFallbackWaiter) {
      log.info(`[Mobile] Emitting on session fallback channel: ${fallbackChannel}`);
      ipcMain.emit(fallbackChannel, {}, {
        questionId,
        answers: cancelled ? {} : answers,
        cancelled,
        respondedBy: 'mobile',
        sessionId,
      });
    }

    // Database fallback: write response so MCP server's database polling can find it
    import('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository').then(({ AgentMessagesRepository }) => {
      AgentMessagesRepository.create({
        sessionId,
        source: 'claude-code',
        direction: 'output' as const,
        createdAt: new Date(),
        content: JSON.stringify({
          type: 'ask_user_question_response',
          questionId,
          answers: cancelled ? {} : answers,
          cancelled,
          respondedBy: 'mobile',
          respondedAt: Date.now()
        })
      }).catch(err => {
        log.warn(`[Mobile] Failed to persist AskUserQuestion response to database: ${err}`);
      });
    });

    log.info(`[Mobile] AskUserQuestion fallback resolution: hasMcpWaiter=${hasMcpWaiter}, hasFallbackWaiter=${hasFallbackWaiter}`);
  }

  // Notify renderer to clear the pending question UI
  notifyAllWindows('ai:askUserQuestionAnswered', {
    sessionId,
    questionId,
    answers,
    answeredBy: 'mobile',
    cancelled,
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

  // Get the provider to resolve the SDK's pending promise
  const provider = ProviderFactory.getProvider('claude-code', sessionId);

  if (!provider) {
    log.warn('No provider found for session:', sessionId);
    return;
  }

  // Call resolveExitPlanModeConfirmation on the provider to resolve the SDK's pending promise
  if ('resolveExitPlanModeConfirmation' in provider) {
    log.info('Resolving ExitPlanMode confirmation:', promptId, 'approved:', response.approved);
    (provider as { resolveExitPlanModeConfirmation: (requestId: string, response: { approved: boolean; clearContext?: boolean; feedback?: string }, sessionId: string, source: string) => void })
      .resolveExitPlanModeConfirmation(
        promptId,
        {
          approved: response.approved,
          clearContext: response.startNewSession,
          feedback: response.feedback,
        },
        sessionId,
        'mobile'
      );
  }

  // Notify renderer to update the UI
  notifyAllWindows('ai:exitPlanModeResponse', {
    sessionId,
    promptId,
    approved: response.approved,
    feedback: response.feedback,
    startNewSession: response.startNewSession,
    answeredBy: 'mobile',
  });

  TrayManager.getInstance().onPromptResolved(sessionId);
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

  // Resolve the permission on the provider directly (same as desktop renderer does via IPC)
  const provider = ProviderFactory.getProvider('claude-code', sessionId);
  log.info('ToolPermission provider lookup:', provider ? 'found' : 'not found', 'hasResolve:', provider ? typeof (provider as any).resolveToolPermission : 'N/A');

  if (provider && typeof (provider as any).resolveToolPermission === 'function') {
    log.info('Calling resolveToolPermission on provider for:', promptId);
    (provider as any).resolveToolPermission(promptId, response, sessionId, 'mobile');
  } else {
    log.warn('No provider found or provider does not support tool permission for session:', sessionId);
  }

  import('electron').then(({ ipcMain }) => {
    const channel = `tool-permission-response:${sessionId}:${promptId}`;
    const hasMcpWaiter = ipcMain.listenerCount(channel) > 0;
    if (hasMcpWaiter) {
      log.info(`[Mobile] Emitting ToolPermission response on MCP channel: ${channel}`);
      ipcMain.emit(channel, {}, {
        requestId: promptId,
        sessionId,
        decision: response.decision,
        scope: response.scope,
        respondedBy: 'mobile',
      });
    }
  }).catch((err) => {
    log.warn(`[Mobile] Failed to emit ToolPermission response over IPC: ${err}`);
  });

  import('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository').then(({ AgentMessagesRepository }) => {
    AgentMessagesRepository.create({
      sessionId,
      source: 'nimbalyst',
      direction: 'output' as const,
      createdAt: new Date(),
      content: JSON.stringify(buildToolPermissionResponseRecord({
        requestId: promptId,
        answer: response,
        respondedBy: 'mobile',
      })),
    }).catch((err) => {
      log.warn(`[Mobile] Failed to persist ToolPermission response to database: ${err}`);
    });
  }).catch((err) => {
    log.warn(`[Mobile] Failed to load AgentMessagesRepository for ToolPermission response: ${err}`);
  });

  // Notify renderer to update the UI
  notifyAllWindows('ai:toolPermissionResponse', {
    sessionId,
    promptId,
    decision: response.decision,
    scope: response.scope,
    answeredBy: 'mobile',
  });
  notifyAllWindows('ai:toolPermissionResolved', { sessionId, requestId: promptId });
  TrayManager.getInstance().onPromptResolved(sessionId);
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
async function notifyAllWindows(channel: string, data: Record<string, unknown>): Promise<void> {
  const { BrowserWindow } = await import('electron');
  const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
  for (const win of windows) {
    win.webContents.send(channel, data);
  }
}
