// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

/*
 * The five administration panels are stubbed, the IPC underneath the dialog is
 * not: what is being tested here is the dialog's own wiring — which tabs a role
 * may see, which panel an `initialTab` lands on, what each panel is handed, and
 * the Projects drill-down. Each panel reads its own IPC and has its own tests;
 * mounting them here would test them twice and make this file slow.
 */
vi.mock('../../Settings/panels/OrganizationMembersRolesPanel', () => ({
  OrganizationMembersRolesPanel: ({
    orgId,
    allowOrganizationCreation,
  }: { orgId?: string; allowOrganizationCreation?: boolean }) => (
    <div
      data-testid="members-panel"
      data-org-id={orgId}
      data-allow-create={String(allowOrganizationCreation)}
    />
  ),
}));
vi.mock('../../Settings/panels/OrganizationProjectsPanel', () => ({
  OrganizationProjectsPanel: ({
    orgId,
    onManageAccess,
  }: { orgId?: string; onManageAccess: (orgId: string, projectId: string) => void }) => (
    <div data-testid="projects-panel" data-org-id={orgId}>
      <button
        type="button"
        data-testid="manage-access-project-7"
        onClick={() => onManageAccess(orgId ?? '', 'project-7')}
      >
        Manage access
      </button>
    </div>
  ),
}));
vi.mock('../../Settings/panels/OrganizationSettingsPanel', () => ({
  OrganizationSettingsPanel: ({
    orgId,
    orgName,
    ownerEmail,
    callerRole,
  }: {
    orgId?: string;
    orgName?: string | null;
    ownerEmail?: string | null;
    callerRole?: string | null;
  }) => (
    <div
      data-testid="settings-panel"
      data-org-id={orgId}
      data-org-name={orgName ?? ''}
      data-owner-email={ownerEmail ?? ''}
      data-caller-role={callerRole ?? 'unresolved'}
    />
  ),
}));
vi.mock('../../Settings/panels/OrganizationBillingPanel', () => ({
  OrganizationBillingPanel: () => <div data-testid="billing-panel" />,
}));
vi.mock('../../Settings/panels/OrganizationDangerZone', () => ({
  OrganizationDangerZone: ({ orgId }: { orgId?: string }) => (
    <div data-testid="danger-panel" data-org-id={orgId} />
  ),
}));
vi.mock('../../Settings/panels/ProjectSharingPanel', () => ({
  ProjectSharingPanel: ({ target }: { target?: { orgId?: string; projectId?: string } }) => (
    <div
      data-testid="project-sharing-panel"
      data-org-id={target?.orgId}
      data-project-id={target?.projectId}
    />
  ),
}));

import { OrgManagementDialog } from '../OrgManagementDialog';

interface RosterResponse {
  success: boolean;
  callerRole?: string;
  members?: { memberId: string; email: string; name: string; role: string }[];
}

function stubElectronAPI({
  listMembers,
}: {
  listMembers: (orgId: string) => Promise<RosterResponse>;
}): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      organization: {
        listMembers,
        list: async () => ({
          success: true,
          teams: [{
            orgId: 'org-a',
            name: 'Acme',
            boundPersonalOrgId: 'personal-a',
            sourceEmail: 'greg@example.com',
          }],
        }),
      },
      stytch: {
        getAccounts: async () => [
          { email: 'greg@example.com', personalOrgId: 'personal-a' },
        ],
      },
    },
  });
}

function roster(callerRole: string): RosterResponse {
  return {
    success: true,
    callerRole,
    members: [{
      memberId: 'member-a',
      email: 'greg@example.com',
      name: 'Greg',
      role: callerRole,
    }],
  };
}

function tabIds(): string[] {
  return Array.from(
    screen.getByTestId('org-management-dialog-tabs').querySelectorAll('button'),
  ).map((button) => button.getAttribute('data-testid') ?? '');
}

function renderDialog(props: { initialTab?: 'members' | 'projects' | 'settings' | 'billing' | 'danger' } = {}) {
  return render(
    <OrgManagementDialog
      isOpen
      onClose={() => {}}
      orgId="org-a"
      initialTab={props.initialTab}
    />,
  );
}

describe('OrgManagementDialog', () => {
  beforeEach(() => {
    stubElectronAPI({ listMembers: async () => roster('admin') });
  });
  afterEach(() => cleanup());

  it('offers an admin every panel and a member only the ones they may act in', async () => {
    renderDialog();
    await waitFor(() => expect(tabIds()).toContain('org-management-tab-billing'));
    expect(tabIds()).toEqual([
      'org-management-tab-members',
      'org-management-tab-projects',
      'org-management-tab-settings',
      'org-management-tab-billing',
      'org-management-tab-danger',
    ]);

    cleanup();
    stubElectronAPI({ listMembers: async () => roster('member') });
    renderDialog({ initialTab: 'settings' });
    // Waiting on the resolved role rather than on the tab list: the admin-only
    // entries are also absent while the roster is still loading, so a bare
    // "three tabs" assertion would pass without the role ever arriving.
    await waitFor(() =>
      expect(screen.getByTestId('settings-panel').getAttribute('data-caller-role'))
        .toBe('member'));
    expect(tabIds()).toEqual([
      'org-management-tab-members',
      'org-management-tab-projects',
      'org-management-tab-settings',
    ]);
  });

  it('lands on the requested tab and hands it the organization', async () => {
    renderDialog({ initialTab: 'danger' });

    await waitFor(() => screen.getByTestId('danger-panel'));
    expect(screen.getByTestId('danger-panel').getAttribute('data-org-id')).toBe('org-a');
    expect(screen.queryByTestId('members-panel')).toBeNull();
  });

  it('never renders an admin-only panel to a member, even when asked for it', async () => {
    let release: ((value: RosterResponse) => void) | undefined;
    stubElectronAPI({
      listMembers: () => new Promise((resolve) => { release = resolve; }),
    });
    renderDialog({ initialTab: 'billing' });

    // While the role is unresolved the dialog shows neither the requested
    // panel nor a fallback: guessing would either leak Billing or bounce an
    // admin off it.
    expect(screen.queryByTestId('billing-panel')).toBeNull();
    screen.getByTestId('org-management-dialog-resolving');

    release?.(roster('member'));

    await waitFor(() => screen.getByTestId('members-panel'));
    expect(screen.queryByTestId('billing-panel')).toBeNull();
  });

  it('threads the resolved role and organization identity into Settings', async () => {
    renderDialog({ initialTab: 'settings' });

    await waitFor(() =>
      expect(screen.getByTestId('settings-panel').getAttribute('data-org-name'))
        .toBe('Acme'));
    const panel = screen.getByTestId('settings-panel');
    expect(panel.getAttribute('data-org-id')).toBe('org-a');
    expect(panel.getAttribute('data-caller-role')).toBe('admin');
    expect(panel.getAttribute('data-owner-email')).toBe('greg@example.com');
  });

  it('drills into a project\'s sharing panel and back out to the project list', async () => {
    renderDialog({ initialTab: 'projects' });
    await waitFor(() => screen.getByTestId('projects-panel'));

    screen.getByTestId('manage-access-project-7').click();

    const sharing = await screen.findByTestId('project-sharing-panel');
    expect(sharing.getAttribute('data-project-id')).toBe('project-7');
    expect(sharing.getAttribute('data-org-id')).toBe('org-a');
    expect(screen.queryByTestId('projects-panel')).toBeNull();

    screen.getByTestId('org-management-project-access-back').click();

    await waitFor(() => screen.getByTestId('projects-panel'));
    expect(screen.queryByTestId('project-sharing-panel')).toBeNull();
  });

  it('leaves the drill-down behind when another tab is opened', async () => {
    renderDialog({ initialTab: 'projects' });
    await waitFor(() => screen.getByTestId('projects-panel'));
    screen.getByTestId('manage-access-project-7').click();
    await screen.findByTestId('project-sharing-panel');

    screen.getByTestId('org-management-tab-members').click();
    await waitFor(() => screen.getByTestId('members-panel'));
    expect(screen.getByTestId('members-panel').getAttribute('data-allow-create'))
      .toBe('false');

    screen.getByTestId('org-management-tab-projects').click();

    await waitFor(() => screen.getByTestId('projects-panel'));
    expect(screen.queryByTestId('project-sharing-panel')).toBeNull();
  });
});
