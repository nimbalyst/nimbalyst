import { describe, expect, it, vi } from 'vitest';

import type { InboxProvider } from '../Inbox/inboxProvider';
import type { InboxRowView } from '../Inbox/inboxTypes';
import {
  DEFAULT_ORG_WINDOW_ROUTE,
  gateOrgWindowRoute,
  isRouteSelected,
  routeForInboxRow,
  withOrgWindowRouting,
} from '../orgWindowState';
import { resolveOrgMessagingGating } from '../orgSidebarViewModel';

function row(overrides: Partial<InboxRowView> = {}): InboxRowView {
  return {
    id: 'delivery-1',
    orgId: 'org-a',
    orgName: 'Acme',
    viewerUserId: 'member-a',
    sourceKind: 'roomMessage',
    sourceId: 'general',
    commentId: 'message-1',
    reasonLabel: 'Mentioned you',
    timestampLabel: '2m',
    unread: true,
    availability: 'available',
    canReply: true,
    createdAt: 1,
    ...overrides,
  } as InboxRowView;
}

function provider(navigate = vi.fn().mockResolvedValue(true)): InboxProvider {
  return {
    getSnapshot: () => ({ status: 'ready', deliveries: [] }),
    subscribe: () => () => {},
    async markRead() {},
    async dismiss() {},
    async migrateOrganization() {},
    navigate,
  };
}

describe('org window routes', () => {
  it('selects on the addressed conversation and admin panel, not just the view', () => {
    const route = { view: 'conversation' as const, conversationId: 'general' };
    expect(isRouteSelected(route, { view: 'conversation', conversationId: 'general' })).toBe(true);
    expect(isRouteSelected(route, { view: 'conversation', conversationId: 'design' })).toBe(false);
    expect(isRouteSelected(route, { view: 'inbox' })).toBe(false);
    expect(isRouteSelected(
      { view: 'admin', adminTab: 'members' },
      { view: 'admin', adminTab: 'projects' },
    )).toBe(false);
  });
});

describe('gateOrgWindowRoute', () => {
  const gating = resolveOrgMessagingGating();

  // Administration is not in this window any more (NIM-2322), so an admin
  // route is redirected regardless of the panel or the viewer's role — a stale
  // hand-off or deep link must land on messaging, not on nothing.
  it.each(['members', 'projects', 'settings', 'billing', 'danger'] as const)(
    'redirects a stale %s route to the messaging landing view',
    (adminTab) => {
      expect(gateOrgWindowRoute({ view: 'admin', adminTab }, gating, []))
        .toEqual(DEFAULT_ORG_WINDOW_ROUTE);
    },
  );

  it('redirects an admin route carrying no panel at all', () => {
    expect(gateOrgWindowRoute({ view: 'admin' }, gating, []))
      .toEqual(DEFAULT_ORG_WINDOW_ROUTE);
  });
});

describe('routeForInboxRow', () => {
  it('routes room and DM deliveries into this window', () => {
    expect(routeForInboxRow(row(), 'org-a'))
      .toEqual({ view: 'conversation', conversationId: 'general' });
    expect(routeForInboxRow(row({ sourceKind: 'dmMessage', sourceId: 'dm-1' }), 'org-a'))
      .toEqual({ view: 'conversation', conversationId: 'dm-1' });
  });

  it('leaves anything this window cannot open to the existing deep link', () => {
    // Trackers and documents live in the project window.
    expect(routeForInboxRow(row({ sourceKind: 'trackerComment' }), 'org-a')).toBeNull();
    expect(routeForInboxRow(row({ sourceKind: 'documentDiscussion' }), 'org-a')).toBeNull();
    // Another organization's delivery, and a source the viewer lost access to.
    expect(routeForInboxRow(row(), 'org-b')).toBeNull();
    expect(routeForInboxRow(row({ availability: 'accessRemoved' }), 'org-a')).toBeNull();
  });
});

describe('withOrgWindowRouting', () => {
  it('opens a room delivery in place instead of routing a deep link out', async () => {
    const navigate = vi.fn().mockResolvedValue(true);
    const openRoute = vi.fn();
    const routed = withOrgWindowRouting(provider(navigate), 'org-a', openRoute);

    await expect(routed.navigate(row())).resolves.toBe(true);
    expect(openRoute).toHaveBeenCalledWith({ view: 'conversation', conversationId: 'general' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('delegates deliveries it cannot open to the wrapped provider', async () => {
    const navigate = vi.fn().mockResolvedValue(false);
    const openRoute = vi.fn();
    const routed = withOrgWindowRouting(provider(navigate), 'org-a', openRoute);

    await expect(routed.navigate(row({ sourceKind: 'trackerComment' }))).resolves.toBe(false);
    expect(openRoute).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
