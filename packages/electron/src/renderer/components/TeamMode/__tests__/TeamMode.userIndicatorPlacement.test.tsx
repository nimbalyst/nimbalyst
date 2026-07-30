// @vitest-environment jsdom
/**
 * The signed-in identity belongs at the bottom of the OrgSidebar in every
 * layout — never in the org rail.
 *
 * It used to move: rail-variant at the bottom of the rail once a second
 * organization appeared, sidebar-variant only while the rail was hidden. That
 * put identity on the window-level switcher, which is wrong — Stytch gives a
 * different member id per organization, so the identity on screen is a property
 * of the organization in view, and the sidebar is the per-organization pane.
 *
 * Both layouts are asserted because the rail appears only with a second
 * organization, and the old behaviour differed precisely across that threshold.
 */
import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

const ORG_ONE = { orgId: 'org-1', name: 'Acme', boundPersonalOrgId: 'account-1', membershipType: 'active_member' };
const ORG_TWO = { orgId: 'org-2', name: 'Beta Co', boundPersonalOrgId: 'account-1', membershipType: 'active_member' };

function installApi(teams: unknown[]) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      team: {
        findForWorkspace: vi.fn().mockResolvedValue(null),
        resolveOrgProjectsLocalState: vi.fn().mockResolvedValue({ success: true, projects: [] }),
        openProjectWorkspace: vi.fn().mockResolvedValue({ success: true }),
      },
      organization: {
        list: vi.fn().mockResolvedValue({ success: true, teams }),
        listMembers: vi.fn().mockResolvedValue({ success: true, members: [], callerRole: 'owner' }),
      },
      stytch: { getAccounts: vi.fn().mockResolvedValue([{ personalOrgId: 'account-1', email: 'a@example.com' }]) },
      invoke: vi.fn().mockResolvedValue([]),
      on: vi.fn().mockReturnValue(() => {}),
      openExternal: vi.fn(),
      openAccountSettings: vi.fn().mockResolvedValue({ success: true }),
      settingsSet: vi.fn().mockResolvedValue(undefined),
    },
  });
}

function renderWindow() {
  const store = createStore();
  store.set(selectedOrgIdAtom, 'org-1');
  return render(<Provider store={store}><TeamMode /></Provider>);
}

async function indicator() {
  await waitFor(() => expect(screen.getByTestId('org-user-indicator')).toBeTruthy());
  return screen.getByTestId('org-user-indicator');
}

describe('org user indicator placement', () => {
  afterEach(() => cleanup());

  it('sits in the sidebar footer, not the rail, when the rail is visible (two orgs)', async () => {
    installApi([ORG_ONE, ORG_TWO]);
    renderWindow();

    // The rail is the layout that used to swallow the indicator.
    await waitFor(() => expect(screen.getByTestId('org-rail')).toBeTruthy());

    const el = await indicator();
    expect(el.closest('[data-testid="org-sidebar"]')).toBeTruthy();
    expect(el.closest('[data-testid="org-rail"]')).toBeNull();
    expect(screen.getByTestId('org-rail').querySelector('[data-testid="org-user-indicator"]')).toBeNull();
  });

  it('sits in the sidebar footer when the rail is hidden (single org)', async () => {
    installApi([ORG_ONE]);
    renderWindow();

    const el = await indicator();
    expect(screen.queryByTestId('org-rail')).toBeNull();
    expect(el.closest('[data-testid="org-sidebar"]')).toBeTruthy();
  });

  it('renders exactly one indicator in the rail-visible layout', async () => {
    // Rendering it in both places would double the account popover and the
    // presence toggle that writes through it.
    installApi([ORG_ONE, ORG_TWO]);
    renderWindow();

    await indicator();
    expect(screen.getAllByTestId('org-user-indicator')).toHaveLength(1);
    expect(screen.getAllByTestId('org-user-indicator-button')).toHaveLength(1);
  });

  it('shows the identity line (initials, presence dot, name) in both layouts', async () => {
    installApi([ORG_ONE, ORG_TWO]);
    renderWindow();

    const el = await indicator();
    // The rail variant was avatar-only; the sidebar variant carries the name
    // line, so losing it would mean the rail markup leaked back in.
    expect(el.querySelector('.org-user-indicator-avatar')).toBeTruthy();
    expect(el.querySelector('.org-user-indicator-dot')).toBeTruthy();
    expect(el.textContent).toContain('a');
    expect(el.classList).toContain('org-user-indicator-sidebar');
  });

  it('keeps the indicator button out of the window drag region', async () => {
    // The sidebar is `-webkit-app-region: drag`; a control inside it that does
    // not opt out is a button the OS swallows.
    installApi([ORG_ONE, ORG_TWO]);
    renderWindow();

    await indicator();
    expect(screen.getByTestId('org-user-indicator-button').classList).toContain('org-window-no-drag');
  });
});
