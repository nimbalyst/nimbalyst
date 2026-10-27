import { sessionInbox } from '../sessionInboxService';
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
import { performTurnInterruption } from '../sessionTurnControl';
import { cancelTurnSetup } from '../turnSetupStages';
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
      cancelTurnSetup(sessionId);
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
    const provider = ProviderFactory.getProvider(session.provider as AIProviderType, sessionId) ?? null;
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

      ctx.analytics.sendEvent('cancel_ai_request', {provider: providerType})
    }
    const inbox = sessionInbox.current(sessionId);
    return performTurnInterruption({
      sessionId, mode: 'stop', provider, guard: ctx.sessionsProcessingQueue,
      isCurrentProvider: () => (ProviderFactory.getProvider(session.provider as AIProviderType, sessionId) ?? null) === provider,
      retireInbox: () => sessionInbox.end(inbox, false),
      sweep: async () => {
        const { getQueuedPromptsStore } = await import('../../RepositoryManager');
        await getQueuedPromptsStore().sweepExecutingForSession(sessionId);
        await ctx.publishQueueStateToSync(sessionId);
      },
      settle: () => ctx.forceSessionIdleOnCancel(sessionId),
      invalidateDrive: (expected) => ctx.invalidateQueueDrive(sessionId, expected),
      drive: () => {
        const path = session.worktreePath || session.workspacePath;
        return path ? ctx.driveQueuedPrompts(sessionId, path, 'renderer-trigger') : Promise.resolve();
      },
      logError: error => logger.main.error('[AIService] Turn cancellation failed:', error),
    });
  });

  // Only the renderer's send-now invokes this (NIM-7642).
  safeHandle('ai:interruptCurrentTurn', (_event, sessionId: string) =>
    ctx.interruptCurrentTurn(sessionId, { userSendNow: true })
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
