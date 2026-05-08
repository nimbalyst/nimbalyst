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
interface PromptResponsePayload {
  promptType: 'ask_user_question' | 'exit_plan_mode' | 'tool_permission' | 'git_commit';
  promptId: string;
  response: AskUserQuestionResponse | ExitPlanModeResponse | ToolPermissionResponse | GitCommitResponse;
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
 * Initialize the mobile session control handler.
 * Listens for control messages from the sync layer and dispatches to appropriate handlers.
 */
export function initMobileSessionControlHandler(
  syncProvider: SyncProvider,
  findWindowByWorkspace: (workspacePath: string) => BrowserWindow | null | undefined
): () => void {
  if (!syncProvider.onSessionControlMessage) {
    log.warn('Sync provider does not support session control messages');
    return () => {};
  }

  const cleanup = syncProvider.onSessionControlMessage((message) => {
    handleControlMessage(message, findWindowByWorkspace);
  });

  // log.info('Mobile session control handler initialized');

  return cleanup;
}

/**
 * Dispatch a control message to the appropriate handler
 */
function handleControlMessage(
  message: SessionControlMessage,
  findWindowByWorkspace: (workspacePath: string) => BrowserWindow | null | undefined
): void {
  log.info('Received control message:', message.type, 'for session:', message.sessionId);

  switch (message.type) {
    case 'cancel':
      handleCancel(message.sessionId);
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
      // Prompts are handled via the queuedPrompts system, not control messages
      // This is here for future expansion if needed
      log.warn('Received prompt control message - prompts should use queuedPrompts system');
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

    default:
      log.warn('Unknown prompt type:', payload.promptType);
  }
}

/**
 * Handle a cancel command
 */
function handleCancel(sessionId: string): void {
  const provider = ProviderFactory.getProvider('claude-code', sessionId);
  if (provider && 'abort' in provider) {
    log.info('Aborting session:', sessionId);
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
    const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
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

  // Notify renderer to update the UI
  notifyAllWindows('ai:toolPermissionResponse', {
    sessionId,
    promptId,
    decision: response.decision,
    scope: response.scope,
    answeredBy: 'mobile',
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

  // Helper to emit the proposal response to unblock the MCP tool
  const emitProposalResponse = async (result: {
    action: 'committed' | 'cancelled';
    commitHash?: string;
    error?: string;
    filesCommitted?: string[];
    commitMessage?: string;
  }) => {
    const { ipcMain } = await import('electron');
    const responseChannel = `git-commit-proposal-response:${sessionId || 'unknown'}:${promptId}`;
    ipcMain.emit(responseChannel, null, result);
    // Notify renderer to clear the pending interactive prompt indicator
    notifyAllWindows('ai:gitCommitProposalResolved', { sessionId, proposalId: promptId });
    TrayManager.getInstance().onPromptResolved(sessionId);
  };

  if (response.action === 'cancelled') {
    await emitProposalResponse({ action: 'cancelled' });
    return;
  }

  // For 'committed' action, we need to execute the git commit on desktop
  if (!response.files || !response.message) {
    log.error('GitCommit response missing files or message');
    await emitProposalResponse({ action: 'cancelled', error: 'Missing files or message' });
    return;
  }

  // Look up the session's workspace path
  try {
    const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
    const session = await AISessionsRepository.get(sessionId);
    if (!session) {
      log.error('GitCommit: session not found:', sessionId);
      await emitProposalResponse({ action: 'cancelled', error: 'Session not found' });
      return;
    }

    const workspacePath = session.workspacePath;
    if (!workspacePath) {
      log.error('GitCommit: no workspace path for session:', sessionId);
      await emitProposalResponse({ action: 'cancelled', error: 'No workspace path' });
      return;
    }

    // Execute the git commit
    const simpleGit = (await import('simple-git')).default;
    const { gitOperationLock } = await import('../../services/GitOperationLock');

    const commitResult = await gitOperationLock.withLock(workspacePath, 'git:commit', async () => {
      const git = simpleGit(workspacePath);

      // Stage the files
      log.info(`[GitCommit mobile] Staging ${response.files!.length} files in ${workspacePath}`);

      // Reset staging area, then add only selected files
      try {
        await git.reset(['HEAD']);
      } catch {
        // May fail in fresh repo with no commits - that's OK
      }
      // Use --all so deletions are staged correctly. Plain `git add <path>`
      // errors with "pathspec did not match any files" when the proposal
      // includes deleted files (e.g., during renames where one path was
      // removed and a new one added).
      await git.add(['--all', '--', ...response.files!]);

      // Commit
      const result = await git.commit(response.message!);
      return result;
    });

    if (commitResult.commit) {
      log.info(`[GitCommit mobile] Successfully committed: ${commitResult.commit}`);
      await emitProposalResponse({
        action: 'committed',
        commitHash: commitResult.commit,
        filesCommitted: response.files,
        commitMessage: response.message,
      });
    } else {
      log.warn('[GitCommit mobile] Commit returned empty hash');
      await emitProposalResponse({
        action: 'cancelled',
        error: 'No changes were committed',
      });
    }
  } catch (error) {
    log.error('[GitCommit mobile] Failed to execute commit:', error);
    await emitProposalResponse({
      action: 'cancelled',
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
