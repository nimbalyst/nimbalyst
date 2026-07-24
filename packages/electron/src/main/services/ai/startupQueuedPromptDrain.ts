export interface StartupQueuedPromptDrainDependencies {
  listPendingOrdinarySessionIds(): Promise<string[]>;
  resolveWorkspacePath(sessionId: string): Promise<string | null>;
  triggerProcessing(sessionId: string, workspacePath: string): Promise<boolean>;
  logError(sessionId: string, error: unknown): void;
}

export async function drainPendingOrdinaryPromptsOnStartup(
  deps: StartupQueuedPromptDrainDependencies,
): Promise<{ discovered: number; triggered: number; skipped: number }> {
  const sessionIds = await deps.listPendingOrdinarySessionIds();
  let triggered = 0;
  let skipped = 0;

  for (const sessionId of sessionIds) {
    try {
      const workspacePath = await deps.resolveWorkspacePath(sessionId);
      if (!workspacePath) {
        skipped++;
        continue;
      }
      if (await deps.triggerProcessing(sessionId, workspacePath)) {
        triggered++;
      } else {
        skipped++;
      }
    } catch (error) {
      skipped++;
      deps.logError(sessionId, error);
    }
  }

  return { discovered: sessionIds.length, triggered, skipped };
}
