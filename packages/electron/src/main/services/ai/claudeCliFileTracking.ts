/**
 * File-edit attribution for the Claude CLI proxy observation backend (NIM-806,
 * Phase 4 parity gap).
 *
 * The SDK path calls `sessionFileTracker.trackToolExecution()` on every tool_call
 * chunk it observes, which creates the `session_files` rows that power the
 * FilesEditedSidebar, the context-graph session→file edges, and committed-session
 * detection. The CLI path bypasses `MessageStreamingHandler` entirely, so none of
 * that ran — the proxy only wrote `ai_agent_messages` rows.
 *
 * This module bridges the gap: it iterates the `tool_use` blocks of each
 * proxy-reassembled assistant turn and feeds them to an injected tracker (mirroring
 * the SDK, which also tracks at tool_use time, before the result arrives). The
 * tracker itself decides which tools touch files; non-file tools no-op there.
 *
 * Pure + DI so it is unit-testable without the real SessionFileTracker.
 */

import type { AssembledAssistantMessage } from './claudeCliObservation/claudeApiMessageAssembler';

/** Feed every tool_use block in a turn to `track`. Failures are swallowed per-call. */
export async function trackClaudeCliFileEdits(opts: {
  message: AssembledAssistantMessage;
  track: (toolName: string, input: unknown, toolUseId: string) => Promise<void>;
}): Promise<void> {
  for (const block of opts.message.content) {
    if (block.type !== 'tool_use') continue;
    try {
      await opts.track(block.name, block.input, block.id);
    } catch {
      // Attribution failures must never break observation. The tracker also
      // catches internally; this is a belt-and-suspenders guard.
    }
  }
}
