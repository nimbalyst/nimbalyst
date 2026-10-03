/**
 * Wording for the spawned-work list shown next to teammates.
 *
 * The list is the CLI's registry of every task it spawns, agents and shell
 * commands alike, and foreground work counts: `task_started` fires for a
 * blocking `Bash` call too (`is_backgrounded: false`). Keep the type visible
 * per row so a shell command that exited non-zero does not read as a sub-agent
 * that died.
 */

import type { TaskInfo } from '../../store/atoms/agentMode';

/** The kind of work a row represents, in the reader's words. */
export function taskKindLabel(taskType: string | undefined): string {
  switch (taskType) {
    case 'local_agent': return 'Sub-agent';
    case 'local_bash': return 'Command';
    case 'local_workflow': return 'Workflow';
    case 'mcp_task': return 'MCP task';
    // A type the CLI adds later stays neutral rather than inheriting the
    // sub-agent wording.
    default: return 'Task';
  }
}

/**
 * How a finished task ended, where the icon alone is ambiguous. `failed` means
 * it ran and exited non-zero, so the command itself is the thing to fix.
 * `stopped` is deliberately the wider word: it covers a kill, a user stop, and
 * the stale-task sweep that rewrites anything still `running` at stream start —
 * the row cannot tell those apart, because the flag that would (`killedByTeardown`)
 * never reaches `currentTasks`. Running and completed already read from the
 * spinner and the green dot.
 */
export function taskOutcomeLabel(status: TaskInfo['status']): string | null {
  switch (status) {
    case 'failed': return 'failed';
    case 'stopped': return 'stopped';
    default: return null;
  }
}
