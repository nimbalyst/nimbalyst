import { useEffect, useMemo, useState } from 'react';

export interface OrgRosterMember {
  memberId: string;
  email: string;
  name: string;
  role: string;
  status?: string;
}

export interface OrgRoster {
  members: OrgRosterMember[];
  /** The signed-in user's member id in this organization, once resolved. */
  viewerUserId: string | null;
  memberNames: Record<string, string>;
  /**
   * The caller's role **in this organization**, or null while it is unresolved.
   *
   * Null is load-bearing: a role is per-organization (Stytch B2B issues a
   * different member id and role per org), so defaulting it would render one
   * org's permissions against another — an admin's Billing and Danger zone
   * shown to a plain member of the org they just switched to. Callers gate
   * admin-only surfaces on a resolved role rather than on a default.
   */
  callerRole: string | null;
  loading: boolean;
}

const EMPTY_ROSTER: OrgRoster = {
  members: [],
  viewerUserId: null,
  memberNames: {},
  callerRole: null,
  loading: true,
};

/**
 * Which roster row is the signed-in user.
 *
 * Stytch B2B issues a different member id per organization, so the personal
 * account id cannot be compared against the roster. Email is the only stable
 * join between the signed-in accounts and an organization's members — the same
 * join the shared-documents home uses.
 *
 * When two signed-in accounts are both on the roster, matching any of them
 * makes the viewer whichever row the server happened to list first, so a DM
 * would title itself after the viewer instead of the other participant
 * (NIM-2459). `preferredEmail` is the sync account, the same tie-break the
 * main process applies when it resolves the org's acting member id.
 */
export function resolveViewerMemberId(
  members: readonly OrgRosterMember[],
  accountEmails: readonly (string | null | undefined)[],
  preferredEmail?: string | null,
): string | null {
  const emails = new Set(
    accountEmails
      .filter((email): email is string => !!email)
      .map((email) => email.toLowerCase()),
  );
  if (emails.size === 0) return null;
  const preferred = preferredEmail?.toLowerCase();
  const preferredMember = preferred && emails.has(preferred)
    ? members.find((member) => member.email?.toLowerCase() === preferred)
    : undefined;
  return (
    preferredMember
      ?? members.find((member) => emails.has(member.email?.toLowerCase() ?? ''))
  )?.memberId ?? null;
}

export function memberNamesById(
  members: readonly OrgRosterMember[],
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const member of members) {
    names[member.memberId] = member.name?.trim() || member.email || member.memberId;
  }
  return names;
}

/**
 * The organization's roster plus the viewer's identity inside it.
 *
 * Conversations attribute messages to team member ids, so every messaging
 * surface needs both — a room cannot render "you" or post without them. The
 * organization's administration surfaces need the role for the same reason
 * they always did, which is why this lives here rather than under `TeamMode`:
 * it reads nothing but `organization:*` / `stytch:*` IPC, so it resolves the
 * same way in the project window as it does in the organization window.
 */
export function useOrgRoster(orgId: string | null | undefined): OrgRoster {
  const [state, setState] = useState<OrgRoster>(EMPTY_ROSTER);

  useEffect(() => {
    if (!orgId) {
      setState({ ...EMPTY_ROSTER, loading: false });
      return;
    }
    let cancelled = false;
    // A different organization means a different member id and a different
    // role, so nothing from the previous one may survive the switch — carrying
    // it over renders org A's permissions and identity against org B.
    setState(EMPTY_ROSTER);
    void Promise.all([
      window.electronAPI?.organization?.listMembers?.(orgId),
      window.electronAPI?.stytch?.getAccounts?.(),
      window.electronAPI?.stytch?.getSyncAccount?.(),
    ]).then(([roster, accounts, syncAccount]) => {
      if (cancelled) return;
      const members: OrgRosterMember[] = roster?.success && Array.isArray(roster.members)
        ? roster.members
        : [];
      const accountRows = Array.isArray(accounts) ? accounts : [];
      setState({
        members,
        viewerUserId: resolveViewerMemberId(
          members,
          accountRows.map((account: { email?: string | null }) => account.email),
          syncAccount?.email,
        ),
        memberNames: memberNamesById(members),
        callerRole: roster?.callerRole ?? 'member',
        loading: false,
      });
    }).catch(() => {
      // A transient roster failure is not evidence that the caller is a plain
      // member: whatever this organization already resolved stays, and a role
      // that never resolved stays null rather than becoming a demotion that
      // bounces an admin off their own panels.
      if (!cancelled) setState((current) => ({ ...current, loading: false }));
    });
    return () => { cancelled = true; };
  }, [orgId]);

  return useMemo(() => state, [state]);
}
