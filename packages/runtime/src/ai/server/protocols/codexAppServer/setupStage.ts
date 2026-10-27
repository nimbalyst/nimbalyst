export class CodexPreparationCancelledError extends Error {
  constructor() {
    super('This message has not been sent to Codex because Stop cancelled its preparation. Send it again when ready.');
    this.name = 'CodexPreparationCancelledError';
  }
}

/** Fixed setup boundaries only: never log prompts, paths, credentials or errors. */
export async function withCodexSetupStage<T>(
  sessionId: string | undefined,
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const log = (boundary: 'begin' | 'settled' | 'failed') => console.log('[CODEX][SETUP]', JSON.stringify({
    sessionId: sessionId ?? null,
    stage,
    boundary,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  }));
  log('begin');
  try {
    const result = await operation();
    log('settled');
    return result;
  } catch (error) {
    log('failed');
    throw error;
  }
}
