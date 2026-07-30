// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import type { OrgSettings } from '../../../../shared/orgSettings';
import { conversationDirectoryAtomFamily } from '../../../store/atoms/conversations';
import { orgSettingsAtomFamily } from '../../../store/atoms/orgSettings';
import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import { TeamMode } from '../TeamMode';
import { orgWindowRouteAtom } from '../orgWindowState';

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
vi.mock('../../Settings/panels/OrganizationSettingsPanel', () => ({
  OrganizationSettingsPanel: ({ callerRole }: { callerRole?: string }) => (
    <div data-testid="org-settings-panel" data-caller-role={callerRole} />
  ),
}));

const team = { orgId: 'org-1', name: 'Acme', boundPersonalOrgId: 'account-1', membershipType: 'active_member' };

const conversations: ConversationDirectoryEntry[] = [
  {
    id: 'general',
    orgId: 'org-1',
    kind: 'orgRoom',
    visibility: 'public',
    title: 'General',
    agentPostingEnabled: false,
    createdByUserId: 'member-a',
    createdAt: 1,
    capabilities: ['read', 'comment'],
  },
  {
    id: 'dm-1',
    orgId: 'org-1',
    kind: 'dm',
    visibility: 'private',
    agentPostingEnabled: false,
    createdByUserId: 'member-a',
    createdAt: 2,
    capabilities: ['read', 'comment'],
  },
];

function installApi(callerRole = 'owner') {
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
        listMembers: vi.fn().mockResolvedValue({ success: true, members: [], callerRole }),
      },
      stytch: { getAccounts: vi.fn().mockResolvedValue([{ personalOrgId: 'account-1', email: 'a@example.com' }]) },
      invoke: vi.fn().mockResolvedValue([]),
      on: vi.fn().mockReturnValue(() => {}),
      openExternal: vi.fn(),
      openAccountSettings: vi.fn().mockResolvedValue({ success: true }),
    },
  });
}

function renderWindow(settings: Partial<OrgSettings['messaging']> = {}) {
  const store = createStore();
  store.set(selectedOrgIdAtom, 'org-1');
  store.set(conversationDirectoryAtomFamily('org-1'), conversations);
  store.set(orgSettingsAtomFamily('org-1'), {
    version: 1,
    messaging: {
      roomsEnabled: true,
      dmsEnabled: true,
      roomCreation: 'members',
      ...settings,
    },
  });
  render(<Provider store={store}><TeamMode /></Provider>);
  return store;
}

describe('TeamMode organization settings gating', () => {
  afterEach(() => cleanup());

  it('opens the Settings admin panel with the viewer role', async () => {
    installApi('admin');
    renderWindow();

    await waitFor(() => expect(screen.getByTestId('team-tab-settings')).toBeTruthy());
    screen.getByTestId('team-tab-settings').click();

    await waitFor(() => expect(screen.getByTestId('org-settings-panel')).toBeTruthy());
    expect(screen.getByTestId('org-settings-panel').getAttribute('data-caller-role')).toBe('admin');
  });

  it('hides rooms, the directory entry and the create control when rooms are off', async () => {
    installApi();
    renderWindow({ roomsEnabled: false });

    await waitFor(() => expect(screen.getByTestId('org-dm-item-dm-1')).toBeTruthy());
    expect(screen.queryByTestId('org-room-item-general')).toBeNull();
    expect(screen.queryByTestId('org-browse-rooms')).toBeNull();
    expect(screen.queryByTestId('org-rooms-section-add')).toBeNull();
    // Never gated.
    expect(screen.getByTestId('team-tab-inbox')).toBeTruthy();
    expect(screen.getByTestId('team-tab-settings')).toBeTruthy();
  });

  it('hides direct messages when DMs are off, leaving rooms alone', async () => {
    installApi();
    renderWindow({ dmsEnabled: false });

    await waitFor(() => expect(screen.getByTestId('org-room-item-general')).toBeTruthy());
    expect(screen.queryByTestId('org-dm-item-dm-1')).toBeNull();
    expect(screen.queryByTestId('org-dms-section-add')).toBeNull();
  });

  it('disables the room [+] for a member when creation is admins-only', async () => {
    installApi('member');
    renderWindow({ roomCreation: 'admins' });

    await waitFor(() => expect(screen.getByTestId('org-room-item-general')).toBeTruthy());
    // The rooms [+] now opens a menu, so the restriction lands on the create
    // item inside it — browsing the directory stays available to a member.
    screen.getByTestId('org-rooms-section-add').click();
    await waitFor(() => expect(screen.getByTestId('org-create-room')).toBeTruthy());
    expect((screen.getByTestId('org-create-room') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('org-browse-rooms') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('org-dms-section-add') as HTMLButtonElement).disabled).toBe(false);
  });

  it('hides the administration-only panels from a member and bounces a route into one', async () => {
    installApi('member');
    const store = renderWindow();

    await waitFor(() => expect(screen.getByTestId('team-tab-members')).toBeTruthy());
    expect(screen.queryByTestId('team-tab-billing')).toBeNull();
    expect(screen.queryByTestId('team-tab-danger')).toBeNull();

    // A deep link or a demotion can still point the window at one.
    store.set(orgWindowRouteAtom, { view: 'admin', adminTab: 'danger' });
    await waitFor(() => expect(store.get(orgWindowRouteAtom)).toEqual({ view: 'inbox' }));
  });

  it('keeps the administration-only panels for an admin', async () => {
    installApi('admin');
    renderWindow();

    await waitFor(() => expect(screen.getByTestId('team-tab-danger')).toBeTruthy());
    expect(screen.getByTestId('team-tab-billing')).toBeTruthy();
  });

  it('moves an open room back to the inbox when rooms are turned off', async () => {
    installApi();
    const store = renderWindow();

    await waitFor(() => expect(screen.getByTestId('org-room-item-general')).toBeTruthy());
    store.set(orgWindowRouteAtom, { view: 'conversation', conversationId: 'general' });

    store.set(orgSettingsAtomFamily('org-1'), {
      version: 1,
      messaging: { roomsEnabled: false, dmsEnabled: true, roomCreation: 'members' },
    });

    await waitFor(() => expect(store.get(orgWindowRouteAtom)).toEqual({ view: 'inbox' }));
  });
});
