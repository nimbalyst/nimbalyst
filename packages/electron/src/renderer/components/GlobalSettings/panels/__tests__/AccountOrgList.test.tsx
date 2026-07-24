// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

import { AccountOrgList } from '../AccountOrgList';
import type { AccountOrganizationGroup } from '../accountOrganizations';

const openManagementWindow = vi.fn();
const acceptInvite = vi.fn();

function group(overrides: Partial<AccountOrganizationGroup> = {}): AccountOrganizationGroup {
  return {
    personalOrgId: 'personal-a',
    email: 'a@example.com',
    organizations: [],
    ...overrides,
  };
}

describe('AccountOrgList', () => {
  beforeEach(() => {
    openManagementWindow.mockReset().mockResolvedValue({ success: true });
    acceptInvite.mockReset().mockResolvedValue({ success: true });
    (window as any).electronAPI = { team: { openManagementWindow, acceptInvite } };
  });

  afterEach(() => cleanup());

  it('opens the org management window targeted at the clicked organization', () => {
    render(
      <AccountOrgList
        group={group({
          organizations: [
            { orgId: 'org-1', name: 'Acme', role: 'owner', isPending: false, projectCount: 3, alsoReachableBy: [] },
          ],
        })}
      />,
    );

    expect(screen.getByText('3 projects')).toBeTruthy();
    screen.getByTestId('account-org-manage').click();
    expect(openManagementWindow).toHaveBeenCalledWith({ orgId: 'org-1' });
  });

  it('accepts a pending invite in place and announces the directory change', async () => {
    const changed = vi.fn();
    window.addEventListener('nimbalyst:organizations-changed', changed);

    render(
      <AccountOrgList
        group={group({
          organizations: [
            { orgId: 'org-invite', name: 'Invited Org', role: 'member', isPending: true, alsoReachableBy: [] },
          ],
        })}
      />,
    );

    expect(screen.getByTestId('account-org-pending-badge')).toBeTruthy();
    // The org window resolves its target against active memberships only, so a
    // Manage button on a pending row would land on the generic unbound surface.
    expect(screen.queryByTestId('account-org-manage')).toBeNull();
    screen.getByTestId('account-org-accept-invite').click();

    await waitFor(() => expect(acceptInvite).toHaveBeenCalledWith('org-invite'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    window.removeEventListener('nimbalyst:organizations-changed', changed);
  });

  it('offers a per-account empty state that creates a new organization', () => {
    render(<AccountOrgList group={group()} />);

    expect(screen.getByTestId('account-org-empty').textContent).toContain('No organizations');
    screen.getByTestId('account-org-new').click();
    expect(openManagementWindow).toHaveBeenCalledWith(undefined);
  });

  it('credits the other signed-in login for a merged organization', () => {
    render(
      <AccountOrgList
        group={group({
          organizations: [
            { orgId: 'org-shared', name: 'Shared', role: 'admin', isPending: false, projectCount: 1, alsoReachableBy: ['b@example.com'] },
          ],
        })}
      />,
    );

    expect(screen.getAllByTestId('account-org-row')).toHaveLength(1);
    expect(screen.getByText(/also signed in as b@example.com/)).toBeTruthy();
  });
});
