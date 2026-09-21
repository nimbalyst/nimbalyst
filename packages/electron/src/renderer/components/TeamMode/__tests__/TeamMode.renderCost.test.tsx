// @vitest-environment jsdom
/**
 * Navigation repaint cost, measured rather than asserted by inspection.
 *
 * A route change must wake only the rows being left and entered. Before Slice
 * 5 it repainted the whole chrome, including every sidebar row. That cost is
 * invisible in a static review, so this file measures the row components
 * directly with the render-budget harness.
 *
 * The room pane and the Inbox are stubbed so the count is the chrome's alone.
 */

// MUST be the first import: it installs the DevTools hook shim that the render
// profiler reads, and react-dom captures that hook once at module init.
import { measureRenders } from '../../../devtools/renderBudget';

import React from 'react';
import { createHydratedOrgStore } from './organizationTestStore';
import { Provider } from 'jotai';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import {
  conversationDirectoryAtomFamily,
  conversationDirectoryLoadStateAtomFamily,
} from '../../../store/atoms/conversations';
import { teamInboxSnapshotAtom } from '../../../store/atoms/teamInbox';
import { OrgModeHost } from '../OrgModeHost';
import { ORG_WINDOW_SURFACE_ID } from '../orgWindowState';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: () => <span />,
}));
vi.mock('../RoomView', () => ({ RoomView: () => <div data-testid="room-view-stub" /> }));
vi.mock('../Inbox', () => ({ InboxSection: () => <div data-testid="inbox-stub" /> }));
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

async function seedStore() {
  const store = await createHydratedOrgStore();
  store.set(conversationDirectoryAtomFamily('org-1'), CONVERSATIONS);
  store.set(conversationDirectoryLoadStateAtomFamily('org-1'), { status: 'ready' });
  return store;
}

function renderHost(store: Awaited<ReturnType<typeof seedStore>>) {
  render(
    <Provider store={store}>
      <OrgModeHost orgId="org-1" surfaceId={ORG_WINDOW_SURFACE_ID} chrome="window" />
    </Provider>,
  );
}

describe('org window navigation repaint cost', () => {
  afterEach(() => cleanup());

  it('keeps an inbox-to-room navigation to one sidebar-row render', async () => {
    installApi();
    renderHost(await seedStore());

    await waitFor(() => screen.getByTestId('org-room-item-general'));
    await waitFor(() => screen.getByTestId('inbox-stub'));
    // Let the mount-time effects (roster, directory retry, route-state IPC)
    // settle so what follows is the navigation's cost alone.
    await act(async () => { await Promise.resolve(); });

    const budget = await measureRenders(async () => {
      await act(async () => { screen.getByTestId('org-room-item-general').click(); });
    });
    await waitFor(() => screen.getByTestId('room-view-stub'));

    // Two rows and no more: the one being left and the one being entered. The
    // other eight subscribe to a boolean that stayed false and hear nothing.
    // Hoisting that subscription would wake the whole list.
    expect(budget.rendersOf('OrgSidebarRow'), budget.report()).toBe(2);
  });

  it('does not repaint the sidebar for an inbox snapshot that changed elsewhere', async () => {
    installApi();
    const store = await seedStore();
    renderHost(store);

    await waitFor(() => screen.getByTestId('org-room-item-general'));
    await act(async () => { await Promise.resolve(); });

    // A delivery in a different organization, and a presence heartbeat for one:
    // this window's sidebar shows neither.
    const budget = await measureRenders(async () => {
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
    });

    expect(budget.rendersOf('OrgSidebarRow'), budget.report()).toBe(0);
  });

  it('keeps a room-to-room navigation to the two rows that changed', async () => {
    installApi();
    renderHost(await seedStore());

    await waitFor(() => screen.getByTestId('org-room-item-general'));
    await act(async () => { screen.getByTestId('org-room-item-general').click(); });
    await waitFor(() => screen.getByTestId('room-view-stub'));
    await act(async () => { await Promise.resolve(); });

    const budget = await measureRenders(async () => {
      await act(async () => { screen.getByTestId('org-room-item-design').click(); });
    });

    // #general and #design. The Inbox rows above them do not hear a room hop.
    expect(budget.rendersOf('OrgSidebarRow'), budget.report()).toBe(2);
  });

  // The Inbox used to be torn down on every hop into a room, which re-read the
  // stored preferences over IPC, restarted its relative-label timer and dropped
  // the search and selection on the way.
  it('keeps the Inbox mounted while visiting a room', async () => {
    installApi();
    renderHost(await seedStore());

    const inbox = await waitFor(() => screen.getByTestId('inbox-stub'));

    await act(async () => { screen.getByTestId('org-room-item-general').click(); });
    await waitFor(() => screen.getByTestId('room-view-stub'));

    expect(screen.getByTestId('inbox-stub')).toBe(inbox);
  });
});
