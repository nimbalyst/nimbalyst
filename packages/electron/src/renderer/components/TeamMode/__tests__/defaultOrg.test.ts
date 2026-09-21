// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  activeOrganizations,
  resolveDefaultOrgId,
  resolveOrgWindowTargetId,
  type OrgChoice,
} from '../defaultOrg';

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

describe('resolveOrgWindowTargetId', () => {
  it('does not switch away from the remembered organization on partial discovery', () => {
    expect(resolveOrgWindowTargetId(null, 'org-unavailable', orgs, false)).toBe('org-unavailable');
    expect(resolveOrgWindowTargetId(null, 'org-unavailable', orgs, true)).toBe('org-first');
  });
  it('opens the queued destination when it is an active membership', () => {
    expect(resolveOrgWindowTargetId('org-second', 'org-first', orgs)).toBe('org-second');
  });

  it('keeps the queued destination while the directory cannot say', () => {
    // A failed or not-yet-hydrated team:list must not route a new member into
    // whichever tenant happens to be remembered.
    expect(resolveOrgWindowTargetId('org-just-joined', 'org-first', [])).toBe('org-just-joined');
  });

  it('drops a queued destination the directory lists without an active membership', () => {
    // The hand-off is only consumed once its room hydrates, which never happens
    // for a non-member, so honouring it would strand the window on the unbound
    // surface for good.
    expect(resolveOrgWindowTargetId('org-invited', 'org-second', orgs)).toBe('org-second');
  });

  it('drops a queued destination the directory does not know at all', () => {
    expect(resolveOrgWindowTargetId('org-i-left', null, orgs)).toBe('org-first');
  });

  it('resolves the remembered organization when nothing is queued', () => {
    expect(resolveOrgWindowTargetId(null, 'org-second', orgs)).toBe('org-second');
  });
});

describe('activeOrganizations', () => {
  it('keeps active and untagged memberships and drops invites', () => {
    expect(activeOrganizations(orgs).map((organization) => organization.orgId))
      .toEqual(['org-first', 'org-second']);
  });
});
