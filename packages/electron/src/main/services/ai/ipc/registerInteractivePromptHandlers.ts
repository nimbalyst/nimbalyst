import { reservePromptAnswer } from '../PromptAnswerReservation';
import { warnIfUnpublished } from '@nimbalyst/runtime/sync/pushOutcome';
import { registerAskUserQuestionAnswerHandler } from './registerAskUserQuestionAnswerHandler';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { configureCodexQuestionDelivery, deliverCodexQuestionAnswer } from '../codexQuestionDelivery';
import { TrayManager } from '../../../tray/TrayManager';
import { safeHandle } from '../../../utils/ipcRegistry';
import { logger } from '../../../utils/logger';
import { getSyncProvider } from '../../SyncManager';
import { persistAskUserQuestionTerminalResult } from '.././askUserQuestionFallbackResolution';
import { buildToolPermissionResponseRecord } from '.././claudeCliToolPermission';
import { setSessionPendingPrompt } from '.././pendingPromptPersistence';
import { type AIServiceContext } from './AIServiceContext';
import { ProviderFactory } from '@nimbalyst/runtime/ai/server';
import { type AIProviderType } from '@nimbalyst/runtime/ai/server/types';
import { ipcMain } from 'electron';

/**
 * Durable interactive prompts: ExitPlanMode confirmations, AskUserQuestion, and
 * tool-permission requests.
 *
 * Each pair answers or cancels a promise the provider is blocked on, so a
 * cancel path that fails to reject leaves the agent hung.
 */
export function registerInteractivePromptHandlers(ctx: AIServiceContext): void {
  configureCodexQuestionDelivery({
    drive: (sessionId, workspacePath) => ctx.driveQueuedPrompts(sessionId, workspacePath, 'session-idle'),
    publish: sessionId => ctx.publishQueueStateToSync(sessionId),
  });
  // Handle ExitPlanMode confirmation response from renderer
  safeHandle('ai:exitPlanModeConfirmResponse', async (event, requestId: string, sessionId: string, response: { approved: boolean; clearContext?: boolean; feedback?: string }) => {
    logger.main.info(`[AIService] ExitPlanMode confirmation response: requestId=${requestId}, approved=${response.approved}, clearContext=${response.clearContext}, hasFeedback=${!!response.feedback}`);

    // Use repository directly - we just need session metadata (provider type),
    // not the full session load with messages
    const session = await AISessionsRepository.get(sessionId);
    if (!session) {
      logger.main.warn(`[AIService] Session not found for ExitPlanMode response: ${sessionId}`);
      return { success: false, error: 'Session not found' };
    }

    const provider = ProviderFactory.getProvider(session.provider as AIProviderType, sessionId);
    if (!provider) {
      logger.main.warn(`[AIService] Provider not found for ExitPlanMode response: ${sessionId}`);
      return { success: false, error: 'Provider not found' };
    }

    // Check if this is a ClaudeCodeProvider with the resolve method
    if (typeof (provider as any).resolveExitPlanModeConfirmation === 'function') {
      (provider as any).resolveExitPlanModeConfirmation(requestId, response, sessionId, 'desktop');

      // If approved, update the session mode to 'agent' in the database
      // This ensures the mode persists across session switches and app restarts
      if (response.approved) {
        await AISessionsRepository.updateMetadata(sessionId, { mode: 'agent' });
        logger.main.info(`[AIService] Session ${sessionId} mode updated to 'agent' after ExitPlanMode approval`);
      }

      // Emit resolved event so the sidebar indicator updates and UI syncs mode change
      const { BrowserWindow } = await import('electron');
      const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
      for (const win of windows) {
        if (!win.webContents.isDestroyed()) {
          win.webContents.send('ai:exitPlanModeResolved', { sessionId, approved: response.approved });
        }
      }

      // Clear pending prompt state for mobile sync and tray
      TrayManager.getInstance().onPromptResolved(sessionId);
      const syncProvider = getSyncProvider();
      if (syncProvider) {
        try {
          const outcome = await syncProvider.pushChange(sessionId, {
            type: 'metadata_updated',
            metadata: { hasPendingPrompt: false, updatedAt: Date.now() },
          });
          warnIfUnpublished(message => logger.main.warn(message), sessionId, '[AIService] Failed to publish sync change', outcome);
        } catch (error) {
          logger.main.warn(`[AIService] Failed to publish sync change for session ${sessionId}:`, error);
        }
      }

      return { success: true };
    } else {
      logger.main.warn(`[AIService] Provider does not support ExitPlanMode confirmation: ${session.provider}`);
      return { success: false, error: 'Provider does not support ExitPlanMode confirmation' };
    }
  });

  registerAskUserQuestionAnswerHandler(ctx);

  // Handle AskUserQuestion cancel from renderer
  // Rejects the pending promise and aborts the AI request
  safeHandle('claude-code:cancel-question', async (event, { questionId, sessionId }: { questionId: string; sessionId?: string }) => {
    logger.main.info(`[AIService] AskUserQuestion cancel received: questionId=${questionId}`);

    // sessionId can be passed directly or extracted from legacy questionId format (ask-{sessionId}-{timestamp})
    let resolvedSessionId = sessionId;
    if (!resolvedSessionId) {
      const sessionIdMatch = questionId.match(/^ask-(.+)-\d+$/);
      if (sessionIdMatch && sessionIdMatch[1] !== 'unknown') {
        resolvedSessionId = sessionIdMatch[1];
      }
    }

    if (!resolvedSessionId) {
      logger.main.warn(`[AIService] No sessionId for AskUserQuestion cancel: ${questionId}`);
      return { success: false, error: 'Session ID required' };
    }

    // Use repository directly - we just need session metadata (provider type),
    // not the full session load with messages
    const session = await AISessionsRepository.get(resolvedSessionId);
    if (!session) {
      logger.main.warn(`[AIService] Session not found for AskUserQuestion cancel: ${resolvedSessionId}`);
      return { success: false, error: 'Session not found' };
    }

    if (session.provider === 'openai-codex') {
      return deliverCodexQuestionAnswer(resolvedSessionId, questionId, { answers: {}, cancelled: true, respondedBy: 'desktop' });
    }

    if (!reservePromptAnswer(resolvedSessionId, 'question', questionId, { answers: {}, cancelled: true })) return { success: false, error: 'Question already answered.' };

    // Missing provider is non-fatal here too (claude-code-cli has no in-process
    // instance) — fall through to the MCP/IPC cancel emit + DB fallback. NIM-806.
    const provider = ProviderFactory.getProvider(session.provider as AIProviderType, resolvedSessionId);
    if (!provider) {
      logger.main.info(`[AIService] No in-process provider for AskUserQuestion cancel (${session.provider}); routing via MCP/IPC channel: ${resolvedSessionId}`);
    }

    const providerSupportsCancel = !!provider && typeof (provider as any).rejectAskUserQuestion === 'function';
    if (providerSupportsCancel) {
      (provider as any).rejectAskUserQuestion(questionId, new Error('User cancelled'));
    }

    const mcpQuestionResponseChannel = `ask-user-question-response:${resolvedSessionId || 'unknown'}:${questionId}`;
    const hasMcpWaiter = ipcMain.listenerCount(mcpQuestionResponseChannel) > 0;
    if (hasMcpWaiter) {
      ipcMain.emit(mcpQuestionResponseChannel, event, {
        questionId,
        answers: {},
        cancelled: true,
        respondedBy: 'desktop',
        sessionId: resolvedSessionId,
      });
    }

    const sessionFallbackChannel = `ask-user-question:${resolvedSessionId}`;
    const hasSessionFallbackWaiter = ipcMain.listenerCount(sessionFallbackChannel) > 0;
    if (hasSessionFallbackWaiter) {
      ipcMain.emit(sessionFallbackChannel, event, {
        questionId,
        answers: {},
        cancelled: true,
        respondedBy: 'desktop',
        sessionId: resolvedSessionId,
      });
    }

    // Write cancellation to database as fallback for MCP server polling
    if (!providerSupportsCancel && resolvedSessionId) {
      const { AgentMessagesRepository } = await import('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository');
      AgentMessagesRepository.create({
        sessionId: resolvedSessionId,
        source: 'claude-code',
        direction: 'output' as const,
        createdAt: new Date(),
        content: JSON.stringify({
          type: 'ask_user_question_response',
          questionId,
          answers: {},
          cancelled: true,
          respondedBy: 'desktop',
          respondedAt: Date.now()
        })
      }).catch(err => {
        logger.main.warn(`[AIService] Failed to persist AskUserQuestion cancel to database: ${err}`);
      });
    }

    if (!providerSupportsCancel && !hasMcpWaiter && !hasSessionFallbackWaiter) {
      // NIM-2208: no provider, no MCP waiter, no fallback waiter means nothing
      // is listening -- the process that opened this question is gone (app
      // restarted, turn died). This used to return an error and leave
      // `metadata.hasPendingPrompt` set, so the session kept showing "awaiting
      // input" in AgentSessionsPopover with no way to dismiss it: the ONLY
      // cancel affordance is this widget, and it was a no-op on exactly the
      // sessions that needed it. Clearing the bit here makes the widget's
      // Cancel button the working escape hatch for a dead prompt.
      logger.main.info(`[AIService] Question cancel target not found; clearing stale pending-prompt bit: ${resolvedSessionId}`);
      await setSessionPendingPrompt(resolvedSessionId, false).catch((err) => {
        logger.main.warn(`[AIService] Failed to clear stale pending-prompt bit on cancel: ${err}`);
      });
      // Issue #1116: clearing the pending-prompt bit dismissed the session-level
      // indicator but left the tool call pending, so the cancelled widget came
      // back on the next session switch. Write the terminal result too.
      await persistAskUserQuestionTerminalResult({
        sessionId: resolvedSessionId,
        questionId,
        answers: {},
        cancelled: true,
      });
      return { success: true, staleCleared: true };
    }

    // For MCP-backed AskUserQuestion (Codex), let the MCP tool call resolve with
    // a cancelled result instead of force-aborting the provider. Immediate abort can
    // interrupt the in-flight MCP request before the cancellation result is delivered.
    if (!hasMcpWaiter && !hasSessionFallbackWaiter) {
      // Provider-backed AskUserQuestion path (Claude Code): abort active turn.
      provider?.abort();
    }

    return { success: true };
  });

  // Handle tool permission response from renderer
  // Used when a tool requires user approval
  safeHandle('claude-code:answer-tool-permission', async (event, {
    requestId,
    sessionId,
    response
  }: {
    requestId: string;
    sessionId: string;
    response: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' }
  }) => {
    logger.main.info(`[AIService] Tool permission response received: requestId=${requestId}, decision=${response.decision}, scope=${response.scope}`);

    if (sessionId === 'unknown') {
      logger.main.warn(`[AIService] Unknown session for tool permission: ${requestId}`);
      return { success: false, error: 'Unknown session' };
    }

    // Use repository directly - we just need session metadata (provider type),
    // not the full session load with messages
    const session = await AISessionsRepository.get(sessionId);
    if (!session) {
      logger.main.warn(`[AIService] Session not found for tool permission: ${sessionId}`);
      return { success: false, error: 'Session not found' };
    }

    if (!reservePromptAnswer(sessionId, 'permission', requestId, response)) return { success: false, error: 'Permission already answered or delivery is unknown.' };

    // SDK path (ClaudeCodeProvider) resolves via the in-process provider.
    const provider = ProviderFactory.getProvider(session.provider as AIProviderType, sessionId);
    if (provider && typeof (provider as any).resolveToolPermission === 'function') {
      (provider as any).resolveToolPermission(requestId, response, sessionId, 'desktop');
      return { success: true };
    }

    // External/agentless providers (e.g. claude-code-cli) have NO in-process
    // provider holding the pending permission — the MCP handler
    // (handleToolPermission) is blocked on the per-request IPC channel instead.
    // So a missing/unsupported provider is NOT fatal: emit on that channel so
    // the waiting MCP handler resolves and returns the decision to the CLI.
    // (Mirrors the AskUserQuestion CLI fix — NIM-806.)
    const { AgentMessagesRepository } = await import('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository');
    await AgentMessagesRepository.create({
      sessionId,
      source: 'nimbalyst',
      direction: 'output',
      createdAt: new Date(),
      content: JSON.stringify(buildToolPermissionResponseRecord({
        requestId,
        answer: response,
        respondedBy: 'desktop',
      })),
    });

    const mcpPermissionChannel = `tool-permission-response:${sessionId}:${requestId}`;
    const hasMcpWaiter = ipcMain.listenerCount(mcpPermissionChannel) > 0;
    if (hasMcpWaiter) {
      logger.main.info(`[AIService] Tool permission emitting on MCP channel: ${mcpPermissionChannel}`);
      ipcMain.emit(mcpPermissionChannel, event, {
        requestId,
        sessionId,
        decision: response.decision,
        scope: response.scope,
        respondedBy: 'desktop',
      });
      return { success: true };
    }

    logger.main.info(`[AIService] Tool permission response persisted without live MCP waiter: ${session.provider} (${sessionId})`);
    return { success: true };
  });

  // Handle tool permission cancel from renderer
  // Rejects the pending promise and aborts the AI request
  safeHandle('claude-code:cancel-tool-permission', async (event, {
    requestId,
    sessionId
  }: {
    requestId: string;
    sessionId: string;
  }) => {
    logger.main.info(`[AIService] Tool permission cancel received: requestId=${requestId}`);

    if (sessionId === 'unknown') {
      logger.main.warn(`[AIService] Unknown session for tool permission cancel: ${requestId}`);
      return { success: false, error: 'Unknown session' };
    }

    // Use repository directly - we just need session metadata (provider type),
    // not the full session load with messages
    const session = await AISessionsRepository.get(sessionId);
    if (!session) {
      logger.main.warn(`[AIService] Session not found for tool permission cancel: ${sessionId}`);
      return { success: false, error: 'Session not found' };
    }

    if (!reservePromptAnswer(sessionId, 'permission', requestId, { decision: 'deny', scope: 'once' })) return { success: false, error: 'Permission already answered.' };

    // SDK path: reject via the in-process provider and abort the turn.
    const provider = ProviderFactory.getProvider(session.provider as AIProviderType, sessionId);
    if (provider && typeof (provider as any).rejectToolPermission === 'function') {
      (provider as any).rejectToolPermission(requestId, new Error('User cancelled'));
      provider.abort();
      return { success: true };
    }

    // External CLI: no provider to reject. Settle the blocked MCP handler with a
    // cancelled deny so it returns {behavior:'deny'} to the CLI (NIM-806).
    const mcpPermissionChannel = `tool-permission-response:${sessionId}:${requestId}`;
    const hasMcpWaiter = ipcMain.listenerCount(mcpPermissionChannel) > 0;
    if (hasMcpWaiter) {
      logger.main.info(`[AIService] Tool permission cancel emitting on MCP channel: ${mcpPermissionChannel}`);
      ipcMain.emit(mcpPermissionChannel, event, {
        requestId,
        sessionId,
        decision: 'deny',
        scope: 'once',
        cancelled: true,
        respondedBy: 'desktop',
      });
      return { success: true };
    }

    logger.main.warn(`[AIService] No provider or MCP waiter for tool permission cancel: ${session.provider} (${sessionId})`);
    return { success: false, error: 'No handler for tool permission cancel' };
  });
}
