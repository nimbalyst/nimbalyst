/**
 * Turn-completion signal for the Claude CLI proxy observation backend (NIM-806,
 * Phase 4 parity gap).
 *
 * The SDK path fires the "Response Ready" OS notification + completion sound from
 * `MessageStreamingHandler` when it sees the turn's `complete`/`result` chunk. The
 * CLI bypasses that handler, so neither fired. The proxy's reassembled assistant
 * message carries a `stopReason`, which is the equivalent signal: `tool_use` means
 * the turn continues (a tool call is pending), anything else (`end_turn`,
 * `stop_sequence`, `max_tokens`) means the assistant yielded back to the user.
 *
 * Pure helpers here decide turn-end + build the notification body; the service
 * wiring (sound, OS notification, mobile push) lives in the observation singleton.
 */

import type { AssembledAssistantMessage } from './claudeCliObservation/claudeApiMessageAssembler';

/**
 * True when this assembled assistant message ends the user-visible turn (the
 * assistant is done and waiting for the user), false while a tool call is still
 * pending or the stop reason is unknown/in-flight.
 */
export function isClaudeCliTurnEnd(stopReason: string | null): boolean {
  return stopReason !== null && stopReason !== 'tool_use';
}

/** Concatenate the assistant text blocks of a turn (ignores thinking / tool_use). */
export function extractAssistantText(message: AssembledAssistantMessage): string {
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Build the OS-notification body, mirroring the SDK's 100-char truncation. */
export function buildTurnNotificationBody(text: string): string {
  const t = text.trim();
  if (t.length === 0) return 'Response complete';
  return t.length > 100 ? `${t.substring(0, 100)}...` : t;
}
