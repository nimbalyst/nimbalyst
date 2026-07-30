import { describe, expect, it, vi } from 'vitest';

import type { InboxProvider } from '../Inbox/inboxProvider';
import type { InboxRowView } from '../Inbox/inboxTypes';
import {
  DEFAULT_ORG_WINDOW_ROUTE,
  gateOrgWindowRoute,
  isFullWidthRoute,
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
  it('gives every surface but the administration panels the full window', () => {
    expect(isFullWidthRoute({ view: 'inbox' })).toBe(true);
    expect(isFullWidthRoute({ view: 'directory' })).toBe(true);
    expect(isFullWidthRoute({ view: 'conversation', conversationId: 'general' })).toBe(true);
    expect(isFullWidthRoute({ view: 'admin', adminTab: 'billing' })).toBe(false);
  });

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

  it('moves the window off an admin panel this viewer may not see', () => {
    expect(gateOrgWindowRoute(
      { view: 'admin', adminTab: 'danger' },
      gating,
      [],
      ['members', 'projects', 'settings'],
    )).toEqual(DEFAULT_ORG_WINDOW_ROUTE);
  });

  it('leaves a panel the viewer may see alone', () => {
    const route = { view: 'admin' as const, adminTab: 'members' as const };
    expect(gateOrgWindowRoute(route, gating, [], ['members'])).toBe(route);
  });

  it('leaves an admin route alone while the role is still unknown', () => {
    // Bouncing here would throw an admin off their own Danger zone for the
    // frame between opening the window and the roster answering.
    const route = { view: 'admin' as const, adminTab: 'danger' as const };
    expect(gateOrgWindowRoute(route, gating, [])).toBe(route);
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
