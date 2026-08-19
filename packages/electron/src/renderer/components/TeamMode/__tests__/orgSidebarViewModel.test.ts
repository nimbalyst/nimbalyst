import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import { describe, expect, it } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import {
  ORG_ADMIN_TABS,
  buildOrgSidebar,
  dmLabel,
  inboxUnreadCount,
  roomLabel,
  unreadCountsByConversation,
  visibleAdminTabs,
} from '../orgSidebarViewModel';

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

function delivery(
  overrides: Partial<TeamInboxSnapshot['deliveries'][number]> = {},
): TeamInboxSnapshot['deliveries'][number] {
  return {
    id: 'delivery-1',
    teamMemberId: asTeamMemberId('member-a'),
    orgId: 'org-a',
    orgName: 'Acme',
    createdAt: 10,
    hasUnreadActivity: false,
    source: {
      orgId: 'org-a',
      sourceKind: 'roomMessage',
      sourceId: 'general',
      commentId: 'message-1',
    },
    ...overrides,
  };
}

function snapshot(
  deliveries: TeamInboxSnapshot['deliveries'],
): TeamInboxSnapshot {
  return { status: 'ready', organizations: [], deliveries };
}

describe('buildOrgSidebar', () => {
  it('pins #general first, sorts the rest by label, and splits DMs out', () => {
    const model = buildOrgSidebar({
      conversations: [
        descriptor({ id: 'release-chatter', title: 'release-chatter' }),
        descriptor({ id: 'design', title: 'design', visibility: 'private' }),
        descriptor(),
        descriptor({ id: 'dm-1', kind: 'dm', visibility: 'private', title: undefined }),
      ],
      dmParticipants: { 'dm-1': ['member-a', 'member-b'] },
      memberNames: { 'member-a': 'Greg', 'member-b': 'Karl' },
      viewerUserId: 'member-a',
    });

    expect(model.rooms.map((item) => item.conversationId))
      .toEqual(['general', 'design', 'release-chatter']);
    expect(model.rooms[0].isGeneral).toBe(true);
    expect(model.rooms[1].isPrivate).toBe(true);
    expect(model.dms.map((item) => item.label)).toEqual(['Karl']);
  });

  it('leaves archived rooms and document discussions out of the sidebar', () => {
    const model = buildOrgSidebar({
      conversations: [
        descriptor(),
        descriptor({ id: 'old', title: 'old', archivedAt: 99 }),
        descriptor({
          id: 'doc-1',
          kind: 'documentDiscussion',
          visibility: 'sourceInherited',
          documentId: 'doc-1',
        }),
      ],
    });

    expect(model.rooms.map((item) => item.conversationId)).toEqual(['general']);
    expect(model.dms).toEqual([]);
  });

  it('carries per-conversation unread counts onto the rows', () => {
    const model = buildOrgSidebar({
      conversations: [descriptor(), descriptor({ id: 'design', title: 'design' })],
      unreadCounts: { general: 3 },
    });

    expect(model.rooms.find((item) => item.conversationId === 'general')?.unreadCount).toBe(3);
    expect(model.rooms.find((item) => item.conversationId === 'design')?.unreadCount).toBe(0);
  });
});

describe('admin tab visibility', () => {
  it('hides the administration-only panels from a plain member', () => {
    expect(visibleAdminTabs(true).map((tab) => tab.id))
      .toEqual(['members', 'projects', 'settings', 'billing', 'danger']);
    // Members and Projects stay: the roster is org-wide knowledge and both
    // panels already reduce their actions for members. Settings renders
    // read-only. Billing and the Danger zone have nothing a member may use.
    expect(visibleAdminTabs(false).map((tab) => tab.id))
      .toEqual(['members', 'projects', 'settings']);
    // An unresolved role is treated as a member: never reveal more by default.
    expect(visibleAdminTabs(undefined).map((tab) => tab.id))
      .toEqual(['members', 'projects', 'settings']);
  });

  it('marks exactly the panels a member can do nothing in as admin-only', () => {
    expect(ORG_ADMIN_TABS.filter((tab) => tab.adminOnly).map((tab) => tab.id))
      .toEqual(['billing', 'danger']);
  });

  // The sidebar is messaging only since NIM-2322; the tab list it used to
  // carry belongs to the management dialog, which reads `visibleAdminTabs`
  // directly.
  it('keeps the administration tabs off the sidebar model', () => {
    expect(buildOrgSidebar({ conversations: [], isOrgAdmin: true }))
      .not.toHaveProperty('adminTabs');
  });
});

describe('conversation labels', () => {
  it('prefers a room title over its slug id', () => {
    expect(roomLabel(descriptor({ id: 'design', title: 'Design' }))).toBe('Design');
    expect(roomLabel(descriptor({ id: 'design', title: '  ' }))).toBe('design');
  });

  it('labels a DM by its other participants, alphabetically', () => {
    const names = { me: 'Greg', b: 'Sarah', c: 'Josh' };
    expect(dmLabel(['me', 'b', 'c'], names, 'me')).toBe('Josh, Sarah');
    expect(dmLabel(['me', 'b'], names, 'me')).toBe('Sarah');
  });

  it('falls back rather than dropping a DM with no participants resolved', () => {
    expect(dmLabel([], {}, 'me')).toBe('Direct message');
    // An unresolved member id is still addressable; it is never invented.
    expect(dmLabel(['me', 'unknown'], {}, 'me')).toBe('unknown');
  });
});

describe('unread derivation', () => {
  it('counts unread and re-advanced deliveries per conversation', () => {
    const counts = unreadCountsByConversation(snapshot([
      delivery(),
      delivery({ id: 'd2', readAt: 20 }),
      delivery({ id: 'd3', readAt: 20, hasUnreadActivity: true }),
      delivery({ id: 'd4', dismissedAt: 30 }),
      delivery({ id: 'd5', orgId: 'org-b' }),
      delivery({
        id: 'd6',
        source: {
          orgId: 'org-a',
          sourceKind: 'dmMessage',
          sourceId: 'dm-1',
          commentId: 'message-9',
        },
      }),
    ]), 'org-a');

    expect(counts).toEqual({ general: 2, 'dm-1': 1 });
  });

  it('counts everything unread in the org for the Inbox pill, conversations included', () => {
    expect(inboxUnreadCount(snapshot([
      delivery(),
      delivery({ id: 'd2', readAt: 20 }),
      delivery({
        id: 'd3',
        source: {
          orgId: 'org-a',
          resourceKind: 'tracker',
          resourceId: 'NIM-1',
          sourceEventId: 'event-1',
          eventClass: 'statusChanged',
        },
      }),
      delivery({ id: 'd4', orgId: 'org-b' }),
    ]), 'org-a')).toBe(2);
  });
});
