// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import {
  conversationDirectoryAtomFamily,
  conversationDirectoryLoadStateAtomFamily,
} from '../../../store/atoms/conversations';
import { orgWindowRouteAtom } from '../orgWindowState';
import {
  recordOrgWindowPendingHandoff,
  resetOrgWindowPendingHandoff,
} from '../onboarding/pendingRouteHandoff';
import { TeamMode } from '../TeamMode';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));
vi.mock('../Inbox', () => ({ InboxSection: () => <div data-testid="inbox" /> }));
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

function installApi(invoke: ReturnType<typeof vi.fn>) {
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
      invoke,
      on: vi.fn().mockReturnValue(() => {}),
      openExternal: vi.fn(),
      openAccountSettings: vi.fn().mockResolvedValue({ success: true }),
    },
  });
}

/**
 * A stale main process failed the directory IPC and the sidebar said "No rooms
 * yet. Create one with + or browse below." — an empty directory and a failed
 * one are not the same thing.
 */
describe('TeamMode directory load failure', () => {
  afterEach(() => {
    cleanup();
    resetOrgWindowPendingHandoff();
  });

  it('surfaces the failure in the sidebar and retries the same directory read', async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    installApi(invoke);
    const store = createStore();
    store.set(selectedOrgIdAtom, 'org-1');
    store.set(conversationDirectoryAtomFamily('org-1'), []);
    store.set(conversationDirectoryLoadStateAtomFamily('org-1'), {
      status: 'error',
      error: 'Conversation directory unavailable',
    });

    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(screen.getByTestId('org-rooms-error')).toBeTruthy());
    expect(screen.queryByTestId('org-rooms-empty')).toBeNull();

    invoke.mockClear();
    fireEvent.click(screen.getByTestId('org-rooms-error-retry'));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'conversation:directory:list',
      { orgId: 'org-1' },
    ));
  });

  it('automatically retries delayed #general hydration without clearing the destination', async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    installApi(invoke);
    const store = createStore();
    const route = { view: 'conversation' as const, conversationId: 'general' };
    store.set(selectedOrgIdAtom, 'org-1');
    store.set(orgWindowRouteAtom, route);
    store.set(conversationDirectoryAtomFamily('org-1'), []);
    store.set(conversationDirectoryLoadStateAtomFamily('org-1'), {
      status: 'error',
      error: 'Conversation directory unavailable',
    });
    recordOrgWindowPendingHandoff('org-1', route);

    render(<Provider store={store}><TeamMode /></Provider>);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'conversation:directory:list',
      { orgId: 'org-1' },
    ));
    invoke.mockClear();

    await new Promise((resolve) => window.setTimeout(resolve, 400));

    expect(invoke).toHaveBeenCalledWith(
      'conversation:directory:list',
      { orgId: 'org-1' },
    );
  });
});
