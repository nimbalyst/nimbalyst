import { ProviderFactory } from '@nimbalyst/runtime/ai/server';

/**
 * True when the session's Claude Code turn has answered and is only draining
 * background tasks on a live query that can take the next prompt. The queue
 * may then dispatch past the busy state and chain guard that the draining
 * turn still holds, instead of waiting up to 30 minutes for a shell.
 * See runtime `claudeCode/drainHandoff.ts`.
 */
export function canDispatchIntoDrain(sessionId: string): boolean {
  const provider = ProviderFactory.getProvider('claude-code', sessionId) as
    | { canAcceptFollowUpDuringDrain?: () => boolean }
    | null;
  return typeof provider?.canAcceptFollowUpDuringDrain === 'function' && provider.canAcceptFollowUpDuringDrain();
}

/**
 * True when the session's Claude Code provider is running a turn the queue did
 * not start, or has emitted the wake for one: background-task results, a
 * teammate message, or a stream-closed continuation. See NIM-7428.
 */
export function isLeadTurnPending(sessionId: string): boolean {
  const provider = ProviderFactory.getProvider('claude-code', sessionId) as
    | { isLeadBusy?: () => boolean }
    | null;
  return typeof provider?.isLeadBusy === 'function' && provider.isLeadBusy();
}
