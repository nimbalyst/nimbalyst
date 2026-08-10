// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrgWelcomeBanner } from '../OrgWelcomeBanner';
import { ORG_WELCOME_DISMISSED_SETTING_KEY } from '../orgWelcomeModel';

const invoke = vi.fn();
const list = vi.fn();
const listMembers = vi.fn();

function installApi(dismissedOrgIds: unknown = []) {
  invoke.mockImplementation(async (channel: string, key: string) => (
    channel === 'app-settings:get' && key === ORG_WELCOME_DISMISSED_SETTING_KEY
      ? dismissedOrgIds
      : undefined
  ));
  list.mockResolvedValue({ success: true, teams: [{ orgId: 'org-1', name: 'Acme' }] });
  listMembers.mockResolvedValue({
    success: true,
    members: [{ memberId: 'm1' }, { memberId: 'm2' }, { memberId: 'm3' }],
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { invoke, organization: { list, listMembers } },
  });
}

beforeEach(() => {
  invoke.mockReset();
  list.mockReset();
  listMembers.mockReset();
});

afterEach(() => cleanup());

/**
 * The card is the whole of invited-member onboarding, so both halves matter:
 * it appears on the first open, and dismissing it has to survive a restart —
 * which means app-settings, never localStorage.
 */
describe('OrgWelcomeBanner', () => {
  it('greets a member on first open with the org name and member count', async () => {
    installApi([]);
    render(
      <Provider store={createStore()}>
        <OrgWelcomeBanner orgId="org-1" />
      </Provider>,
    );

    const card = await screen.findByTestId('org-welcome-card');
    expect(card.textContent).toContain('Welcome to Acme');
    expect(card.textContent).toContain('3 members');
  });

  it('persists the dismissal to app-settings and hides the card', async () => {
    installApi([]);
    render(
      <Provider store={createStore()}>
        <OrgWelcomeBanner orgId="org-1" />
      </Provider>,
    );

    fireEvent.click(await screen.findByTestId('org-welcome-dismiss'));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'app-settings:set',
      ORG_WELCOME_DISMISSED_SETTING_KEY,
      ['org-1'],
    ));
    expect(screen.queryByTestId('org-welcome-card')).toBeNull();
  });

  it('stays hidden for an organization that was already dismissed', async () => {
    installApi(['org-1']);
    render(
      <Provider store={createStore()}>
        <OrgWelcomeBanner orgId="org-1" />
      </Provider>,
    );

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.queryByTestId('org-welcome-card')).toBeNull();
    // A dismissed card costs one settings read and no org round trips.
    expect(list).not.toHaveBeenCalled();
  });

  // The card is mounted inside #general now, so an "Open #general" action would
  // point at the surface the reader is already on.
  it('offers no open-#general action, being hosted inside #general', async () => {
    installApi([]);
    render(
      <Provider store={createStore()}>
        <OrgWelcomeBanner orgId="org-1" />
      </Provider>,
    );

    await screen.findByTestId('org-welcome-card');
    expect(screen.queryByTestId('org-welcome-open-general')).toBeNull();
  });
});
