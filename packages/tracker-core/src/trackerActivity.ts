/**
 * The activity trail stored on a tracker item's `data.activity`.
 *
 * This lives in tracker-core because two hosts write it — the app's tracker
 * tool handlers and the CLI's offline write path — and a row written by one
 * must be byte-for-byte what the other would have written. Two hand-maintained
 * copies had already drifted on the coalescing rule, so the shape is defined
 * once here and both hosts call it.
 */

/** How many entries survive on an item before the oldest are dropped. */
const MAX_ACTIVITY_ENTRIES = 100;

/**
 * Longest `oldValue` / `newValue` an entry stores. The trail shows at most 80
 * characters of a value, but entries used to carry a whole description on each
 * side, so a long plan edited a few times outgrew the 256 KiB shared-item limit
 * and stopped syncing (NIM-7336).
 */
export const MAX_ACTIVITY_VALUE_CHARS = 500;

/** Bound an activity value to `MAX_ACTIVITY_VALUE_CHARS`, marking the cut with an ellipsis. */
export function capActivityValue(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= MAX_ACTIVITY_VALUE_CHARS) return value;
  let end = MAX_ACTIVITY_VALUE_CHARS - 1;
  // Never split a surrogate pair.
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

function normalizeIdentityValue(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

/**
 * Whether two activity authors are the same person, so consecutive edits
 * coalesce into one entry instead of a run of near-identical rows.
 *
 * Email wins because it is the only identifier stable across hosts: the app
 * resolves identity from Stytch and the CLI from git config, and the same
 * person's `displayName` differs between them. Name comparisons are the
 * fallback for an anonymous local user who has no email at all.
 */
function isSameAuthor(left: any, right: any): boolean {
  if (!left || !right) return false;

  const leftEmails = [left.email, left.gitEmail]
    .map(normalizeIdentityValue)
    .filter((value): value is string => value !== null);
  const rightEmails = [right.email, right.gitEmail]
    .map(normalizeIdentityValue)
    .filter((value): value is string => value !== null);
  if (leftEmails.length > 0 || rightEmails.length > 0) {
    return leftEmails.some((value) => rightEmails.includes(value));
  }

  const leftGitName = normalizeIdentityValue(left.gitName);
  const rightGitName = normalizeIdentityValue(right.gitName);
  if (leftGitName || rightGitName) {
    return leftGitName !== null && leftGitName === rightGitName;
  }

  const leftDisplayName = normalizeIdentityValue(left.displayName);
  const rightDisplayName = normalizeIdentityValue(right.displayName);
  return leftDisplayName !== null && leftDisplayName === rightDisplayName;
}

/**
 * Append or coalesce an activity entry in a tracker item's `data.activity`.
 *
 * Mutates `data` in place, and migrates a legacy `customFields.activity` array
 * up to the top level on the way through — old rows stored it nested, and a
 * caller that appended to the top-level array alone would silently orphan the
 * existing history.
 *
 * Consecutive `updated` entries by the same author on the same field collapse
 * into the last one, so dragging a slider does not write a hundred rows. The
 * `content` field is the exception: its `newValue` is not overwritten, because
 * the entry records that the body changed rather than what it changed to.
 */
export function appendActivity(
  data: Record<string, any>,
  authorIdentity: any,
  action: string,
  details?: { field?: string; oldValue?: string; newValue?: string; note?: string }
): void {
  const activity = data.activity || data.customFields?.activity || [];
  if (data.customFields?.activity) {
    delete data.customFields.activity;
    if (Object.keys(data.customFields).length === 0) delete data.customFields;
  }
  const now = Date.now();
  const lastEntry = activity[activity.length - 1];
  const shouldCoalesce =
    action === "updated" &&
    lastEntry?.action === "updated" &&
    lastEntry.field === details?.field &&
    isSameAuthor(lastEntry.authorIdentity, authorIdentity);

  if (shouldCoalesce) {
    if (details?.field !== "content") {
      lastEntry.newValue = capActivityValue(details?.newValue);
    }
    lastEntry.timestamp = now;
    data.activity =
      activity.length > MAX_ACTIVITY_ENTRIES
        ? activity.slice(-MAX_ACTIVITY_ENTRIES)
        : activity;
    return;
  }

  activity.push({
    id: `activity_${now}_${Math.random().toString(36).slice(2, 6)}`,
    authorIdentity,
    action,
    field: details?.field,
    oldValue: capActivityValue(details?.oldValue),
    newValue: capActivityValue(details?.newValue),
    timestamp: now,
    // Only present when supplied, so a host that never passes one still
    // writes the same bytes as before.
    ...(details?.note !== undefined ? { note: details.note } : {}),
  });
  data.activity =
    activity.length > MAX_ACTIVITY_ENTRIES
      ? activity.slice(-MAX_ACTIVITY_ENTRIES)
      : activity;
}
