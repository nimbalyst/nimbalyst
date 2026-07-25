// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

/**
 * The org window is a single reusable window: opening it again just focuses it
 * and sends `team-window:set-target`. Retargeting at the org already in the URL
 * — or re-opening it untargeted — must still take effect, because the user may
 * have switched the window elsewhere with the in-window switcher since.
 */

vi.mock('../TeamMode', () => ({ TeamMode: () => <div data-testid="team-mode" /> }));
vi.mock('../../../contexts/DialogContext', () => ({
  DialogProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TeamManagementApp } from '../TeamManagementApp';
import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import { LAST_SELECTED_ORG_SETTING_KEY } from '../defaultOrg';

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

function retarget(payload: { orgId?: string | null; workspacePath?: string | null }) {
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
  });

  it('re-seeds the atom when retargeted at the org it was opened with', async () => {
    const store = createStore();
    render(<Provider store={store}><TeamManagementApp /></Provider>);

    await waitFor(() => expect(store.get(selectedOrgIdAtom)).toBe('org-a'));

    // The user switched the window to another org from the in-window switcher.
    act(() => { store.set(selectedOrgIdAtom, 'org-b'); });

    // Clicking "Manage" for org A again focuses the window with the same target.
    retarget({ orgId: 'org-a' });

    await waitFor(() => expect(store.get(selectedOrgIdAtom)).toBe('org-a'));
  });

  it('re-resolves the default when re-opened untargeted from the Window menu', async () => {
    const store = createStore();
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
    await waitFor(() => expect(listOrganizations.mock.calls.length).toBeGreaterThan(callsBefore));
    await waitFor(() => expect(store.get(selectedOrgIdAtom)).toBe('org-b'));
  });

  it('remembers a targeted open as the last selected organization', async () => {
    const store = createStore();
    render(<Provider store={store}><TeamManagementApp /></Provider>);

    await waitFor(() => expect(settings.get(LAST_SELECTED_ORG_SETTING_KEY)).toBe('org-a'));

    retarget({ orgId: 'org-b' });
    await waitFor(() => expect(settings.get(LAST_SELECTED_ORG_SETTING_KEY)).toBe('org-b'));
  });
});
