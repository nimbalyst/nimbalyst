/**
 * Account -> organizations grouping for the Account settings screen.
 *
 * `team:list` fans out one `GET /api/teams` per signed-in account and merges the
 * results by `orgId`, so a single directory entry can be reachable from several
 * logins. The accounts section renders orgs inline under the login they belong
 * to, which needs the inverse view: one bucket per account, each org appearing
 * exactly once under the account whose JWT actually authorizes it.
 *
 * Kept as a pure function (no atoms, no IPC) so the attribution rules are
 * directly testable — see `__tests__/accountOrganizations.test.ts`.
 */

import type {
  OrganizationDirectoryEntry,
  PersonalAccountSummary,
} from '../../../store/atoms/settingsDomains';

export interface AccountOrganizationEntry {
  orgId: string;
  name: string;
  /** owner / admin / member / guest, as reported by the server. */
  role: string;
  /** True while the membership is an unaccepted invite. */
  isPending: boolean;
  /** Number of projects in the org; undefined when the server did not send a registry. */
  projectCount?: number;
  /** Emails of the other signed-in logins that also reach this org (merged bindings). */
  alsoReachableBy: string[];
}

export interface AccountOrganizationGroup {
  personalOrgId: string;
  email: string | null;
  organizations: AccountOrganizationEntry[];
}

/** A membership is active unless the server tags it as pending/invited. */
export function isPendingMembership(membershipType?: string): boolean {
  return !!membershipType && membershipType !== 'active_member';
}

/**
 * Resolve the single account an org should render under. Preference order:
 * the explicit local binding (the account `getOrgScopedJwt` will use), then the
 * account that discovered the membership, then an email match, then any merged
 * binding. Returns null when no signed-in account can claim the org — that org
 * has no usable team JWT, so it is deliberately not shown under a login.
 */
function resolveOwningAccountId(
  organization: OrganizationDirectoryEntry,
  accountsById: Map<string, PersonalAccountSummary>,
  accountIdsByEmail: Map<string, string>,
): string | null {
  const candidates = [
    organization.boundPersonalOrgId ?? undefined,
    organization.owningPersonalOrgId ?? undefined,
    organization.sourcePersonalOrgId,
  ];
  for (const candidate of candidates) {
    if (candidate && accountsById.has(candidate)) return candidate;
  }

  const byEmail = organization.sourceEmail
    ? accountIdsByEmail.get(organization.sourceEmail.toLowerCase())
    : undefined;
  if (byEmail) return byEmail;

  for (const binding of organization.accountBindings ?? []) {
    if (accountsById.has(binding.personalOrgId)) return binding.personalOrgId;
  }

  return null;
}

/**
 * Bucket the organization directory under the signed-in accounts. Groups are
 * returned in the order the accounts were given, and every account gets a group
 * (possibly empty) so the caller can render a per-account empty state.
 */
export function groupOrganizationsByAccount(
  accounts: PersonalAccountSummary[],
  organizations: OrganizationDirectoryEntry[],
): AccountOrganizationGroup[] {
  const accountsById = new Map(accounts.map((account) => [account.personalOrgId, account]));
  const accountIdsByEmail = new Map(
    accounts
      .filter((account) => !!account.email)
      .map((account) => [account.email!.toLowerCase(), account.personalOrgId]),
  );

  const groups = new Map<string, AccountOrganizationGroup>(
    accounts.map((account) => [
      account.personalOrgId,
      { personalOrgId: account.personalOrgId, email: account.email, organizations: [] },
    ]),
  );

  const claimed = new Set<string>();
  for (const organization of organizations) {
    // team:list merges by orgId, but a stale/duplicated snapshot must never
    // produce two rows for the same org.
    if (claimed.has(organization.orgId)) continue;
    const ownerId = resolveOwningAccountId(organization, accountsById, accountIdsByEmail);
    if (!ownerId) continue;
    claimed.add(organization.orgId);

    const alsoReachableBy = (organization.accountBindings ?? [])
      .map((binding) => binding.personalOrgId)
      .filter((personalOrgId) => personalOrgId !== ownerId)
      .map((personalOrgId) => accountsById.get(personalOrgId)?.email ?? null)
      .filter((email): email is string => !!email);

    groups.get(ownerId)!.organizations.push({
      orgId: organization.orgId,
      name: organization.name,
      role: organization.role,
      isPending: isPendingMembership(organization.membershipType),
      projectCount: organization.projects?.length,
      alsoReachableBy,
    });
  }

  return accounts.map((account) => groups.get(account.personalOrgId)!);
}
