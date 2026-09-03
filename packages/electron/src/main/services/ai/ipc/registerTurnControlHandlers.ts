import { safeHandle } from '../../../utils/ipcRegistry';
import { logger } from '../../../utils/logger';
import { getTerminalSessionManager } from '../../TerminalSessionManager';
import {
  ProviderFactory,
  AIProvider,
} from '@nimbalyst/runtime/ai/server';
import {
  type AIProviderType,
  type SessionData,
  AI_PROVIDER_TYPES,
} from '@nimbalyst/runtime/ai/server/types';
import { agentCapabilitiesForProviderType } from '@nimbalyst/runtime/ai/server/agentCapabilities';
import { safeSend } from '../aiServiceUtils';
import type { AIServiceContext } from './AIServiceContext';

/**
 * Stopping and compacting an in-flight turn.
 *
 * All three handlers act on a turn that is already running (or was), which is
 * why compaction lives here rather than with the model handlers: it is a
 * mid-conversation control operation, not a configuration read.
 */
export function registerTurnControlHandlers(ctx: AIServiceContext): void {
  // Cancel current request
  safeHandle('ai:cancelRequest', async (_event, sessionId: string, chunksReceived?: number) => {
    // console.log(`[AIService] ai:cancelRequest received for sessionId: ${sessionId}`);
    // Abort the provider for the specific session
    if (!sessionId) {
      throw new Error('Session ID is required to cancel request');
    }

    // Use repository directly - we just need session metadata (provider type),
    // not the full session load with messages
    const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
    const session = await AISessionsRepository.get(sessionId);
    if (!session) {
      console.warn(`[AIService] Cancel failed - session not found: ${sessionId}`);
      return { success: false, error: 'Session not found' };
    }

    if (session.provider === 'claude-code-cli') {
      const terminalManager = getTerminalSessionManager();
      if (!terminalManager.isTerminalActive(sessionId)) {
        console.warn(`[AIService] Cancel failed - no active claude-code-cli terminal for session: ${sessionId}`);
        return { success: false, error: 'No active terminal for session' };
      }

      terminalManager.writeToTerminal(sessionId, '\x03');
      ctx.analytics.sendEvent('ai_stream_interrupted', {
        provider: 'claude-code-cli',
        chunksReceived: chunksReceived || 0,
        reason: 'user_cancel'
      });
      ctx.analytics.sendEvent('cancel_ai_request', { provider: 'claude-code-cli' });
      return { success: true };
    }

    // console.log(`[AIService] Session found, provider type: ${session.provider}`);
    const provider = ProviderFactory.getProvider(session.provider as AIProviderType, sessionId);
    // console.log(`[AIService] Provider lookup result: ${provider ? 'found' : 'NOT FOUND'}`);
    if (provider) {
      // Get provider type
      const providerType = (provider as any).providerType || 'unknown';

      // Track stream interruption
      ctx.analytics.sendEvent('ai_stream_interrupted', {
        provider: providerType,
        chunksReceived: chunksReceived || 0,
        reason: 'user_cancel'
      });

      // Defensive cleanup: if the in-flight turn was processing a queued
      // prompt, drop the in-memory guard and unwedge any DB row stuck in
      // 'executing'. sweepExecutingForSession is delivery-aware -- a
      // prompt whose user message already landed in ai_agent_messages is
      // marked completed instead of rolled back, so the queue trigger
      // that follows the abort doesn't immediately re-claim and re-send
      // the same input (NIM-615). The delete also clears the guard's
      // ownership lease, so when the dispatch this cancel displaced finally
      // settles it releases nothing rather than releasing whatever prompt
      // took the session next (#1018).
      ctx.sessionsProcessingQueue.delete(sessionId);
      try {
        const { getQueuedPromptsStore } = await import('../../RepositoryManager');
        const queueStore = getQueuedPromptsStore();
        const { completed, failed, rolledBack } = await queueStore.sweepExecutingForSession(sessionId);
        if (completed > 0 || failed > 0 || rolledBack > 0) {
          logger.main.info(
            `[AIService] cancelRequest: swept session ${sessionId} -- ${completed} answered marked completed, ${failed} delivered-but-unanswered marked failed, ${rolledBack} undelivered rolled back`
          );
          await ctx.publishQueueStateToSync(sessionId);
        }
      } catch (sweepErr) {
        logger.main.error('[AIService] cancelRequest: sweepExecutingForSession failed:', sweepErr);
      }

      provider.abort();
      // console.log(`[AIService] Cancelled request for session ${sessionId}`);
      ctx.analytics.sendEvent('cancel_ai_request', {provider: providerType})
      await ctx.forceSessionIdleOnCancel(sessionId);
      return { success: true };
    }
    // No live provider: the turn is already gone (e.g. it died on an in-band
    // error chunk without settling). Cancel must still be authoritative --
    // otherwise the stale 'running' state in SessionStateManager survives and
    // the renderer's processing reconcile re-asserts the spinner seconds later.
    console.warn(`[AIService] Cancel: no active provider for session ${sessionId} - clearing stale running state`);
    await ctx.forceSessionIdleOnCancel(sessionId);
    return { success: true };
  });

  safeHandle('ai:interruptCurrentTurn', (_event, sessionId: string) =>
    ctx.interruptCurrentTurn(sessionId)
  );

  // #1252: compact via the provider's real RPC. The renderer used to send
  // the literal string "/compact" as a user turn, which only ever worked for
  // providers whose SDK happens to interpret slash commands -- for Codex it
  // reached the model as prompt text and silently did nothing.
  safeHandle('ai:compactSession', async (event, sessionId: string) => {
    if (!sessionId) {
      throw new Error('ai:compactSession requires a sessionId');
    }
    // Compaction acts on a running agent, so the live instance is the only
    // thing worth asking -- and it is what knows which transport it is on.
    // This used to hardcode `getProvider('openai-codex', ...)`, which is the
    // provider-name check the capability contract exists to replace.
    let provider: AIProvider | null = null;
    for (const type of AI_PROVIDER_TYPES) {
      provider = ProviderFactory.getProvider(type, sessionId);
      if (provider) break;
    }

    // The stored session is what a cold compact runs on: the Compact button
    // is offered for every session of a provider that declares `rpc`,
    // including one restored after a restart that has not sent a turn in this
    // app launch and so has no provider instance. The conversation still
    // exists on the agent's side, so hand the provider what it needs to reach
    // it instead of refusing (#574).
    const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
    const storedSession = await AISessionsRepository.get(sessionId);
    if (!provider && storedSession?.provider) {
      // Only for a type that declares `rpc`: everything else has nothing to
      // call here, and the declaration fails closed for ids the factory does
      // not build (extension-contributed agents).
      if (agentCapabilitiesForProviderType(storedSession.provider).compaction === 'rpc') {
        provider = ProviderFactory.createProvider(storedSession.provider as AIProviderType, sessionId);
      }
    }
    if (!provider) {
      return { success: false, error: 'Cannot compact: this session has no active provider yet.' };
    }
    // A provider declaring anything other than 'rpc' has no compaction call
    // to make here -- 'slash-command' providers compact by sending a
    // `/compact` turn, which is the renderer's path, not this one.
    if (provider.getAgentCapabilities().compaction !== 'rpc') {
      return { success: false, error: 'This provider does not support compaction.' };
    }
    const compactable = provider as unknown as {
      compactSession?: (
        id: string,
        options?: { workspacePath?: string; providerSessionId?: string },
      ) => Promise<void>;
    };
    if (typeof compactable?.compactSession !== 'function') {
      return { success: false, error: 'This provider does not support compaction.' };
    }
    try {
      await compactable.compactSession(sessionId, {
        workspacePath: storedSession?.worktreePath || storedSession?.workspacePath,
        providerSessionId: storedSession?.providerSessionId,
      });

      // The conversation the meter was measuring no longer exists. Nothing
      // here knows how large the summary is, so drop the reading rather than
      // leave the pre-compaction one on screen -- the next turn reports a
      // measured one. Without this, the one action whose whole purpose is
      // reducing context left the session reading 90% until something else
      // happened to refresh it. The denominator goes too: the meter falls
      // back to cumulative spend over the window, which would replace a stale
      // percentage with a confidently wrong one. Cumulative totals stay --
      // compaction reset the context, not what the session has spent.
      const storedUsage = (storedSession?.metadata as Record<string, unknown> | undefined)
        ?.tokenUsage as SessionData['tokenUsage'] | undefined;
      if (storedUsage?.currentContext || storedUsage?.contextWindow) {
        const clearedUsage = { ...storedUsage, currentContext: undefined, contextWindow: undefined };
        await ctx.sessionManager.updateSessionTokenUsage(sessionId, clearedUsage);
        safeSend(event, 'ai:tokenUsageUpdated', { sessionId, tokenUsage: clearedUsage });
      }

      return { success: true };
    } catch (error) {
      console.error('[AIService] compactSession failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });
}
