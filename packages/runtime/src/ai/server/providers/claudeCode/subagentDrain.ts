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
  /**
   * SDK task type. 'local_bash' is a backgrounded shell command; anything else
   * (or absent) is treated as a sub-agent. Only `resolvePromptEndDelay` reads
   * it — the other helpers key off status alone.
   */
  taskType?: string;
}

/** A tracked task as `activeTasks` holds it — status is written in place. */
export interface MutableSubagentTask extends SubagentTaskLike {
  description?: string;
  taskId?: string;
}

// The immediate tool_result the SDK returns when a command/sub-agent is
// launched in (or moved to) the background. It is a launch acknowledgement,
// not a completion: the task is still running and will settle later via a
// system task_notification chunk. The CLI has used several wordings —
// "Command running in background with ID: …" (Bash), "Task is now running in
// the background" and "Async agent launched successfully… The agent is
// working in the background" (sub-agents) — so match all of them. NIM-1556.
const BACKGROUND_LAUNCH_ACK = /running in (the )?background|working in the background|async agent launched/i;

/**
 * Flatten tool_result content to searchable text. The SDK delivers it either
 * as a plain string or as an array of content blocks ({type:'text', text}) —
 * the sub-agent launch acknowledgement arrives as the latter. NIM-1556.
 */
export function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block =>
        block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '')
      .join('\n');
  }
  return '';
}

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
  if (BACKGROUND_LAUNCH_ACK.test(extractToolResultText(resultContent))) return false;
  return true;
}

/**
 * Decide whether a terminal task_notification is worth recording for a
 * continuation turn.
 *
 * While draining, backgroundedness is implied — every task still running at the
 * lead's `result` was necessarily a background one, so record unconditionally
 * (unchanged behavior).
 *
 * Off the drain path this is the #1410 gate. A task that settles DURING the turn
 * never engages the drain machinery (hasRunningTasks() is already false at the
 * `result` chunk), yet the CLI still queues its own `<task-notification>`
 * continuation turn for a BACKGROUNDED one — and that turn runs against a
 * control channel we tear down ~0.3s later, so every tool call needing a
 * permission decision is denied before canUseTool is ever reached. Recording the
 * notification is what lets Nimbalyst close the subprocess and deliver the
 * equivalent turn visibly instead.
 *
 * A FOREGROUND Task must not qualify: it settled via its own tool_result, the
 * model already saw that result inline, and the CLI queues nothing. Treating it
 * as a trigger would bill an extra continuation turn per delegation.
 */
export function shouldRecordTerminalNotification(
  task: { taskType?: string; isBackgrounded?: boolean },
  draining: boolean,
): boolean {
  if (draining) return true;
  return task.taskType === 'local_bash' || task.isBackgrounded === true;
}

/**
 * Decide whether the turn must run drain finalization even though it never
 * entered the drain (nothing was still running at the `result` chunk).
 *
 * True when a backgrounded task reported terminally during the turn: that fact
 * predicts the CLI has a continuation turn queued on a subprocess whose control
 * channel is about to die. Finalization closes it and delivers the results
 * visibly instead. See #1410.
 */
export function shouldFinalizeForSettledBackgroundTasks(params: {
  willDrainSubagents: boolean;
  terminalNotificationCount: number;
}): boolean {
  return !params.willDrainSubagents && params.terminalNotificationCount > 0;
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

/**
 * Decide whether a `result` chunk should arm the grace-period timer that ends
 * the control channel after N seconds of stream silence. A notification-flush
 * result must NOT arm it: the CLI is still working (often minutes of
 * main-stream silence while a background sub-agent runs), so ending the channel
 * mid-turn makes every later canUseTool/hook request fail "Stream closed" and
 * leaks the runaway subprocess. Only the REAL result arms the timer. Non-result
 * chunks never arm it. See NIM-1470.
 */
export function shouldArmGraceTimerForResult(
  chunk: { type?: string; subtype?: string; is_error?: boolean; num_turns?: number; result?: string },
  sawTaskNotificationThisTurn: boolean,
  sawAssistantOutputThisTurn: boolean,
): boolean {
  if (chunk.type !== 'result') return false;
  return !isNotificationFlushResult(chunk, sawTaskNotificationThisTurn, sawAssistantOutputThisTurn);
}

/** Terminal task_notification captured while draining, for the continuation turn. */
export interface TaskTerminalNotification {
  taskId: string;
  description: string;
  status: 'completed' | 'failed' | 'stopped';
  summary?: string;
  outputFile?: string;
  /**
   * The task reported 'stopped' because OUR teardown killed it — the drain
   * grace timer expired, we closed the prompt stream, and the CLI killed the
   * task along with its own process. Distinct from a user stop, which reaches
   * this struct identically. A background shell (local_bash) streams no chunks
   * while it runs, so it never resets the grace timer and this is its normal
   * fate on any run longer than the window. See GitHub #1355.
   */
  killedByTeardown?: boolean;
  /** How long the task had been running when it was killed, for the report. */
  elapsedMs?: number;
}

/** True for a task that ended only because our own teardown killed it. */
function wasKilledByTeardown(n: TaskTerminalNotification): boolean {
  return n.status === 'stopped' && n.killedByTeardown === true;
}

/** A notification worth telling the session about. */
function isReportable(n: TaskTerminalNotification): boolean {
  return n.status !== 'stopped' || wasKilledByTeardown(n);
}

/**
 * After a clean drain resolve, decide whether to wake the session with a
 * visible continuation turn carrying the task results. Completed/failed tasks
 * warrant one, and so does a task our own teardown killed — silence there left
 * the agent unable to tell "killed" from "stopped" and cost the reporter a
 * duplicate paid re-run (#1355). A task the USER stopped stays stopped.
 */
export function shouldContinueWithTaskResults(
  cause: DrainExitCause,
  notifications: TaskTerminalNotification[],
): boolean {
  return cause === 'resolved' && notifications.some(isReportable);
}

/** "13m 42s" / "47s" — coarse duration for the report line. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Build the continuation prompt delivered (via the idle-message path) when
 * background tasks settled after the lead turn ended. Visible to the user, so
 * it reads as a system notification rather than an internal nudge.
 *
 * A teardown kill is named as a kill, not left as a bare "stopped": the agent
 * reads this to decide whether the work still needs doing. See #1355.
 */
export function buildTaskResultContinuationMessage(
  notifications: TaskTerminalNotification[],
): string {
  const reportable = notifications.filter(isReportable);
  const killed = reportable.filter(wasKilledByTeardown);

  const lines = reportable.map(n => {
    const parts = wasKilledByTeardown(n)
      ? [
          `- "${n.description || n.taskId}" was KILLED at process exit`
          + (n.elapsedMs !== undefined ? ` after running ${formatElapsed(n.elapsedMs)}` : '')
          + ' — it did not finish on its own.',
        ]
      : [`- "${n.description || n.taskId}" ${n.status}`];
    if (n.summary) parts.push(`  Summary: ${n.summary}`);
    if (n.outputFile) parts.push(`  Output file: ${n.outputFile}`);
    return parts.join('\n');
  });

  const header =
    killed.length === reportable.length
      ? '[System: background task(s) you launched were killed before finishing:'
      : '[System: background task(s) you launched have settled:';

  const footer = killed.length > 0
    ? '\nAny output file above holds only partial output, up to the moment of the kill.'
      + ' Treat the killed work as NOT done: re-run it, or report that it could not complete.'
      + ' Continue the work that was waiting on the rest.]'
    : '\nContinue the work that was waiting on them.]';

  return header + '\n' + lines.join('\n') + footer;
}

/** True if any tracked sub-agent task is still running. */
export function hasRunningTasks(tasks: Iterable<SubagentTaskLike>): boolean {
  for (const t of tasks) {
    if (t.status === 'running') return true;
  }
  return false;
}

/**
 * Mark every still-running task stopped and return their labels. Called when
 * the transport those tasks were running on is gone — the drain loop exiting
 * with stragglers, or abort() killing the subprocess — so no further
 * task_notification can settle them. Leaving one 'running' makes the next
 * turn's `result` defer teardown for nothing (NIM-2458).
 */
export function reapRunningTasks(tasks: Iterable<MutableSubagentTask>): string[] {
  const stranded: string[] = [];
  for (const task of tasks) {
    if (task.status === 'running') {
      task.status = 'stopped';
      stranded.push(task.description || task.taskId || 'unknown task');
    }
  }
  return stranded;
}

/** Count of tasks still running — what the drain gate actually keys off. */
export function countRunningTasks(tasks: Iterable<SubagentTaskLike>): number {
  let count = 0;
  for (const t of tasks) {
    if (t.status === 'running') count++;
  }
  return count;
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
 * Default bound on how long a backgrounded shell holds the prompt stream open
 * after its turn ended.
 *
 * The grace timer this feeds is a NO-ACTIVITY stall detector: any SDK chunk
 * resets it. That works for a sub-agent, which streams `task_progress` while it
 * runs — silence from one really is a stall. A `local_bash` task streams nothing
 * at all until it settles, so silence from one carries no information, and the
 * 5-minute sub-agent window killed every background shell that ran longer than
 * it. See GitHub #1355.
 *
 * 30 minutes covers CI waits and long builds while still bounding a runaway; on
 * expiry the existing `killedByTeardown` path reports the kill honestly rather
 * than letting it look like a user stop.
 */
export const DEFAULT_SHELL_DRAIN_MS = 1_800_000;

/**
 * Resolve the background-shell window, allowing an env override so tests can use
 * a short window instead of waiting out half an hour. Invalid / non-positive
 * values fall back to the default. Mirrors `resolveStreamStallMs`.
 */
export function resolveShellDrainMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.NIMBALYST_CC_SHELL_DRAIN_MS;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SHELL_DRAIN_MS;
}

/**
 * How long to leave the prompt stream open after a turn ends, given what is
 * still running. Ending it closes the CLI's stdin, which kills every live
 * background task with the subprocess — so the window has to be sized by what
 * silence MEANS for each kind of task, not by one number for all of them.
 *
 * Takes the max over the running set: a stalled sub-agent must not cut short a
 * live shell. Terminal tasks are ignored, so a settled shell stops holding the
 * stream open. With nothing running, the short idle window applies.
 */
export function resolvePromptEndDelay(
  tasks: Iterable<SubagentTaskLike>,
  windows: { idle: number; subagent: number; shell: number },
): number {
  let delay = windows.idle;
  for (const task of tasks) {
    if (task.status !== 'running') continue;
    const window = task.taskType === 'local_bash' ? windows.shell : windows.subagent;
    if (window > delay) delay = window;
  }
  return delay;
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
