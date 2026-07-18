/**
 * Turn-state transition applied when an interactive prompt (AskUserQuestion /
 * PromptForUserInput) settles — i.e. the user answered or cancelled (NIM-806).
 *
 * On settle the turn is resuming, so the session's running indicator should be
 * re-asserted. For the SDK / Codex paths the provider drives the rest of the
 * turn (and its eventual completion), so forcing `running` here is correct.
 *
 * For the genuine `claude-code-cli` path we must NOT force `running` here: that
 * session's running/idle lifecycle is owned by the PID-state watcher
 * (claudeCliPidState → SessionStateManager). Forcing `running` at settle races
 * the watcher's turn-ending `idle` — SessionStateManager's supersede-guard then
 * drops the `idle`'s `session:completed` emit, leaving the renderer's running
 * indicator stuck on after the CLI already finished the turn (NIM-806 Defect A).
 * The watcher is the single authority for CLI turn state.
 */

import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';

type StateManager = Pick<ReturnType<typeof getSessionStateManager>, 'updateActivity'>;

export interface ApplyInteractivePromptSettleTurnStateArgs {
  sessionId: string | undefined;
  /** True for the genuine `claude-code-cli` provider. */
  isCliSession: boolean;
  /** Generation captured when this exact prompt became pending. */
  attentionGeneration?: string | null;
  stateManager: StateManager;
}

export async function applyInteractivePromptSettleTurnState(
  args: ApplyInteractivePromptSettleTurnStateArgs,
): Promise<void> {
  if (!args.sessionId) return;
  // CLI sessions: leave the running/idle indicator to the PID watcher (see above).
  if (args.isCliSession) return;
  // SDK/MCP prompt callbacks are delayed. Without an exact generation this
  // could flip a newer prompt B from waiting back to running, so fail closed.
  if (!args.attentionGeneration) return;
  await args.stateManager.updateActivity({
    sessionId: args.sessionId,
    status: 'running',
    isStreaming: true,
    attentionGeneration: args.attentionGeneration,
  });
}
