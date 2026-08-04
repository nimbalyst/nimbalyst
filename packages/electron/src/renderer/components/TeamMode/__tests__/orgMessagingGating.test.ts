import { describe, expect, it } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import type { OrgSettings } from '../../../../shared/orgSettings';
import { DEFAULT_ORG_SETTINGS, normalizeOrgSettings } from '../../../../shared/orgSettings';
import {
  buildOrgSidebar,
  isOrgAdminRole,
  resolveOrgMessagingGating,
} from '../orgSidebarViewModel';
import { gateOrgWindowRoute } from '../orgWindowState';
import { buildComposeDestinations } from '../roomManagementViewModel';
import type { OrgRosterMember } from '../useOrgRoster';

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

const conversations: ConversationDirectoryEntry[] = [
  descriptor(),
  descriptor({ id: 'design', title: 'design' }),
  descriptor({ id: 'dm-1', kind: 'dm', visibility: 'private', title: undefined }),
];

const members: OrgRosterMember[] = [
  { memberId: 'member-a', email: 'a@example.com', name: 'Ann', role: 'admin' },
  { memberId: 'member-b', email: 'b@example.com', name: 'Bo', role: 'member' },
];

function settings(patch: Partial<OrgSettings['messaging']> = {}): OrgSettings {
  return normalizeOrgSettings({ messaging: { ...DEFAULT_ORG_SETTINGS.messaging, ...patch } });
}

describe('isOrgAdminRole', () => {
  it('treats owners and admins as administrators and nothing else', () => {
    expect(isOrgAdminRole('owner')).toBe(true);
    expect(isOrgAdminRole('admin')).toBe(true);
    expect(isOrgAdminRole('member')).toBe(false);
    expect(isOrgAdminRole(undefined)).toBe(false);
  });
});

describe('resolveOrgMessagingGating', () => {
  it('shows everything by default, including for a plain member', () => {
    expect(resolveOrgMessagingGating(DEFAULT_ORG_SETTINGS, { isOrgAdmin: false }))
      .toEqual({
        roomsVisible: true,
        dmsVisible: true,
        canCreateRoom: true,
        canCreateDirectMessage: true,
      });
  });

  it('defaults to permissive when settings have not loaded', () => {
    // Gating is read before the fetch resolves; starting from "rooms off"
    // would blink the whole section out on every window open.
    expect(resolveOrgMessagingGating().roomsVisible).toBe(true);
    expect(resolveOrgMessagingGating().dmsVisible).toBe(true);
  });

  it.each([
    ['member', false],
    ['admin', true],
  ] as const)(
    'restricts room creation to admins for a %s viewer',
    (_role, isOrgAdmin) => {
      const gating = resolveOrgMessagingGating(
        settings({ roomCreation: 'admins' }),
        { isOrgAdmin },
      );
      expect(gating.roomsVisible).toBe(true);
      expect(gating.canCreateRoom).toBe(isOrgAdmin);
      // Restricting creation never restricts direct messages.
      expect(gating.canCreateDirectMessage).toBe(true);
    },
  );

  it('hides rooms entirely when rooms are off, for admins too', () => {
    const gating = resolveOrgMessagingGating(
      settings({ roomsEnabled: false }),
      { isOrgAdmin: true },
    );
    expect(gating.roomsVisible).toBe(false);
    expect(gating.canCreateRoom).toBe(false);
    expect(gating.dmsVisible).toBe(true);
  });

  it('hides direct messages when DMs are off, leaving rooms alone', () => {
    const gating = resolveOrgMessagingGating(settings({ dmsEnabled: false }));
    expect(gating.dmsVisible).toBe(false);
    expect(gating.canCreateDirectMessage).toBe(false);
    expect(gating.roomsVisible).toBe(true);
    expect(gating.canCreateRoom).toBe(true);
  });
});

describe('buildOrgSidebar gating', () => {
  it('lists both sections with messaging fully enabled', () => {
    const model = buildOrgSidebar({ conversations, settings: DEFAULT_ORG_SETTINGS });
    expect(model.rooms.map((room) => room.conversationId)).toEqual(['general', 'design']);
    expect(model.dms.map((dm) => dm.conversationId)).toEqual(['dm-1']);
  });

  it('drops every room, #general included, when rooms are off', () => {
    const model = buildOrgSidebar({
      conversations,
      settings: settings({ roomsEnabled: false }),
    });
    expect(model.rooms).toEqual([]);
    expect(model.dms.map((dm) => dm.conversationId)).toEqual(['dm-1']);
    expect(model.gating.roomsVisible).toBe(false);
  });

  it('drops direct messages when DMs are off', () => {
    const model = buildOrgSidebar({
      conversations,
      settings: settings({ dmsEnabled: false }),
    });
    expect(model.dms).toEqual([]);
    expect(model.rooms).toHaveLength(2);
  });

  it('keeps rooms readable but uncreatable for a member under admins-only creation', () => {
    const model = buildOrgSidebar({
      conversations,
      settings: settings({ roomCreation: 'admins' }),
      isOrgAdmin: false,
    });
    expect(model.rooms).toHaveLength(2);
    expect(model.gating.canCreateRoom).toBe(false);
  });
});

describe('gateOrgWindowRoute', () => {
  const roomsOff = resolveOrgMessagingGating(settings({ roomsEnabled: false }));
  const dmsOff = resolveOrgMessagingGating(settings({ dmsEnabled: false }));
  const allOn = resolveOrgMessagingGating(DEFAULT_ORG_SETTINGS);

  it('leaves permitted destinations untouched', () => {
    const route = { view: 'conversation' as const, conversationId: 'general' };
    expect(gateOrgWindowRoute(route, allOn, conversations)).toBe(route);
    expect(gateOrgWindowRoute({ view: 'directory' }, allOn, conversations))
      .toEqual({ view: 'directory' });
  });

  it('sends the rooms directory back to the inbox when rooms are off', () => {
    expect(gateOrgWindowRoute({ view: 'directory' }, roomsOff, conversations))
      .toEqual({ view: 'inbox' });
  });

  it('sends an open room or DM back to the inbox when its kind is off', () => {
    expect(gateOrgWindowRoute(
      { view: 'conversation', conversationId: 'design' },
      roomsOff,
      conversations,
    )).toEqual({ view: 'inbox' });
    expect(gateOrgWindowRoute(
      { view: 'conversation', conversationId: 'dm-1' },
      dmsOff,
      conversations,
    )).toEqual({ view: 'inbox' });
  });

  it('leaves a conversation the directory has not loaded alone', () => {
    // Deep links arrive before the listing does; bouncing them would break the
    // inbox's own navigation into a room.
    const route = { view: 'conversation' as const, conversationId: 'unknown' };
    expect(gateOrgWindowRoute(route, roomsOff, conversations)).toBe(route);
    expect(gateOrgWindowRoute(route, roomsOff, [])).toBe(route);
  });

  it('never gates the inbox, and sends administration out of the window', () => {
    expect(gateOrgWindowRoute({ view: 'inbox' }, roomsOff, conversations))
      .toEqual({ view: 'inbox' });
    // Administration is the ORG_MANAGEMENT dialog now, so its old route lands
    // on the inbox rather than on an empty content region.
    const admin = { view: 'admin' as const, adminTab: 'settings' as const };
    expect(gateOrgWindowRoute(admin, roomsOff, conversations))
      .toEqual({ view: 'inbox' });
  });
});

describe('buildComposeDestinations gating', () => {
  it('offers rooms and people when both are enabled', () => {
    const destinations = buildComposeDestinations({
      conversations,
      members,
      viewerUserId: 'member-a',
    });
    expect(destinations.map((destination) => destination.kind))
      .toEqual(['room', 'room', 'member']);
  });

  it('drops room destinations when rooms are off', () => {
    const destinations = buildComposeDestinations({
      conversations,
      members,
      viewerUserId: 'member-a',
      allowRooms: false,
    });
    expect(destinations.every((destination) => destination.kind === 'member')).toBe(true);
    expect(destinations).toHaveLength(1);
  });

  it('drops people when direct messages are off', () => {
    const destinations = buildComposeDestinations({
      conversations,
      members,
      viewerUserId: 'member-a',
      allowDirectMessages: false,
    });
    expect(destinations.every((destination) => destination.kind === 'room')).toBe(true);
    expect(destinations).toHaveLength(2);
  });

  it('offers nothing when both are off', () => {
    expect(buildComposeDestinations({
      conversations,
      members,
      viewerUserId: 'member-a',
      allowRooms: false,
      allowDirectMessages: false,
    })).toEqual([]);
  });
});
