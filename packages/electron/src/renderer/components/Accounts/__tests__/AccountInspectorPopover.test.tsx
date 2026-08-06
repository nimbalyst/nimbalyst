// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountInspectorPopover } from '../AccountInspectorPopover';

function anchor(): HTMLElement {
  const el = document.createElement('button');
  document.body.appendChild(el);
  return el;
}

describe('AccountInspectorPopover', () => {
  afterEach(() => cleanup());

  it('shows one Account row (email → account screen) and one Organization row (project org → org screen)', () => {
    const onOpenAccount = vi.fn();
    const onManageOrganization = vi.fn();
    render(
      <AccountInspectorPopover
        accounts={[
          { personalOrgId: 'sync', personalUserId: 'u1', email: 'me@example.com', isSyncAccount: true, sessionStatus: 'active' },
          { personalOrgId: 'other', personalUserId: 'u2', email: 'other@example.com', isSyncAccount: false, sessionStatus: 'active' },
        ]}
        projectOrg={{ orgId: 'org-work', name: 'Work Team' }}
        anchorEl={anchor()}
        onClose={vi.fn()}
        onOpenAccount={onOpenAccount}
        onManageOrganization={onManageOrganization}
        onOpenApplicationSettings={vi.fn()}
        onOpenProjectSettings={vi.fn()}
      />,
    );

    // The active (sync) account's email appears, not a list of every account/project.
    screen.getByText('me@example.com');
    expect(screen.queryByText('other@example.com')).toBeNull();
    screen.getByText('Work Team');

    fireEvent.click(screen.getByTestId('account-inspector-account-row'));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('account-inspector-organization-row'));
    expect(onManageOrganization).toHaveBeenCalledWith('org-work');
  });

  it('links to Application and Project settings', () => {
    const onOpenApplicationSettings = vi.fn();
    const onOpenProjectSettings = vi.fn();
    render(
      <AccountInspectorPopover
        accounts={[]}
        projectOrg={null}
        anchorEl={anchor()}
        onClose={vi.fn()}
        onOpenAccount={vi.fn()}
        onManageOrganization={vi.fn()}
        onOpenApplicationSettings={onOpenApplicationSettings}
        onOpenProjectSettings={onOpenProjectSettings}
      />,
    );

    fireEvent.click(screen.getByTestId('account-inspector-application-settings-row'));
    expect(onOpenApplicationSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('account-inspector-project-settings-row'));
    expect(onOpenProjectSettings).toHaveBeenCalledTimes(1);
  });

  it('invites sign-in when signed out and offers org setup when the project has none', () => {
    const onManageOrganization = vi.fn();
    render(
      <AccountInspectorPopover
        accounts={[]}
        projectOrg={null}
        anchorEl={anchor()}
        onClose={vi.fn()}
        onOpenAccount={vi.fn()}
        onManageOrganization={onManageOrganization}
        onOpenApplicationSettings={vi.fn()}
        onOpenProjectSettings={vi.fn()}
      />,
    );

    screen.getByText('Sign in');
    screen.getByText('No organization');

    // With no project org, the org row opens the window with no target (create flow).
    fireEvent.click(screen.getByTestId('account-inspector-organization-row'));
    expect(onManageOrganization).toHaveBeenCalledWith(undefined);
  });

  // An unresolved lookup used to render as "No organization -- Set up", which
  // offered org creation to a user who had just finished it.
  it('does not offer org setup while the organization lookup is still running', () => {
    render(
      <AccountInspectorPopover
        accounts={[]}
        projectOrg={null}
        projectOrgLoading
        anchorEl={anchor()}
        onClose={vi.fn()}
        onOpenAccount={vi.fn()}
        onManageOrganization={vi.fn()}
        onOpenApplicationSettings={vi.fn()}
        onOpenProjectSettings={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('account-inspector-organization-row')).toBeNull();
    screen.getByTestId('account-inspector-organization-loading');
  });
});
