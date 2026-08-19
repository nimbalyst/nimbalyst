import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import { describe, expect, it } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import { inboxUnreadCount } from '../orgSidebarViewModel';
import {
  connectionSummary,
  isOrgConnectionReady,
  orgConnectionStatus,
  shouldRenderOrgRail,
} from '../orgWindowRailViewModel';

function snapshot(): TeamInboxSnapshot {
  return {
    status: 'ready',
    organizations: [
      { orgId: 'org-a', orgName: 'Acme', status: 'ready' },
      { orgId: 'org-b', orgName: 'Beta', status: 'offline' },
    ],
    deliveries: [
      {
        id: 'delivery-a',
        teamMemberId: asTeamMemberId('member-a'),
        orgId: 'org-a',
        orgName: 'Acme',
        createdAt: 1,
        hasUnreadActivity: true,
        source: {
          orgId: 'org-a',
          sourceKind: 'roomMessage',
          sourceId: 'general',
          commentId: 'comment-a',
        },
      },
      {
        id: 'delivery-b',
        teamMemberId: asTeamMemberId('member-a'),
        orgId: 'org-b',
        orgName: 'Beta',
        createdAt: 2,
        hasUnreadActivity: true,
        source: {
          orgId: 'org-b',
          sourceKind: 'roomMessage',
          sourceId: 'general',
          commentId: 'comment-b',
        },
      },
      {
        id: 'delivery-read',
        teamMemberId: asTeamMemberId('member-a'),
        orgId: 'org-b',
        orgName: 'Beta',
        createdAt: 3,
        readAt: 4,
        hasUnreadActivity: false,
        source: {
          orgId: 'org-b',
          sourceKind: 'roomMessage',
          sourceId: 'general',
          commentId: 'comment-c',
        },
      },
    ],
  };
}

describe('org window rail view model', () => {
  it('renders the org rail only for two or more active memberships', () => {
    expect(shouldRenderOrgRail([
      { orgId: 'org-a', name: 'Acme', membershipType: 'active_member' },
    ])).toBe(false);
    expect(shouldRenderOrgRail([
      { orgId: 'org-a', name: 'Acme', membershipType: 'active_member' },
      { orgId: 'org-b', name: 'Beta', membershipType: 'invited_member' },
    ])).toBe(false);
    expect(shouldRenderOrgRail([
      { orgId: 'org-a', name: 'Acme', membershipType: 'active_member' },
      { orgId: 'org-b', name: 'Beta', membershipType: 'active_member' },
    ])).toBe(true);
  });

  it('keeps unread badge selectors scoped per org', () => {
    const value = snapshot();
    expect(inboxUnreadCount(value, 'org-a')).toBe(1);
    expect(inboxUnreadCount(value, 'org-b')).toBe(1);
    expect(inboxUnreadCount(value, 'org-c')).toBe(0);
  });

  it('reports per-org and aggregate connection state', () => {
    const value = snapshot();
    expect(orgConnectionStatus(value, 'org-a')).toBe('ready');
    expect(isOrgConnectionReady(value, 'org-a')).toBe(true);
    expect(orgConnectionStatus(value, 'org-b')).toBe('offline');
    expect(isOrgConnectionReady(value, 'org-b')).toBe(false);
    expect(connectionSummary(value)).toEqual({
      orgCount: 2,
      reconnectingCount: 1,
      allReady: false,
    });
  });
});
