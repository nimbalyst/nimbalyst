// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stytchAuthAtom } from '../../../../store/atoms/stytchAuth';
import { OrgCreationWizard } from '../OrgCreationWizard';
import { createOrgWizardState } from '../orgWizardModel';
import type { OrgWizardApi } from '../orgWizardRunner';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));
vi.mock('../../../common/AlphaBadge', () => ({ AlphaBadge: () => <span /> }));
vi.mock('../../../common/TeamBetaNotice', () => ({
  TEAM_BETA_TOOLTIP: 'beta',
  TeamBetaNotice: () => <div />,
}));
vi.mock('../../../../utils/teamAnalytics', () => ({ trackTeamAnalyticsEvent: vi.fn() }));

function fakeApi(overrides: Partial<OrgWizardApi> = {}): OrgWizardApi {
  return {
    findPendingInvitation: vi.fn(async () => null),
    acceptInvitation: vi.fn(async (orgId: string) => ({ orgId })),
    createOrganization: vi.fn(async () => ({ orgId: 'org-1' })),
    inviteMember: vi.fn(async () => {}),
    ...overrides,
  };
}

const settings = new Map<string, unknown>();
let jotaiStore = createStore();

function renderWithStore(element: React.ReactElement) {
  return render(<Provider store={jotaiStore}>{element}</Provider>);
}

beforeEach(() => {
  settings.clear();
  jotaiStore = createStore();
  jotaiStore.set(stytchAuthAtom, {
    isAuthenticated: true,
    user: {
      user_id: 'user-1',
      emails: [{ email: 'a@example.com', verified: true }],
    },
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      stytch: { getAccounts: vi.fn().mockResolvedValue([{ personalOrgId: 'account-1', email: 'a@example.com' }]) },
      invoke: vi.fn(async (channel: string, key: string, value?: unknown) => {
        if (channel === 'app-settings:get') return settings.get(key);
        if (channel === 'app-settings:set') {
          settings.set(key, value);
          return true;
        }
        return undefined;
      }),
    },
  });
});

afterEach(() => cleanup());

/**
 * The wizard is the only place an organization can be created now, so the walk
 * from an empty name to the done step is exercised end to end. Every step runs
 * in the one dialog, and the org window is never opened by the wizard —
 * finishing only queues the "land on #general" route for whenever the user
 * opens it themselves.
 */
describe('OrgCreationWizard', () => {
  it('walks create, invite and done in one dialog without opening the org window', async () => {
    const api = fakeApi();
    const onOrganizationCreated = vi.fn();
    const onClose = vi.fn();
    renderWithStore(
      <OrgCreationWizard
        isOpen
        onClose={onClose}
        api={api}
        onOrganizationCreated={onOrganizationCreated}
      />,
    );

    fireEvent.change(await screen.findByTestId('org-wizard-name-input'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('org-wizard-primary'));

    // Create advances to invite in the same dialog; nothing has closed.
    await screen.findByTestId('org-wizard-invite-step');
    expect(api.createOrganization).toHaveBeenCalledWith({ name: 'Acme', sourcePersonalOrgId: 'account-1' });
    expect(onOrganizationCreated).toHaveBeenCalledWith('org-1');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('org-wizard-email-input'), {
      target: { value: 'karl@example.com, josh@example.com ' },
    });
    expect(screen.getAllByTestId('org-wizard-email-chip')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('org-wizard-primary'));
    await screen.findByTestId('org-wizard-done-step');
    expect(api.inviteMember).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId('org-wizard-primary'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // Finishing queues #general for the user's own first open, clears the
    // draft, and pre-dismisses the invited-member welcome card.
    expect(settings.get('orgWindowPendingRoute')).toEqual({ orgId: 'org-1', conversationId: 'general' });
    expect(settings.get('orgWizardDraft')).toBeNull();
    expect(settings.get('orgWelcomeDismissedOrgIds')).toEqual(['org-1']);
  });

  /**
   * The retired one-field CreateTeamDialog attached the project it was opened
   * from; folding it into the wizard must not drop that.
   */
  it('adopts the project it was opened from, pre-filled with its name', async () => {
    const api = fakeApi();
    renderWithStore(
      <OrgCreationWizard
        isOpen
        onClose={vi.fn()}
        api={api}
        workspacePath="/tmp/acme-app"
        suggestedName="acme-app"
      />,
    );

    const input = await screen.findByTestId('org-wizard-name-input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('acme-app'));
    fireEvent.click(screen.getByTestId('org-wizard-primary'));

    await waitFor(() => expect(api.createOrganization).toHaveBeenCalledWith({
      name: 'acme-app',
      sourcePersonalOrgId: 'account-1',
      workspacePath: '/tmp/acme-app',
    }));
  });

  it('keeps the organization when the invite step is skipped', async () => {
    const api = fakeApi();
    renderWithStore(
      <OrgCreationWizard
        isOpen
        initialState={{
          ...createOrgWizardState({ orgName: 'Acme' }),
          createdOrgId: 'org-1',
          step: 'invite',
        }}
        onClose={() => {}}
        api={api}
      />,
    );

    fireEvent.click(screen.getByTestId('org-wizard-skip'));
    await screen.findByTestId('org-wizard-done-step');
    expect(api.inviteMember).not.toHaveBeenCalled();
  });

  it('stays on the first step and reports a failed creation', async () => {
    const api = fakeApi({
      createOrganization: vi.fn(async () => { throw new Error('alpha is invite-only'); }),
    });
    renderWithStore(<OrgCreationWizard isOpen onClose={() => {}} api={api} />);

    fireEvent.change(await screen.findByTestId('org-wizard-name-input'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('org-wizard-primary'));

    expect((await screen.findByTestId('org-wizard-error')).textContent).toContain('invite-only');
    screen.getByTestId('org-wizard-identity-step');
  });

  it('moves from account to identity when auth arrives without another click', async () => {
    jotaiStore.set(stytchAuthAtom, { isAuthenticated: false, user: null });
    const api = fakeApi();
    renderWithStore(<OrgCreationWizard isOpen onClose={() => {}} api={api} />);
    await screen.findByTestId('org-wizard-account-step');

    act(() => {
      jotaiStore.set(stytchAuthAtom, {
        isAuthenticated: true,
        user: {
          user_id: 'user-1',
          emails: [{ email: 'a@example.com', verified: true }],
        },
      });
    });

    await screen.findByTestId('org-wizard-identity-step');
    expect(api.findPendingInvitation).toHaveBeenCalledWith('a@example.com');
  });

  it('exposes a matching invitation and wires its accept action', async () => {
    const api = fakeApi({
      findPendingInvitation: vi.fn(async () => ({
        orgId: 'org-invite',
        name: 'Acme Robotics',
        email: 'a@example.com',
      })),
    });
    const onClose = vi.fn();
    renderWithStore(<OrgCreationWizard isOpen onClose={onClose} api={api} />);

    await screen.findByTestId('org-wizard-pending-invitation');
    expect(screen.queryByTestId('org-wizard-name-input')).toBeNull();
    fireEvent.click(screen.getByTestId('org-wizard-accept-invitation'));
    await waitFor(() => expect(api.acceptInvitation).toHaveBeenCalledWith('org-invite'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // Joining closes the dialog; the org window is not opened, only routed for
    // whenever the user opens it.
    expect(settings.get('orgWindowPendingRoute')).toEqual({ orgId: 'org-invite', conversationId: 'general' });
    expect(settings.get('orgWizardDraft')).toBeNull();
  });

  /**
   * The draft only exists to survive the sign-in round trip, so writes coalesce
   * rather than firing per keystroke — but a remount must still find the name.
   */
  it('coalesces draft writes and still restores the name on a remount', async () => {
    const api = fakeApi();
    const writes = () => (window.electronAPI.invoke as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel, key]) => channel === 'app-settings:set' && key === 'orgWizardDraft');

    const { unmount } = renderWithStore(
      <OrgCreationWizard isOpen onClose={() => {}} api={api} />,
    );
    const input = await screen.findByTestId('org-wizard-name-input');
    for (const value of ['A', 'Ac', 'Acm', 'Acme']) {
      fireEvent.change(input, { target: { value } });
    }

    // Four keystrokes inside one step, no write yet.
    expect(writes()).toHaveLength(0);
    unmount();
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
    expect(writes().length).toBeLessThan(4);

    renderWithStore(<OrgCreationWizard isOpen onClose={() => {}} api={api} />);
    await waitFor(() => {
      expect((screen.getByTestId('org-wizard-name-input') as HTMLInputElement).value).toBe('Acme');
    });
  });

  /**
   * Resume-on-reopen is intended, so the only way to stop the wizard resuming
   * a half-finished setup forever is an explicit discard.
   */
  it('resumes a created organization at invite and discards it from the header close', async () => {
    const api = fakeApi();
    settings.set('orgWizardDraft', {
      version: 1,
      step: 'invite',
      orgName: 'Acme',
      owner: 'a@example.com',
      sourcePersonalOrgId: 'account-1',
      workspacePath: null,
      createdOrgId: 'org-1',
      emails: [],
      invitedEmails: [],
    });

    renderWithStore(<OrgCreationWizard isOpen onClose={vi.fn()} api={api} />);
    await screen.findByTestId('org-wizard-invite-step');

    fireEvent.click(screen.getByTestId('org-wizard-close'));
    await waitFor(() => expect(settings.get('orgWizardDraft')).toBeNull());

    // A wizard opened after the discard starts over instead of resuming.
    cleanup();
    renderWithStore(<OrgCreationWizard isOpen onClose={vi.fn()} api={api} />);
    await screen.findByTestId('org-wizard-identity-step');
    expect(screen.queryByTestId('org-wizard-invite-step')).toBeNull();
  });

  it('numbers the steps across the whole journey', async () => {
    const api = fakeApi();
    renderWithStore(<OrgCreationWizard isOpen onClose={() => {}} api={api} />);

    fireEvent.change(await screen.findByTestId('org-wizard-name-input'), { target: { value: 'Acme' } });
    expect(screen.getByTestId('org-wizard-step-count').textContent).toBe('Step 1 of 3');
    fireEvent.click(screen.getByTestId('org-wizard-primary'));

    await screen.findByTestId('org-wizard-invite-step');
    expect(screen.getByTestId('org-wizard-step-count').textContent).toBe('Step 2 of 3');
  });

  /**
   * Create, join, invite and room calls all end by writing state. A discard
   * accepted while one is in flight is undone by whatever returns last, so the
   * exits are closed for the duration instead.
   */
  it('ignores every dismissal while a mutation is in flight', async () => {
    let finishCreate: (result: { orgId: string }) => void = () => {};
    const api = fakeApi({
      createOrganization: vi.fn(() => new Promise<{ orgId: string }>((resolve) => {
        finishCreate = resolve;
      })),
    });
    const onClose = vi.fn();
    renderWithStore(<OrgCreationWizard isOpen onClose={onClose} api={api} />);

    fireEvent.change(await screen.findByTestId('org-wizard-name-input'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('org-wizard-primary'));
    await waitFor(() => expect(api.createOrganization).toHaveBeenCalled());

    expect((screen.getByTestId('org-wizard-cancel') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('org-wizard-close') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('org-wizard-cancel'));
    fireEvent.click(screen.getByTestId('org-wizard-close'));
    fireEvent.click(screen.getByTestId('org-creation-wizard-overlay'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    // The ignored dismissals do not resurface once the mutation lands: the
    // wizard carries on to the invite step, still open.
    await act(async () => { finishCreate({ orgId: 'org-1' }); });
    await screen.findByTestId('org-wizard-invite-step');
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByTestId('org-wizard-cancel') as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * The lookup is about one account. Signing in as somebody else while it is in
   * flight used to commit the first account's invitation into the second's
   * wizard.
   */
  it('drops an invitation answer for an account that is no longer signed in', async () => {
    let answerLookup: (invitation: { orgId: string; name: string; email: string } | null) => void = () => {};
    const api = fakeApi({
      findPendingInvitation: vi.fn((email: string) => (
        email === 'a@example.com'
          ? new Promise<{ orgId: string; name: string; email: string } | null>((resolve) => {
            answerLookup = resolve;
          })
          : Promise.resolve(null)
      )),
    });
    renderWithStore(<OrgCreationWizard isOpen onClose={vi.fn()} api={api} />);

    await waitFor(() => expect(api.findPendingInvitation).toHaveBeenCalledWith('a@example.com'));

    act(() => {
      jotaiStore.set(stytchAuthAtom, {
        isAuthenticated: true,
        user: { user_id: 'user-2', emails: [{ email: 'b@example.com', verified: true }] },
      });
    });
    await waitFor(() => expect(api.findPendingInvitation).toHaveBeenCalledWith('b@example.com'));

    await act(async () => {
      answerLookup({ orgId: 'org-invite', name: 'Acme Robotics', email: 'a@example.com' });
    });

    expect(screen.queryByTestId('org-wizard-pending-invitation')).toBeNull();
    expect(await screen.findByTestId('org-wizard-identity-step')).toBeTruthy();
  });

  /** Signing out mid-lookup starts no replacement lookup to supersede it. */
  it('drops an invitation answer that lands after the user signed out', async () => {
    let answerLookup: (invitation: { orgId: string; name: string; email: string } | null) => void = () => {};
    const api = fakeApi({
      findPendingInvitation: vi.fn(() => new Promise<{ orgId: string; name: string; email: string } | null>((resolve) => {
        answerLookup = resolve;
      })),
    });
    renderWithStore(<OrgCreationWizard isOpen onClose={vi.fn()} api={api} />);

    await waitFor(() => expect(api.findPendingInvitation).toHaveBeenCalledWith('a@example.com'));

    act(() => {
      jotaiStore.set(stytchAuthAtom, { isAuthenticated: false, user: null });
    });
    await act(async () => {
      answerLookup({ orgId: 'org-invite', name: 'Acme Robotics', email: 'a@example.com' });
    });

    expect(screen.queryByTestId('org-wizard-pending-invitation')).toBeNull();
    expect(api.findPendingInvitation).toHaveBeenCalledTimes(1);
  });

  /**
   * The retired CreateTeamDialog owned new organizations with the sync account;
   * the wizard's picker took whichever row the directory returned first.
   */
  it('owns the organization with the sync account by default', async () => {
    (window.electronAPI.stytch.getAccounts as ReturnType<typeof vi.fn>).mockResolvedValue([
      { personalOrgId: 'work', email: 'work@example.com', isSyncAccount: false, sessionStatus: 'active' },
      { personalOrgId: 'personal', email: 'a@example.com', isSyncAccount: true, sessionStatus: 'active' },
    ]);
    const api = fakeApi();
    renderWithStore(<OrgCreationWizard isOpen onClose={vi.fn()} api={api} />);

    const select = await screen.findByTestId('org-wizard-account-select') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('personal'));

    fireEvent.change(screen.getByTestId('org-wizard-name-input'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('org-wizard-primary'));
    await waitFor(() => expect(api.createOrganization).toHaveBeenCalledWith({
      name: 'Acme',
      sourcePersonalOrgId: 'personal',
    }));
  });

  /**
   * The overwhelmingly common case is one stored account. There is no choice to
   * make, so the wizard shows no picker and creates the org under the sole
   * account without the user touching anything.
   */
  it('creates under the only account without showing a picker', async () => {
    (window.electronAPI.stytch.getAccounts as ReturnType<typeof vi.fn>).mockResolvedValue([
      { personalOrgId: 'solo', email: 'solo@example.com', isSyncAccount: true, sessionStatus: 'active' },
    ]);
    const api = fakeApi();
    renderWithStore(<OrgCreationWizard isOpen onClose={vi.fn()} api={api} />);

    fireEvent.change(await screen.findByTestId('org-wizard-name-input'), { target: { value: 'Acme' } });
    // The owner is stated, not chosen.
    await screen.findByTestId('org-wizard-owner-hint');
    expect(screen.queryByTestId('org-wizard-account-select')).toBeNull();

    fireEvent.click(screen.getByTestId('org-wizard-primary'));
    await waitFor(() => expect(api.createOrganization).toHaveBeenCalledWith({
      name: 'Acme',
      sourcePersonalOrgId: 'solo',
    }));
  });

  /** A stored choice can name an account that has since been signed out. */
  it('replaces a restored account choice that no longer exists', async () => {
    settings.set('orgWizardDraft', {
      version: 1,
      step: 'identity',
      orgName: 'Acme',
      owner: 'a@example.com',
      sourcePersonalOrgId: 'removed-account',
      workspacePath: null,
      createdOrgId: null,
      emails: [],
      invitedEmails: [],
    });
    (window.electronAPI.stytch.getAccounts as ReturnType<typeof vi.fn>).mockResolvedValue([
      { personalOrgId: 'work', email: 'work@example.com', isSyncAccount: false, sessionStatus: 'active' },
      { personalOrgId: 'personal', email: 'a@example.com', isSyncAccount: true, sessionStatus: 'active' },
    ]);
    const api = fakeApi();
    renderWithStore(<OrgCreationWizard isOpen onClose={vi.fn()} api={api} />);

    const select = await screen.findByTestId('org-wizard-account-select') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('personal'));
  });

  /** The draft key is global; the identity that typed it is not. */
  it('does not hand one account\'s draft to the next account signing in', async () => {
    settings.set('orgWizardDraft', {
      version: 1,
      step: 'identity',
      orgName: 'Someone else\'s org',
      owner: 'previous@example.com',
      sourcePersonalOrgId: '',
      workspacePath: null,
      createdOrgId: null,
      emails: ['their-team@example.com'],
      invitedEmails: [],
    });
    const api = fakeApi();
    renderWithStore(<OrgCreationWizard isOpen onClose={vi.fn()} api={api} />);

    const input = await screen.findByTestId('org-wizard-name-input') as HTMLInputElement;
    expect(input.value).toBe('');
    await waitFor(() => expect(settings.get('orgWizardDraft')).toBeNull());
  });

  it('rejects text that cannot be an email address', async () => {
    const api = fakeApi();
    renderWithStore(
      <OrgCreationWizard
        isOpen
        initialState={{
          ...createOrgWizardState({ orgName: 'Acme' }),
          createdOrgId: 'org-1',
          step: 'invite',
        }}
        onClose={() => {}}
        api={api}
      />,
    );

    fireEvent.change(screen.getByTestId('org-wizard-email-input'), { target: { value: 'not-an-email ' } });
    expect((await screen.findByTestId('org-wizard-email-invalid')).textContent).toContain('not-an-email');
    expect(screen.queryAllByTestId('org-wizard-email-chip')).toHaveLength(0);
  });
});
