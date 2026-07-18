import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { settleTerminalAttentionBeforeContinuation } from './terminalAttentionSettlement';

export interface AIServiceQueuedChainSettlementPayload {
  sessionId: string;
  workspacePath: string;
  source: string;
  attentionGeneration: string;
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
  logInfo: (message: string) => void;
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
    }: AIServiceQueuedChainSettlementPayload) => {
      const stateBeforeSettlement = stateManager.getSessionState(sessionId);
      const replacedBeforeSettlement = Boolean(
        stateBeforeSettlement?.attentionGeneration &&
        stateBeforeSettlement.attentionGeneration !== attentionGeneration,
      );
      settledChildErrored = !replacedBeforeSettlement && stateBeforeSettlement?.status === 'error';
      deps.logInfo(`[AIService] ${source}: chain settled for session ${sessionId}, ending session`);

      await settleTerminal({
        sessionId,
        attentionGeneration,
        reason: settledChildErrored ? 'error' : 'completed',
      }, () => stateManager.endSession(sessionId, { attentionGeneration }));

      const stateAfterSettlement = stateManager.getSessionState(sessionId);
      const replacedDuringSettlement = Boolean(
        stateAfterSettlement?.attentionGeneration &&
        stateAfterSettlement.attentionGeneration !== attentionGeneration,
      );
      settledChainEnded = !replacedBeforeSettlement &&
        !replacedDuringSettlement &&
        !stateAfterSettlement;
      if (settledChainEnded) {
        deps.scheduleStop(sessionId, 500);
      }
    },
  };
}
