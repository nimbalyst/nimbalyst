// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import { TeamMode } from '../TeamMode';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));
vi.mock('../Inbox', () => ({ InboxSection: () => <div data-testid="inbox" /> }));
vi.mock('../../Settings/panels/OrganizationMembersRolesPanel', () => ({
  OrganizationMembersRolesPanel: () => <div data-testid="members" />,
}));
vi.mock('../../Settings/panels/OrganizationProjectsPanel', () => ({ OrganizationProjectsPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationBillingPanel', () => ({ OrganizationBillingPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationDangerZone', () => ({ OrganizationDangerZone: () => <div /> }));
vi.mock('../../Settings/panels/ProjectSharingPanel', () => ({ ProjectSharingPanel: () => <div /> }));

const team = { orgId: 'org-1', name: 'Acme', boundPersonalOrgId: 'account-1', membershipType: 'active_member' };

function installApi() {
  const settingsSet = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      team: {
        findForWorkspace: vi.fn().mockResolvedValue(null),
        resolveOrgProjectsLocalState: vi.fn().mockResolvedValue({ success: true, projects: [] }),
        openProjectWorkspace: vi.fn().mockResolvedValue({ success: true }),
      },
      organization: {
        list: vi.fn().mockResolvedValue({ success: true, teams: [team] }),
        listMembers: vi.fn().mockResolvedValue({ success: true, members: [], callerRole: 'owner' }),
      },
      stytch: { getAccounts: vi.fn().mockResolvedValue([{ personalOrgId: 'account-1', email: 'a@example.com' }]) },
      invoke: vi.fn().mockResolvedValue([]),
      on: vi.fn().mockReturnValue(() => {}),
      openExternal: vi.fn(),
      openAccountSettings: vi.fn().mockResolvedValue({ success: true }),
      settingsSet,
    },
  });
  return { settingsSet };
}

function renderWindow() {
  const store = createStore();
  store.set(selectedOrgIdAtom, 'org-1');
  return render(<Provider store={store}><TeamMode /></Provider>);
}

/**
 * The org window's preferences have to be reachable from the window itself —
 * it is a separate window, so the main window's settings dialog is not an
 * answer. Both entry points are asserted because either one going missing
 * leaves the preference unreachable for whichever layout the user is in (the
 * rail appears only with a second organization).
 */
describe('org window preferences', () => {
  afterEach(() => cleanup());

  it('opens the preferences dialog from the title-bar gear', async () => {
    installApi();
    renderWindow();

    await waitFor(() => expect(screen.getByTestId('org-window-preferences')).toBeTruthy());
    expect(screen.queryByTestId('org-preferences-dialog')).toBeNull();

    fireEvent.click(screen.getByTestId('org-window-preferences'));

    await waitFor(() => expect(screen.getByTestId('org-preferences-dialog')).toBeTruthy());
    expect(screen.getByTestId('org-preferences-message-display')).toBeTruthy();
  });

  it('keeps the gear out of the window drag region', async () => {
    installApi();
    renderWindow();

    // The title bar is `-webkit-app-region: drag`; a control inside it that
    // does not opt out is a button the OS swallows.
    await waitFor(() => expect(screen.getByTestId('org-window-preferences')).toBeTruthy());
    expect(screen.getByTestId('org-window-preferences').classList).toContain('org-window-no-drag');
  });

  it('opens the preferences dialog from the account popover', async () => {
    installApi();
    renderWindow();

    await waitFor(() => expect(screen.getByTestId('org-user-indicator-button')).toBeTruthy());
    fireEvent.click(screen.getByTestId('org-user-indicator-button'));

    await waitFor(() => expect(screen.getByTestId('org-user-popover-preferences')).toBeTruthy());
    fireEvent.click(screen.getByTestId('org-user-popover-preferences'));

    await waitFor(() => expect(screen.getByTestId('org-preferences-dialog')).toBeTruthy());
    // The popover closes behind the dialog rather than stacking with it.
    expect(screen.queryByTestId('org-user-popover')).toBeNull();
  });

  it('writes the density preference through the settings registry, not local state', async () => {
    const { settingsSet } = installApi();
    renderWindow();

    await waitFor(() => expect(screen.getByTestId('org-window-preferences')).toBeTruthy());
    fireEvent.click(screen.getByTestId('org-window-preferences'));
    await waitFor(() => expect(screen.getByTestId('org-preferences-dialog')).toBeTruthy());

    // Comfortable is the default and is shown as the current choice.
    expect(screen.getByTestId('org-preferences-density-comfortable').getAttribute('data-selected')).toBe('true');
    expect(screen.getByTestId('org-preferences-density-compact').getAttribute('data-selected')).toBe('false');

    fireEvent.click(screen.getByTestId('org-preferences-density-compact'));

    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('team.messages.density', 'compact'));
  });

  it('closes the dialog from Done', async () => {
    installApi();
    renderWindow();

    await waitFor(() => expect(screen.getByTestId('org-window-preferences')).toBeTruthy());
    fireEvent.click(screen.getByTestId('org-window-preferences'));
    await waitFor(() => expect(screen.getByTestId('org-preferences-dialog')).toBeTruthy());

    fireEvent.click(screen.getByTestId('org-preferences-done'));

    await waitFor(() => expect(screen.queryByTestId('org-preferences-dialog')).toBeNull());
  });
});
