// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import {
  ADMIN_TABS,
  DEFAULT_ADMIN_TAB,
  FULL_WIDTH_TABS,
  TeamMode,
} from '../TeamMode';

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
      team: { findForWorkspace: vi.fn().mockResolvedValue(null) },
      organization: { list: vi.fn().mockResolvedValue({ success: true, teams: [team] }) },
      stytch: { getAccounts: vi.fn().mockResolvedValue([{ personalOrgId: 'account-1', email: 'a@example.com' }]) },
      openExternal: vi.fn(),
    },
  });
}

/**
 * The org window lands on the Inbox, and the Inbox is the tab that opts out of
 * the 900px administration column. Both are deliberate placement decisions, so
 * they are asserted rather than left to whichever edit touches the file next.
 */
describe('TeamMode admin tabs', () => {
  afterEach(() => cleanup());

  it('lists the tabs in the shipped order with the Inbox first', () => {
    expect(ADMIN_TABS.map((entry) => entry.id)).toEqual([
      'inbox',
      'members',
      'projects',
      'billing',
      'danger',
    ]);
    expect(DEFAULT_ADMIN_TAB).toBe('inbox');
    expect([...FULL_WIDTH_TABS]).toEqual(['inbox']);
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

  it('restores the administration column on an administration tab', async () => {
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
});
