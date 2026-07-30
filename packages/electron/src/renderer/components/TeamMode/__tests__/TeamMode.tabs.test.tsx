// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import { ADMIN_TABS, TeamMode } from '../TeamMode';
import { DEFAULT_ORG_WINDOW_ROUTE, isFullWidthRoute } from '../orgWindowState';

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
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      team: {
        findForWorkspace: vi.fn().mockResolvedValue(null),
        resolveOrgProjectsLocalState: vi.fn().mockResolvedValue({
          success: true,
          projects: [],
        }),
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
    },
  });
}

/**
 * The org window lands on the Inbox, and only the administration panels keep
 * the 900px column — the Inbox, conversations and the rooms directory are
 * full-bleed surfaces. Both are deliberate placement decisions, so they are
 * asserted rather than left to whichever edit touches the file next.
 */
describe('TeamMode org window navigation', () => {
  afterEach(() => cleanup());

  it('lists the administration panels in the shipped order, Inbox no longer among them', () => {
    expect(ADMIN_TABS.map((entry) => entry.id)).toEqual([
      'members',
      'projects',
      // Organization settings sit between Projects and Billing.
      'settings',
      'billing',
      'danger',
    ]);
    expect(DEFAULT_ORG_WINDOW_ROUTE.view).toBe('inbox');
    expect(isFullWidthRoute({ view: 'inbox' })).toBe(true);
    expect(isFullWidthRoute({ view: 'conversation', conversationId: 'general' })).toBe(true);
    expect(isFullWidthRoute({ view: 'admin', adminTab: 'members' })).toBe(false);
  });

  it('opens on the Inbox, full width, in one content region', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-1');
    const { container } = render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(screen.getByTestId('inbox')).toBeTruthy());
    const mains = container.querySelectorAll('.team-mode-content');
    expect(mains).toHaveLength(1);
    expect(mains[0].classList.contains('team-mode-content-full')).toBe(true);
    // The administration column cap must not apply to the two-pane surface.
    expect(mains[0].querySelector('.max-w-\\[900px\\]')).toBeNull();
  });

  it('restores the administration column on an administration panel', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-1');
    const { container } = render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(screen.getByTestId('team-tab-members')).toBeTruthy());
    screen.getByTestId('team-tab-members').click();

    await waitFor(() => expect(screen.getByTestId('members')).toBeTruthy());
    const mains = container.querySelectorAll('.team-mode-content');
    expect(mains).toHaveLength(1);
    expect(mains[0].classList.contains('team-mode-content-full')).toBe(false);
    expect(mains[0].querySelector('.max-w-\\[900px\\]')).not.toBeNull();
  });

  it('opens the rooms directory from the sidebar', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-1');
    render(<Provider store={store}><TeamMode /></Provider>);

    // The directory has no row of its own any more — it is an item in the
    // rooms section's + menu.
    await waitFor(() => expect(screen.getByTestId('org-rooms-section-add')).toBeTruthy());
    screen.getByTestId('org-rooms-section-add').click();
    await waitFor(() => expect(screen.getByTestId('org-browse-rooms')).toBeTruthy());
    screen.getByTestId('org-browse-rooms').click();

    await waitFor(() => expect(screen.getByTestId('org-rooms-directory')).toBeTruthy());
  });
});
