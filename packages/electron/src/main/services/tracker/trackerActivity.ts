function normalizeIdentityValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

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

/** Append or coalesce an activity entry in a tracker item's data.activity array. */
export function appendActivity(
  data: Record<string, any>,
  authorIdentity: any,
  action: string,
  details?: { field?: string; oldValue?: string; newValue?: string },
): void {
  const activity = data.activity || data.customFields?.activity || [];
  if (data.customFields?.activity) {
    delete data.customFields.activity;
    if (Object.keys(data.customFields).length === 0) delete data.customFields;
  }
  const now = Date.now();
  const lastEntry = activity[activity.length - 1];
  const shouldCoalesce = action === 'updated'
    && lastEntry?.action === 'updated'
    && lastEntry.field === details?.field
    && isSameAuthor(lastEntry.authorIdentity, authorIdentity);

  if (shouldCoalesce) {
    if (details?.field !== 'content') {
      lastEntry.newValue = details?.newValue;
    }
    lastEntry.timestamp = now;
    data.activity = activity.length > 100 ? activity.slice(-100) : activity;
    return;
  }

  activity.push({
    id: `activity_${now}_${Math.random().toString(36).slice(2, 6)}`,
    authorIdentity,
    action,
    field: details?.field,
    oldValue: details?.oldValue,
    newValue: details?.newValue,
    timestamp: now,
  });
  data.activity = activity.length > 100 ? activity.slice(-100) : activity;
}
