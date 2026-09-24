/**
 * Shared between main (wakeup:create validation) and the renderer ("Run later"
 * menu), so both sides agree on what counts as "too soon" (#1497).
 */

/** A scheduled prompt must fire at least this far in the future. */
export const MIN_WAKEUP_LEAD_MS = 30_000;

/**
 * Who scheduled a wakeup. The agent's self-pacing tool replaces its own
 * previous wakeup; a person's "Run later" prompts accumulate and are never
 * replaced by either side.
 */
export type SessionWakeupOrigin = 'agent' | 'user';
