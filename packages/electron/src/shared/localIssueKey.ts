/**
 * Local-only issue keys for tracker items that do not yet have a
 * server-assigned identity.
 *
 * The `NIM-###` namespace (or whatever the room's prefix is) belongs to the
 * tracker room and to nothing else. A client that mints into it is guessing,
 * and two clients guessing independently is how the same shared item ended up
 * as NIM-2521 in one workspace and NIM-2525 in another: every create path
 * allocated a local `MAX(issue_number)+1` before the mutation was acked, and
 * the loser never converged.
 *
 * A synced item therefore carries an `LC-###` key between creation and the
 * ack. It is visibly not a real issue key, so nobody pastes it into a commit
 * message expecting `CommitTrackerLinker` to resolve it, and it never occupies
 * `issue_number` -- the column the room owns.
 */

export const LOCAL_ISSUE_KEY_PREFIX = 'LC';

const LOCAL_ISSUE_KEY_PATTERN = /^LC-(\d+)$/;

export function formatLocalIssueKey(localNumber: number): string {
  return `${LOCAL_ISSUE_KEY_PREFIX}-${localNumber}`;
}

/**
 * True for a provisional local key. Callers that resolve user-typed references
 * (commit trailers, `Fixes` lines) must treat these as unresolvable rather than
 * matching them against the room's namespace.
 */
export function isLocalIssueKey(issueKey: string | null | undefined): boolean {
  return typeof issueKey === 'string' && LOCAL_ISSUE_KEY_PATTERN.test(issueKey.trim());
}

/** Numeric suffix of a local key, or null when it is not one. */
export function parseLocalIssueNumber(issueKey: string | null | undefined): number | null {
  if (typeof issueKey !== 'string') return null;
  const match = LOCAL_ISSUE_KEY_PATTERN.exec(issueKey.trim());
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
