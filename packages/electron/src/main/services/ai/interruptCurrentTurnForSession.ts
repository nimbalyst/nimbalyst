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
}

export interface InterruptCurrentTurnResult {
  success: boolean;
  error?: string;
  method?: string;
  promptClear?: PendingPromptPersistenceResult;
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

  if (options?.expectedGeneration !== undefined) {
    const currentGeneration = deps.getCurrentAttentionGeneration(sessionId);
    if (currentGeneration && currentGeneration !== options.expectedGeneration) {
      return {
        success: false,
        error: 'stale generation',
        promptClear: undefined,
      };
    }

    if (deps.getSessionStatus(sessionId) === 'waiting_for_input') {
      return {
        success: false,
        error: 'session is waiting for input',
        promptClear: undefined,
      };
    }
  }

  const session = await deps.getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found' };
  }

  if (
    options?.expectedGeneration !== undefined
    && deps.getSessionStatus(sessionId) === 'waiting_for_input'
  ) {
    return {
      success: false,
      error: 'session is waiting for input',
      promptClear: undefined,
    };
  }

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
  if (!provider) {
    return { success: false, error: 'No active provider for session', promptClear };
  }

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
