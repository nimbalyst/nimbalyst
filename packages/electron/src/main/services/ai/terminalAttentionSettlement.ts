import {
  attentionEventService,
  type SettleTerminalAttentionArgs,
} from '../AttentionEventService';
import {
  setSessionPendingPrompt,
  type PendingPromptPersistenceResult,
} from './pendingPromptPersistence';

export interface TerminalAttentionSettlementArgs {
  sessionId: string;
  attentionGeneration: string;
  expectedPromptId?: string;
  /** Exact compare-clear already completed under the prompt action lock. */
  preclearedPrompt?: PendingPromptPersistenceResult;
  reason: SettleTerminalAttentionArgs['reason'];
}

export interface TerminalAttentionSettlementDeps {
  clearPendingPrompt: typeof setSessionPendingPrompt;
  settleAttention: (
    sessionId: string,
    args: SettleTerminalAttentionArgs,
  ) => Promise<number>;
}

const defaultDeps: TerminalAttentionSettlementDeps = {
  clearPendingPrompt: setSessionPendingPrompt,
  settleAttention: (sessionId, args) =>
    attentionEventService.settleTerminalAttention(sessionId, args),
};

/**
 * Settle one turn's durable prompt bit and attention records before allowing a
 * queued continuation to be claimed/dispatched. The same generation is used
 * for both compare-and-clear operations, so a delayed turn-A callback cannot
 * erase a prompt opened by turn B.
 */
export async function settleTerminalAttentionBeforeContinuation<T>(
  args: TerminalAttentionSettlementArgs,
  continuation: (settlement: {
    promptClear: PendingPromptPersistenceResult;
    attentionSettledCount: number;
  }) => Promise<T>,
  deps: TerminalAttentionSettlementDeps = defaultDeps,
): Promise<{
  promptClear: PendingPromptPersistenceResult;
  attentionSettledCount: number;
  continuationResult: T;
}> {
  const promptClear = args.preclearedPrompt ?? await deps.clearPendingPrompt(
    args.sessionId,
    false,
    {
      ...(args.expectedPromptId ? { expectedPromptId: args.expectedPromptId } : {}),
      expectedGeneration: args.attentionGeneration,
    },
  );
  const attentionSettledCount = await deps.settleAttention(args.sessionId, {
    attentionGeneration: args.attentionGeneration,
    ...(args.expectedPromptId ? { promptIdentity: args.expectedPromptId } : {}),
    reason: args.reason,
  });
  const continuationResult = await continuation({ promptClear, attentionSettledCount });
  return { promptClear, attentionSettledCount, continuationResult };
}
