// Reducer for the SDK's system task chunks (task_started / task_progress /
// task_notification / task_updated) over the provider's `activeTasks` map.
//
// Extracted from ClaudeCodeProvider so the task lifecycle — which decides
// whether a turn ends quietly or wakes the session with a paid continuation —
// can be driven directly in tests. The decision helpers it calls live in
// subagentDrain.ts; this module owns only the bookkeeping between them.

import {
  mapTaskUpdatedPatchStatus,
  shouldApplyTaskUpdatedStatus,
  shouldRecordTerminalNotification,
  type TaskTerminalNotification,
} from './subagentDrain';

/** A task as `activeTasks` tracks it. Mutated in place. */
export interface TrackedSystemTask {
  taskId: string;
  description: string;
  taskType?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  toolUseId?: string;
  toolCount: number;
  tokenCount: number;
  durationMs: number;
  lastToolName?: string;
  summary?: string;
  isBackgrounded?: boolean;
  terminalNotified?: boolean;
  /**
   * A terminal notification that arrived with no background evidence yet.
   *
   * A fast background shell on a CLI that sends no `is_backgrounded` can settle
   * BEFORE its launch acknowledgement reaches us. Deciding at notification time
   * would drop it (no evidence), and the acknowledgement then arrives for an
   * already-terminal task — so the turn ends with nothing running and nothing
   * buffered, and the user never learns the command finished. Hold it here
   * instead and let the acknowledgement classify it. A task that never gets
   * that evidence ran in the foreground, and the held record is simply
   * discarded with the task.
   */
  pendingTerminalNotification?: TaskTerminalNotification;
}

/**
 * Record that a task really was backgrounded, on evidence observed outside the
 * system-task stream — in practice the launch acknowledgement that came back as
 * its tool_result.
 *
 * This is the only route by which a task that already reported terminally can
 * be classified, so it also releases any notification held at that moment.
 * Release is guarded by `terminalNotified`, which makes it exactly once no
 * matter how many acknowledgements or repeat notifications arrive, and across
 * turns — the per-turn `notifications` buffer cannot carry that guarantee.
 *
 * Returns true when something changed and the caller should refresh the UI.
 */
export function recordBackgroundEvidence(
  task: TrackedSystemTask,
  notifications: TaskTerminalNotification[],
): boolean {
  let changed = false;
  if (task.isBackgrounded !== true) {
    task.isBackgrounded = true;
    changed = true;
  }
  const held = task.pendingTerminalNotification;
  if (held && !task.terminalNotified) {
    task.terminalNotified = true;
    task.pendingTerminalNotification = undefined;
    notifications.push(held);
    changed = true;
  }
  return changed;
}

/**
 * Finished tasks kept in `activeTasks` and in `metadata.currentTasks`.
 *
 * The CLI reports every Bash call as a task, so an unbounded map grew one
 * session's metadata row to 993KB, and the session list re-read and parsed that
 * column for every session on each refresh until main ran out of heap.
 */
export const FINISHED_TASK_RETENTION = 20;

/**
 * Drop the oldest finished tasks beyond `keep`, in place. Running tasks are
 * never dropped: the drain and wake logic only reads running ones, and a
 * finished task's held notification is only released by an acknowledgement
 * that arrives right after its launch, well inside the retention window.
 * Returns true when anything was removed.
 */
export function pruneFinishedTasks(tasks: Map<string, TrackedSystemTask>, keep = FINISHED_TASK_RETENTION): boolean {
  const finished = [...tasks.values()].filter(task => task.status !== 'running');
  if (finished.length <= keep) return false;
  // Persisted entries from older builds may lack startedAt; treat them as oldest.
  finished.sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0));
  for (const task of finished.slice(0, finished.length - keep)) tasks.delete(task.taskId);
  return true;
}

/**
 * The persisted form of the task list. The held notification is in-memory
 * bookkeeping for the wake path and duplicated half of each entry on disk.
 */
export function persistedTasks(tasks: Iterable<TrackedSystemTask>): Array<Omit<TrackedSystemTask, 'pendingTerminalNotification'>> {
  return Array.from(tasks, ({ pendingTerminalNotification: _held, ...task }) => task);
}

export interface ApplySystemTaskChunkParams {
  subtype: string;
  chunk: any;
  tasks: Map<string, TrackedSystemTask>;
  /** The lead turn ended and we are draining background tasks. */
  draining: boolean;
  /** The drain grace window expired, so a 'stopped' is our own kill (#1355). */
  graceExpired: boolean;
  /** Appended to when a terminal notification is worth a continuation turn. */
  notifications: TaskTerminalNotification[];
  log?: (message: string) => void;
}

/**
 * Apply one system task chunk. Returns true when the task list changed and the
 * caller should emit a task update to the UI.
 */
export function applySystemTaskChunk(params: ApplySystemTaskChunkParams): boolean {
  const { subtype, chunk, tasks, draining, graceExpired, notifications } = params;
  const log = params.log ?? (() => {});

  if (subtype === 'task_started') {
    tasks.set(chunk.task_id, {
      taskId: chunk.task_id,
      description: chunk.description || '',
      taskType: chunk.task_type,
      status: 'running',
      startedAt: Date.now(),
      // The CLI reports foregroundness here for every task it tracks, ordinary
      // foreground Bash calls included. Preserve the absent case as undefined —
      // "no signal" is not "backgrounded". See #1493.
      isBackgrounded: typeof chunk.is_backgrounded === 'boolean' ? chunk.is_backgrounded : undefined,
      toolUseId: chunk.tool_use_id,
      toolCount: 0,
      tokenCount: 0,
      durationMs: 0,
    });
    log(`[CLAUDE-CODE] SUBAGENT_TASK started: id=${chunk.task_id} type=${chunk.task_type ?? 'n/a'} desc="${(chunk.description || '').substring(0, 80)}"`);
    return true;
  }

  const existing = tasks.get(chunk.task_id);
  if (!existing) return false;

  if (subtype === 'task_progress') {
    existing.toolCount = chunk.usage?.tool_uses ?? existing.toolCount;
    existing.tokenCount = chunk.usage?.total_tokens ?? existing.tokenCount;
    existing.durationMs = chunk.usage?.duration_ms ?? existing.durationMs;
    existing.lastToolName = chunk.last_tool_name ?? existing.lastToolName;
    return true;
  }

  if (subtype === 'task_notification') {
    existing.status = chunk.status || 'completed';
    existing.summary = chunk.summary;
    if (chunk.usage) {
      existing.toolCount = chunk.usage.tool_uses ?? existing.toolCount;
      existing.tokenCount = chunk.usage.total_tokens ?? existing.tokenCount;
      existing.durationMs = chunk.usage.duration_ms ?? existing.durationMs;
    }
    log(`[CLAUDE-CODE] SUBAGENT_TASK notification: id=${chunk.task_id} status=${existing.status} draining=${draining}`);
    // Capture terminal notifications for background tasks so
    // finalizeBackgroundDrain can wake the session with the results (the CLI's
    // own continuation turn cannot be surfaced — the consumer already received
    // complete). While draining, that is every task still running at the lead's
    // result (NIM-1470); off the drain path it needs real background evidence,
    // so a foreground Task or Bash does not bill a spurious extra continuation
    // turn (#1410 / #1493). `terminalNotified` lives on the task rather than
    // the buffer because the buffer is per-turn and the CLI can repeat a
    // notification on a later one.
    if (!existing.terminalNotified) {
      const status = existing.status === 'running' ? 'completed' : existing.status;
      const record: TaskTerminalNotification = {
        taskId: chunk.task_id,
        description: existing.description,
        status,
        summary: chunk.summary,
        outputFile: chunk.output_file,
        // A 'stopped' that arrives after our grace timer closed the stream is
        // our own kill, not a user stop — report it as one. #1355.
        killedByTeardown: status === 'stopped' && graceExpired,
        elapsedMs: Date.now() - existing.startedAt,
      };
      if (shouldRecordTerminalNotification(existing, draining)) {
        existing.terminalNotified = true;
        existing.pendingTerminalNotification = undefined;
        notifications.push(record);
      } else {
        // No background evidence yet. Hold rather than drop — see
        // `pendingTerminalNotification`. A repeat notification just refreshes
        // the held record, so the eventual release is still exactly one.
        existing.pendingTerminalNotification = record;
      }
    }
    return true;
  }

  if (subtype === 'task_updated') {
    // Wire-safe TaskState patch (status / is_backgrounded / description).
    const patch = chunk.patch;
    if (!patch || typeof patch !== 'object') return false;
    // Promotion only. A patch never demotes a task the launch acknowledgement
    // already proved backgrounded.
    if (patch.is_backgrounded === true) existing.isBackgrounded = true;
    if (typeof patch.description === 'string' && patch.description) existing.description = patch.description;
    // While draining, terminal status comes ONLY from task_notification —
    // settling on the (earlier) terminal patch exits the drain loop before the
    // notification is read, and the wake continuation never fires.
    const mapped = mapTaskUpdatedPatchStatus(patch.status);
    if (shouldApplyTaskUpdatedStatus(mapped, draining)) {
      existing.status = mapped!;
    }
    if (typeof patch.error === 'string' && patch.error) existing.summary = patch.error;
    return true;
  }

  return false;
}
