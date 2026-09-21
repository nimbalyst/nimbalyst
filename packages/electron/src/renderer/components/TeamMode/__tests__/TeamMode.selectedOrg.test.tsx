// @vitest-environment jsdom
import React from 'react';
import { createHydratedOrgStore } from './organizationTestStore';
import { Provider } from 'jotai';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import { dialogRef } from '../../../contexts/DialogContext';
import { DIALOG_IDS } from '../../../dialogs/registry';
import { organizationDirectoryAtom, organizationDirectoryStateAtom } from '../../../store/atoms/settingsDomains';
import { orgTrackerItemsAtom, trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { OrgModeHost } from '../OrgModeHost';
import { ORG_WINDOW_SURFACE_ID } from '../orgWindowState';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
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
        acceptInvitation: vi.fn().mockResolvedValue({ success: true }),
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

  it('routes administration to the management dialog, and offers a stranded invite an Accept', async () => {
    // Karl, 2026-08-11: the window opened on this surface and it was a dead end
    // — three organizations he could not administer and a Retry that could not
    // change anything. Administration is the ORG_MANAGEMENT dialog, which this
    // window hosts, and an unaccepted invite is the one thing that unsticks the
    // preserved destination.
    installApi();
    (window as any).electronAPI.organization.list = vi.fn().mockResolvedValue({
      success: true,
      teams: [otherTeam, { orgId: 'org-invited', name: 'Invited Org', membershipType: 'invited_member' }],
    });
    const open = vi.fn();
    dialogRef.current = { open } as unknown as typeof dialogRef.current;
    const store = await createHydratedOrgStore();
    render(
      <Provider store={store}>
        <OrgModeHost
        orgId="org-invited"
        surfaceId={ORG_WINDOW_SURFACE_ID}
        chrome="window"
        />
      </Provider>,
    );

    await waitFor(() => screen.getByTestId('team-mode-organization-settings'));
    fireEvent.click(screen.getByTestId('team-mode-organization-settings'));
    expect(open).toHaveBeenCalledWith(DIALOG_IDS.ORG_MANAGEMENT, { orgId: 'org-other' });

    fireEvent.click(screen.getByTestId('pending-invitation-accept'));
    await waitFor(() => expect(
      (window as any).electronAPI.organization.acceptInvitation,
    ).toHaveBeenCalledWith('org-invited'));
  });

  it('preserves an explicit destination instead of falling back to the first organization', async () => {
    installApi();
    const store = await createHydratedOrgStore();
    store.set(selectedOrgIdAtom, 'org-i-left');
    render(
      <Provider store={store}>
        <OrgModeHost
        orgId="org-i-left"
        surfaceId={ORG_WINDOW_SURFACE_ID}
        chrome="window"
        onOrgIdChange={(nextOrgId) => store.set(selectedOrgIdAtom, nextOrgId)}
        />
      </Provider>,
    );

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
    const store = await createHydratedOrgStore();
    store.set(selectedOrgIdAtom, 'org-other');
    store.set(organizationDirectoryStateAtom, { entries: [], status: 'loading', complete: false });
    render(
      <Provider store={store}>
        <OrgModeHost
        orgId="org-other"
        surfaceId={ORG_WINDOW_SURFACE_ID}
        chrome="window"
        onOrgIdChange={(nextOrgId) => store.set(selectedOrgIdAtom, nextOrgId)}
        />
      </Provider>,
    );

    screen.getByText('Loading organization…');
    expect(screen.queryByTestId('team-mode-organization-recovery')).toBeNull();
    expect(store.get(selectedOrgIdAtom)).toBe('org-other');

    act(() => { store.set(organizationDirectoryAtom, [otherTeam]); });

    await waitFor(() => expect(orgIdentity()).toContain('Other Org'));
  });

  it('offers organization choices on the unbound surface when active organizations exist', async () => {
    installApi();
    const store = await createHydratedOrgStore();
    // No workspace and no selection: the unbound surface, but the user is in orgs.
    render(
      <Provider store={store}>
        <OrgModeHost
        orgId={null}
        surfaceId={ORG_WINDOW_SURFACE_ID}
        chrome="window"
        />
      </Provider>,
    );

    await waitFor(() => screen.getByTestId('team-mode-organization-choices'));
    expect(screen.getAllByTestId('team-mode-organization-choice')).toHaveLength(2);
  });

  it('targets the explicitly selected non-workspace organization', async () => {
    installApi();
    const store = await createHydratedOrgStore();
    const { container } = render(
      <Provider store={store}>
        <OrgModeHost
          orgId="org-other"
          workspacePath="/workspace"
          surfaceId={ORG_WINDOW_SURFACE_ID}
          chrome="window"
          isActive
        />
      </Provider>,
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
    expect(screen.queryByTestId('organization-members-roles-panel')).toBeNull();
  });

  it('uses an explicit host organization without mutating the window selection', async () => {
    installApi();
    const store = await createHydratedOrgStore();
    store.set(selectedOrgIdAtom, 'org-workspace');

    render(
      <Provider store={store}>
        <OrgModeHost orgId="org-other" surfaceId="project-org-mode" />
      </Provider>,
    );

    await waitFor(() => expect(
      (window as any).electronAPI.organization.listMembers,
    ).toHaveBeenCalledWith('org-other'));
    expect(store.get(selectedOrgIdAtom)).toBe('org-workspace');
  });

  it('hydrates the org tracker slice for chips without touching workspace records', async () => {
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
    const store = await createHydratedOrgStore();
    // What initTrackerSyncListeners loads at startup. Org mode shares this
    // store whenever it is a mode rather than a window, and stays mounted while
    // hidden, so seeding the workspace map here emptied every tracker surface
    // (#3637). Asserted as a mode because that is the arrangement that broke.
    store.set(trackerItemsMapAtom, new Map([['bug-1', { id: 'bug-1' } as never]]));

    render(
      <Provider store={store}>
        <OrgModeHost orgId="org-other" surfaceId="project-org-mode" chrome="mode" />
      </Provider>,
    );

    await waitFor(() => expect(
      store.get(orgTrackerItemsAtom).get('org-other')?.get('plan-1'),
    ).toMatchObject({
      issueKey: 'NIM-2300',
      primaryType: 'plan',
      fields: {
        title: 'Satellite apps',
        status: 'in-progress',
      },
    }));
    expect(store.get(trackerItemsMapAtom).get('bug-1')).toBeDefined();
  });

  it('falls back to the workspace-bound organization when no organization is selected', async () => {
    installApi();
    const store = await createHydratedOrgStore();
    render(
      <Provider store={store}>
        <OrgModeHost
          orgId={null}
          workspacePath="/workspace"
          surfaceId={ORG_WINDOW_SURFACE_ID}
          chrome="window"
          isActive
        />
      </Provider>,
    );

    await waitFor(() => expect(orgIdentity()).toContain('Workspace Org'));
    await waitFor(() => expect(
      (window as any).electronAPI.organization.listMembers,
    ).toHaveBeenCalledWith('org-workspace'));
  });

  it('renders org-only (no workspace) without a workspace lookup', async () => {
    installApi();
    const findForWorkspace = (window as any).electronAPI.team.findForWorkspace;
    const store = await createHydratedOrgStore();
    // No workspacePath: the standalone org-management window targets the org only.
    render(
      <Provider store={store}>
        <OrgModeHost
        orgId="org-other"
        surfaceId={ORG_WINDOW_SURFACE_ID}
        chrome="window"
        />
      </Provider>,
    );

    await waitFor(() => expect(orgIdentity()).toContain('Other Org'));
    // No workspace-scoped sharing surface, and no workspace lookup at all: the
    // window targets the organization only.
    expect(screen.queryByRole('button', { name: /project sharing/i })).toBeNull();
    expect(findForWorkspace).not.toHaveBeenCalled();
  });
});
