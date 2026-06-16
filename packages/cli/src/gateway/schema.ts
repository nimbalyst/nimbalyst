/**
 * Schema-version gating and status-shorthand resolution shared by both gateways.
 */

/**
 * The CLI understands tracker_items schemas in this range. `MAX_KNOWN_SCHEMA`
 * is the newest migration version this build was written against. A file newer
 * than this is *warned* about for reads (reads of an unknown-newer schema are
 * generally safe because we only touch long-stable columns) and *refused* for
 * writes (phase 2). Bump this when the CLI is verified against a newer schema.
 */
export const MIN_SUPPORTED_SCHEMA = 1;
export const MAX_KNOWN_SCHEMA = 12;

/**
 * Terminal (closed) statuses across built-in + custom types. Used to resolve the
 * `--status open` / `--status closed` meta-values without per-type schema in
 * direct mode. Custom types whose terminal vocabulary differs can still be
 * filtered with an explicit `--status <value>`.
 */
export const TERMINAL_STATUSES = new Set([
  'done',
  'closed',
  'completed',
  'complete',
  'resolved',
  'rejected',
  'superseded',
  'cancelled',
  'canceled',
  'merged',
  'wontfix',
  "won't-fix",
  'archived',
]);

export function isMetaStatus(status: string): status is 'open' | 'closed' {
  return status === 'open' || status === 'closed';
}
