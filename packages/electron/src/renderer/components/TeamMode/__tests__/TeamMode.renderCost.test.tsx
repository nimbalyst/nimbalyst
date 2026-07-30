// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import {
  conversationDirectoryAtomFamily,
  conversationDirectoryLoadStateAtomFamily,
} from '../../../store/atoms/conversations';
import { teamInboxSnapshotAtom } from '../../../store/atoms/teamInbox';
import { TeamMode } from '../TeamMode';

/**
 * Navigation repaint cost, measured rather than asserted by inspection.
 *
 * Every sidebar row renders exactly one `MaterialSymbol`, so counting how many
 * times the icon renders is a direct count of how much of the window a small
 * navigation repainted. Before Slice 5 a route change re-rendered the entire
 * body — rail, every sidebar row, the admin group and the title bar — which is
 * what Greg saw as "small navigations repaint the whole window".
 *
 * The room pane and the Inbox are stubbed so the count is the chrome's alone.
 */
const counts = { symbol: 0 };
const icons: string[] = [];

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => {
    counts.symbol += 1;
    icons.push(icon);
    return <span>{icon}</span>;
  },
}));

vi.mock('../RoomView', () => ({
  RoomView: () => <div data-testid="room-view-stub" />,
}));
vi.mock('../Inbox', () => ({
  InboxSection: () => <div data-testid="inbox-stub" />,
}));
vi.mock('../../Settings/panels/OrganizationMembersRolesPanel', () => ({
  OrganizationMembersRolesPanel: () => <div data-testid="members" />,
}));
vi.mock('../../Settings/panels/OrganizationProjectsPanel', () => ({ OrganizationProjectsPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationBillingPanel', () => ({ OrganizationBillingPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationDangerZone', () => ({ OrganizationDangerZone: () => <div /> }));
vi.mock('../../Settings/panels/ProjectSharingPanel', () => ({ ProjectSharingPanel: () => <div /> }));

const team = {
  orgId: 'org-1',
  name: 'Acme',
  boundPersonalOrgId: 'account-1',
  membershipType: 'active_member',
  role: 'owner',
};

function room(id: string, title: string): ConversationDirectoryEntry {
  return {
    id,
    orgId: 'org-1',
    kind: 'orgRoom',
    title,
    visibility: 'public',
    createdAt: 0,
    createdByUserId: 'member-1',
    agentPostingEnabled: false,
    capabilities: ['read', 'comment', 'react'],
  } as ConversationDirectoryEntry;
}

const CONVERSATIONS = [
  room('general', 'General'),
  room('design', 'design'),
  room('eng', 'eng'),
  room('random', 'random'),
];

function installApi() {
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
      send: vi.fn(),
      openExternal: vi.fn(),
      openAccountSettings: vi.fn().mockResolvedValue({ success: true }),
    },
  });
}

function seedStore() {
  const store = createStore();
  store.set(selectedOrgIdAtom, 'org-1');
  store.set(conversationDirectoryAtomFamily('org-1'), CONVERSATIONS);
  store.set(conversationDirectoryLoadStateAtomFamily('org-1'), { status: 'ready' });
  return store;
}

describe('org window navigation repaint cost', () => {
  afterEach(() => cleanup());

  it('repaints only the rows whose selection changed when the route changes', async () => {
    installApi();
    const store = seedStore();
    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(screen.getByTestId('org-room-item-general')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('inbox-stub')).toBeTruthy());
    // Let the mount-time effects (roster, directory retry, route-state IPC)
    // settle so what follows is the navigation's cost alone.
    await act(async () => { await Promise.resolve(); });

    const before = counts.symbol;
    await act(async () => { screen.getByTestId('org-room-item-general').click(); });
    await waitFor(() => expect(screen.getByTestId('room-view-stub')).toBeTruthy());
    const navigationCost = counts.symbol - before;

    // Measured: 15 icon renders before Slice 5 — the whole chrome — against 2
    // after. Inbox deselects, #general selects, and nothing else repaints.
    expect(icons.slice(before)).toEqual(['inbox', 'tag']);
    expect(navigationCost).toBe(2);
  });

  it('does not repaint the sidebar for an inbox snapshot that changed elsewhere', async () => {
    installApi();
    const store = seedStore();
    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(screen.getByTestId('org-room-item-general')).toBeTruthy());
    await act(async () => { await Promise.resolve(); });

    const before = counts.symbol;
    // A delivery in a different organization, and a presence heartbeat for one:
    // this window's sidebar shows neither.
    await act(async () => {
      store.set(teamInboxSnapshotAtom, {
        status: 'ready',
        deliveries: [{
          id: 'delivery-1',
          orgId: 'org-other',
          createdAt: 1,
          source: { kind: 'roomMessage', sourceId: 'other-room' },
        }],
        organizations: [{ orgId: 'org-1', orgName: 'Acme', status: 'ready' }],
        presence: { 'org-other': { 'member-9': { memberId: 'member-9', status: 'online' } } },
      } as never);
    });

    expect(counts.symbol - before).toBe(0);
  });

  it('repaints two rows for a room-to-room switch, not the window', async () => {
    installApi();
    const store = seedStore();
    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(screen.getByTestId('org-room-item-general')).toBeTruthy());
    await act(async () => { screen.getByTestId('org-room-item-general').click(); });
    await waitFor(() => expect(screen.getByTestId('room-view-stub')).toBeTruthy());
    await act(async () => { await Promise.resolve(); });

    const before = counts.symbol;
    await act(async () => { screen.getByTestId('org-room-item-design').click(); });

    // #general deselects, #design selects. Both are public rooms, so both are
    // the same icon — two rows, and only two.
    expect(icons.slice(before)).toEqual(['tag', 'tag']);
  });

  // The Inbox used to be torn down on every hop into a room, which re-read the
  // stored preferences over IPC, restarted its relative-label timer and dropped
  // the search and selection on the way.
  it('keeps the Inbox mounted and hidden once it has been visited', async () => {
    installApi();
    const store = seedStore();
    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(screen.getByTestId('inbox-stub')).toBeTruthy());
    expect(screen.getByTestId('team-mode-inbox-slot').className)
      .not.toContain('hidden');

    await act(async () => { screen.getByTestId('org-room-item-general').click(); });
    await waitFor(() => expect(screen.getByTestId('room-view-stub')).toBeTruthy());

    expect(screen.getByTestId('inbox-stub')).toBeTruthy();
    expect(screen.getByTestId('team-mode-inbox-slot').className).toContain('hidden');
  });
});
