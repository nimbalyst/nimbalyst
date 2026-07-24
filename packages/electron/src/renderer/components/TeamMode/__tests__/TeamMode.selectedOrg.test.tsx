// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import { TeamMode } from '../TeamMode';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));
vi.mock('../../Settings/panels/OrganizationMembersRolesPanel', () => ({
  OrganizationMembersRolesPanel: ({ orgId, readOnlyRoles }: { orgId?: string; readOnlyRoles?: boolean }) => (
    <div data-testid={readOnlyRoles ? 'readonly-members' : 'admin-members'} data-org-id={orgId} />
  ),
}));
vi.mock('../../Settings/panels/OrganizationProjectsPanel', () => ({ OrganizationProjectsPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationSecurityPanel', () => ({ OrganizationSecurityPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationBillingPanel', () => ({ OrganizationBillingPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationDangerZone', () => ({ OrganizationDangerZone: () => <div /> }));
vi.mock('../../Settings/panels/ProjectSharingPanel', () => ({ ProjectSharingPanel: () => <div /> }));

const workspaceTeam = {
  orgId: 'org-workspace',
  name: 'Workspace Org',
  boundPersonalOrgId: 'account-workspace',
};
const otherTeam = {
  orgId: 'org-other',
  name: 'Other Org',
  boundPersonalOrgId: 'account-other',
  membershipType: 'active_member',
};

function installApi() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      team: { findForWorkspace: vi.fn().mockResolvedValue({ success: true, team: workspaceTeam }) },
      organization: { list: vi.fn().mockResolvedValue({ success: true, teams: [workspaceTeam, otherTeam] }) },
      stytch: {
        getAccounts: vi.fn().mockResolvedValue([
          { personalOrgId: 'account-workspace', email: 'workspace@example.com' },
          { personalOrgId: 'account-other', email: 'other@example.com' },
        ]),
      },
      openExternal: vi.fn(),
    },
  });
}

describe('TeamMode organization targeting', () => {
  afterEach(() => cleanup());

  // A targeted open of an org you have since left (or one that vanished on a
  // refetch) must not strand the user on the unbound "create an organization"
  // surface with no way back to the orgs they do belong to.
  it('recovers onto an active organization when the selected one is stale', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-i-left');
    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Workspace Org' })).toBeTruthy());
    expect(store.get(selectedOrgIdAtom)).toBe('org-workspace');
  });

  it('keeps the target when the directory comes back empty rather than clearing it', async () => {
    installApi();
    (window as any).electronAPI.organization.list = vi.fn().mockResolvedValue({ success: false });
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-other');
    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(screen.getByText(/Create an organization to collaborate/)).toBeTruthy());
    expect(store.get(selectedOrgIdAtom)).toBe('org-other');
  });

  it('offers the switcher on the unbound surface when active organizations exist', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, null);
    // No workspace and no selection: the unbound surface, but the user is in orgs.
    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(screen.getByTestId('org-window-switcher')).toBeTruthy());
  });

  it('administers the explicitly selected non-workspace organization', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-other');
    render(<Provider store={store}><TeamMode workspacePath="/workspace" isActive /></Provider>);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Other Org' })).toBeTruthy());
    // Members is the full editable roster (no read-only duplicate), scoped to the org.
    expect(screen.getByTestId('admin-members').getAttribute('data-org-id')).toBe('org-other');
    // Single left-nav org-admin layout: Members, Projects, Billing, Danger.
    expect(screen.getByTestId('team-tab-members')).toBeTruthy();
    expect(screen.getByTestId('team-tab-projects')).toBeTruthy();
    expect(screen.getByTestId('team-tab-billing')).toBeTruthy();
    expect(screen.getByTestId('team-tab-danger')).toBeTruthy();
  });

  it('falls back to the workspace-bound organization when no organization is selected', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, null);
    render(<Provider store={store}><TeamMode workspacePath="/workspace" isActive /></Provider>);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Workspace Org' })).toBeTruthy());
    expect(screen.getByTestId('admin-members').getAttribute('data-org-id')).toBe('org-workspace');
  });

  it('renders org-only (no workspace) without a redundant project-sharing tab or a workspace lookup', async () => {
    installApi();
    const findForWorkspace = (window as any).electronAPI.team.findForWorkspace;
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-other');
    // No workspacePath: the standalone org-management window targets the org only.
    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Other Org' })).toBeTruthy());
    expect(screen.getByTestId('admin-members').getAttribute('data-org-id')).toBe('org-other');
    // No workspace-scoped "Project sharing" tab; org projects live under Projects.
    expect(screen.queryByRole('button', { name: /project sharing/i })).toBeNull();
    expect(screen.getByTestId('team-tab-projects')).toBeTruthy();
    expect(findForWorkspace).not.toHaveBeenCalled();
  });
});

