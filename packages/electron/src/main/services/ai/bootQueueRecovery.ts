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
  failAllPending(sessionId: string, errorMessage: string): Promise<number>;
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
    try {
      const workspacePath = await deps.getWorkspacePath(sessionId);
      if (!workspacePath) {
        // Routing needs a workspace; without one there is no window to deliver
        // into and no honest way to pick a fallback. Fail atomically rather
        // than silently leaving the rows pending forever.
        await deps.failAllPending(
          sessionId,
          'Queued prompt delivery failed: workspace mapping unavailable',
        );
        deps.logWarn('[Main] Boot recovery: failed pending prompts for unmapped session');
        continue;
      }
      deps.requestDrive(sessionId, workspacePath);
      driven += 1;
    } catch {
      // One malformed or unavailable session must not prevent later pending
      // rows from reaching their valid workspace driver. Do not expose the
      // workspace, prompt, provider output, or raw exception in this warning.
      deps.logWarn('[Main] Boot recovery: failed to recover one session; continuing');
    }
  }

  return driven;
}
