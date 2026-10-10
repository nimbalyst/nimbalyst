/**
 * The send-wall contract: what happened between the user pressing send and a
 * message actually reaching a provider.
 *
 * Roughly a third of new users create an agent session and never produce a
 * downstream event, and today we cannot tell "did not try" apart from "tried
 * and was silently refused." `ai_request_failed` reads 0.0% for that group,
 * which is evidence of a missing event rather than evidence of no failures --
 * it fires deep inside the stream, long after the guards that would refuse a
 * first-time user have already thrown.
 *
 * The shape is three events, not one:
 *
 *   ai_message_submit_attempted  the denominator; fires before any guard
 *   ai_send_blocked              every non-send termination, with a reason
 *   ai_message_sent              unchanged, the success terminal
 *
 * so the funnel is `attempted - blocked - sent`. A non-zero residue is itself
 * a finding: it means some path terminates a send with no instrumentation.
 * Folding the outcome into one deferred event would hide exactly that, which
 * is the failure mode this whole contract exists to remove.
 *
 * Reasons are a closed union on purpose. The `database_error` incident (one
 * session, ~62k events, every one `errorType: unknown`) is what unbounded
 * property values cost, and a raw error message is also the easiest way to
 * leak a filesystem path into a payload.
 */

import {
  booleanRule,
  categoryRule,
  enumRule,
  validateAgainstSchemas,
  type PropertiesFor,
} from './eventContract';

// Re-exported so a send-wall call site needs one import, not two.
export { toStableAnalyticsCategory } from './eventContract';

/** Where the submit came from. */
export const SEND_SURFACES = ['transcript', 'launch_popup'] as const;
export type SendSurface = (typeof SEND_SURFACES)[number];

/**
 * Every way a send can end without reaching a provider.
 *
 * Renderer-side guards live in `SessionTranscript.handleSend`; main-side
 * guards live at the top of `MessageStreamingHandler.handle`. Main emits its
 * own blocked event rather than having the renderer classify a thrown error --
 * string-matching an error message is fragile, and raw errors must never enter
 * a payload.
 */
export const SEND_BLOCKED_REASONS = [
  // Renderer, before anything is dispatched
  'empty_draft',
  'no_session_data',
  'queued_cli_not_ready',
  'cli_submit_failed',
  'submission_record_failed',
  'queued_while_loading',
  'mode_switch_failed',
  'slash_command_only',
  'slash_command_clear',
  // Renderer, after main rejected and emitted nothing itself
  'ipc_error',
  // Main process guards
  'duplicate_prompt',
  'no_session_id',
  'no_workspace',
  'session_not_found',
  'session_mismatch',
  'no_provider',
  'no_api_key',
] as const;
export type SendBlockedReason = (typeof SEND_BLOCKED_REASONS)[number];

/** Why the composer's send affordance is unavailable when a session opens. */
export const COMPOSER_DISABLED_REASONS = [
  'none',
  'no_provider_selected',
  'no_models_available',
  'session_loading',
  'workspace_untrusted',
  'unknown',
] as const;
export type ComposerDisabledReason = (typeof COMPOSER_DISABLED_REASONS)[number];

const surface = enumRule(...SEND_SURFACES);
const blockedReason = enumRule(...SEND_BLOCKED_REASONS);
const disabledReason = enumRule(...COMPOSER_DISABLED_REASONS);

export const SEND_WALL_EVENT_SCHEMAS = {
  ai_message_submit_attempted: {
    surface,
    provider: categoryRule,
    promptLengthBucket: categoryRule,
    // Session-scoped, not person-scoped. "First ever" is derivable from the
    // event stream itself, but "first turn of this session" is not without a
    // per-session query, and it is the cut that separates a cold composer from
    // an ongoing conversation.
    isFirstMessageInSession: booleanRule,
    sessionMode: categoryRule,
  },
  ai_send_blocked: {
    surface,
    reason: blockedReason,
    provider: categoryRule,
  },
  composer_state_reported: {
    surface,
    sendEnabled: booleanRule,
    disabledReason,
    providerSelected: booleanRule,
    // The observable form of "the model list was empty": a session that opened
    // without a model resolved. The list itself lives inside ModelSelector,
    // which fetches its own — plumbing it up to the transcript purely to report
    // on it would change component structure for a telemetry field.
    modelSelected: booleanRule,
    provider: categoryRule,
  },
} as const;

type SchemaMap = typeof SEND_WALL_EVENT_SCHEMAS;
export type SendWallEventName = keyof SchemaMap & string;
export type SendWallProperties<E extends SendWallEventName> = PropertiesFor<SchemaMap, E>;

export function validateSendWallEvent<E extends SendWallEventName>(
  event: E,
  properties: SendWallProperties<E>,
): { event: E; properties: SendWallProperties<E> } {
  return validateAgainstSchemas(SEND_WALL_EVENT_SCHEMAS, event, properties);
}

/**
 * Bucket a draft's length. Never emit a raw character count next to a prompt
 * event -- with a small population it narrows toward the prompt itself.
 *
 * These are the canonical buckets: `bucketMessageLength`, which stamps
 * `ai_message_sent`, delegates here so attempted and sent can never drift into
 * incomparable scales. A zero-length draft buckets as `short` rather than
 * getting its own value -- the `empty_draft` blocked reason already records it,
 * and a fourth value would change the shape of the existing event.
 */
export function bucketPromptLength(length: number): 'short' | 'medium' | 'long' {
  if (length < 100) return 'short';
  if (length < 500) return 'medium';
  return 'long';
}
