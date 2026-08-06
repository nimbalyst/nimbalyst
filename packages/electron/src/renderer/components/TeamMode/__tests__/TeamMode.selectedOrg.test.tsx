// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import { organizationDirectoryAtom } from '../../../store/atoms/settingsDomains';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
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
  role: 'member',
};

function installApi() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      team: {
        findForWorkspace: vi.fn().mockResolvedValue({ success: true, team: workspaceTeam }),
        resolveOrgProjectsLocalState: vi.fn().mockResolvedValue({
          success: true,
          projects: [],
        }),
        openProjectWorkspace: vi.fn().mockResolvedValue({ success: true }),
      },
      organization: {
        list: vi.fn().mockResolvedValue({ success: true, teams: [workspaceTeam, otherTeam] }),
        listMembers: vi.fn().mockResolvedValue({ success: true, members: [], callerRole: 'owner' }),
      },
      invoke: vi.fn().mockResolvedValue([]),
      on: vi.fn().mockReturnValue(() => {}),
      stytch: {
        getAccounts: vi.fn().mockResolvedValue([
          { personalOrgId: 'account-workspace', email: 'workspace@example.com' },
          { personalOrgId: 'account-other', email: 'other@example.com' },
        ]),
      },
      openExternal: vi.fn(),
      openAccountSettings: vi.fn().mockResolvedValue({ success: true }),
    },
  });
}

// The org identity is the static sidebar header now; switching moved to the
// org rail / unbound choice list.
function orgIdentity(): string {
  return screen.getByTestId('org-sidebar-header').textContent ?? '';
}

describe('TeamMode organization targeting', () => {
  afterEach(() => cleanup());

  it('preserves an explicit destination instead of falling back to the first organization', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-i-left');
    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => screen.getByTestId('team-mode-organization-recovery'));
    expect(store.get(selectedOrgIdAtom)).toBe('org-i-left');
    expect(screen.getAllByTestId('team-mode-organization-choice')).toHaveLength(2);
  });

  it('recovers the preserved target when central account/org hydration arrives later', async () => {
    installApi();
    (window as any).electronAPI.organization.list = vi.fn().mockResolvedValue({
      success: true,
      teams: [],
    });
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-other');
    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => screen.getByTestId('team-mode-organization-recovery'));
    expect(store.get(selectedOrgIdAtom)).toBe('org-other');

    store.set(organizationDirectoryAtom, [otherTeam]);

    await waitFor(() => expect(orgIdentity()).toContain('Other Org'));
  });

  it('offers organization choices on the unbound surface when active organizations exist', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, null);
    // No workspace and no selection: the unbound surface, but the user is in orgs.
    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => screen.getByTestId('team-mode-organization-choices'));
    expect(screen.getAllByTestId('team-mode-organization-choice')).toHaveLength(2);
  });

  it('targets the explicitly selected non-workspace organization', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-other');
    const { container } = render(
      <Provider store={store}><TeamMode workspacePath="/workspace" isActive /></Provider>,
    );

    await waitFor(() => expect(orgIdentity()).toContain('Other Org'));
    const controlsInsideDragRegions = container.querySelectorAll(
      '[data-window-drag-region] button, '
      + '[data-window-drag-region] input, '
      + '[data-window-drag-region] select, '
      + '[data-window-drag-region] textarea, '
      + '[data-window-drag-region] a[href]',
    );
    expect(controlsInsideDragRegions.length).toBeGreaterThan(0);
    for (const control of controlsInsideDragRegions) {
      expect(control.closest('.org-window-no-drag')).not.toBeNull();
    }
    // The window is scoped to that organization: its roster is the one read.
    await waitFor(() => expect(
      (window as any).electronAPI.organization.listMembers,
    ).toHaveBeenCalledWith('org-other'));
    // Messaging only since NIM-2322 — administration is the ORG_MANAGEMENT
    // dialog, so the window offers Inbox and conversations and nothing else.
    screen.getByTestId('team-tab-inbox');
    for (const tab of ['members', 'projects', 'settings', 'billing', 'danger']) {
      expect(screen.queryByTestId(`team-tab-${tab}`)).toBeNull();
    }
    expect(screen.queryByTestId('admin-members')).toBeNull();
  });

  it('hydrates canonical tracker records for chips in the dedicated org window', async () => {
    installApi();
    const invoke = (window as any).electronAPI.invoke as ReturnType<typeof vi.fn>;
    invoke.mockImplementation(async (channel: string, payload?: { orgId?: string }) => {
      if (channel === 'team-window:tracker-items-list') {
        expect(payload).toEqual({ orgId: 'org-other' });
        return [{
          id: 'plan-1',
          issueKey: 'NIM-2300',
          type: 'plan',
          typeTags: ['plan'],
          title: 'Satellite apps',
          status: 'in-progress',
          workspace: '/workspace',
          source: 'native',
        }];
      }
      return [];
    });
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-other');

    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(
      store.get(trackerItemsMapAtom).get('plan-1'),
    ).toMatchObject({
      issueKey: 'NIM-2300',
      primaryType: 'plan',
      fields: {
        title: 'Satellite apps',
        status: 'in-progress',
      },
    }));
  });

  it('falls back to the workspace-bound organization when no organization is selected', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, null);
    render(<Provider store={store}><TeamMode workspacePath="/workspace" isActive /></Provider>);

    await waitFor(() => expect(orgIdentity()).toContain('Workspace Org'));
    await waitFor(() => expect(
      (window as any).electronAPI.organization.listMembers,
    ).toHaveBeenCalledWith('org-workspace'));
  });

  it('renders org-only (no workspace) without a workspace lookup', async () => {
    installApi();
    const findForWorkspace = (window as any).electronAPI.team.findForWorkspace;
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-other');
    // No workspacePath: the standalone org-management window targets the org only.
    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(orgIdentity()).toContain('Other Org'));
    // No workspace-scoped sharing surface, and no workspace lookup at all: the
    // window targets the organization only.
    expect(screen.queryByRole('button', { name: /project sharing/i })).toBeNull();
    expect(findForWorkspace).not.toHaveBeenCalled();
  });
});
