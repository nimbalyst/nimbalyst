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

/**
 * The current local-number form: the project's own prefix, a dot, the number.
 *
 * The separator is the whole point. A team prefix is validated as two to five
 * uppercase letters, so a dot can never occur in one -- which means `NIM.12`
 * and `NIM-12` cannot be confused, and telling them apart costs a regex rather
 * than a database lookup. That matters because local numbers do not stay
 * local: an agent handed one writes it into a commit message, and the only
 * property worth guaranteeing is that the escaped number fails loudly instead
 * of resolving to some other item.
 *
 * Length could not do this job. The room's prefix-conflict path already hands
 * back longer alternatives (NIM taken -> NIMA), so "local prefixes are longer"
 * would collide with real team keys.
 */
export const LOCAL_KEY_SEPARATOR = '.';

const LOCAL_KEY_PATTERN = /^([A-Z]{2,5})\.(\d+)$/;

export function formatLocalKey(prefix: string, localNumber: number): string {
  return `${prefix.toUpperCase()}${LOCAL_KEY_SEPARATOR}${localNumber}`;
}

/** True for a dotted local number, whatever project prefix it carries. */
export function isLocalKeyReference(reference: string | null | undefined): boolean {
  return typeof reference === 'string' && LOCAL_KEY_PATTERN.test(reference.trim());
}

export function parseLocalKey(
  reference: string | null | undefined,
): { prefix: string; localNumber: number } | null {
  if (typeof reference !== 'string') return null;
  const match = LOCAL_KEY_PATTERN.exec(reference.trim());
  if (!match) return null;
  const localNumber = Number(match[2]);
  if (!Number.isSafeInteger(localNumber)) return null;
  return { prefix: match[1], localNumber };
}

/**
 * True for any reference that is a private handle rather than a shared key --
 * the recycled `LC-###` values still sitting in old databases, and the current
 * dotted form. Callers resolving user-typed references against the room's
 * namespace must refuse both.
 */
export function isPrivateIssueReference(reference: string | null | undefined): boolean {
  return isLocalIssueKey(reference) || isLocalKeyReference(reference);
}

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

/**
 * How a key should be described to an agent or a user.
 *
 * A provisional key is not just "not final" -- it is actively unsafe to hold
 * onto. `nextLocalIssueNumber` derives the next suffix by scanning rows whose
 * key still starts with `LC-`, so once the ack rewrites `LC-2` to `NIM-2615`
 * nothing matches and the counter resets: the next create is `LC-2` again.
 * A caller that stashed the first `LC-2` and later resolves it lands on a
 * different item entirely.
 */
export function describeIssueKey(
  issueKey: string | null | undefined,
  itemId: string,
): { ref: string; isProvisional: boolean; caveat: string | null } {
  if (!issueKey) {
    return { ref: itemId, isProvisional: false, caveat: null };
  }
  // A dotted local number is stable -- it is never reissued and never
  // rewritten -- so it is safe to hold onto, unlike the recycled `LC-###`
  // values below. It is still private to this machine and this project, and
  // the leak that matters is an agent putting it in a commit message where a
  // reader resolves it against their own tracker.
  if (isLocalKeyReference(issueKey)) {
    return {
      ref: issueKey,
      isProvisional: false,
      caveat:
        `${issueKey} is this machine's private number for the item, not a shared key. `
        + `It resolves only in this project, on this machine. Do not put it in commit `
        + `messages, pull requests, or anything another person reads -- for them it `
        + `resolves to nothing, or to a different item.`,
    };
  }
  if (!isLocalIssueKey(issueKey)) {
    return { ref: issueKey, isProvisional: false, caveat: null };
  }
  return {
    ref: `${issueKey} (provisional)`,
    isProvisional: true,
    caveat:
      `${issueKey} is a local placeholder, NOT this item's issue key. The server assigns the real key. ` +
      `Re-read the item by its ID (${itemId}) to get it. Do not put ${issueKey} in commit messages, ` +
      `links, or references -- it does not resolve, and it is later reused by a different item.`,
  };
}

/**
 * The key to show for an item, or nothing when it has none worth showing.
 *
 * A team key first: it is the only form that means the same thing to everyone.
 * Then this machine's local number, which at least resolves in this project.
 * A leftover `LC-###` loses to both -- those values were reissued as items were
 * acked, so displaying one where a stable number exists points the reader at
 * whatever happens to hold that placeholder now.
 */
export function resolveDisplayIssueKey(
  item: { issueKey?: string | null; localKey?: string | null },
): string | undefined {
  if (item.issueKey && !isLocalIssueKey(item.issueKey)) return item.issueKey;
  return item.localKey ?? undefined;
}

/** Numeric suffix of a local key, or null when it is not one. */
export function parseLocalIssueNumber(issueKey: string | null | undefined): number | null {
  if (typeof issueKey !== 'string') return null;
  const match = LOCAL_ISSUE_KEY_PATTERN.exec(issueKey.trim());
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
