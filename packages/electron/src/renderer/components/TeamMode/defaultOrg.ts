/**
 * Which organization the org-management window lands on when it is opened
 * without an explicit `orgId` (Window > Organization Messages, the switcher's
 * untargeted entries).
 *
 * Pure so the precedence is testable without mounting the window — see
 * `__tests__/defaultOrg.test.ts`.
 */

import { LAST_SELECTED_ORG_SETTING_KEY } from '../../../shared/orgProjectWalk';

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

/**
 * The org an untargeted open should land on, given a queued onboarding
 * destination (the creation wizard and the invite-accept buttons leave one
 * behind) and the remembered selection.
 *
 * The queued destination wins — silently choosing the first visible org would
 * route a new member into the wrong tenant — but only while it is openable, or
 * while the directory cannot say. A destination the directory positively lists
 * without an active membership is dropped: the hand-off is consumed only once
 * its room hydrates, which never happens for a non-member, so honouring it
 * strands the window on the unbound surface for good. The record itself is left
 * in place, so it still replays if the membership activates later.
 */
export function resolveOrgWindowTargetId(
  pendingOrgId: string | null | undefined,
  lastSelectedOrgId: string | null | undefined,
  organizations: OrgChoice[],
  complete = true,
): string | null {
  const active = activeOrganizations(organizations);
  if (pendingOrgId) {
    const directorySilent = active.length === 0;
    if (!complete || directorySilent || active.some((organization) => organization.orgId === pendingOrgId)) {
      return pendingOrgId;
    }
  }
  if (!complete && lastSelectedOrgId) return lastSelectedOrgId;
  return resolveDefaultOrgId(lastSelectedOrgId, organizations);
}

/**
 * app-settings key holding the org an untargeted open falls back to. Main
 * clears it on sign-out, so the key itself is declared in the shared module.
 */
export { LAST_SELECTED_ORG_SETTING_KEY };

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
