// @vitest-environment node
import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import { describe, expect, it } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';
import { unreadCountsByConversation } from '../../components/TeamMode/orgSidebarViewModel';
import {
  isConversationUnread,
  selectConversationDirectory,
  unreadDeliveryIdsForConversation,
} from '../conversationDirectoryViewModel';

function descriptor(
  overrides: Partial<ConversationDirectoryEntry> = {},
): ConversationDirectoryEntry {
  return {
    id: 'general',
    orgId: 'org-a',
    kind: 'orgRoom',
    visibility: 'public',
    title: 'General',
    agentPostingEnabled: false,
    createdByUserId: 'member-a',
    createdAt: 1,
    capabilities: ['read', 'comment'],
    ...overrides,
  };
}

function inboxSnapshot(
  deliveries: TeamInboxSnapshot['deliveries'],
): TeamInboxSnapshot {
  return {
    status: 'ready',
    organizations: [],
    deliveries,
  };
}

describe('selectConversationDirectory', () => {
  it('filters fixture descriptors by org, read capability, archive state, and kind', () => {
    const fixtures: ConversationDirectoryEntry[] = [
      descriptor(),
      descriptor({ id: 'dm-a', kind: 'dm', visibility: 'private' }),
      descriptor({ id: 'archived', archivedAt: 20 }),
      descriptor({ id: 'manage-only', capabilities: ['manageRoom'] }),
      descriptor({ id: 'other-org', orgId: 'org-b' }),
    ];

    expect(selectConversationDirectory(fixtures, { orgId: 'org-a' })
      .map((entry) => entry.id)).toEqual(['general', 'dm-a']);
    expect(selectConversationDirectory(fixtures, {
      orgId: 'org-a',
      includeArchived: true,
      kinds: ['orgRoom'],
    }).map((entry) => entry.id)).toEqual(['general', 'archived']);
  });

  it('drops a row from a server old enough to omit capabilities instead of throwing', () => {
    const fixtures = [
      descriptor(),
      { ...descriptor({ id: 'no-capabilities' }), capabilities: undefined },
    ] as ConversationDirectoryEntry[];

    expect(selectConversationDirectory(fixtures, { orgId: 'org-a' })
      .map((entry) => entry.id)).toEqual(['general']);
  });
});

describe('conversation unread derivation', () => {
  const target = { orgId: 'org-a', conversationId: 'general' };

  it('uses unread deliveries and materialized conversation watermark advances', () => {
    const unread = inboxSnapshot([{
      id: 'delivery-1',
      teamMemberId: asTeamMemberId('member-a'),
      orgId: 'org-a',
      orgName: 'Acme',
      source: {
        orgId: 'org-a',
        sourceKind: 'roomMessage',
        sourceId: 'general',
        commentId: 'message-1',
      },
      createdAt: 10,
      hasUnreadActivity: false,
    }]);
    const advanced = inboxSnapshot([{
      ...unread.deliveries[0],
      readAt: 11,
      hasUnreadActivity: true,
    }]);

    expect(isConversationUnread(unread, target)).toBe(true);
    expect(isConversationUnread(advanced, target)).toBe(true);
  });

  it('isolates orgs and ignores read, dismissed, and non-conversation deliveries', () => {
    const snapshot = inboxSnapshot([
      {
        id: 'read',
        teamMemberId: asTeamMemberId('member-a'),
        orgId: 'org-a',
        orgName: 'Acme',
        source: {
          orgId: 'org-a',
          sourceKind: 'roomMessage',
          sourceId: 'general',
          commentId: 'message-1',
        },
        createdAt: 10,
        readAt: 11,
        hasUnreadActivity: false,
      },
      {
        id: 'dismissed',
        teamMemberId: asTeamMemberId('member-a'),
        orgId: 'org-a',
        orgName: 'Acme',
        source: {
          orgId: 'org-a',
          sourceKind: 'roomMessage',
          sourceId: 'general',
          commentId: 'message-2',
        },
        createdAt: 12,
        dismissedAt: 13,
        hasUnreadActivity: true,
      },
      {
        id: 'other-org',
        teamMemberId: asTeamMemberId('member-a'),
        orgId: 'org-b',
        orgName: 'Other',
        source: {
          orgId: 'org-b',
          sourceKind: 'roomMessage',
          sourceId: 'general',
          commentId: 'message-3',
        },
        createdAt: 14,
        hasUnreadActivity: true,
      },
      {
        id: 'activity',
        teamMemberId: asTeamMemberId('member-a'),
        orgId: 'org-a',
        orgName: 'Acme',
        source: {
          orgId: 'org-a',
          resourceKind: 'tracker',
          resourceId: 'tracker-1',
          sourceEventId: 'event-1',
          eventClass: 'assignment',
        },
        createdAt: 15,
        hasUnreadActivity: true,
      },
    ]);

    expect(isConversationUnread(snapshot, target)).toBe(false);
  });

  it('names the unread deliveries a room open should mark read, and drops the sidebar count once they are', () => {
    const open = inboxSnapshot([
      {
        id: 'delivery-1',
        teamMemberId: asTeamMemberId('member-a'),
        orgId: 'org-a',
        orgName: 'Acme',
        source: {
          orgId: 'org-a',
          sourceKind: 'roomMessage',
          sourceId: 'general',
          commentId: 'message-1',
        },
        createdAt: 10,
        hasUnreadActivity: false,
      },
      {
        id: 'delivery-2',
        teamMemberId: asTeamMemberId('member-a'),
        orgId: 'org-a',
        orgName: 'Acme',
        source: {
          orgId: 'org-a',
          sourceKind: 'roomMessage',
          sourceId: 'design',
          commentId: 'message-2',
        },
        createdAt: 11,
        hasUnreadActivity: false,
      },
    ]);

    expect(unreadDeliveryIdsForConversation(open, target))
      .toEqual(['delivery-1']);
    expect(unreadCountsByConversation(open, 'org-a'))
      .toEqual({ general: 1, design: 1 });

    // What the server reports back once the open marked those deliveries read.
    const afterMarkRead = inboxSnapshot([
      { ...open.deliveries[0], readAt: 12, hasUnreadActivity: false },
      open.deliveries[1],
    ]);

    expect(unreadDeliveryIdsForConversation(afterMarkRead, target)).toEqual([]);
    expect(unreadCountsByConversation(afterMarkRead, 'org-a'))
      .toEqual({ design: 1 });
  });
});
