// Decision helpers for the "background sub-agent drain" behavior in
// ClaudeCodeProvider.sendMessage(). Extracted as pure functions so the teardown
// logic can be unit-tested without the full SDK streaming machinery.
//
// Background: the SDK runs plain/background Task/Agent sub-agents natively inside
// the lead's subprocess and streams their lifecycle as system `task_started` /
// `task_progress` / `task_notification` chunks (tracked in `activeTasks`). A
// background sub-agent can outlive the lead's own turn: the lead emits its
// `result` chunk (turn end) while the sub-agent is still running. The streaming
// loop used to break immediately on `result`, so the sub-agent's later
// `task_notification` was never read and its stdin was torn down — killing it and
// leaving the orchestrator idle forever. See NIM-1344 / GitHub #732.

export interface SubagentTaskLike {
  status: string;
}

/** True if any tracked sub-agent task is still running. */
export function hasRunningTasks(tasks: Iterable<SubagentTaskLike>): boolean {
  for (const t of tasks) {
    if (t.status === 'running') return true;
  }
  return false;
}

/**
 * After the lead's `result` chunk, decide whether to defer teardown (keep
 * draining the SDK iterator) because background sub-agents are still running,
 * rather than breaking out of the loop immediately.
 */
export function shouldDeferTeardownForSubagents(hasRunning: boolean): boolean {
  return hasRunning;
}

/**
 * While draining (after `complete` was already emitted), decide whether the loop
 * can now exit because every background sub-agent has reported a terminal status.
 */
export function shouldExitDrain(
  completeEmitted: boolean,
  draining: boolean,
  hasRunning: boolean,
): boolean {
  return completeEmitted && draining && !hasRunning;
}

// Why the streaming loop stopped iterating. Derived from WHERE the loop exits, so
// we never have to guess the abort source from shared instance state.
export type DrainExitCause =
  | 'resolved' // sub-agents finished (or turn ended with none running)
  | 'aborted' // abort() / supersede — the AbortController fired
  | 'interrupted' // interruptWithMessage() — teammate/user interrupt
  | 'iterator-done' // the SDK iterator ended on its own
  | 'iterator-error'; // the SDK iterator threw

export interface DrainOutcome {
  /** Mark still-running tasks as stopped (they will never report completion). */
  markStopped: boolean;
  /**
   * Nudge the orchestrator with a visible continuation turn. Only true for an
   * UNEXPECTED death — never for a user stop or a new-prompt supersede, where a
   * continuation would contradict the user's intent or race their real prompt.
   */
  autoContinue: boolean;
}

/**
 * Decide what to do when the streaming loop exits while draining background
 * sub-agents. Auto-continue ONLY when the death was unexpected (the SDK iterator
 * ended or threw while tasks were still running) — not on abort/interrupt.
 */
export function classifyDrainOutcome(params: {
  wasDraining: boolean;
  hasRunningTasks: boolean;
  cause: DrainExitCause;
}): DrainOutcome {
  if (!params.wasDraining || !params.hasRunningTasks) {
    return { markStopped: false, autoContinue: false };
  }
  const unexpected = params.cause === 'iterator-done' || params.cause === 'iterator-error';
  return { markStopped: true, autoContinue: unexpected };
}
