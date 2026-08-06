/**
 * The last route the invite-accept / creation-wizard hand-off applied.
 *
 * The org window resets a conversation route to the Inbox when its organization
 * changes, which includes the window's first mount. That reset and the
 * asynchronous hand-off (`useOrgWindowPendingRoute`, which reads app-settings)
 * race: when the hand-off lands first, the reset would clobber it and send a
 * brand-new member to the Inbox instead of `#general`.
 *
 * Recording the applied route makes the two orders converge. The reset consults
 * this marker and leaves the route alone only when the window is *currently*
 * pointed exactly where the hand-off put it, for the same organization — so a
 * stale marker cannot suppress a later, genuine org-switch reset.
 */

import type { OrgWindowRoute } from '../orgWindowState';

let handoff: { orgId: string; route: OrgWindowRoute } | null = null;

export function recordOrgWindowPendingHandoff(
  orgId: string,
  route: OrgWindowRoute,
): void {
  handoff = { orgId, route };
}

export function isOrgWindowPendingHandoffRoute(
  orgId: string,
  route: OrgWindowRoute,
): boolean {
  return (
    !!handoff
    && handoff.orgId === orgId
    && handoff.route.view === route.view
    && handoff.route.conversationId === route.conversationId
    && handoff.route.adminTab === route.adminTab
  );
}

export function clearOrgWindowPendingHandoff(
  orgId: string,
  route: OrgWindowRoute,
): void {
  if (isOrgWindowPendingHandoffRoute(orgId, route)) handoff = null;
}

/** Test seam: the marker is module state, and each test starts from nothing. */
export function resetOrgWindowPendingHandoff(): void {
  handoff = null;
}
