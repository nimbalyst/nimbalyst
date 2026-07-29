// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxSection } from '../InboxSection';
import { createInboxFixtures } from '../inboxFixtures';
import { createFixtureInboxProvider } from '../inboxFixtureProvider';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const NOW = Date.parse('2026-07-26T18:00:00.000Z');

function installApi() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { invoke: vi.fn().mockResolvedValue(undefined) },
  });
}

function renderInbox(overrides: Parameters<typeof createFixtureInboxProvider>[0] = {}) {
  const provider = createFixtureInboxProvider({ now: NOW, ...overrides });
  const utils = render(<InboxSection provider={provider} now={NOW} />);
  return { provider, ...utils };
}

describe('InboxSection', () => {
  beforeEach(() => { installApi(); });
  afterEach(() => cleanup());

  it('renders the grouped list with unread markers and agent attribution', async () => {
    renderInbox();

    await waitFor(() => expect(screen.getByTestId('inbox-list')).toBeTruthy());
    expect(screen.getByTestId('inbox-group-today')).toBeTruthy();

    const agentRow = screen.getByTestId('inbox-row-delivery-agent-reply');
    expect(within(agentRow).getByTestId('inbox-row-agent-glyph')).toBeTruthy();
    expect(agentRow.textContent).toContain('packaging-audit');
    expect(agentRow.textContent).toContain('for Marcus Lee');

    // An agent mention dispatched but not yet picked up shows as pending.
    expect(within(screen.getByTestId('inbox-row-delivery-agent-mention')).getByTestId('inbox-row-agent-pending')).toBeTruthy();

    expect(screen.getByTestId('inbox-row-delivery-mention-room').getAttribute('data-unread')).toBe('true');
    expect(screen.getByTestId('inbox-row-delivery-dm').getAttribute('data-unread')).toBe('false');
  });

  it('shows nothing about the former source on an access-removed row', async () => {
    renderInbox();

    const row = await screen.findByTestId('inbox-row-delivery-access-removed');
    expect(within(row).getByTestId('inbox-row-unavailable').textContent).toContain('No longer available');
    for (const leak of ['Corp dev', 'term sheet', 'Alex Fenn', 'Corp Dev']) {
      expect(row.textContent).not.toContain(leak);
    }
    // It stays dismissible — dismissal is the only exit from a dead row.
    expect(within(row).getByTestId('inbox-row-dismiss-delivery-access-removed')).toBeTruthy();
  });

  it('filters, and composes the search query with the active filter', async () => {
    renderInbox();
    await screen.findByTestId('inbox-list');

    fireEvent.click(screen.getByTestId('inbox-filter-assigned'));
    expect(screen.getByTestId('inbox-row-delivery-assignment')).toBeTruthy();
    expect(screen.queryByTestId('inbox-row-delivery-mention-room')).toBeNull();

    fireEvent.click(screen.getByTestId('inbox-filter-mentions'));
    fireEvent.change(screen.getByTestId('inbox-search-input'), { target: { value: 'priya' } });

    // Priya authored both a mention and the assignment; the mentions filter
    // still holds, so only the mention survives.
    expect(screen.getByTestId('inbox-row-delivery-mention-room')).toBeTruthy();
    expect(screen.queryByTestId('inbox-row-delivery-assignment')).toBeNull();
  });

  it('offers the federated escalation in the empty and partial result states', async () => {
    renderInbox();
    await screen.findByTestId('inbox-list');

    fireEvent.change(screen.getByTestId('inbox-search-input'), { target: { value: 'priya' } });
    expect(screen.getByTestId('inbox-search-all')).toBeTruthy();

    fireEvent.change(screen.getByTestId('inbox-search-input'), { target: { value: 'nothing-matches-this' } });
    const empty = screen.getByTestId('inbox-empty-state');
    expect(within(empty).getByTestId('inbox-search-all')).toBeTruthy();
    expect(within(empty).getByTestId('inbox-empty-clear-filters')).toBeTruthy();
  });

  it('explains each empty filter on its own terms', async () => {
    const { rerender } = renderInbox({ deliveries: [] });
    await waitFor(() => expect(screen.getByTestId('inbox-empty-state')).toBeTruthy());
    expect(screen.getByTestId('inbox-empty-state').textContent).toContain('Your inbox is clear');

    rerender(<InboxSection provider={createFixtureInboxProvider({ now: NOW, deliveries: [] })} />);
    fireEvent.click(screen.getByTestId('inbox-filter-follows'));
    expect(screen.getByTestId('inbox-empty-state').getAttribute('data-filter')).toBe('follows');
    expect(screen.getByTestId('inbox-empty-state').textContent).toContain('not following');
  });

  it('renders the loading skeleton with the controls disabled', () => {
    renderInbox({ status: 'loading' });

    expect(screen.getByTestId('inbox-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('inbox-list')).toBeNull();
    expect((screen.getByTestId('inbox-filter-mentions') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('inbox-search-input') as HTMLInputElement).disabled).toBe(true);
  });

  it('labels cached previews as stale when offline', async () => {
    renderInbox({ status: 'offlineWithCache' });

    await screen.findByTestId('inbox-list');
    expect(screen.getByTestId('inbox-status-banner').textContent).toContain('Offline');
    expect(screen.getAllByTestId('inbox-row-stale-label').length).toBeGreaterThan(0);
  });

  it('explains that the inbox needs a connection when there is no cache', () => {
    renderInbox({ status: 'offlineWithoutCache', deliveries: [] });

    expect(screen.getByTestId('inbox-offline-empty').textContent).toContain('needs a connection');
    expect(screen.queryByTestId('inbox-list')).toBeNull();
  });

  it('marks a row read only after navigation succeeds', async () => {
    const navigate = vi.fn().mockResolvedValue(true);
    renderInbox({ navigate });
    await screen.findByTestId('inbox-list');

    fireEvent.click(screen.getByTestId('inbox-row-delivery-mention-room'));

    await waitFor(() => expect(
      screen.getByTestId('inbox-row-delivery-mention-room').getAttribute('data-unread'),
    ).toBe('false'));
    expect(navigate).toHaveBeenCalled();
  });

  it('keeps a row unread and says so when navigation fails', async () => {
    renderInbox({ navigate: vi.fn().mockResolvedValue(false) });
    await screen.findByTestId('inbox-list');

    fireEvent.click(screen.getByTestId('inbox-row-delivery-mention-room'));

    await waitFor(() => expect(screen.getByTestId('inbox-activation-notice')).toBeTruthy());
    expect(screen.getByTestId('inbox-row-delivery-mention-room').getAttribute('data-unread')).toBe('true');
  });

  it('explains the missing permission in the context pane for a read-only source', async () => {
    renderInbox();
    await screen.findByTestId('inbox-list');

    fireEvent.click(screen.getByTestId('inbox-row-delivery-read-only'));

    await waitFor(() => expect(screen.getByTestId('inbox-composer-read-only')).toBeTruthy());
    expect(screen.getByTestId('inbox-composer-read-only').textContent).toContain('viewer access');
  });

  it('reveals nothing in the context pane for an access-removed delivery', async () => {
    renderInbox();
    await screen.findByTestId('inbox-list');

    fireEvent.click(screen.getByTestId('inbox-row-delivery-access-removed'));

    const pane = await screen.findByTestId('inbox-context-pane');
    expect(within(pane).getByTestId('inbox-context-unavailable')).toBeTruthy();
    for (const leak of ['Corp dev', 'term sheet', 'Alex Fenn']) {
      expect(pane.textContent).not.toContain(leak);
    }
  });

  it('scopes mark-all-read to the active filter', async () => {
    const { provider } = renderInbox();
    await screen.findByTestId('inbox-list');
    const markRead = vi.spyOn(provider, 'markRead');

    fireEvent.click(screen.getByTestId('inbox-filter-assigned'));
    fireEvent.click(screen.getByTestId('inbox-mark-all-read'));

    expect(markRead).toHaveBeenCalledWith(['delivery-assignment']);
  });

  it('dismisses a row out of the list', async () => {
    renderInbox();
    await screen.findByTestId('inbox-list');

    fireEvent.click(screen.getByTestId('inbox-row-dismiss-delivery-access-removed'));

    await waitFor(() => expect(screen.queryByTestId('inbox-row-delivery-access-removed')).toBeNull());
  });

  it('narrows the list with the org scope control', async () => {
    renderInbox();
    await screen.findByTestId('inbox-list');

    fireEvent.click(screen.getByTestId('inbox-scope-trigger'));
    const menu = await screen.findByTestId('inbox-scope-menu');
    // Every org starts checked; unchecking Acme leaves Northwind.
    fireEvent.click(within(menu).getByText('Acme'));

    await waitFor(() => expect(screen.queryByTestId('inbox-row-delivery-mention-room')).toBeNull());
    expect(screen.getByTestId('inbox-row-delivery-read-only')).toBeTruthy();
  });

  it('persists the filter and scope through app settings, never localStorage', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
    const localStorageSpy = vi.spyOn(Storage.prototype, 'setItem');

    renderInbox();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app-settings:get', 'inboxViewPreferences'));

    fireEvent.click(screen.getByTestId('inbox-filter-mentions'));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'app-settings:set',
      'inboxViewPreferences',
      expect.objectContaining({ filter: 'mentions' }),
    ));
    expect(localStorageSpy).not.toHaveBeenCalled();
    localStorageSpy.mockRestore();
  });

  it('restores the persisted filter on mount', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { invoke: vi.fn().mockResolvedValue({ filter: 'assigned', scope: {} }) },
    });

    renderInbox();

    await waitFor(() => expect(screen.getByTestId('inbox-filter-assigned').getAttribute('aria-selected')).toBe('true'));
    expect(screen.queryByTestId('inbox-row-delivery-mention-room')).toBeNull();
  });

  it('offers the fixture state picker only while the fixtures are the source', async () => {
    renderInbox();
    await screen.findByTestId('inbox-list');
    expect(screen.getByTestId('inbox-state-picker')).toBeTruthy();

    cleanup();

    const realish = createFixtureInboxProvider({ now: NOW });
    delete (realish as { simulateStatus?: unknown }).simulateStatus;
    render(<InboxSection provider={realish} />);
    await screen.findByTestId('inbox-list');
    expect(screen.queryByTestId('inbox-state-picker')).toBeNull();
  });

  it('isolates a legacy organization with an explicit migration affordance', async () => {
    const { provider } = renderInbox({
      unavailableOrganizations: [{
        orgId: 'org-legacy',
        orgName: 'Legacy Co',
        errorCode: 'ORG_SERVER_MANAGED_DEK_REQUIRED',
      }],
    });
    const migrate = vi.spyOn(provider, 'migrateOrganization');

    const unavailable = await screen.findByTestId(
      'inbox-organization-unavailable-org-legacy',
    );
    expect(unavailable.textContent).toContain(
      'Messaging is not available for Legacy Co',
    );
    expect(screen.getByTestId('inbox-list')).toBeTruthy();

    fireEvent.click(within(unavailable).getByRole('button', {
      name: 'Migrate organization',
    }));
    expect(migrate).toHaveBeenCalledWith('org-legacy');
  });

  it('shows an empty inbox rather than fixtures when no provider is mounted', async () => {
    // Production mounts no provider until the atom-backed one is wired. The
    // surface must reach its empty state there, never the review fixtures.
    render(<InboxSection />);

    await waitFor(() => expect(screen.getByTestId('inbox-empty-state')).toBeTruthy());
    expect(screen.queryByTestId('inbox-list')).toBeNull();
    expect(screen.queryByTestId('inbox-state-picker')).toBeNull();
    expect(document.body.textContent).not.toContain('Priya Raman');
  });

  it('hides the mute control when the provider cannot change the follow state', async () => {
    const provider = createFixtureInboxProvider({ now: NOW });
    delete (provider as { setSubscriptionState?: unknown }).setSubscriptionState;
    render(<InboxSection provider={provider} now={NOW} />);
    await screen.findByTestId('inbox-list');

    // This row is followed, so the control would otherwise be offered.
    fireEvent.click(screen.getByTestId('inbox-row-delivery-mention-room'));

    await screen.findByTestId('inbox-context-pane');
    expect(screen.queryByTestId('inbox-context-subscription')).toBeNull();
  });

  it('offers the mute control when the provider implements it', async () => {
    renderInbox();
    await screen.findByTestId('inbox-list');

    fireEvent.click(screen.getByTestId('inbox-row-delivery-mention-room'));

    expect(await screen.findByTestId('inbox-context-subscription')).toBeTruthy();
  });

  it('ages relative timestamps without waiting for new data', async () => {
    // The ticker is driven directly rather than through fake timers, which
    // would also stall testing-library's own polling.
    let clock = NOW;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const ticks: Array<() => void> = [];
    const intervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(((handler: TimerHandler) => {
        ticks.push(handler as () => void);
        return ticks.length as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval);

    try {
      // No `now` prop: the surface owns its clock, which is what has to tick.
      render(<InboxSection provider={createFixtureInboxProvider({ now: NOW })} />);
      const row = await screen.findByTestId('inbox-row-delivery-mention-room');
      expect(row.textContent).toContain('12m');
      expect(ticks.length).toBeGreaterThan(0);

      clock = NOW + 11 * 60_000;
      act(() => { for (const tick of ticks) tick(); });

      expect(
        screen.getByTestId('inbox-row-delivery-mention-room').textContent,
      ).toContain('23m');
    } finally {
      intervalSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('covers every fixture availability state so each is reachable for review', async () => {
    renderInbox();
    await screen.findByTestId('inbox-list');

    const availabilities = new Set(
      createInboxFixtures({ now: NOW }).map((delivery) => delivery.availability),
    );
    expect(availabilities).toEqual(new Set(['available', 'accessRemoved', 'deletedSource']));
    expect(screen.getByTestId('inbox-row-delivery-deleted-source').getAttribute('data-availability')).toBe('deletedSource');
  });
});
