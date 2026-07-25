import { describe, expect, it } from 'vitest';

import { selectProjectSharingEntry } from '../projectSharingEntry';

const remote = 'git@example.com:acme/app.git';
const orgs = [{ orgId: 'org-1', name: 'Acme' }];

describe('selectProjectSharingEntry', () => {
  it('offers both choices when the user administers at least one organization', () => {
    expect(selectProjectSharingEntry({ gitRemote: remote, adminOrgs: orgs })).toEqual({
      state: 'choose-existing-or-new',
      needsGitRemote: false,
    });
  });

  it('starts at create when there is no organization to join yet', () => {
    expect(selectProjectSharingEntry({ gitRemote: remote, adminOrgs: [] })).toEqual({
      state: 'create-first-organization',
      needsGitRemote: false,
    });
  });

  it('surfaces a pending invite ahead of every other choice', () => {
    const invite = { orgId: 'org-invite', name: 'Invited Org', membershipType: 'invited_member' };

    expect(selectProjectSharingEntry({ gitRemote: remote, adminOrgs: orgs, pendingInvite: invite })).toEqual({
      state: 'invite-pending',
      needsGitRemote: false,
      invite,
    });
  });

  it('flags a missing git remote without hiding the options', () => {
    expect(selectProjectSharingEntry({ gitRemote: '', adminOrgs: orgs })).toEqual({
      state: 'choose-existing-or-new',
      needsGitRemote: true,
    });
    expect(selectProjectSharingEntry({ adminOrgs: [] })).toEqual({
      state: 'create-first-organization',
      needsGitRemote: true,
    });
  });

  it('still surfaces an invite when the workspace has no git remote', () => {
    const invite = { orgId: 'org-invite', name: 'Invited Org' };

    expect(selectProjectSharingEntry({ pendingInvite: invite })).toEqual({
      state: 'invite-pending',
      needsGitRemote: true,
      invite,
    });
  });
});
