// @vitest-environment jsdom
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
import { ORG_WINDOW_SURFACE_ID, orgWindowRouteAtomFamily } from '../orgWindowState';
import { OrgModeHost } from '../OrgModeHost';

const orgWindowRouteAtom = orgWindowRouteAtomFamily(ORG_WINDOW_SURFACE_ID);

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));
vi.mock('../Inbox', () => ({ InboxSection: () => <div data-testid="inbox" /> }));
// Renders whatever the window hands it as the under-header notice, so the test
// sees exactly what a member would.
vi.mock('../RoomView', () => ({
  RoomView: ({ entry, notice }: { entry: ConversationDirectoryEntry; notice?: React.ReactNode }) => (
    <div data-testid="org-room-view" data-conversation-id={entry.id}>{notice}</div>
  ),
}));
vi.mock('../onboarding/OrgWelcomeBanner', () => ({
  OrgWelcomeBanner: ({ orgId }: { orgId: string | null | undefined }) => (
    <div data-testid="org-welcome-card" data-org-id={orgId} />
  ),
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

function room(id: string, title: string): ConversationDirectoryEntry {
  return {
    id,
    orgId: 'org-1',
    kind: 'orgRoom',
    visibility: 'public',
    title,
    agentPostingEnabled: false,
    createdByUserId: 'member-a',
    createdAt: 1,
    capabilities: ['read', 'comment'],
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

async function renderWindow() {
  installApi();
  const store = await createHydratedOrgStore();
  store.set(conversationDirectoryAtomFamily('org-1'), [room('general', 'General'), room('design', 'Design')]);
  store.set(conversationDirectoryLoadStateAtomFamily('org-1'), { status: 'ready' });
  render(
    <Provider store={store}>
      <OrgModeHost orgId="org-1" surfaceId={ORG_WINDOW_SURFACE_ID} chrome="window" />
    </Provider>,
  );
  return store;
}

/**
 * The welcome card used to be a band across the whole window, above every
 * surface. It now belongs to #general only (2026-07-28 layout decision).
 */
describe('TeamMode welcome card placement', () => {
  afterEach(() => cleanup());

  it('mounts the card inside #general and nowhere else', async () => {
    const store = await renderWindow();
    await waitFor(() => screen.getByTestId('inbox'));
    // Not on the Inbox landing surface.
    expect(screen.queryByTestId('org-welcome-card')).toBeNull();

    act(() => {
      store.set(orgWindowRouteAtom, { view: 'conversation', conversationId: 'general' });
    });
    await waitFor(() => screen.getByTestId('org-welcome-card'));
    expect(screen.getByTestId('org-welcome-card').getAttribute('data-org-id')).toBe('org-1');
    // Inside the room view, not above the window chrome.
    expect(screen.getByTestId('org-room-view').contains(screen.getByTestId('org-welcome-card'))).toBe(true);

    act(() => {
      store.set(orgWindowRouteAtom, { view: 'conversation', conversationId: 'design' });
    });
    await waitFor(() =>
      expect(screen.getByTestId('org-room-view').getAttribute('data-conversation-id')).toBe('design'));
    expect(screen.queryByTestId('org-welcome-card')).toBeNull();
  });
});
