import { safeHandle } from '../../../utils/ipcRegistry';
import { logger } from '../../../utils/logger';
import { getTerminalSessionManager } from '../../TerminalSessionManager';
import { AnalyticsService } from '../../analytics/AnalyticsService.ts';
import { type DriveReason } from '.././QueueDriveService';
import { getFileExtensionForAnalytics, safeSend } from '.././aiServiceUtils';
import { flushNextClaudeCliQueuedPromptForSession } from '.././claudeCliQueueFlushSingleton';
import { type AIServiceContext } from './AIServiceContext';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { remoteSessions } from '../remoteSessions';

/**
 * Queued-prompt lifecycle: claim, complete, fail, list, create, delete, and the
 * manual drain trigger.
 *
 * Every transition that changes what is still pending must publish the queue
 * state to sync afterwards, or mobile keeps re-showing a prompt the desktop
 * already claimed (NIM-2402).
 */
export function registerQueuedPromptHandlers(ctx: AIServiceContext): void {
  // Atomically claim a queued prompt for processing
  // Returns the prompt data if successfully claimed, null if already claimed by another instance
  // Uses the new queued_prompts table with proper row-level atomic updates
  safeHandle('ai:claimQueuedPrompt', async (
    event,
    sessionId: string,
    promptId: string
  ) => {
    await remoteSessions.assertLocalExecution(sessionId);
    // Use the new QueuedPromptsStore for atomic claim
    const { getQueuedPromptsStore } = await import('../../RepositoryManager');
    const queueStore = getQueuedPromptsStore();

    // Atomic claim - only succeeds if status is still 'pending'
    const claimed = await queueStore.claim(promptId);

    if (claimed) {
      logger.main.info(`[AIService] claimQueuedPrompt: claimed ${promptId} for session ${sessionId}`);
      // The claimed prompt is now in the transcript, so drop it from the
      // queue mobile sees rather than leaving it double-reported.
      await ctx.publishQueueStateToSync(sessionId);
      // Return in the format expected by the renderer
      return {
        id: claimed.id,
        prompt: claimed.prompt,
        timestamp: claimed.createdAt,
        attachments: claimed.attachments,
        documentContext: claimed.documentContext,
      };
    }

    logger.main.info(`[AIService] claimQueuedPrompt: prompt ${promptId} not found or already claimed`);
    return null;
  });

  // Mark a queued prompt as completed
  safeHandle('ai:completeQueuedPrompt', async (
    event,
    promptId: string
  ) => {
    const { getQueuedPromptsStore } = await import('../../RepositoryManager');
    const queueStore = getQueuedPromptsStore();
    const row = await queueStore.get(promptId);
    await queueStore.complete(promptId);
    logger.main.info(`[AIService] completeQueuedPrompt: ${promptId}`);
    if (row?.sessionId) {
      await ctx.publishQueueStateToSync(row.sessionId);
    }
  });

  // Mark a queued prompt as failed
  safeHandle('ai:failQueuedPrompt', async (
    event,
    promptId: string,
    errorMessage: string
  ) => {
    const { getQueuedPromptsStore } = await import('../../RepositoryManager');
    const queueStore = getQueuedPromptsStore();
    const row = await queueStore.get(promptId);
    await queueStore.fail(promptId, errorMessage);
    logger.main.info(`[AIService] failQueuedPrompt: ${promptId} - ${errorMessage}`);
    if (row?.sessionId) {
      await ctx.publishQueueStateToSync(row.sessionId);
    }
  });

  // List pending prompts for a session
  safeHandle('ai:listPendingPrompts', async (
    event,
    sessionId: string
  ) => {
    const { getQueuedPromptsStore } = await import('../../RepositoryManager');
    const queueStore = getQueuedPromptsStore();
    const pending = await queueStore.listPending(sessionId);
    return pending.map(p => ({
      id: p.id,
      prompt: p.prompt,
      timestamp: p.createdAt,
      attachments: p.attachments,
      documentContext: p.documentContext,
    }));
  });

  // Create a new queued prompt (for local queuing)
  safeHandle('ai:createQueuedPrompt', async (
    event,
    sessionId: string,
    prompt: string,
    attachments?: any[],
    documentContext?: any
  ) => {
    await remoteSessions.assertLocalExecution(sessionId);
    const { getQueuedPromptsStore } = await import('../../RepositoryManager');
    const queueStore = getQueuedPromptsStore();

    // Generate a unique ID with 'local-' prefix to identify locally-created prompts
    // This prevents the mobile sync handler from re-broadcasting these prompts
    const promptId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const queuedDocumentContext = {
      ...(documentContext ?? {}),
      promptProvenance: {
        actor: 'human' as const,
        origin: 'composer' as const,
        ...documentContext?.promptProvenance,
        queuedPromptId: promptId,
      },
    };

    const created = await queueStore.create({
      id: promptId,
      sessionId,
      prompt,
      attachments,
      documentContext: queuedDocumentContext,
    });

    logger.main.info(`[AIService] createQueuedPrompt: created ${promptId} for session ${sessionId}`);

    // Mirror the new depth to mobile so a desktop-queued prompt shows there too.
    await ctx.publishQueueStateToSync(sessionId);

    // Look up the session once (lightweight — no message log) for both the
    // analytics event and the claude-code-cli idle-flush kick below.
    let queuedSession: { provider?: string; workspacePath?: string } | null = null;
    try {
      const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
      queuedSession = await AISessionsRepository.get(sessionId);
    } catch (lookupError) {
      logger.main.warn('[AIService] createQueuedPrompt: session lookup failed:', lookupError);
    }

    // Track ai_message_queued analytics event
    try {
      if (queuedSession) {
        const fileExtension = getFileExtensionForAnalytics(documentContext?.filePath);
        AnalyticsService.getInstance().sendEvent('ai_message_queued', {
          provider: queuedSession.provider,
          source: 'local',
          hasDocumentContext: !!documentContext,
          hasAttachments: !!(attachments && attachments.length > 0),
          ...(fileExtension && { fileExtension }),
        });
      }
    } catch (analyticsError) {
      logger.main.warn('[AIService] Failed to track ai_message_queued:', analyticsError);
    }

    // Notify the renderer to update the queue list UI
    // This ensures locally-queued prompts are visible (same as mobile sync path)
    safeSend(event, 'ai:queuedPromptsReceived', {
      sessionId,
      promptCount: 1
    });

    // claude-code-cli (NIM-806): the CLI queue normally drains on the PID
    // watcher's running->idle transition. But a prompt queued while the CLI is
    // ALREADY idle (e.g. smart-commit on a session sitting at its prompt) has no
    // transition to ride, so it would sit forever. If the terminal is live and
    // the session is idle right now, kick a flush directly. The flush singleton's
    // in-flight guard + DB claim make this safe against a concurrent transition
    // flush; if the CLI is mid-turn (running/waiting), we skip and let the next
    // idle transition drain it.
    //
    // NIM-821: idleness is decided from the LIVE PID file, not just
    // SessionStateManager's snapshot — the snapshot is updated asynchronously
    // from the PID watcher, and a prompt queued inside that gap (PID already
    // idle, state still 'running') skipped the kick with no future idle
    // transition ever coming. Either signal saying idle kicks the flush; the
    // claim is race-safe, so erring toward flushing is fine.
    if (queuedSession?.provider === 'claude-code-cli') {
      const terminalManager = getTerminalSessionManager();
      const state = getSessionStateManager().getSessionState(sessionId);
      const workspacePath = queuedSession.workspacePath ?? state?.workspacePath;
      if (terminalManager.isTerminalActive(sessionId) && workspacePath) {
        if (state?.status === 'idle') {
          void flushNextClaudeCliQueuedPromptForSession(sessionId, workspacePath);
        } else {
          void terminalManager.getClaudeCliLiveTurnState(sessionId).then((live) => {
            if (live === 'idle') {
              void flushNextClaudeCliQueuedPromptForSession(sessionId, workspacePath);
            }
          }).catch(() => {});
        }
      }
    }

    return {
      id: created.id,
      prompt: created.prompt,
      timestamp: created.createdAt,
      attachments: created.attachments,
      documentContext: created.documentContext,
    };
  });

  // Delete a queued prompt (for user cancellation)
  safeHandle('ai:deleteQueuedPrompt', async (
    event,
    promptId: string
  ) => {
    const { getQueuedPromptsStore } = await import('../../RepositoryManager');
    const queueStore = getQueuedPromptsStore();
    const row = await queueStore.get(promptId);
    await queueStore.delete(promptId);
    logger.main.info(`[AIService] deleteQueuedPrompt: deleted ${promptId}`);
    if (row?.sessionId) {
      await ctx.publishQueueStateToSync(row.sessionId);
    }
    return { success: true };
  });

  // Trigger queue processing for a session (e.g., when voice command queued while AI is idle)
  safeHandle('ai:triggerQueueProcessing', async (
    event,
    sessionId: string,
    workspacePath: string,
    reason?: DriveReason
  ) => {
    // Route through the driver so a renderer trigger that can't dispatch
    // right now (session mid-turn) re-drives itself instead of evaporating.
    const outcome = await ctx.driveQueuedPrompts(sessionId, workspacePath, reason ?? 'renderer-trigger');

    return { processed: outcome.kind === 'dispatched' };
  });
}
