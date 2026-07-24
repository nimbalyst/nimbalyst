import { describe, expect, it } from 'vitest';

import { groupOrganizationsByAccount } from '../accountOrganizations';
import type {
  OrganizationDirectoryEntry,
  PersonalAccountSummary,
} from '../../../../store/atoms/settingsDomains';

function account(
  personalOrgId: string,
  email: string | null,
  overrides: Partial<PersonalAccountSummary> = {},
): PersonalAccountSummary {
  return {
    personalOrgId,
    personalUserId: `${personalOrgId}-user`,
    email,
    isSyncAccount: false,
    sessionStatus: 'active',
    ...overrides,
  };
}

function organization(
  orgId: string,
  overrides: Partial<OrganizationDirectoryEntry> = {},
): OrganizationDirectoryEntry {
  return {
    orgId,
    name: `${orgId} org`,
    role: 'member',
    ...overrides,
  };
}

describe('groupOrganizationsByAccount', () => {
  it('buckets each organization under the login that discovered it', () => {
    const accounts = [account('personal-a', 'a@example.com'), account('personal-b', 'b@example.com')];
    const organizations = [
      organization('org-1', { sourcePersonalOrgId: 'personal-a', role: 'owner' }),
      organization('org-2', { sourcePersonalOrgId: 'personal-b', role: 'admin' }),
    ];

    const groups = groupOrganizationsByAccount(accounts, organizations);

    expect(groups.map((group) => group.personalOrgId)).toEqual(['personal-a', 'personal-b']);
    expect(groups[0].organizations.map((org) => org.orgId)).toEqual(['org-1']);
    expect(groups[1].organizations.map((org) => org.orgId)).toEqual(['org-2']);
  });

  it('gives every account a group, including logins with no organizations', () => {
    const accounts = [account('personal-a', 'a@example.com'), account('personal-b', 'b@example.com')];

    const groups = groupOrganizationsByAccount(accounts, [
      organization('org-1', { sourcePersonalOrgId: 'personal-a' }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[1]).toEqual({
      personalOrgId: 'personal-b',
      email: 'b@example.com',
      organizations: [],
    });
  });

  it('shows a merged organization once, under the bound account, crediting the other login', () => {
    const accounts = [account('personal-a', 'a@example.com'), account('personal-b', 'b@example.com')];
    const merged = organization('org-shared', {
      sourcePersonalOrgId: 'personal-a',
      boundPersonalOrgId: 'personal-b',
      accountBindings: [
        { personalOrgId: 'personal-a', teamMemberId: 'member-a' },
        { personalOrgId: 'personal-b', teamMemberId: 'member-b' },
      ],
    });

    const groups = groupOrganizationsByAccount(accounts, [merged]);

    expect(groups[0].organizations).toEqual([]);
    expect(groups[1].organizations).toHaveLength(1);
    expect(groups[1].organizations[0].alsoReachableBy).toEqual(['a@example.com']);
  });

  it('does not duplicate an organization that appears twice in the directory', () => {
    const accounts = [account('personal-a', 'a@example.com'), account('personal-b', 'b@example.com')];
    const groups = groupOrganizationsByAccount(accounts, [
      organization('org-1', { sourcePersonalOrgId: 'personal-a' }),
      organization('org-1', { sourcePersonalOrgId: 'personal-b' }),
    ]);

    expect(groups[0].organizations.map((org) => org.orgId)).toEqual(['org-1']);
    expect(groups[1].organizations).toEqual([]);
  });

  it('flags pending invites and leaves active memberships alone', () => {
    const accounts = [account('personal-a', 'a@example.com')];
    const groups = groupOrganizationsByAccount(accounts, [
      organization('org-invited', {
        sourcePersonalOrgId: 'personal-a',
        membershipType: 'invited_member',
      }),
      organization('org-pending', {
        sourcePersonalOrgId: 'personal-a',
        membershipType: 'pending_member',
      }),
      organization('org-active', {
        sourcePersonalOrgId: 'personal-a',
        membershipType: 'active_member',
      }),
      organization('org-unknown-membership', { sourcePersonalOrgId: 'personal-a' }),
    ]);

    expect(groups[0].organizations.map((org) => [org.orgId, org.isPending])).toEqual([
      ['org-invited', true],
      ['org-pending', true],
      ['org-active', false],
      ['org-unknown-membership', false],
    ]);
  });

  it('reports the project count only when the server sent a project registry', () => {
    const accounts = [account('personal-a', 'a@example.com')];
    const groups = groupOrganizationsByAccount(accounts, [
      organization('org-with-projects', {
        sourcePersonalOrgId: 'personal-a',
        projects: [
          { projectId: 'p1', name: 'One', slug: 'one' },
          { projectId: 'p2', name: 'Two', slug: 'two' },
        ],
      }),
      organization('org-without-registry', { sourcePersonalOrgId: 'personal-a' }),
    ]);

    expect(groups[0].organizations[0].projectCount).toBe(2);
    expect(groups[0].organizations[1].projectCount).toBeUndefined();
  });

  it('falls back to the source email when the source account id is unknown', () => {
    const accounts = [account('personal-a', 'A@Example.com')];
    const groups = groupOrganizationsByAccount(accounts, [
      organization('org-1', { sourcePersonalOrgId: 'stale-personal-org', sourceEmail: 'a@example.com' }),
    ]);

    expect(groups[0].organizations.map((org) => org.orgId)).toEqual(['org-1']);
  });

  it('omits organizations that no signed-in account can claim', () => {
    const accounts = [account('personal-a', 'a@example.com')];
    const groups = groupOrganizationsByAccount(accounts, [
      organization('org-orphan', { sourcePersonalOrgId: 'signed-out-account', sourceEmail: 'gone@example.com' }),
    ]);

    expect(groups[0].organizations).toEqual([]);
  });
});
