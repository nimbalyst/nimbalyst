import { AISessionsRepository } from '@nimbalyst/runtime';
import {
  promptActionOwnsCurrentGeneration,
  readPendingPromptIdentity,
  type PendingPromptActionOwnership,
  type PendingPromptPersistenceResult,
  type PromptActionCurrentGenerationDeps,
} from './pendingPromptPersistence';

export interface PromptOwnedActionState {
  ownership: PendingPromptActionOwnership;
  promptClear: PendingPromptPersistenceResult | undefined;
}

export interface PromptOwnedActionExecutionDeps extends Partial<PromptActionCurrentGenerationDeps> {
  scheduleImmediate?: (callback: () => void) => void;
  hasNoReplacementPrompt?: (sessionId: string) => boolean | Promise<boolean>;
}

async function hasNoReplacementPrompt(sessionId: string): Promise<boolean> {
  try {
    const session = await AISessionsRepository.get(sessionId);
    return !readPendingPromptIdentity(session?.metadata).hasPendingPrompt;
  } catch {
    return false;
  }
}

function ownsCurrentGeneration(
  state: PromptOwnedActionState,
  deps: PromptOwnedActionExecutionDeps,
): boolean {
  if (
    !state.promptClear ||
    state.promptClear.superseded ||
    state.promptClear.local.skippedReason === 'identity_read_failed'
  ) {
    return false;
  }
  return deps.getCurrentGeneration
    ? promptActionOwnsCurrentGeneration(state.ownership, {
        getCurrentGeneration: deps.getCurrentGeneration,
      })
    : promptActionOwnsCurrentGeneration(state.ownership);
}

/** Execute a generation-wide effect (such as provider.abort) only for its turn. */
export function runPromptOwnedCurrentAction(
  state: PromptOwnedActionState,
  action: () => void,
  deps: PromptOwnedActionExecutionDeps = {},
): boolean {
  if (!ownsCurrentGeneration(state, deps)) return false;
  action();
  return true;
}

/**
 * Schedule an orphan-recovery continuation only while A owns the session, then
 * compare again inside the scheduled callback so B can safely start between
 * the IPC response and the next event-loop turn.
 */
export function schedulePromptOwnedCurrentAction(
  state: PromptOwnedActionState,
  action: () => void | Promise<void>,
  deps: PromptOwnedActionExecutionDeps = {},
): boolean {
  if (!ownsCurrentGeneration(state, deps)) return false;
  const schedule = deps.scheduleImmediate ?? setImmediate;
  schedule(() => {
    void (async () => {
      if (!ownsCurrentGeneration(state, deps)) return;
      const noReplacement = await (
        deps.hasNoReplacementPrompt?.(state.ownership.sessionId)
        ?? hasNoReplacementPrompt(state.ownership.sessionId)
      );
      if (!noReplacement || !ownsCurrentGeneration(state, deps)) return;
      await action();
    })();
  });
  return true;
}
