/**
 * Per-session tracker that reconstructs sub-agent (`Task`) attribution for the
 * genuine `claude-code-cli` proxy-observation path (NIM-806, Phase 3 / B3).
 *
 * The B2 stream-json wire (Mainframe) tags every sub-agent event with a
 * `parent_tool_use_id`, so a sub-agent's turns are trivially skippable. The raw
 * Anthropic `/v1/messages` traffic we observe in B3 carries NO such field: the
 * CLI runs `Task` sub-agents in-process and their API calls are independent
 * requests on the same loopback proxy, indistinguishable per-request from the
 * parent's.
 *
 * We recover the relationship from the only signal the wire DOES give us:
 *   1. The parent turn ends with a `tool_use` block whose name is `Task` — at
 *      that point the parent is BLOCKED until the sub-agent finishes, so every
 *      assistant turn observed while a Task is in flight is sub-agent traffic.
 *   2. The sub-agent's final output returns to the parent as a `tool_result`
 *      (keyed by the Task's tool_use_id) in the parent's next request body —
 *      which ends the in-flight window.
 *
 * Callers use `isSubAgentTurnInFlight` to mark sub-agent assistant turns hidden
 * (so they don't pollute the visible transcript) and to suppress their
 * intermediate tool_result logging, while still attributing their file edits.
 *
 * Dependency-free so both the observation layer and any future Task wiring can
 * import it without an import cycle.
 */

/** The CLI's sub-agent spawning tool. */
export const TASK_TOOL_NAME = 'Task';

interface AssistantToolBlock {
  type: string;
  name?: string;
  id?: string;
}

interface AssistantTurnLike {
  content: AssistantToolBlock[];
}

/** Per-session set of Task tool_use ids whose sub-agent is still running. */
const inFlightTaskIdsBySession = new Map<string, Set<string>>();

function getSet(sessionId: string): Set<string> {
  let set = inFlightTaskIdsBySession.get(sessionId);
  if (!set) {
    set = new Set<string>();
    inFlightTaskIdsBySession.set(sessionId, set);
  }
  return set;
}

/** True when a `Task` sub-agent is mid-flight for this session. */
export function isSubAgentTurnInFlight(sessionId: string): boolean {
  return (inFlightTaskIdsBySession.get(sessionId)?.size ?? 0) > 0;
}

/**
 * Record any `Task` tool calls in a just-completed assistant turn as in-flight.
 * Call this AFTER deciding whether the turn itself was a sub-agent turn (the
 * parent message carrying the Task call must persist visibly).
 */
export function noteAssistantTaskCalls(sessionId: string, msg: AssistantTurnLike): void {
  if (!sessionId || !Array.isArray(msg?.content)) return;
  const set = getSet(sessionId);
  for (const block of msg.content) {
    if (block?.type === 'tool_use' && block.name === TASK_TOOL_NAME && typeof block.id === 'string' && block.id) {
      set.add(block.id);
    }
  }
}

/**
 * Mark Task tool_use ids as completed when their `tool_result` shows up in a
 * request body. Non-Task ids (a sub-agent's own Bash/Read results) are ignored,
 * so they keep the in-flight window open until the Task itself resolves.
 */
export function noteToolResultsCompleteTasks(sessionId: string, toolUseIds: string[]): void {
  const set = inFlightTaskIdsBySession.get(sessionId);
  if (!set) return;
  for (const id of toolUseIds) {
    set.delete(id);
  }
  if (set.size === 0) inFlightTaskIdsBySession.delete(sessionId);
}

/** Drop the session's set (call when its observation session ends). */
export function clearSubAgentTracking(sessionId: string): void {
  inFlightTaskIdsBySession.delete(sessionId);
}
