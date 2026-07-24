/**
 * Pure helpers for the voice agent's task-status tool. Kept free of Electron and
 * service imports so the running/waiting derivation is unit-testable in isolation
 * (importing VoiceModeService would drag in the whole main process).
 */

/** Status of the agent task the voice agent is driving, surfaced to extension
 *  voice tools via the `extensions:ai-get-task-status` IPC. */
export interface AgentTaskStatus {
  sessionId: string;
  title: string | null;
  status: 'idle' | 'running' | 'waiting_for_input' | 'error';
  running: boolean;
  waitingForInput: boolean;
}

/**
 * Map an ai_sessions row to the task-status shape. `running` is true only while
 * the agent is actively working; `waiting_for_input` is its own signal so a voice
 * tool can say "it's waiting on you" rather than "still going". Unknown/missing
 * status falls back to 'idle' (not running).
 */
export function mapAiSessionStatusToTaskStatus(row: {
  id: string;
  title: string | null;
  status: string | null;
}): AgentTaskStatus {
  const known = ['idle', 'running', 'waiting_for_input', 'error'] as const;
  const raw = row.status ?? 'idle';
  const status = (known as readonly string[]).includes(raw)
    ? (raw as AgentTaskStatus['status'])
    : 'idle';
  return {
    sessionId: row.id,
    title: row.title ?? null,
    status,
    running: status === 'running',
    waitingForInput: status === 'waiting_for_input',
  };
}
