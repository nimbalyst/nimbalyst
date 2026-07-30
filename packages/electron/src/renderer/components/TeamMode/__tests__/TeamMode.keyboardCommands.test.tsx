// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import { ORG_WINDOW_COMMAND_CHANNEL } from '../../../../shared/orgWindowCommands';
import { conversationDirectoryAtomFamily } from '../../../store/atoms/conversations';
import { orgSettingsAtomFamily } from '../../../store/atoms/orgSettings';
import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import { teamInboxSnapshotAtom } from '../../../store/atoms/teamInbox';
import { TeamMode } from '../TeamMode';
import { orgWindowRouteAtom } from '../orgWindowState';
import { consumeInboxSearchFocusRequest } from '../orgWindowCommandBus';
import { useOrgWindowCommandSource } from '../useOrgWindowCommandSource';

/**
 * The org window's keyboard-first messaging path, end to end inside the
 * renderer: a key press (or a Messages-menu IPC message) reaches the window
 * root's command source, crosses the command bus, and lands in the body as a
 * dialog, a route change or a mark-read call.
 */

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));
vi.mock('../Inbox', () => ({ InboxSection: () => <div data-testid="inbox" /> }));
vi.mock('../RoomView', () => ({ RoomView: ({ entry }: { entry: { id: string } }) => (
  <div data-testid="room-view" data-conversation-id={entry.id} />
) }));
vi.mock('../../Settings/panels/OrganizationMembersRolesPanel', () => ({
  OrganizationMembersRolesPanel: () => <div data-testid="members" />,
}));
vi.mock('../../Settings/panels/OrganizationProjectsPanel', () => ({ OrganizationProjectsPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationBillingPanel', () => ({ OrganizationBillingPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationDangerZone', () => ({ OrganizationDangerZone: () => <div /> }));
vi.mock('../../Settings/panels/ProjectSharingPanel', () => ({ ProjectSharingPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationSettingsPanel', () => ({ OrganizationSettingsPanel: () => <div /> }));

const markRead = vi.fn().mockResolvedValue(undefined);
vi.mock('../Inbox/inboxProvider', async () => {
  const actual = await vi.importActual<typeof import('../Inbox/inboxProvider')>(
    '../Inbox/inboxProvider',
  );
  return {
    ...actual,
    useInboxProvider: () => ({
      subscribe: () => () => {},
      getSnapshot: () => ({ status: 'ready', deliveries: [] }),
      markRead: (...args: unknown[]) => markRead(...args),
      dismiss: vi.fn(),
      navigate: vi.fn(),
      migrateOrganization: vi.fn(),
    }),
  };
});

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
    id: 'design',
    orgId: 'org-1',
    kind: 'orgRoom',
    visibility: 'public',
    title: 'Design',
    agentPostingEnabled: false,
    createdByUserId: 'member-a',
    createdAt: 2,
    capabilities: ['read', 'comment'],
  },
];

/** The `webContents.send` listeners the window registered, keyed by channel. */
const ipcListeners = new Map<string, (payload: unknown) => void>();

function installApi() {
  ipcListeners.clear();
  // The accelerators are Cmd-based on macOS and Ctrl-based elsewhere; jsdom
  // reports neither, so the platform is pinned for these presses.
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
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
      send: vi.fn(),
      on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
        ipcListeners.set(channel, handler);
        return () => ipcListeners.delete(channel);
      }),
      openExternal: vi.fn(),
      openAccountSettings: vi.fn().mockResolvedValue({ success: true }),
    },
  });
}

/** Stands in for TeamManagementApp, which is where the source hook is mounted. */
function CommandSource() {
  useOrgWindowCommandSource();
  return null;
}

function renderWindow(deliveries: unknown[] = []) {
  const store = createStore();
  store.set(selectedOrgIdAtom, 'org-1');
  store.set(conversationDirectoryAtomFamily('org-1'), conversations);
  store.set(orgSettingsAtomFamily('org-1'), {
    version: 1,
    messaging: { roomsEnabled: true, dmsEnabled: true, roomCreation: 'members' },
  });
  if (deliveries.length > 0) {
    // Only the deliveries are under test; the rest of the snapshot (presence,
    // connections) has to stay well-formed for the surrounding window.
    store.set(teamInboxSnapshotAtom, {
      ...store.get(teamInboxSnapshotAtom),
      deliveries,
    } as never);
  }
  render(
    <Provider store={store}>
      <CommandSource />
      <TeamMode />
    </Provider>,
  );
  return store;
}

function pressKey(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => { fireEvent.keyDown(window, init); });
}

describe('org window keyboard messaging commands', () => {
  afterEach(() => {
    cleanup();
    markRead.mockClear();
    // The focus latch is module state; a leftover request would leak forward.
    consumeInboxSearchFocusRequest();
  });

  it('opens the compose destination picker on Cmd+K', async () => {
    installApi();
    renderWindow();
    await waitFor(() => expect(screen.getByTestId('org-room-item-general')).toBeTruthy());
    expect(screen.queryByTestId('compose-destination-dialog')).toBeNull();

    pressKey({ key: 'k', metaKey: true });

    await waitFor(() => expect(screen.getByTestId('compose-destination-dialog')).toBeTruthy());
  });

  it('opens the picker from the Messages menu over IPC', async () => {
    installApi();
    renderWindow();
    await waitFor(() => expect(screen.getByTestId('org-room-item-general')).toBeTruthy());

    act(() => { ipcListeners.get(ORG_WINDOW_COMMAND_CHANNEL)?.('newMessage'); });

    await waitFor(() => expect(screen.getByTestId('compose-destination-dialog')).toBeTruthy());
  });

  it('ignores an unknown command from the main process', async () => {
    installApi();
    renderWindow();
    await waitFor(() => expect(screen.getByTestId('org-room-item-general')).toBeTruthy());

    act(() => { ipcListeners.get(ORG_WINDOW_COMMAND_CHANNEL)?.('drop-database'); });

    expect(screen.queryByTestId('compose-destination-dialog')).toBeNull();
  });

  it('walks the sidebar order with next / previous conversation, wrapping', async () => {
    installApi();
    const store = renderWindow();
    await waitFor(() => expect(screen.getByTestId('org-room-item-general')).toBeTruthy());

    // Sorted: Design, then General pinned to the top — so the order is
    // general, design.
    pressKey({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
    await waitFor(() => expect(store.get(orgWindowRouteAtom))
      .toEqual({ view: 'conversation', conversationId: 'general' }));

    pressKey({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
    await waitFor(() => expect(store.get(orgWindowRouteAtom))
      .toEqual({ view: 'conversation', conversationId: 'design' }));

    pressKey({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true });
    await waitFor(() => expect(store.get(orgWindowRouteAtom))
      .toEqual({ view: 'conversation', conversationId: 'general' }));
  });

  it('returns to the inbox on Cmd+I', async () => {
    installApi();
    const store = renderWindow();
    await waitFor(() => expect(screen.getByTestId('org-room-item-general')).toBeTruthy());
    act(() => { store.set(orgWindowRouteAtom, { view: 'conversation', conversationId: 'general' }); });

    pressKey({ key: 'i', metaKey: true });

    await waitFor(() => expect(store.get(orgWindowRouteAtom)).toEqual({ view: 'inbox' }));
  });

  it('routes to the inbox and latches a search-focus request on Cmd+F', async () => {
    installApi();
    const store = renderWindow();
    await waitFor(() => expect(screen.getByTestId('org-room-item-general')).toBeTruthy());
    act(() => { store.set(orgWindowRouteAtom, { view: 'conversation', conversationId: 'general' }); });

    pressKey({ key: 'f', metaKey: true });

    await waitFor(() => expect(store.get(orgWindowRouteAtom)).toEqual({ view: 'inbox' }));
    // The Inbox is mocked out here, so nothing consumed the request; the real
    // surface picks it up on mount.
    expect(consumeInboxSearchFocusRequest()).toBe(true);
  });

  it('marks every unread delivery in the organization read on Cmd+Shift+U', async () => {
    installApi();
    renderWindow([
      { id: 'd1', orgId: 'org-1', source: { orgId: 'org-1', sourceKind: 'roomMessage', sourceId: 'general', commentId: 'm1' } },
      { id: 'd2', orgId: 'org-1', readAt: 5, hasUnreadActivity: true, source: { orgId: 'org-1', sourceKind: 'roomMessage', sourceId: 'design', commentId: 'm2' } },
      // Already read, and another organization's — neither belongs in the batch.
      { id: 'd3', orgId: 'org-1', readAt: 5, source: { orgId: 'org-1', sourceKind: 'roomMessage', sourceId: 'general', commentId: 'm3' } },
      { id: 'd4', orgId: 'org-2', source: { orgId: 'org-2', sourceKind: 'roomMessage', sourceId: 'general', commentId: 'm4' } },
    ]);
    await waitFor(() => expect(screen.getByTestId('org-room-item-general')).toBeTruthy());

    pressKey({ key: 'U', metaKey: true, shiftKey: true });

    await waitFor(() => expect(markRead).toHaveBeenCalledWith(['d1', 'd2']));
  });

  it('does not call markRead when the organization has nothing unread', async () => {
    installApi();
    renderWindow();
    await waitFor(() => expect(screen.getByTestId('org-room-item-general')).toBeTruthy());

    pressKey({ key: 'U', metaKey: true, shiftKey: true });

    expect(markRead).not.toHaveBeenCalled();
  });
});
