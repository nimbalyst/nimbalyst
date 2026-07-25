// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

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
vi.mock('../H2EncryptionMigration', () => ({
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
vi.mock('../../../../contexts/DialogContext', () => ({
  useDialogState: () => ({ open: vi.fn(), close: vi.fn(), isOpen: false, data: null }),
}));
vi.mock('../../../../dialogs/registry', () => ({ DIALOG_IDS: { CREATE_TEAM: 'create-team' } }));

import { ProjectScopedTeamExistsState } from '../WorkspaceProjectSharingPanel';

function renderServerManagedTeamSurface() {
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
    callerRole: 'admin',
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
  afterEach(() => cleanup());

  it('renders no envelope-based trust or re-share affordances', () => {
    renderServerManagedTeamSurface();

    // The people-with-access surface is present (the reachable team UI).
    expect(screen.getByTestId('project-access-editor')).toBeTruthy();

    // No legacy E2E trust / re-share UI.
    expect(screen.queryByText(/re-share/i)).toBeNull();
    expect(screen.queryByText(/mark as verified/i)).toBeNull();
    expect(screen.queryByText(/revoke trust/i)).toBeNull();
    expect(screen.queryByText(/identity key fingerprint/i)).toBeNull();
    expect(screen.queryByText(/your fingerprint/i)).toBeNull();
    expect(screen.queryByTitle(/identity verified/i)).toBeNull();
    expect(screen.queryByTitle(/not verified/i)).toBeNull();
  });
});
