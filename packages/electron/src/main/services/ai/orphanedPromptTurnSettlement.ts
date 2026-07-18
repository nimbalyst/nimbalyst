import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import {
  promptActionOwnsCurrentGeneration,
  type PendingPromptActionOwnership,
  type PendingPromptPersistenceResult,
} from './pendingPromptPersistence';
import {
  settleTerminalAttentionBeforeContinuation,
  type TerminalAttentionSettlementArgs,
} from './terminalAttentionSettlement';

export interface SettleOrphanedPromptTurnArgs {
  ownership: PendingPromptActionOwnership;
  reason: TerminalAttentionSettlementArgs['reason'];
  promptClear?: PendingPromptPersistenceResult;
}

export interface SettleOrphanedPromptTurnDeps {
  settleTerminal: typeof settleTerminalAttentionBeforeContinuation;
  ownsCurrentGeneration: (ownership: PendingPromptActionOwnership) => boolean;
  endSession: (sessionId: string, attentionGeneration: string) => Promise<void>;
}

const defaultDeps: SettleOrphanedPromptTurnDeps = {
  settleTerminal: settleTerminalAttentionBeforeContinuation,
  ownsCurrentGeneration: promptActionOwnsCurrentGeneration,
  endSession: (sessionId, attentionGeneration) =>
    getSessionStateManager().endSession(sessionId, { attentionGeneration }),
};

/**
 * Settle an orphaned prompt's exact generation. This is intentionally the only
 * no-waiter path allowed to terminally mutate session state; absence of durable
 * identity/generation or any compare failure preserves the current turn.
 */
export async function settleOrphanedPromptTurn(
  args: SettleOrphanedPromptTurnArgs,
  deps: SettleOrphanedPromptTurnDeps = defaultDeps,
): Promise<{
  settled: boolean;
  promptClear?: PendingPromptPersistenceResult;
  attentionSettledCount: number;
}> {
  const { ownership } = args;
  if (!ownership.matchedPendingPrompt || !ownership.attentionGeneration) {
    return { settled: false, attentionSettledCount: 0 };
  }

  const settlement = await deps.settleTerminal(
    {
      sessionId: ownership.sessionId,
      attentionGeneration: ownership.attentionGeneration,
      expectedPromptId: ownership.promptId,
      ...(args.promptClear ? { preclearedPrompt: args.promptClear } : {}),
      reason: args.reason,
    },
    async ({ promptClear }) => {
      if (
        promptClear.superseded ||
        promptClear.local.skippedReason === 'identity_read_failed' ||
        !deps.ownsCurrentGeneration(ownership)
      ) {
        return false;
      }
      await deps.endSession(ownership.sessionId, ownership.attentionGeneration!);
      return true;
    },
  );

  return {
    settled: settlement.continuationResult,
    promptClear: settlement.promptClear,
    attentionSettledCount: settlement.attentionSettledCount,
  };
}
