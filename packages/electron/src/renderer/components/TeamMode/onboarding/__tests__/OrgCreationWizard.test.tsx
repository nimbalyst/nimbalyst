// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../../shared/conversationDirectory';
import { OrgCreationWizard } from '../OrgCreationWizard';
import type { OrgWizardApi } from '../orgWizardRunner';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));
vi.mock('../../../common/AlphaBadge', () => ({ AlphaBadge: () => <span /> }));
vi.mock('../../../common/TeamAlphaNotice', () => ({
  TEAM_ALPHA_TOOLTIP: 'alpha',
  TeamAlphaNotice: () => <div />,
}));
vi.mock('../../../../utils/teamAnalytics', () => ({ trackTeamAnalyticsEvent: vi.fn() }));

function fakeApi(overrides: Partial<OrgWizardApi> = {}): OrgWizardApi {
  return {
    createOrganization: vi.fn(async () => ({ orgId: 'org-1' })),
    inviteMember: vi.fn(async () => {}),
    listConversations: vi.fn(async () => [] as ConversationDirectoryEntry[]),
    createConversation: vi.fn(async () => {}),
    resolveViewerUserId: vi.fn(async () => 'member-1'),
    postMessage: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      stytch: { getAccounts: vi.fn().mockResolvedValue([{ personalOrgId: 'account-1', email: 'a@example.com' }]) },
      invoke: vi.fn().mockResolvedValue(undefined),
    },
  });
});

afterEach(() => cleanup());

/**
 * The wizard is the only place an organization can be created now, so the walk
 * from an empty name to "#general is ready" is exercised end to end — including
 * the hand-off that makes the window land on the room.
 */
describe('OrgCreationWizard', () => {
  it('walks name, invite, rooms and done, then opens the organization', async () => {
    const api = fakeApi();
    const openOrgWindow = vi.fn();
    const onOrganizationCreated = vi.fn();
    render(
      <OrgCreationWizard
        isOpen
        onClose={() => {}}
        api={api}
        openOrgWindow={openOrgWindow}
        onOrganizationCreated={onOrganizationCreated}
      />,
    );

    // The owning account resolves asynchronously; creating before it lands
    // would silently fall back to the primary login.
    await act(async () => {});

    fireEvent.change(screen.getByTestId('org-wizard-name-input'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('org-wizard-primary'));
    await screen.findByTestId('org-wizard-invite-step');
    expect(api.createOrganization).toHaveBeenCalledWith({ name: 'Acme', sourcePersonalOrgId: 'account-1' });
    expect(onOrganizationCreated).toHaveBeenCalledWith('org-1');

    fireEvent.change(screen.getByTestId('org-wizard-email-input'), {
      target: { value: 'karl@example.com, josh@example.com ' },
    });
    expect(screen.getAllByTestId('org-wizard-email-chip')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('org-wizard-primary'));
    await screen.findByTestId('org-wizard-rooms-step');
    expect(api.inviteMember).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId('org-wizard-room-chip-dev'));
    fireEvent.click(screen.getByTestId('org-wizard-primary'));
    await screen.findByTestId('org-wizard-done-step');
    expect(api.createConversation).toHaveBeenCalledWith('org-1', expect.objectContaining({ id: 'dev' }));
    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'general' }));

    fireEvent.click(screen.getByTestId('org-wizard-primary'));
    await waitFor(() => expect(openOrgWindow).toHaveBeenCalledWith('org-1'));
  });

  it('keeps the organization when the invite step is skipped', async () => {
    const api = fakeApi();
    render(<OrgCreationWizard isOpen onClose={() => {}} api={api} openOrgWindow={vi.fn()} />);

    fireEvent.change(screen.getByTestId('org-wizard-name-input'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('org-wizard-primary'));
    await screen.findByTestId('org-wizard-invite-step');

    fireEvent.click(screen.getByTestId('org-wizard-skip'));
    await screen.findByTestId('org-wizard-rooms-step');
    expect(api.inviteMember).not.toHaveBeenCalled();

    // Skipping the rooms step still leaves #general readable.
    fireEvent.click(screen.getByTestId('org-wizard-skip'));
    await screen.findByTestId('org-wizard-done-step');
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.postMessage).toHaveBeenCalledTimes(1);
  });

  it('stays on the first step and reports a failed creation', async () => {
    const api = fakeApi({
      createOrganization: vi.fn(async () => { throw new Error('alpha is invite-only'); }),
    });
    render(<OrgCreationWizard isOpen onClose={() => {}} api={api} openOrgWindow={vi.fn()} />);

    fireEvent.change(screen.getByTestId('org-wizard-name-input'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('org-wizard-primary'));

    expect((await screen.findByTestId('org-wizard-error')).textContent).toContain('invite-only');
    expect(screen.getByTestId('org-wizard-identity-step')).toBeTruthy();
  });

  it('rejects text that cannot be an email address', async () => {
    const api = fakeApi();
    render(<OrgCreationWizard isOpen onClose={() => {}} api={api} openOrgWindow={vi.fn()} />);
    fireEvent.change(screen.getByTestId('org-wizard-name-input'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('org-wizard-primary'));
    await screen.findByTestId('org-wizard-invite-step');

    fireEvent.change(screen.getByTestId('org-wizard-email-input'), { target: { value: 'not-an-email ' } });
    expect((await screen.findByTestId('org-wizard-email-invalid')).textContent).toContain('not-an-email');
    expect(screen.queryAllByTestId('org-wizard-email-chip')).toHaveLength(0);
  });
});
