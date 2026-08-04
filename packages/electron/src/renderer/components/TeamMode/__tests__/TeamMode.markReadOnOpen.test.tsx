// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import { teamInboxSnapshotAtom } from '../../../store/atoms/teamInbox';
import {
  conversationDirectoryAtomFamily,
  conversationDirectoryLoadStateAtomFamily,
} from '../../../store/atoms/conversations';
import { InboxProviderContext, type InboxProvider } from '../Inbox/inboxProvider';
import { inboxUnreadCount } from '../orgSidebarViewModel';
import { orgWindowRouteAtom } from '../orgWindowState';
import { TeamMode } from '../TeamMode';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));
vi.mock('../Inbox', () => ({ InboxSection: () => <div data-testid="inbox" /> }));
vi.mock('../RoomView', () => ({
  RoomView: ({ entry }: { entry: ConversationDirectoryEntry }) => (
    <div data-testid="org-room-view" data-conversation-id={entry.id} />
  ),
}));
vi.mock('../../Settings/panels/OrganizationMembersRolesPanel', () => ({
  OrganizationMembersRolesPanel: () => <div />,
}));
vi.mock('../../Settings/panels/OrganizationProjectsPanel', () => ({ OrganizationProjectsPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationBillingPanel', () => ({ OrganizationBillingPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationDangerZone', () => ({ OrganizationDangerZone: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationSettingsPanel', () => ({ OrganizationSettingsPanel: () => <div /> }));
vi.mock('../../Settings/panels/ProjectSharingPanel', () => ({ ProjectSharingPanel: () => <div /> }));

const team = {
  orgId: 'org-1',
  name: 'Acme',
  boundPersonalOrgId: 'account-1',
  membershipType: 'active_member',
};

const general: ConversationDirectoryEntry = {
  id: 'general',
  orgId: 'org-1',
  kind: 'orgRoom',
  visibility: 'public',
  title: 'General',
  agentPostingEnabled: false,
  createdByUserId: 'member-a',
  createdAt: 1,
  capabilities: ['read', 'comment'],
};

function snapshotWith(
  deliveries: TeamInboxSnapshot['deliveries'],
): TeamInboxSnapshot {
  return { status: 'ready', organizations: [], deliveries };
}

function delivery(id: string, conversationId: string) {
  return {
    id,
    recipientUserId: 'member-a',
    orgId: 'org-1',
    orgName: 'Acme',
    source: {
      orgId: 'org-1',
      sourceKind: 'roomMessage' as const,
      sourceId: conversationId,
      commentId: `${id}-message`,
    },
    createdAt: 10,
    hasUnreadActivity: false,
  };
}

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
        listMembers: vi.fn().mockResolvedValue({
          success: true,
          callerRole: 'member',
          members: [{ memberId: 'member-a', email: 'a@example.com', name: 'A', role: 'member' }],
        }),
      },
      stytch: {
        getAccounts: vi.fn().mockResolvedValue([
          { personalOrgId: 'account-1', email: 'a@example.com' },
        ]),
      },
      invoke: vi.fn().mockResolvedValue([]),
      on: vi.fn().mockReturnValue(() => {}),
      openExternal: vi.fn(),
      openAccountSettings: vi.fn().mockResolvedValue({ success: true }),
    },
  });
}

/**
 * Only activating an inbox row used to mark anything read, so opening a room
 * from the sidebar left its unread pill up forever and messages arriving while
 * it was on screen kept accruing.
 */
describe('TeamMode marks a room read while it is open', () => {
  afterEach(() => cleanup());

  it('marks the routed conversation\'s deliveries read, once, and drops the count', async () => {
    installApi();
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-1');
    store.set(conversationDirectoryAtomFamily('org-1'), [general]);
    store.set(conversationDirectoryLoadStateAtomFamily('org-1'), { status: 'ready' });
    store.set(teamInboxSnapshotAtom, snapshotWith([
      delivery('delivery-1', 'general'),
      delivery('delivery-2', 'design'),
    ]));

    const markRead = vi.fn().mockResolvedValue(undefined);
    const provider: InboxProvider = {
      getSnapshot: () => ({ status: 'ready', deliveries: [] }),
      subscribe: () => () => {},
      markRead,
      dismiss: async () => {},
      migrateOrganization: async () => {},
      navigate: async () => false,
    };

    render(
      <Provider store={store}>
        <InboxProviderContext.Provider value={provider}>
          <TeamMode />
        </InboxProviderContext.Provider>
      </Provider>,
    );
    await waitFor(() => screen.getByTestId('inbox'));
    expect(markRead).not.toHaveBeenCalled();

    act(() => {
      store.set(orgWindowRouteAtom, { view: 'conversation', conversationId: 'general' });
    });

    await waitFor(() => expect(markRead).toHaveBeenCalledWith(['delivery-1']));
    // The other room's delivery is untouched.
    expect(markRead).toHaveBeenCalledTimes(1);

    // What the server reports back: the sidebar's org-wide count drops with it.
    act(() => {
      store.set(teamInboxSnapshotAtom, snapshotWith([
        { ...delivery('delivery-1', 'general'), readAt: 20 },
        delivery('delivery-2', 'design'),
      ]));
    });
    await waitFor(() =>
      expect(inboxUnreadCount(store.get(teamInboxSnapshotAtom), 'org-1')).toBe(1));
    // Already handled: the snapshot churn must not re-mark it.
    expect(markRead).toHaveBeenCalledTimes(1);

    // A message arriving while the room is still open is marked too.
    act(() => {
      store.set(teamInboxSnapshotAtom, snapshotWith([
        { ...delivery('delivery-1', 'general'), readAt: 20 },
        delivery('delivery-2', 'design'),
        delivery('delivery-3', 'general'),
      ]));
    });
    await waitFor(() => expect(markRead).toHaveBeenCalledWith(['delivery-3']));
  });
});
