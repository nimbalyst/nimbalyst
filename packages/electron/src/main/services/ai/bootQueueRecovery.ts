/**
 * Boot-time re-drive of stranded queues.
 *
 * `sweepExecutingOnBoot` already normalizes rows left mid-flight at quit
 * (delivered-and-answered → completed, delivered-but-unanswered → failed,
 * never-delivered → pending). Nothing then claimed the `pending` bucket, so a
 * prompt queued before a quit sat there until the user happened to open that
 * session's transcript (#962). This hands every stranded session to the queue
 * driver.
 *
 * Deliberately drives only what the sweep left `pending`: rows the sweep
 * resolved must never be re-sent (NIM-615 / #783).
 */

export interface BootQueueRecoveryDeps {
  listSessionIdsWithPending(): Promise<string[]>;
  getWorkspacePath(sessionId: string): Promise<string | null | undefined>;
  requestDrive(sessionId: string, workspacePath: string): void;
  logInfo(message: string): void;
  logWarn(message: string): void;
}

/** Returns the number of sessions handed to the driver. */
export async function driveStrandedQueuesOnBoot(deps: BootQueueRecoveryDeps): Promise<number> {
  const sessionIds = await deps.listSessionIdsWithPending();
  if (sessionIds.length === 0) return 0;

  deps.logInfo(`[Main] Boot recovery: driving ${sessionIds.length} session(s) with pending prompts`);

  let driven = 0;
  for (const sessionId of sessionIds) {
    const workspacePath = await deps.getWorkspacePath(sessionId);
    if (!workspacePath) {
      // Routing needs a workspace; without one there is no window to deliver
      // into and no honest way to pick a fallback.
      deps.logWarn(`[Main] Boot recovery: session ${sessionId} has no workspacePath; skipping`);
      continue;
    }
    deps.requestDrive(sessionId, workspacePath);
    driven += 1;
  }

  return driven;
}
