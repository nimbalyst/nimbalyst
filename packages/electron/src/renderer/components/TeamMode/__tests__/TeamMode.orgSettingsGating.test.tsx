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

  // The Settings panel and the rest of administration moved to the
  // ORG_MANAGEMENT dialog (NIM-2322), which carries the viewer role into them
  // — see OrgManagementDialog.test.tsx. This window hosts none of them, for an
  // admin either.
  it('hosts no administration panel, even for an admin', async () => {
    installApi('admin');
    renderWindow();

    await waitFor(() => screen.getByTestId('org-sidebar'));
    expect(screen.queryByTestId('org-settings-panel')).toBeNull();
    for (const tab of ['members', 'projects', 'settings', 'billing', 'danger']) {
      expect(screen.queryByTestId(`team-tab-${tab}`)).toBeNull();
    }
  });

  it('hides rooms, the directory entry and the create control when rooms are off', async () => {
    installApi();
    renderWindow({ roomsEnabled: false });

    await waitFor(() => screen.getByTestId('org-dm-item-dm-1'));
    expect(screen.queryByTestId('org-room-item-general')).toBeNull();
    expect(screen.queryByTestId('org-browse-rooms')).toBeNull();
    expect(screen.queryByTestId('org-rooms-section-add')).toBeNull();
    // Never gated.
    screen.getByTestId('team-tab-inbox');
  });

  it('hides direct messages when DMs are off, leaving rooms alone', async () => {
    installApi();
    renderWindow({ dmsEnabled: false });

    await waitFor(() => screen.getByTestId('org-room-item-general'));
    expect(screen.queryByTestId('org-dm-item-dm-1')).toBeNull();
    expect(screen.queryByTestId('org-dms-section-add')).toBeNull();
  });

  it('disables the room [+] for a member when creation is admins-only', async () => {
    installApi('member');
    renderWindow({ roomCreation: 'admins' });

    await waitFor(() => screen.getByTestId('org-room-item-general'));
    // The rooms [+] now opens a menu, so the restriction lands on the create
    // item inside it — browsing the directory stays available to a member.
    screen.getByTestId('org-rooms-section-add').click();
    await waitFor(() => screen.getByTestId('org-create-room'));
    expect((screen.getByTestId('org-create-room') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('org-browse-rooms') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('org-dms-section-add') as HTMLButtonElement).disabled).toBe(false);
  });

  // Role no longer decides anything about administration *here*: an admin route
  // is a destination this window does not have, so it bounces for an owner just
  // as it does for a plain member.
  it.each(['member', 'admin'])(
    'bounces an administration route out of the window for a %s',
    async (callerRole) => {
      installApi(callerRole);
      const store = renderWindow();

      await waitFor(() => screen.getByTestId('org-sidebar'));
      // A deep link or a hand-off left over from before NIM-2322.
      store.set(orgWindowRouteAtom, { view: 'admin', adminTab: 'danger' });
      await waitFor(() => expect(store.get(orgWindowRouteAtom)).toEqual({ view: 'inbox' }));
    },
  );

  it('moves an open room back to the inbox when rooms are turned off', async () => {
    installApi();
    const store = renderWindow();

    await waitFor(() => screen.getByTestId('org-room-item-general'));
    store.set(orgWindowRouteAtom, { view: 'conversation', conversationId: 'general' });

    store.set(orgSettingsAtomFamily('org-1'), {
      version: 1,
      messaging: { roomsEnabled: false, dmsEnabled: true, roomCreation: 'members' },
    });

    await waitFor(() => expect(store.get(orgWindowRouteAtom)).toEqual({ view: 'inbox' }));
  });
});
