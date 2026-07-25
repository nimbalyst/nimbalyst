/**
 * Which organization the org-management window lands on when it is opened
 * without an explicit `orgId` (Window > Organization Manager, the switcher's
 * untargeted entries).
 *
 * Pure so the precedence is testable without mounting the window — see
 * `__tests__/defaultOrg.test.ts`.
 */

export interface OrgChoice {
  orgId: string;
  name: string;
  role?: string;
  membershipType?: string;
}

/** Only accepted memberships can be administered; invites resolve nothing. */
export function isActiveMembership(membershipType?: string): boolean {
  return !membershipType || membershipType === 'active_member';
}

/** Active memberships only, in the order the server returned them. */
export function activeOrganizations(organizations: OrgChoice[]): OrgChoice[] {
  return organizations.filter((organization) => isActiveMembership(organization.membershipType));
}

/**
 * Resolve the org to open: the last selected one when the user is still an
 * active member of it, otherwise the first active org, otherwise null (which
 * keeps the unbound create/accept surface).
 */
export function resolveDefaultOrgId(
  lastSelectedOrgId: string | null | undefined,
  organizations: OrgChoice[],
): string | null {
  const active = activeOrganizations(organizations);
  if (lastSelectedOrgId && active.some((organization) => organization.orgId === lastSelectedOrgId)) {
    return lastSelectedOrgId;
  }
  return active[0]?.orgId ?? null;
}

/** app-settings key holding the org an untargeted open falls back to. */
export const LAST_SELECTED_ORG_SETTING_KEY = 'lastSelectedOrgId';

export async function readLastSelectedOrgId(): Promise<string | null> {
  try {
    const stored = await window.electronAPI?.invoke?.('app-settings:get', LAST_SELECTED_ORG_SETTING_KEY);
    return typeof stored === 'string' && stored ? stored : null;
  } catch {
    // A missing/unreadable setting just means "no last selection".
    return null;
  }
}

export async function persistLastSelectedOrgId(orgId: string): Promise<void> {
  try {
    await window.electronAPI?.invoke?.('app-settings:set', LAST_SELECTED_ORG_SETTING_KEY, orgId);
  } catch {
    // Best effort: failing to remember the selection must not block the window.
  }
}
