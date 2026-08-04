// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import { TeamMode } from '../TeamMode';
import { DEFAULT_ORG_WINDOW_ROUTE, orgWindowRouteAtom } from '../orgWindowState';

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
 * The org window lands on the Inbox and every surface it has is full-bleed:
 * administration — the only thing that wanted the 900px form column — is the
 * `ORG_MANAGEMENT` dialog since NIM-2322. Both are deliberate placement
 * decisions, so they are asserted rather than left to whichever edit touches
 * the file next.
 */
describe('TeamMode org window navigation', () => {
  afterEach(() => cleanup());

  it('opens on the Inbox, full width, in one content region', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-1');
    const { container } = render(<Provider store={store}><TeamMode /></Provider>);

    expect(DEFAULT_ORG_WINDOW_ROUTE.view).toBe('inbox');
    await waitFor(() => screen.getByTestId('inbox'));
    const mains = container.querySelectorAll('.team-mode-content');
    expect(mains).toHaveLength(1);
    expect(mains[0].classList.contains('team-mode-content-full')).toBe(true);
    // The administration column cap must not apply to the two-pane surface.
    expect(mains[0].querySelector('.max-w-\\[900px\\]')).toBeNull();
  });

  it('has no administration destinations left in the sidebar', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-1');
    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => screen.getByTestId('org-sidebar'));
    expect(screen.queryByTestId('org-admin-toggle')).toBeNull();
    for (const tab of ['members', 'projects', 'settings', 'billing', 'danger']) {
      expect(screen.queryByTestId(`team-tab-${tab}`)).toBeNull();
    }
  });

  it('redirects a stale administration route back to the messaging surface', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-1');
    // A hand-off or deep link left over from when this window administered the
    // organization. It must not render an empty content region.
    store.set(orgWindowRouteAtom, { view: 'admin', adminTab: 'members' });
    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(store.get(orgWindowRouteAtom))
      .toEqual(DEFAULT_ORG_WINDOW_ROUTE));
    await waitFor(() => screen.getByTestId('inbox'));
    expect(screen.queryByTestId('members')).toBeNull();
  });

  it('opens the rooms directory from the sidebar', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-1');
    render(<Provider store={store}><TeamMode /></Provider>);

    // The directory has no row of its own any more — it is an item in the
    // rooms section's + menu.
    await waitFor(() => screen.getByTestId('org-rooms-section-add'));
    screen.getByTestId('org-rooms-section-add').click();
    await waitFor(() => screen.getByTestId('org-browse-rooms'));
    screen.getByTestId('org-browse-rooms').click();

    await waitFor(() => screen.getByTestId('org-rooms-directory'));
  });
});
