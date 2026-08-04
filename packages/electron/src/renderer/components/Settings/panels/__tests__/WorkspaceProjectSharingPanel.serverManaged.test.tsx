// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// NIM-1779/C2: team key custody is server-managed, so the reachable team
// sharing surface (ProjectScopedTeamExistsState) must not present the legacy
// envelope-based trust badges or a "Re-share key" affordance. The old E2E
// trust/re-share UI (TeamExistsState + MemberFingerprintDetail) was removed;
// this test guards against it coming back.

// Heavy / side-effecting module imports pulled in by the panel file -- stub them
// so the component renders in jsdom without a real runtime or IPC.
vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));
vi.mock('../SecurityEncryptionSection', () => ({
  SecurityEncryptionSection: () => <div data-testid="security-encryption-section" />,
}));
vi.mock('../MoveProjectWizard', () => ({ MoveProjectWizard: () => null }));
vi.mock('../MergeOrgWizard', () => ({ MergeOrgWizard: () => null }));
vi.mock('../ProjectAccessEditor', () => ({
  ProjectAccessEditor: () => <div data-testid="project-access-editor" />,
}));
vi.mock('../../../common/AlphaBadge', () => ({
  AlphaBadge: () => null,
  SETTINGS_ALPHA_TOOLTIP: '',
}));
const openDialog = vi.fn();
vi.mock('../../../../contexts/DialogContext', () => ({
  useDialogState: () => ({ open: vi.fn(), close: vi.fn(), isOpen: false, data: null }),
  dialogRef: { current: { open: (...args: unknown[]) => openDialog(...args) } },
}));
vi.mock('../../../../dialogs/registry', () => ({
  DIALOG_IDS: {
    ORG_CREATION_WIZARD: 'org-creation-wizard',
    ORG_MANAGEMENT: 'org-management',
  },
}));

const openManagementWindow = vi.fn();

import { ProjectScopedTeamExistsState } from '../WorkspaceProjectSharingPanel';

function renderServerManagedTeamSurface(callerRole = 'admin', teamOverrides: Record<string, unknown> = {}) {
  const team = {
    orgId: 'org-sm',
    name: 'Server Managed Team',
    gitRemote: 'git@example.com:acme/app.git',
    gitRemoteHash: 'abc123',
    teamProjectId: 'proj-1',
    members: [
      { id: 'm1', name: 'Alice', email: 'alice@example.com', role: 'admin' as const, status: 'active' as const, avatarColor: '#60a5fa', isYou: true },
      { id: 'm2', name: 'Bob', email: 'bob@example.com', role: 'member' as const, status: 'active' as const, avatarColor: '#a78bfa' },
    ],
    callerRole,
    ...teamOverrides,
  };
  const projects = [
    { projectId: 'proj-1', teamProjectId: 'proj-1', gitRemoteHash: 'abc123', slug: 'app', name: 'App' },
  ];
  return render(
    <ProjectScopedTeamExistsState
      team={team}
      projects={projects}
      workspacePath="/tmp/app"
      adminOrgs={[]}
      localGitRemote="git@example.com:acme/app.git"
      onLinkProject={vi.fn()}
      onUnlinkProject={vi.fn()}
      onProjectMoved={vi.fn()}
    />
  );
}

describe('WorkspaceProjectSharingPanel server-managed team surface (NIM-1779/C2)', () => {
  beforeEach(() => {
    openDialog.mockReset();
    openManagementWindow.mockReset();
    (window as any).electronAPI = { team: { openManagementWindow } };
  });
  afterEach(() => cleanup());

  // NIM-2322: administering the organization this project belongs to happens in
  // this window, on the Projects tab — the surface this button sits on is about
  // the project's place in the organization.
  it('opens the management dialog on Projects instead of the organization window', () => {
    renderServerManagedTeamSurface();

    fireEvent.click(screen.getByText('Open organization'));

    expect(openDialog).toHaveBeenCalledWith('org-management', {
      orgId: 'org-sm',
      initialTab: 'projects',
    });
    expect(openManagementWindow).not.toHaveBeenCalled();
  });

  it('renders no envelope-based trust or re-share affordances', () => {
    renderServerManagedTeamSurface();

    // The people-with-access surface is present (the reachable team UI).
    screen.getByTestId('project-access-editor');

    // No legacy E2E trust / re-share UI.
    expect(screen.queryByText(/re-share/i)).toBeNull();
    expect(screen.queryByText(/mark as verified/i)).toBeNull();
    expect(screen.queryByText(/revoke trust/i)).toBeNull();
    expect(screen.queryByText(/identity key fingerprint/i)).toBeNull();
    expect(screen.queryByText(/your fingerprint/i)).toBeNull();
    expect(screen.queryByTitle(/identity verified/i)).toBeNull();
    expect(screen.queryByTitle(/not verified/i)).toBeNull();
  });

  it('labels an organization viewer as Viewer', () => {
    renderServerManagedTeamSurface('viewer');
    screen.getByText('Server Managed Team · Viewer');
  });

  /**
   * The workspace -> organization -> account chain ends at the login that owns
   * the binding. That tail only distinguishes something once a second account
   * exists; with one it is the only answer there could be.
   */
  it('omits the owning-account tail when only one account is stored', () => {
    renderServerManagedTeamSurface('admin', {
      boundPersonalOrgId: 'personal-1',
      boundAccountEmail: 'solo@example.com',
      storedAccountCount: 1,
    });

    expect(screen.queryByTestId('workspace-organization-account-tail')).toBeNull();
    // The workspace -> organization part of the chain is untouched.
    expect(screen.getByTestId('workspace-organization-account-chain').textContent)
      .toContain('app → Server Managed Team');
  });

  it('names the owning account once a second account is stored', () => {
    renderServerManagedTeamSurface('admin', {
      boundPersonalOrgId: 'personal-1',
      boundAccountEmail: 'solo@example.com',
      storedAccountCount: 2,
    });

    expect(screen.getByTestId('workspace-organization-account-tail').textContent)
      .toContain('solo@example.com');
  });
});
