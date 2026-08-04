// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  adjacentConversationId,
  orderedConversationIds,
  type OrgSidebarItem,
  type OrgSidebarModel,
} from '../orgSidebarViewModel';

function item(conversationId: string, kind: OrgSidebarItem['kind']): OrgSidebarItem {
  return {
    conversationId,
    kind,
    label: conversationId,
    isPrivate: false,
    isGeneral: conversationId === 'general',
    unreadCount: 0,
  };
}

function model(
  rooms: string[] = [],
  dms: string[] = [],
): OrgSidebarModel {
  return {
    rooms: rooms.map((id) => item(id, 'orgRoom')),
    dms: dms.map((id) => item(id, 'dm')),
    gating: {
      roomsVisible: true,
      dmsVisible: true,
      canCreateRoom: true,
      canCreateDirectMessage: true,
    },
  };
}

describe('orderedConversationIds', () => {
  it('is rooms then direct messages, in sidebar order', () => {
    expect(orderedConversationIds(model(['general', 'design'], ['dm-1'])))
      .toEqual(['general', 'design', 'dm-1']);
  });
});

describe('adjacentConversationId', () => {
  const sidebar = model(['general', 'design'], ['dm-1']);

  it('steps forward and backward through the sidebar order', () => {
    expect(adjacentConversationId(sidebar, 'general', 1)).toBe('design');
    expect(adjacentConversationId(sidebar, 'design', 1)).toBe('dm-1');
    expect(adjacentConversationId(sidebar, 'dm-1', -1)).toBe('design');
  });

  it('wraps at both ends', () => {
    expect(adjacentConversationId(sidebar, 'dm-1', 1)).toBe('general');
    expect(adjacentConversationId(sidebar, 'general', -1)).toBe('dm-1');
  });

  it('enters the list from outside it', () => {
    // Inbox, directory, an admin panel: forward lands on the first, back on
    // the last, so the shortcut is also the way in.
    expect(adjacentConversationId(sidebar, undefined, 1)).toBe('general');
    expect(adjacentConversationId(sidebar, undefined, -1)).toBe('dm-1');
    // A conversation the sidebar does not list (still loading, or just gated
    // off) is treated the same way rather than getting stuck.
    expect(adjacentConversationId(sidebar, 'not-listed', 1)).toBe('general');
  });

  it('has nowhere to go in an organization with no conversations', () => {
    expect(adjacentConversationId(model(), undefined, 1)).toBeNull();
    expect(adjacentConversationId(model(), 'general', -1)).toBeNull();
  });
});
