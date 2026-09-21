// @vitest-environment jsdom
import React from 'react';
import { createHydratedOrgStore } from './organizationTestStore';
import { Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

/**
 * The org window is a single reusable window: opening it again just focuses it
 * and sends `team-window:set-target`. Retargeting at the org already in the URL
 * — or re-opening it untargeted — must still take effect, because the user may
 * have switched the window elsewhere with the in-window switcher since.
 */

vi.mock('../OrgModeHost', () => ({ OrgModeHost: () => <div data-testid="team-mode" /> }));
vi.mock('../../../contexts/DialogContext', () => ({
  DialogProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TeamManagementApp } from '../TeamManagementApp';
import { organizationDirectoryStateAtom, organizationDirectoryAtom } from '../../../store/atoms/settingsDomains';
import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import { consumeInboxRowSelectionRequest } from '../orgWindowCommandBus';
import { ORG_WINDOW_SURFACE_ID, orgWindowRouteAtomFamily } from '../orgWindowState';
import { LAST_SELECTED_ORG_SETTING_KEY } from '../defaultOrg';
import {
  ORG_WINDOW_PENDING_ROUTE_SETTING_KEY,
  pendingGeneralRoute,
} from '../onboarding/orgWelcomeModel';

const orgWindowRouteAtom = orgWindowRouteAtomFamily(ORG_WINDOW_SURFACE_ID);

let setTargetHandler: ((payload: { orgId?: string | null; workspacePath?: string | null }) => void) | null = null;
const settings = new Map<string, unknown>();
const listOrganizations = vi.fn();

function installApi() {
  setTargetHandler = null;
  settings.clear();
  listOrganizations.mockReset().mockResolvedValue({
    success: true,
    teams: [
      { orgId: 'org-a', name: 'Acme' },
      { orgId: 'org-b', name: 'Beta', membershipType: 'active_member' },
    ],
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      setTitle: vi.fn(),
      organization: { list: listOrganizations },
      invoke: vi.fn(async (channel: string, key: string, value?: unknown) => {
        if (channel === 'app-settings:get') return settings.get(key);
        if (channel === 'app-settings:set') { settings.set(key, value); return undefined; }
        return undefined;
      }),
      on: vi.fn((channel: string, handler: (payload: any) => void) => {
        if (channel === 'team-window:set-target') setTargetHandler = handler;
        return () => {};
      }),
    },
  });
}

function retarget(payload: {
  orgId?: string | null;
  workspacePath?: string | null;
  feedbackRequestId?: string | null;
}) {
  act(() => { setTargetHandler?.(payload); });
}

describe('TeamManagementApp retargeting', () => {
  beforeEach(() => {
    installApi();
    window.history.replaceState({}, '', '/?mode=team-management&orgId=org-a');
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
    // The selection latch is a module singleton; a request left pending would
    // be picked up by the next test's Inbox.
    consumeInboxRowSelectionRequest(ORG_WINDOW_SURFACE_ID);
  });

  /**
   * A `nimbalyst://feedback-request/...` link has to land the recipient on the
   * respond card, which lives inline in the Inbox's context pane. The existing
   * `virtual://feedback-request/` tab is the *author's* results view, so opening
   * one would be actively wrong here — the destination is a selected Inbox row.
   */
  it('points a feedback-request link at the Inbox row rather than a tab', async () => {
    window.history.replaceState(
      {},
      '',
      '/?mode=team-management&orgId=org-a&feedbackRequestId=request-1',
    );
    const store = await createHydratedOrgStore();
    render(<Provider store={store}><TeamManagementApp /></Provider>);

    await waitFor(() => expect(store.get(orgWindowRouteAtom).view).toBe('inbox'));
    expect(consumeInboxRowSelectionRequest(ORG_WINDOW_SURFACE_ID)).toEqual({
      orgId: 'org-a',
      sourceKind: 'feedbackRequest',
      sourceId: 'request-1',
    });

    // The window is a single reusable one, so a second link arrives as a
    // retarget rather than a fresh mount and must latch again.
    act(() => { store.set(orgWindowRouteAtom, { view: 'directory' }); });
    retarget({ orgId: 'org-a', feedbackRequestId: 'request-2' });

    await waitFor(() => expect(store.get(orgWindowRouteAtom).view).toBe('inbox'));
    expect(consumeInboxRowSelectionRequest(ORG_WINDOW_SURFACE_ID)).toMatchObject({ sourceId: 'request-2' });
  });

  it('re-seeds the atom when retargeted at the org it was opened with', async () => {
    const store = await createHydratedOrgStore();
    render(<Provider store={store}><TeamManagementApp /></Provider>);

    await waitFor(() => expect(store.get(selectedOrgIdAtom)).toBe('org-a'));

    // The user switched the window to another org from the in-window switcher.
    act(() => { store.set(selectedOrgIdAtom, 'org-b'); });

    // Clicking "Manage" for org A again focuses the window with the same target.
    retarget({ orgId: 'org-a' });

    await waitFor(() => expect(store.get(selectedOrgIdAtom)).toBe('org-a'));
  });

  it('re-resolves the default when re-opened untargeted from the Window menu', async () => {
    const store = await createHydratedOrgStore();
    render(<Provider store={store}><TeamManagementApp /></Provider>);

    await waitFor(() => expect(store.get(selectedOrgIdAtom)).toBe('org-a'));

    // The in-window switcher moved to org B and remembered it.
    settings.set(LAST_SELECTED_ORG_SETTING_KEY, 'org-b');

    // First untargeted open resolves the last selected org.
    retarget({ orgId: null });
    await waitFor(() => expect(store.get(selectedOrgIdAtom)).toBe('org-b'));

    act(() => { store.set(selectedOrgIdAtom, null); });
    const callsBefore = listOrganizations.mock.calls.length;

    // Re-opening untargeted must resolve again, not sit on the unbound surface.
    retarget({ orgId: null });
    expect(listOrganizations.mock.calls.length).toBe(callsBefore);
    await waitFor(() => expect(store.get(selectedOrgIdAtom)).toBe('org-b'));
  });

  it('remembers a targeted open as the last selected organization', async () => {
    const store = await createHydratedOrgStore();
    render(<Provider store={store}><TeamManagementApp /></Provider>);

    await waitFor(() => expect(settings.get(LAST_SELECTED_ORG_SETTING_KEY)).toBe('org-a'));

    retarget({ orgId: 'org-b' });
    await waitFor(() => expect(settings.get(LAST_SELECTED_ORG_SETTING_KEY)).toBe('org-b'));
  });

  it('preserves a replayed invite destination across restart instead of choosing the first org', async () => {
    window.history.replaceState({}, '', '/?mode=team-management');
    // The membership the invite created has not reached team:list yet.
    listOrganizations.mockResolvedValue({ success: true, teams: [] });
    settings.set(
      ORG_WINDOW_PENDING_ROUTE_SETTING_KEY,
      pendingGeneralRoute('org-invite'),
    );
    settings.set(LAST_SELECTED_ORG_SETTING_KEY, 'org-a');
    const store = await createHydratedOrgStore();

    render(<Provider store={store}><TeamManagementApp /></Provider>);

    await waitFor(() => expect(store.get(selectedOrgIdAtom)).toBe('org-invite'));

    // Replaying the callback/open event is idempotent: the same single pending
    // record wins again, and no first-org fallback replaces it.
    retarget({ orgId: null });
    await waitFor(() => expect(store.get(selectedOrgIdAtom)).toBe('org-invite'));
    expect(settings.get(ORG_WINDOW_PENDING_ROUTE_SETTING_KEY)).toEqual(
      pendingGeneralRoute('org-invite'),
    );
  });

  it('opens a working organization when the queued destination is not a membership', async () => {
    // The hand-off is only consumed once its room hydrates, so a destination the
    // user cannot open would otherwise win every open, for good.
    window.history.replaceState({}, '', '/?mode=team-management');
    settings.set(
      ORG_WINDOW_PENDING_ROUTE_SETTING_KEY,
      pendingGeneralRoute('org-never-joined'),
    );
    settings.set(LAST_SELECTED_ORG_SETTING_KEY, 'org-b');
    const store = await createHydratedOrgStore();

    render(<Provider store={store}><TeamManagementApp /></Provider>);

    await waitFor(() => expect(store.get(selectedOrgIdAtom)).toBe('org-b'));
    // The destination is kept, not deleted: it still replays if the membership
    // is activated later.
    expect(settings.get(ORG_WINDOW_PENDING_ROUTE_SETTING_KEY)).toEqual(
      pendingGeneralRoute('org-never-joined'),
    );
  });

  it('preserves a pending destination while another account has only a partial directory', async () => {
    window.history.replaceState({}, '', '/?mode=team-management');
    settings.set(ORG_WINDOW_PENDING_ROUTE_SETTING_KEY, pendingGeneralRoute('org-invite'));
    const store = await createHydratedOrgStore();
    store.set(organizationDirectoryStateAtom, {
      entries: [{ orgId: 'org-a', name: 'Acme', role: 'owner' }], status: 'loading', complete: false,
    });
    render(<Provider store={store}><TeamManagementApp /></Provider>);
    await waitFor(() => expect(store.get(selectedOrgIdAtom)).toBe('org-invite'));
    act(() => store.set(organizationDirectoryAtom, [{ orgId: 'org-invite', name: 'Invited org', role: 'member' }]));
    await waitFor(() => expect(store.get(selectedOrgIdAtom)).toBe('org-invite'));
  });

});
