import { describe, expect, it } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import {
  EMPTY_CREATE_ROOM_FORM,
  MAX_DM_PARTICIPANTS,
  buildComposeDestinations,
  buildCreateRoomRequest,
  buildDirectMessageRequest,
  buildRoomMemberRows,
  buildRoomSettingsUpdate,
  deriveRoomId,
  findExistingDirectMessage,
  validateRoomId,
} from '../roomManagementViewModel';

function room(
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

const members = [
  { memberId: 'member-a', email: 'greg@example.com', name: 'Greg Hinkle', role: 'owner' },
  { memberId: 'member-b', email: 'karl@example.com', name: 'Karl', role: 'member' },
  { memberId: 'member-c', email: 'sarah@example.com', name: '', role: 'member' },
];

describe('deriveRoomId', () => {
  it('slugs a typed room name', () => {
    expect(deriveRoomId('Design Reviews')).toBe('design-reviews');
  });

  it('drops characters the server would reject rather than substituting them', () => {
    expect(deriveRoomId('Design & Review!')).toBe('design-review');
    expect(deriveRoomId('release/candidates')).toBe('releasecandidates');
  });

  it('keeps the id a valid room segment at the edges', () => {
    expect(deriveRoomId('  spaced   out  ')).toBe('spaced-out');
    expect(deriveRoomId('--weird--')).toBe('weird');
    expect(deriveRoomId('v1.2_beta')).toBe('v1.2_beta');
    expect(deriveRoomId('!!!')).toBe('');
  });
});

describe('validateRoomId', () => {
  it('accepts the server pattern and rejects everything else', () => {
    expect(validateRoomId('design-reviews')).toBeNull();
    expect(validateRoomId('v1.2_beta')).toBeNull();
    expect(validateRoomId('design reviews')).toMatch(/letters, numbers/);
    expect(validateRoomId('design/reviews')).toMatch(/letters, numbers/);
    expect(validateRoomId('')).toMatch(/Enter a room name/);
  });

  it('catches a collision the server would answer with a flat conflict', () => {
    expect(validateRoomId('General', ['general', 'design'])).toMatch(/already exists/);
  });
});

describe('buildCreateRoomRequest', () => {
  it('derives the id from the name and builds a public room request', () => {
    const result = buildCreateRoomRequest({
      ...EMPTY_CREATE_ROOM_FORM,
      name: 'Release Chatter',
      topic: '  Ship talk  ',
    });

    expect(result.canSubmit).toBe(true);
    expect(result.resolvedId).toBe('release-chatter');
    expect(result.request).toEqual({
      id: 'release-chatter',
      kind: 'orgRoom',
      visibility: 'public',
      title: 'Release Chatter',
      topic: 'Ship talk',
      agentPostingEnabled: false,
    });
  });

  it('prefers a typed id over the derived one', () => {
    const result = buildCreateRoomRequest({
      ...EMPTY_CREATE_ROOM_FORM,
      name: 'Release Chatter',
      id: 'releases',
    });
    expect(result.resolvedId).toBe('releases');
    expect(result.request?.id).toBe('releases');
  });

  it('sends initial members only for private rooms, never the creator', () => {
    const form = {
      ...EMPTY_CREATE_ROOM_FORM,
      name: 'Leads',
      memberIds: ['member-b', 'member-b', 'member-a'],
    };

    const asPublic = buildCreateRoomRequest(form, { viewerUserId: 'member-a' });
    expect(asPublic.request?.memberships).toBeUndefined();

    const asPrivate = buildCreateRoomRequest(
      { ...form, visibility: 'private' },
      { viewerUserId: 'member-a' },
    );
    expect(asPrivate.request?.memberships).toEqual([
      { userId: 'member-b', role: 'member' },
    ]);
  });

  it('blocks submission on a missing name or a colliding id', () => {
    const noName = buildCreateRoomRequest(EMPTY_CREATE_ROOM_FORM);
    expect(noName.canSubmit).toBe(false);
    expect(noName.request).toBeNull();

    const collision = buildCreateRoomRequest(
      { ...EMPTY_CREATE_ROOM_FORM, name: 'General' },
      { existingIds: ['general'] },
    );
    expect(collision.canSubmit).toBe(false);
    expect(collision.idError).toMatch(/already exists/);
  });

  it('carries the agent-posting choice through', () => {
    const result = buildCreateRoomRequest({
      ...EMPTY_CREATE_ROOM_FORM,
      name: 'Bots',
      agentPostingEnabled: true,
    });
    expect(result.request?.agentPostingEnabled).toBe(true);
  });
});

describe('buildDirectMessageRequest', () => {
  it('counts the viewer as a participant without asking for them', () => {
    const result = buildDirectMessageRequest(['member-b'], 'member-a');
    expect(result.error).toBeNull();
    expect(result.participants).toEqual(['member-a', 'member-b']);
    expect(result.request).toEqual({
      kind: 'dm',
      visibility: 'private',
      memberships: [
        { userId: 'member-a', role: 'member' },
        { userId: 'member-b', role: 'member' },
      ],
    });
  });

  it('deduplicates and ignores a re-picked viewer', () => {
    const result = buildDirectMessageRequest(
      ['member-b', 'member-b', 'member-a'],
      'member-a',
    );
    expect(result.participants).toEqual(['member-a', 'member-b']);
  });

  it('enforces the 2-8 participant range the server applies', () => {
    expect(buildDirectMessageRequest([], 'member-a').error).toMatch(/at least one/);

    const tooMany = buildDirectMessageRequest(
      Array.from({ length: MAX_DM_PARTICIPANTS }, (_, index) => `member-${index}`),
      'viewer',
    );
    expect(tooMany.participants).toHaveLength(MAX_DM_PARTICIPANTS + 1);
    expect(tooMany.error).toMatch(/at most 8/);
    expect(tooMany.request).toBeNull();

    const atCeiling = buildDirectMessageRequest(
      Array.from({ length: MAX_DM_PARTICIPANTS - 1 }, (_, index) => `member-${index}`),
      'viewer',
    );
    expect(atCeiling.error).toBeNull();
  });

  it('refuses to build without a resolved viewer', () => {
    const result = buildDirectMessageRequest(['member-b'], null);
    expect(result.request).toBeNull();
    expect(result.error).toMatch(/still resolving/);
  });
});

describe('findExistingDirectMessage', () => {
  const conversations = [
    room({ id: 'dm-1', kind: 'dm', visibility: 'private', title: undefined }),
    room({ id: 'dm-2', kind: 'dm', visibility: 'private', title: undefined }),
    room({
      id: 'dm-old',
      kind: 'dm',
      visibility: 'private',
      title: undefined,
      archivedAt: 5,
    }),
  ];
  const participants = {
    'dm-1': ['member-a', 'member-b'],
    'dm-2': ['member-a', 'member-b', 'member-c'],
    'dm-old': ['member-a', 'member-c'],
  };

  it('matches on the participant set regardless of order', () => {
    expect(
      findExistingDirectMessage(conversations, participants, ['member-b', 'member-a'])?.id,
    ).toBe('dm-1');
  });

  it('does not match a superset, an archived DM, or unknown participants', () => {
    expect(
      findExistingDirectMessage(conversations, participants, ['member-a', 'member-c']),
    ).toBeNull();
    expect(
      findExistingDirectMessage(conversations, {}, ['member-a', 'member-b']),
    ).toBeNull();
  });
});

describe('buildComposeDestinations', () => {
  const conversations = [
    room({ id: 'general', title: 'General' }),
    room({ id: 'design', title: 'Design', topic: 'Design reviews' }),
    room({ id: 'archived', title: 'Archived', archivedAt: 9 }),
    room({ id: 'read-only', title: 'Announcements', capabilities: ['read'] }),
    room({ id: 'dm-1', kind: 'dm', visibility: 'private', title: undefined }),
  ];

  it('lists postable rooms then people, excluding the viewer', () => {
    const destinations = buildComposeDestinations({
      conversations,
      members,
      viewerUserId: 'member-a',
    });
    expect(destinations.map((destination) => `${destination.kind}:${destination.id}`)).toEqual([
      'room:design',
      'room:general',
      'member:member-b',
      'member:member-c',
    ]);
  });

  it('falls back to the email when a member has no name', () => {
    const destinations = buildComposeDestinations({
      conversations: [],
      members,
      viewerUserId: 'member-a',
    });
    expect(destinations.map((destination) => destination.label)).toEqual([
      'Karl',
      'sarah@example.com',
    ]);
  });

  it('filters on label, id and sublabel', () => {
    const byTopic = buildComposeDestinations({
      conversations,
      members,
      viewerUserId: 'member-a',
      query: 'reviews',
    });
    expect(byTopic.map((destination) => destination.id)).toEqual(['design']);

    const byEmail = buildComposeDestinations({
      conversations,
      members,
      viewerUserId: 'member-a',
      query: 'KARL@',
    });
    expect(byEmail.map((destination) => destination.id)).toEqual(['member-b']);
  });
});

describe('buildRoomMemberRows', () => {
  it('reports every role as unknown until a membership list is available', () => {
    const rows = buildRoomMemberRows(members, null, 'member-a');
    expect(rows.every((row) => row.roomRole === null)).toBe(true);
    expect(rows[0].isViewer).toBe(true);
  });

  it('joins the roster against active memberships', () => {
    const rows = buildRoomMemberRows(
      members,
      [
        {
          conversationId: 'design',
          userId: 'member-a',
          role: 'roomAdmin',
          addedByUserId: 'member-a',
          createdAt: 1,
        },
        {
          conversationId: 'design',
          userId: 'member-b',
          role: 'member',
          addedByUserId: 'member-a',
          createdAt: 1,
          removedAt: 2,
        },
      ],
      'member-a',
    );
    expect(rows.map((row) => row.roomRole)).toEqual(['roomAdmin', null, null]);
  });
});

describe('buildRoomSettingsUpdate', () => {
  const entry = room({ id: 'design', title: 'Design', topic: 'Design reviews' });

  it('sends only what changed', () => {
    expect(buildRoomSettingsUpdate({ name: 'Design HQ', topic: 'Design reviews' }, entry))
      .toEqual({ error: null, input: { title: 'Design HQ' } });
    expect(buildRoomSettingsUpdate({ name: 'Design', topic: 'Reviews' }, entry))
      .toEqual({ error: null, input: { topic: 'Reviews' } });
  });

  it('treats an emptied topic as a clear, not an omission', () => {
    expect(buildRoomSettingsUpdate({ name: 'Design', topic: '   ' }, entry))
      .toEqual({ error: null, input: { topic: null } });
  });

  it('makes an unchanged form a no-op and an empty name an error', () => {
    expect(buildRoomSettingsUpdate({ name: '  Design  ', topic: 'Design reviews' }, entry))
      .toEqual({ error: null, input: null });
    expect(buildRoomSettingsUpdate({ name: '  ', topic: 'x' }, entry).error)
      .toMatch(/name is required/);
  });
});
