import { describe, expect, it } from 'vitest';

import { activeOrganizations, resolveDefaultOrgId, type OrgChoice } from '../defaultOrg';

const orgs: OrgChoice[] = [
  { orgId: 'org-first', name: 'First', role: 'owner' },
  { orgId: 'org-second', name: 'Second', role: 'admin', membershipType: 'active_member' },
  { orgId: 'org-invited', name: 'Invited', role: 'member', membershipType: 'invited_member' },
];

describe('resolveDefaultOrgId', () => {
  it('opens the last selected organization when it is still an active membership', () => {
    expect(resolveDefaultOrgId('org-second', orgs)).toBe('org-second');
  });

  it('falls back to the first active organization when the last selected one is gone', () => {
    expect(resolveDefaultOrgId('org-left-last-week', orgs)).toBe('org-first');
  });

  it('ignores a last selection that is only a pending invite', () => {
    expect(resolveDefaultOrgId('org-invited', orgs)).toBe('org-first');
  });

  it('uses the first active organization when nothing was persisted', () => {
    expect(resolveDefaultOrgId(null, orgs)).toBe('org-first');
    expect(resolveDefaultOrgId(undefined, orgs)).toBe('org-first');
  });

  it('resolves nothing when there is no active membership, keeping the unbound surface', () => {
    expect(resolveDefaultOrgId('org-second', [])).toBeNull();
    expect(resolveDefaultOrgId(null, [{ orgId: 'org-invited', name: 'Invited', membershipType: 'invited_member' }]))
      .toBeNull();
  });
});

describe('activeOrganizations', () => {
  it('keeps active and untagged memberships and drops invites', () => {
    expect(activeOrganizations(orgs).map((organization) => organization.orgId))
      .toEqual(['org-first', 'org-second']);
  });
});
