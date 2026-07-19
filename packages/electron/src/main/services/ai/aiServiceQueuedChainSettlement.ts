import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { settleTerminalAttentionBeforeContinuation } from './terminalAttentionSettlement';
import { codexEditWindowRegistry } from '../CodexEditWindowRegistry';

export interface AIServiceQueuedChainSettlementPayload {
  sessionId: string;
  workspacePath: string;
  source: string;
  attentionGeneration?: string;
  outcome: 'completed' | 'failed';
}

export interface AIServiceQueuedChainSettlementTracker {
  readonly settledChildErrored: boolean;
  readonly settledChainEnded: boolean;
  onChainSettled: (payload: AIServiceQueuedChainSettlementPayload) => Promise<void>;
}

interface AIServiceQueuedChainSettlementDeps {
  stateManager?: ReturnType<typeof getSessionStateManager>;
  settleTerminal?: typeof settleTerminalAttentionBeforeContinuation;
  scheduleStop: (sessionId: string, delayMs: number) => void;
  clearEditWindow?: (sessionId: string) => void;
  logInfo: (message: string) => void;
}

export interface DeferredSessionDrainHandlers {
  onTeammatesAllCompleted: (data: { sessionId: string }) => Promise<void>;
  onSubagentsDrainSettled: (data: { sessionId: string }) => Promise<void>;
  replayPendingDrain: () => Promise<void>;
}

interface DeferredSessionDrainDeps {
  sessionId: string;
  stateManager?: ReturnType<typeof getSessionStateManager>;
  processingSet: Set<string>;
  getAttentionGeneration: () => string | undefined;
  getDeferredOutcome: () => 'completed' | 'error' | null;
  isLeadBusy: () => boolean;
  settleTerminal: (reason: 'completed' | 'error') => Promise<unknown>;
  stopWatcher: () => Promise<void>;
  scheduleWatcherStop: (delayMs: number) => void;
  clearEditWindow: () => void;
  playCompletionSound: () => void;
  logInfo: (message: string) => void;
}

/**
 * Provider drain callbacks installed by MessageStreamingHandler. Kept as a
 * production composition seam so teammate/subagent terminal races can be
 * exercised with the real state manager and provider event wiring.
 */
export function createDeferredSessionDrainHandlers(
  deps: DeferredSessionDrainDeps,
): DeferredSessionDrainHandlers {
  const stateManager = deps.stateManager ?? getSessionStateManager();
  let settled = false;
  let settling = false;
  let pendingDrain: {
    attentionGeneration: string;
    source: 'teammates' | 'subagents';
  } | null = null;

  const replayPendingDrain = async (): Promise<void> => {
    if (settled || settling || !pendingDrain) return;
    const deferredOutcome = deps.getDeferredOutcome();
    const currentGeneration = deps.getAttentionGeneration();
    if (!currentGeneration || pendingDrain.attentionGeneration !== currentGeneration) {
      pendingDrain = null;
      return;
    }
    const state = stateManager.getSessionState(deps.sessionId);
    if (!state || state.attentionGeneration !== currentGeneration) {
      pendingDrain = null;
      return;
    }
    if (!deferredOutcome || deps.isLeadBusy() || deps.processingSet.has(deps.sessionId)) return;

    const { attentionGeneration, source } = pendingDrain;
    pendingDrain = null;
    settling = true;
    try {
      if (deferredOutcome === 'error' || state.status === 'error') {
        deps.logInfo(`[AIService] ${source} drain for failed generation ${attentionGeneration}; running error cleanup only`);
        await deps.settleTerminal('error');
        const stateAfterErrorCleanup = stateManager.getSessionState(deps.sessionId);
        if (
          stateAfterErrorCleanup?.attentionGeneration === attentionGeneration
          && stateAfterErrorCleanup.status === 'error'
        ) {
          deps.scheduleWatcherStop(500);
          deps.clearEditWindow();
          settled = true;
        }
        return;
      }

      await deps.settleTerminal('completed');
      const stateBeforeEnd = stateManager.getSessionState(deps.sessionId);
      if (!stateBeforeEnd || stateBeforeEnd.attentionGeneration !== attentionGeneration) return;
      if (stateBeforeEnd.status === 'error') {
        await deps.settleTerminal('error');
        deps.scheduleWatcherStop(500);
        deps.clearEditWindow();
        settled = true;
        return;
      }
      await stateManager.endSession(deps.sessionId, { attentionGeneration });
      // A replacement generation can start while endSession's DB write awaits.
      // Never apply A's watcher/sound cleanup to that new owner.
      if (stateManager.getSessionState(deps.sessionId)) return;
      await deps.stopWatcher();
      deps.clearEditWindow();
      deps.playCompletionSound();
      settled = true;
    } finally {
      settling = false;
    }
  };

  const settle = async (
    data: { sessionId: string },
    source: 'teammates' | 'subagents',
  ): Promise<void> => {
    if (!data.sessionId || data.sessionId !== deps.sessionId) return;
    if (settled) return;
    const attentionGeneration = deps.getAttentionGeneration();
    if (!attentionGeneration) return;
    const state = stateManager.getSessionState(data.sessionId);
    if (!state || state.attentionGeneration !== attentionGeneration) return;
    pendingDrain ??= { attentionGeneration, source };
    await replayPendingDrain();
  };

  return {
    onTeammatesAllCompleted: (data) => settle(data, 'teammates'),
    onSubagentsDrainSettled: (data) => settle(data, 'subagents'),
    replayPendingDrain,
  };
}

/**
 * Build the exact generation-bound callback installed by AIService on the
 * queued dispatcher. Keeping the callback as a production composition seam
 * lets the A-to-B regression exercise the real state manager, prompt
 * persistence, terminal subscriber, and attention service without constructing
 * the entire Electron AIService graph.
 */
export function createAIServiceQueuedChainSettlement(
  deps: AIServiceQueuedChainSettlementDeps,
): AIServiceQueuedChainSettlementTracker {
  const stateManager = deps.stateManager ?? getSessionStateManager();
  const settleTerminal = deps.settleTerminal ?? settleTerminalAttentionBeforeContinuation;
  let settledChildErrored = false;
  let settledChainEnded = false;

  return {
    get settledChildErrored() {
      return settledChildErrored;
    },
    get settledChainEnded() {
      return settledChainEnded;
    },
    onChainSettled: async ({
      sessionId,
      source,
      attentionGeneration,
      outcome,
    }: AIServiceQueuedChainSettlementPayload) => {
      settledChildErrored = false;
      settledChainEnded = false;
      if (!attentionGeneration) {
        settledChildErrored = outcome === 'failed';
        deps.logInfo(
          `[AIService] ${source}: chain settlement has no owned generation for session ${sessionId}; skipping terminal mutation`,
        );
        return;
      }

      const stateBeforeSettlement = stateManager.getSessionState(sessionId);
      const replacedBeforeSettlement = Boolean(
        attentionGeneration &&
        stateBeforeSettlement?.attentionGeneration &&
        stateBeforeSettlement.attentionGeneration !== attentionGeneration,
      );
      const failed = outcome === 'failed' || stateBeforeSettlement?.status === 'error';
      settledChildErrored = !replacedBeforeSettlement && failed;
      const settlementGeneration = attentionGeneration;

      if (
        failed &&
        !replacedBeforeSettlement &&
        stateBeforeSettlement?.status !== 'error'
      ) {
        await stateManager.updateActivity({
          sessionId,
          status: 'error',
          ...(settlementGeneration
            ? { attentionGeneration: settlementGeneration }
            : {}),
        });
      }

      deps.logInfo(
        `[AIService] ${source}: chain settled for session ${sessionId} with outcome ${failed ? 'failed' : 'completed'}`,
      );

      await settleTerminal({
        sessionId,
        attentionGeneration: settlementGeneration,
        reason: failed ? 'error' : 'completed',
      }, async () => {
        if (!failed) {
          await stateManager.endSession(sessionId, {
            attentionGeneration: settlementGeneration,
          });
        }
      });

      const stateAfterSettlement = stateManager.getSessionState(sessionId);
      const replacedDuringSettlement = Boolean(
        stateAfterSettlement?.attentionGeneration &&
        stateAfterSettlement.attentionGeneration !== settlementGeneration,
      );
      settledChainEnded = !replacedBeforeSettlement && !replacedDuringSettlement && (
        failed
          ? !stateAfterSettlement || stateAfterSettlement.status === 'error'
          : !stateAfterSettlement
      );
      if (settledChainEnded) {
        if (failed) {
          (deps.clearEditWindow ?? ((id) => codexEditWindowRegistry.clearSession(id)))(sessionId);
        }
        deps.scheduleStop(sessionId, 500);
      }
    },
  };
}
