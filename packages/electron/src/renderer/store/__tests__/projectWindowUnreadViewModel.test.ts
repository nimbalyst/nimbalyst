import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import { describe, expect, it } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import {
  formatUnreadCount,
  selectProjectWindowUnreadSummary,
  selectProjectWindowUnreadTarget,
} from '../projectWindowUnreadViewModel';

function snapshot(
  deliveries: TeamInboxSnapshot['deliveries'],
  organizations: TeamInboxSnapshot['organizations'] = [],
): TeamInboxSnapshot {
  return {
    status: 'ready',
    deliveries,
    organizations,
  };
}

function delivery(
  id: string,
  orgId: string,
  orgName: string,
  overrides: Partial<TeamInboxSnapshot['deliveries'][number]> = {},
): TeamInboxSnapshot['deliveries'][number] {
  return {
    id,
    teamMemberId: asTeamMemberId('member-a'),
    orgId,
    orgName,
    createdAt: 10,
    hasUnreadActivity: false,
    ...overrides,
  };
}

describe('project window unread summary', () => {
  it('aggregates unread deliveries across orgs and ignores read or dismissed rows', () => {
    const summary = selectProjectWindowUnreadSummary(snapshot([
      delivery('a-1', 'org-a', 'Acme'),
      delivery('a-2', 'org-a', 'Acme', { readAt: 11, hasUnreadActivity: true }),
      delivery('a-read', 'org-a', 'Acme', { readAt: 11 }),
      delivery('b-1', 'org-b', 'Beta'),
      delivery('b-dismissed', 'org-b', 'Beta', { dismissedAt: 12 }),
      delivery('c-read', 'org-c', 'Core', { readAt: 11 }),
    ]));

    expect(summary.totalUnread).toBe(3);
    expect(summary.orgs).toEqual([
      { orgId: 'org-a', orgName: 'Acme', unreadCount: 2 },
      { orgId: 'org-b', orgName: 'Beta', unreadCount: 1 },
    ]);
  });

  it('selects the workspace org when it has unread before falling back to the highest unread org', () => {
    const summary = selectProjectWindowUnreadSummary(snapshot([
      delivery('a-1', 'org-a', 'Acme'),
      delivery('a-2', 'org-a', 'Acme'),
      delivery('b-1', 'org-b', 'Beta'),
    ]));

    expect(selectProjectWindowUnreadTarget(summary, 'org-b')).toBe('org-b');
    expect(selectProjectWindowUnreadTarget(summary, 'org-c')).toBe('org-a');
    expect(selectProjectWindowUnreadTarget(summary, null)).toBe('org-a');
  });

  it('caps display counts without changing totals', () => {
    expect(formatUnreadCount(5)).toBe('5');
    expect(formatUnreadCount(100)).toBe('99+');
  });
});
