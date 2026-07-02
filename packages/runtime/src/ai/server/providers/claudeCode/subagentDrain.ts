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

// The immediate tool_result the SDK returns when a command/sub-agent is
// launched in (or moved to) the background. It is a launch acknowledgement,
// not a completion: the task is still running and will settle later via a
// system task_notification chunk.
const BACKGROUND_LAUNCH_ACK = /running in (the )?background/i;

/**
 * Decide whether a tool_result whose toolUseId matches a tracked task means
 * that task has finished. True only for the foreground case (the tool call
 * blocked until the sub-agent completed). Backgrounded tasks return an
 * immediate "running in background" acknowledgement while still running —
 * settling on it made hasRunningTasks() false at turn end, so the drain never
 * engaged and teardown killed the task with the subprocess. See NIM-1470.
 */
export function shouldSettleTaskFromToolResult(
  task: { taskType?: string; isBackgrounded?: boolean; status: string },
  resultContent: unknown,
): boolean {
  if (task.status !== 'running') return false;
  // local_bash tasks only exist when a Bash command was backgrounded; their
  // matching tool_result is always the launch acknowledgement.
  if (task.taskType === 'local_bash') return false;
  // Authoritative signal from a task_updated patch, when the CLI sent one.
  if (task.isBackgrounded) return false;
  if (typeof resultContent === 'string' && BACKGROUND_LAUNCH_ACK.test(resultContent)) return false;
  return true;
}

/**
 * Map a task_updated patch status (SDK TaskState vocabulary) onto the
 * provider's coarser task status vocabulary. Returns undefined when the patch
 * carries no status change we track (pending/paused stay "running" — the task
 * has not reached a terminal state).
 */
export function mapTaskUpdatedPatchStatus(
  patchStatus: string | undefined,
): 'running' | 'completed' | 'failed' | 'stopped' | undefined {
  switch (patchStatus) {
    case 'pending':
    case 'running':
    case 'paused':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'killed':
      return 'stopped';
    default:
      return undefined;
  }
}

/**
 * Decide whether a task_updated patch's mapped status may be applied to the
 * tracked task. While draining after the lead turn ended, terminal statuses
 * must come ONLY from task_notification: the CLI emits the terminal
 * task_updated patch first, and settling on it exits the drain loop before
 * the notification chunk (summary, output file) is read — leaving nothing to
 * build the wake-up continuation from. See NIM-1470.
 */
export function shouldApplyTaskUpdatedStatus(
  mapped: 'running' | 'completed' | 'failed' | 'stopped' | undefined,
  draining: boolean,
): boolean {
  if (!mapped) return false;
  if (mapped === 'running') return true;
  return !draining;
}

/**
 * Detect the empty "flush" result the CLI emits when a resumed session has
 * pending task notifications: it enqueues the <task-notification> user message,
 * emits a success result with num_turns=0 and no text, and only THEN processes
 * the queued notification plus the real user prompt. Treating that flush result
 * as end-of-turn swallows the user's prompt (the real answer streams after it,
 * into a torn-down channel). See NIM-1470.
 */
export function isNotificationFlushResult(
  chunk: { type?: string; subtype?: string; is_error?: boolean; num_turns?: number; result?: string },
  sawTaskNotificationThisTurn: boolean,
  sawAssistantOutputThisTurn: boolean,
): boolean {
  return (
    chunk.type === 'result'
    && chunk.subtype === 'success'
    && chunk.is_error !== true
    && chunk.num_turns === 0
    && !chunk.result
    && sawTaskNotificationThisTurn
    && !sawAssistantOutputThisTurn
  );
}

/** Terminal task_notification captured while draining, for the continuation turn. */
export interface TaskTerminalNotification {
  taskId: string;
  description: string;
  status: 'completed' | 'failed' | 'stopped';
  summary?: string;
  outputFile?: string;
}

/**
 * After a clean drain resolve, decide whether to wake the session with a
 * visible continuation turn carrying the task results. Only completed/failed
 * tasks warrant one — a task stopped by the user should stay stopped.
 */
export function shouldContinueWithTaskResults(
  cause: DrainExitCause,
  notifications: TaskTerminalNotification[],
): boolean {
  return cause === 'resolved' && notifications.some(n => n.status !== 'stopped');
}

/**
 * Build the continuation prompt delivered (via the idle-message path) when
 * background tasks finished after the lead turn ended. Visible to the user,
 * so it reads as a system notification rather than an internal nudge.
 */
export function buildTaskResultContinuationMessage(
  notifications: TaskTerminalNotification[],
): string {
  const lines = notifications
    .filter(n => n.status !== 'stopped')
    .map(n => {
      const parts = [`- "${n.description || n.taskId}" ${n.status}`];
      if (n.summary) parts.push(`  Summary: ${n.summary}`);
      if (n.outputFile) parts.push(`  Output file: ${n.outputFile}`);
      return parts.join('\n');
    });
  return (
    '[System: background task(s) you launched have finished:\n'
    + lines.join('\n')
    + '\nContinue the work that was waiting on them.]'
  );
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
