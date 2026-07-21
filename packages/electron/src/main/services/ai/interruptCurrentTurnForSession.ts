import type { PendingPromptPersistenceResult } from './pendingPromptPersistence';

interface InterruptSessionLike {
  provider: string;
}

interface InterruptibleProviderLike {
  interruptCurrentTurn(): Promise<{ method: string }>;
}

export interface InterruptCurrentTurnDependencies {
  getSession(sessionId: string): Promise<InterruptSessionLike | null>;
  setSessionPendingPrompt(
    sessionId: string,
    hasPendingPrompt: false,
    options?: { expectedGeneration?: string },
  ): Promise<PendingPromptPersistenceResult>;
  cancelAllAttentionForSession(
    sessionId: string,
    reason: 'interrupted',
  ): Promise<unknown>;
  isTerminalActive(sessionId: string): boolean;
  writeToTerminal(sessionId: string, text: string): void;
  getProvider(providerType: string, sessionId: string): InterruptibleProviderLike | null;
  deleteFromProcessingQueue(sessionId: string): void;
  sweepExecutingForSession(sessionId: string): Promise<{
    completed: number;
    failed: number;
    rolledBack: number;
  }>;
  getCurrentAttentionGeneration(sessionId: string): string | undefined;
  getSessionStatus(sessionId: string): string | undefined;
  logInfo(message: string): void;
  logError(message: string, error: unknown): void;
}

export interface InterruptCurrentTurnOptions {
  expectedGeneration?: string;
  priorityRowId?: string;
  operationId?: string;
  fence?: number;
  assertInterruptFence?: () => Promise<boolean>;
  enterInterruptApplication?: <T>(
    action: () => Promise<T>,
  ) => Promise<{ owned: true; value: T } | { owned: false }>;
  beforeNativeEntry?: () => Promise<void>;
}

export interface InterruptCurrentTurnResult {
  success: boolean;
  error?: string;
  method?: string;
  promptClear?: PendingPromptPersistenceResult;
  nativeCertainty?: 'not_applied' | 'unknown' | 'applied';
  nativeEntered?: boolean;
}

/**
 * Interrupt a session's current turn through injected main-process seams.
 * Supplying an expected generation turns this into a fail-closed control-plane
 * operation; omitting it preserves the renderer's unconditional manual action.
 */
export async function runInterruptCurrentTurnForSession(
  deps: InterruptCurrentTurnDependencies,
  sessionId: string,
  options?: InterruptCurrentTurnOptions,
): Promise<InterruptCurrentTurnResult> {
  if (!sessionId) {
    throw new Error('Session ID is required to interrupt');
  }

  if (options?.expectedGeneration === undefined) {
    // Keep the renderer/manual path's established ordering and unconditional
    // semantics. Only host-owned priority interrupts use the fenced path.
    const session = await deps.getSession(sessionId);
    if (!session) return { success: false, error: 'Session not found' };
    const promptClear = await deps.setSessionPendingPrompt(sessionId, false);
    await deps.cancelAllAttentionForSession(sessionId, 'interrupted');

    if (session.provider === 'claude-code-cli') {
      if (!deps.isTerminalActive(sessionId)) {
        return { success: false, error: 'No active terminal for session', promptClear };
      }
      deps.writeToTerminal(sessionId, '\x03');
      deps.logInfo(`[AIService] Interrupted claude-code-cli terminal for session ${sessionId}`);
      return { success: true, method: 'terminal-ctrl-c', promptClear };
    }

    const provider = deps.getProvider(session.provider, sessionId);
    if (!provider) return { success: false, error: 'No active provider for session', promptClear };
    deps.deleteFromProcessingQueue(sessionId);
    try {
      const { completed, failed, rolledBack } = await deps.sweepExecutingForSession(sessionId);
      if (completed > 0 || failed > 0 || rolledBack > 0) {
        deps.logInfo(
          `[AIService] interruptCurrentTurn: swept session ${sessionId} -- ${completed} answered marked completed, ${failed} delivered-but-unanswered marked failed, ${rolledBack} undelivered rolled back`,
        );
      }
    } catch (sweepErr) {
      deps.logError('[AIService] interruptCurrentTurn: sweepExecutingForSession failed:', sweepErr);
    }
    const result = await provider.interruptCurrentTurn();
    deps.logInfo(`[AIService] Interrupted current turn for session ${sessionId} (method=${result.method})`);
    return { success: true, method: result.method, promptClear };
  }

  const expectedGeneration = options.expectedGeneration;
  const generationStillOwned = () => (
    deps.getCurrentAttentionGeneration(sessionId) === expectedGeneration
    && deps.getSessionStatus(sessionId) === 'running'
  );
  const notApplied = (result: Omit<InterruptCurrentTurnResult, 'nativeCertainty' | 'nativeEntered'>): InterruptCurrentTurnResult => ({
    ...result,
    nativeCertainty: 'not_applied',
    nativeEntered: false,
  });
  const staleResult = (): InterruptCurrentTurnResult => {
    if (deps.getCurrentAttentionGeneration(sessionId) !== expectedGeneration) {
      return notApplied({
        success: false,
        error: 'stale generation',
        promptClear: undefined,
      });
    }
    const status = deps.getSessionStatus(sessionId);
    return notApplied({
      success: false,
      error: status === 'waiting_for_input'
        ? 'session is waiting for input'
        : status === 'idle'
          ? 'session is idle'
          : status === 'error'
            ? 'session is in error state'
            : 'session status is missing',
      promptClear: undefined,
    });
  };
  const verifyDurableEntry = async (): Promise<InterruptCurrentTurnResult | null> => {
    if (options.assertInterruptFence) {
      try {
        if (!await options.assertInterruptFence()) {
          return notApplied({ success: false, error: 'interrupt application fence lost' });
        }
      } catch (error) {
        return notApplied({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await options.beforeNativeEntry?.();
    if (!generationStillOwned()) return staleResult();
    return null;
  };
  const atInterruptEntryAuthority = async (
    action: () => Promise<InterruptCurrentTurnResult>,
  ): Promise<InterruptCurrentTurnResult> => {
    const rejected = await verifyDurableEntry();
    if (rejected) return rejected;
    if (!options.enterInterruptApplication) return action();
    const entered = await options.enterInterruptApplication(async () => {
      if (!generationStillOwned()) return staleResult();
      return action();
    });
    return entered.owned
      ? entered.value
      : notApplied({ success: false, error: 'interrupt application fence lost' });
  };

  if (!generationStillOwned()) return staleResult();

  let session: InterruptSessionLike | null;
  try {
    session = await deps.getSession(sessionId);
  } catch (error) {
    return notApplied({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!session) {
    return notApplied({ success: false, error: 'Session not found' });
  }
  if (!generationStillOwned()) return staleResult();

  if (session.provider === 'claude-code-cli') {
    if (!deps.isTerminalActive(sessionId)) {
      return notApplied({ success: false, error: 'No active terminal for session' });
    }
    return atInterruptEntryAuthority(async () => {
      // The takeover CAS cannot commit while this gate is held. No await follows
      // the final predicates before the PTY mutation begins.
      try {
        deps.writeToTerminal(sessionId, '\x03');
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          nativeCertainty: 'unknown',
          nativeEntered: true,
        };
      }
      deps.logInfo(`[AIService] Interrupted claude-code-cli terminal for session ${sessionId}`);
      return {
        success: true,
        method: 'terminal-ctrl-c',
        nativeCertainty: 'applied',
        nativeEntered: true,
      };
    });
  }
  if (!generationStillOwned()) return staleResult();
  let provider: InterruptibleProviderLike | null;
  try {
    provider = deps.getProvider(session.provider, sessionId);
  } catch (error) {
    return notApplied({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!provider) {
    return notApplied({ success: false, error: 'No active provider for session' });
  }

  return atInterruptEntryAuthority(async () => {
    // Provider lookup was synchronous and the process-wide gate excludes a
    // takeover from the durable verification through provider entry/result.
    try {
      deps.deleteFromProcessingQueue(sessionId);
    } catch (error) {
      return notApplied({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    let result: { method: string };
    try {
      result = await provider.interruptCurrentTurn();
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        nativeCertainty: 'unknown',
        nativeEntered: true,
      };
    }
    deps.logInfo(`[AIService] Interrupted current turn for session ${sessionId} (method=${result.method})`);
    return {
      success: true,
      method: result.method,
      nativeCertainty: 'applied',
      nativeEntered: true,
    };
  });
}
