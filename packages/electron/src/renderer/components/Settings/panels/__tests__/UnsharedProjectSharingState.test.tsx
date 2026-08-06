// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const openDialog = vi.hoisted(() => vi.fn());
// `organizationCreationEnabled` is a build-time constant (dev true, packaged
// false); a getter lets one suite exercise both packaging branches.
const flags = vi.hoisted(() => ({ organizationCreationEnabled: true }));

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));
vi.mock('../../../../utils/teamAnalytics', () => ({ trackTeamAnalyticsEvent: vi.fn() }));
vi.mock('../SecurityEncryptionSection', () => ({ SecurityEncryptionSection: () => null }));
vi.mock('../MoveProjectWizard', () => ({ MoveProjectWizard: () => null }));
vi.mock('../MergeOrgWizard', () => ({ MergeOrgWizard: () => null }));
vi.mock('../ProjectAccessEditor', () => ({ ProjectAccessEditor: () => null }));
vi.mock('../../../common/AlphaBadge', () => ({ AlphaBadge: () => null, SETTINGS_ALPHA_TOOLTIP: '' }));
vi.mock('../../../../contexts/DialogContext', () => ({
  useDialogState: (id: string) => ({
    open: (data: unknown) => openDialog(id, data),
    close: vi.fn(),
    isOpen: false,
    data: null,
  }),
}));
vi.mock('../../../../dialogs/registry', () => ({
  DIALOG_IDS: { ORG_CREATION_WIZARD: 'org-creation-wizard', ACCOUNT_LOGIN: 'account-login' },
}));
vi.mock('../../../../store/atoms/settingsDomains', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get organizationCreationEnabled() { return flags.organizationCreationEnabled; },
}));

import {
  UnsharedProjectSharingState,
  WorkspaceProjectSharingPanel,
} from '../WorkspaceProjectSharingPanel';

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

    screen.getByTestId('project-sharing-choices');
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
    screen.getByTestId('project-sharing-choose-existing');
    screen.getByTestId('project-sharing-choose-new');
  });

  // Adding without a remote used to be blocked, because nothing could match the
  // workspace back to the project the server minted. The workspace now records
  // which project it was added as, so the flow goes through and only says what
  // the missing remote costs.
  it('allows adding to an existing organization without a git remote', () => {
    const { onAddToOrg } = renderFlow({ gitRemote: '' });

    fireEvent.change(screen.getByTestId('project-sharing-org-picker'), { target: { value: 'org-1' } });
    fireEvent.click(screen.getByTestId('project-sharing-choose-existing'));

    const confirmAction = screen.getByTestId('project-sharing-confirm-action') as HTMLButtonElement;
    expect(confirmAction.disabled).toBe(false);
    expect(screen.getByTestId('project-sharing-confirm').textContent).toContain('only this computer connects');

    fireEvent.click(confirmAction);
    expect(onAddToOrg).toHaveBeenCalledWith('org-1');
  });

  it('still allows creating an organization without a git remote', () => {
    const { onCreateOrganization } = renderFlow({ gitRemote: '' });

    fireEvent.click(screen.getByTestId('project-sharing-choose-new'));
    const confirmAction = screen.getByTestId('project-sharing-confirm-action') as HTMLButtonElement;
    expect(confirmAction.disabled).toBe(false);

    fireEvent.click(confirmAction);
    expect(onCreateOrganization).toHaveBeenCalled();
  });

  it('lets the user back out of the confirm step', () => {
    renderFlow();

    fireEvent.click(screen.getByTestId('project-sharing-choose-new'));
    fireEvent.click(screen.getByTestId('project-sharing-back'));

    screen.getByTestId('project-sharing-choices');
  });
});

/**
 * Organization creation has one surface now — the wizard — and the panel's
 * signed-out arm is an entry point into it rather than a sentence telling the
 * user to go find another panel.
 */
describe('WorkspaceProjectSharingPanel entry points', () => {
  beforeEach(() => {
    openDialog.mockClear();
    flags.organizationCreationEnabled = true;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        stytch: {
          getAuthState: vi.fn(async () => ({ isAuthenticated: false, user: null })),
          refreshSession: vi.fn(),
          subscribeAuthState: vi.fn(),
          onAuthStateChange: vi.fn(() => () => {}),
          getAccounts: vi.fn(async () => []),
        },
        team: {
          getGitRemote: vi.fn(async () => ({ success: true, remote: 'git@example.com:acme/app.git' })),
          list: vi.fn(async () => ({ success: true, teams: [] })),
          findForWorkspace: vi.fn(async () => ({ success: true, team: null })),
        },
      },
    });
  });

  afterEach(() => cleanup());

  it('gives a signed-out user a button into the wizard, not instructions', async () => {
    render(<WorkspaceProjectSharingPanel workspacePath="/tmp/acme-app" />);

    const signedOut = await screen.findByTestId('project-sharing-signed-out');
    expect(signedOut.textContent).not.toContain('Account & Sync');

    fireEvent.click(screen.getByTestId('project-sharing-sign-in'));
    await waitFor(() => expect(openDialog).toHaveBeenCalled());
    expect(openDialog.mock.calls[0][0]).toBe('org-creation-wizard');
    expect(openDialog.mock.calls[0][1]).toMatchObject({
      workspacePath: '/tmp/acme-app',
      suggestedName: 'acme-app',
      entryPoint: 'project_sharing',
    });
  });

  /**
   * With creation switched off, the wizard's only destination past sign-in is a
   * create step that cannot run — so the signed-out button signs the user in
   * instead of walking them into that dead end. The signed-in card already
   * hides its create choice the same way.
   */
  it('signs a packaged-build user in rather than into a create it cannot finish', async () => {
    flags.organizationCreationEnabled = false;
    render(<WorkspaceProjectSharingPanel workspacePath="/tmp/acme-app" />);

    fireEvent.click(await screen.findByTestId('project-sharing-sign-in'));
    await waitFor(() => expect(openDialog).toHaveBeenCalled());
    expect(openDialog.mock.calls[0][0]).toBe('account-login');
    expect(openDialog.mock.calls[0][1]).toMatchObject({ mode: 'first-sign-in' });
  });

  it('routes the signed-in create action into the same wizard', async () => {
    (window as any).electronAPI.stytch.getAuthState = vi.fn(async () => ({
      isAuthenticated: true,
      user: { user_id: 'u1', emails: [{ email: 'a@example.com' }] },
    }));

    render(<WorkspaceProjectSharingPanel workspacePath="/tmp/acme-app" />);

    fireEvent.click(await screen.findByTestId('project-sharing-choose-new'));
    fireEvent.click(screen.getByTestId('project-sharing-confirm-action'));

    await waitFor(() => expect(openDialog).toHaveBeenCalled());
    expect(openDialog.mock.calls[0][0]).toBe('org-creation-wizard');
    expect(openDialog.mock.calls[0][1]).toMatchObject({ workspacePath: '/tmp/acme-app' });
  });
});
