// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));
vi.mock('../H2EncryptionMigration', () => ({ SecurityEncryptionSection: () => null }));
vi.mock('../MoveProjectWizard', () => ({ MoveProjectWizard: () => null }));
vi.mock('../MergeOrgWizard', () => ({ MergeOrgWizard: () => null }));
vi.mock('../ProjectAccessEditor', () => ({ ProjectAccessEditor: () => null }));
vi.mock('../../../common/AlphaBadge', () => ({ AlphaBadge: () => null, SETTINGS_ALPHA_TOOLTIP: '' }));
vi.mock('../../../../contexts/DialogContext', () => ({
  useDialogState: () => ({ open: vi.fn(), close: vi.fn(), isOpen: false, data: null }),
}));
vi.mock('../../../../dialogs/registry', () => ({ DIALOG_IDS: { CREATE_TEAM: 'create-team' } }));

import { UnsharedProjectSharingState } from '../WorkspaceProjectSharingPanel';

const remote = 'git@example.com:acme/app.git';

function renderFlow(overrides: Partial<React.ComponentProps<typeof UnsharedProjectSharingState>> = {}) {
  const onAddToOrg = vi.fn();
  const onCreateOrganization = vi.fn();
  render(
    <UnsharedProjectSharingState
      workspacePath="/tmp/acme-app"
      gitRemote={remote}
      adminOrgs={[{ orgId: 'org-1', name: 'Acme' }]}
      onAddToOrg={onAddToOrg}
      onCreateOrganization={onCreateOrganization}
      {...overrides}
    />,
  );
  return { onAddToOrg, onCreateOrganization };
}

describe('UnsharedProjectSharingState', () => {
  afterEach(() => cleanup());

  it('asks one question first and only acts after the confirm step', () => {
    const { onAddToOrg } = renderFlow();

    expect(screen.getByTestId('project-sharing-choices')).toBeTruthy();
    expect(screen.queryByTestId('project-sharing-confirm')).toBeNull();

    fireEvent.change(screen.getByTestId('project-sharing-org-picker'), { target: { value: 'org-1' } });
    fireEvent.click(screen.getByTestId('project-sharing-choose-existing'));

    expect(onAddToOrg).not.toHaveBeenCalled();
    expect(screen.getByTestId('project-sharing-confirm').textContent).toContain('Add acme-app to Acme');

    fireEvent.click(screen.getByTestId('project-sharing-confirm-action'));
    expect(onAddToOrg).toHaveBeenCalledWith('org-1');
  });

  it('goes straight to creating an organization when the user has none', () => {
    const { onCreateOrganization } = renderFlow({ adminOrgs: [] });

    expect(screen.queryByTestId('project-sharing-org-picker')).toBeNull();
    fireEvent.click(screen.getByTestId('project-sharing-choose-new'));
    fireEvent.click(screen.getByTestId('project-sharing-confirm-action'));

    expect(onCreateOrganization).toHaveBeenCalled();
  });

  it('explains a missing git remote instead of hiding the choices', () => {
    renderFlow({ gitRemote: '' });

    expect(screen.getByTestId('project-sharing-no-remote').textContent).toContain('no git remote');
    expect(screen.getByTestId('project-sharing-choose-existing')).toBeTruthy();
    expect(screen.getByTestId('project-sharing-choose-new')).toBeTruthy();
  });

  // Adding without a remote POSTs a nameless, remote-less project that no
  // workspace can ever resolve to, and the panel then falls back to these
  // choices with no error — so every retry would orphan another one.
  it('blocks the add-to-existing confirm action when the workspace has no git remote', () => {
    const { onAddToOrg } = renderFlow({ gitRemote: '' });

    fireEvent.change(screen.getByTestId('project-sharing-org-picker'), { target: { value: 'org-1' } });
    fireEvent.click(screen.getByTestId('project-sharing-choose-existing'));

    const confirmAction = screen.getByTestId('project-sharing-confirm-action') as HTMLButtonElement;
    expect(confirmAction.disabled).toBe(true);
    expect(screen.getByTestId('project-sharing-blocked').textContent).toContain('needs a git remote');
    expect(screen.getByTestId('project-sharing-blocked').textContent).toContain('git remote add origin');

    fireEvent.click(confirmAction);
    expect(onAddToOrg).not.toHaveBeenCalled();
  });

  it('still allows creating an organization without a git remote', () => {
    const { onCreateOrganization } = renderFlow({ gitRemote: '' });

    fireEvent.click(screen.getByTestId('project-sharing-choose-new'));
    const confirmAction = screen.getByTestId('project-sharing-confirm-action') as HTMLButtonElement;
    expect(confirmAction.disabled).toBe(false);
    expect(screen.queryByTestId('project-sharing-blocked')).toBeNull();

    fireEvent.click(confirmAction);
    expect(onCreateOrganization).toHaveBeenCalled();
  });

  it('lets the user back out of the confirm step', () => {
    renderFlow();

    fireEvent.click(screen.getByTestId('project-sharing-choose-new'));
    fireEvent.click(screen.getByTestId('project-sharing-back'));

    expect(screen.getByTestId('project-sharing-choices')).toBeTruthy();
  });
});
